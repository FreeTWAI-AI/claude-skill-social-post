#!/usr/bin/env python3
"""Identity, state-machine, permit, and store-concurrency tests."""

from __future__ import annotations

import tempfile
from pathlib import Path

from comment_domain import EVENT_TYPES, normalize_comment
from comment_policy import build_queue
from comment_store import comment_store_revision, commit_comment_records
from comment_test_support import (
    POLICY,
    approval_for,
    assert_invalid,
    assert_valid,
    draft_for,
    finish_for,
    sample_comment,
    send_start_for,
)


def check_platform_normalization_and_identity() -> None:
    if not {"session_granted", "session_revoked"}.issubset(EVENT_TYPES):
        raise AssertionError("authorization grant events are missing from EVENT_TYPES")
    keys = {
        sample_comment(platform, platform=platform)["comment_key"]
        for platform in ("facebook", "instagram", "threads")
    }
    if len(keys) != 3:
        raise AssertionError("cross-platform comments collapsed into one identity")
    weak = sample_comment("weak", strong=False)
    if weak["identity_confidence"] != "weak":
        raise AssertionError("missing platform ID did not produce weak identity")

    spoofed_raw = dict(weak)
    spoofed_raw["identity_confidence"] = "strong"
    spoofed = normalize_comment(spoofed_raw)
    if spoofed["identity_confidence"] != "weak":
        raise AssertionError("caller-supplied strong identity bypassed the anchor derivation")

    string_boolean = sample_comment("string-bool", body_complete="false")
    if string_boolean["body_complete"] is True:
        raise AssertionError("the string 'false' was coerced to boolean true")
    assert_invalid([string_boolean], [], "body_complete must be boolean")

    permalink = "https://example.com/post/permalink?comment=stable"
    before = sample_comment(
        "permalink-edit", strong=False, comment_permalink=permalink, body="原本的留言",
    )
    after = sample_comment(
        "permalink-edit", strong=False, comment_permalink=permalink, body="編輯後的留言",
        observed_at="2026-08-28T10:01:00+08:00",
    )
    if before["comment_key"] != after["comment_key"]:
        raise AssertionError("permalink-anchored comment identity changed after body edit")
    if before["raw_fingerprint"] == after["raw_fingerprint"]:
        raise AssertionError("edited permalink-anchored comment did not change fingerprint")
    assert_valid([before, after], [])


def check_auto_gate_and_repetition() -> None:
    first = sample_comment("one")
    second = sample_comment("two")
    first_draft = draft_for(first, "one", "真的很謝謝你！")
    second_draft = draft_for(second, "two", "這個回覆不同。")
    result = assert_valid([first, second], [first_draft, second_draft])
    default_queue = result["queue"]
    if any(item["bounded_auto_eligible"] for item in default_queue["items"]):
        raise AssertionError("batch_confirm mode silently enabled auto-send")
    bounded = build_queue(result["latest_comments"], result["reply_states"], POLICY, "bounded_auto")
    if len(bounded["bounded_auto_candidates"]) != 2:
        raise AssertionError("safe strong comments were not bounded-auto candidates")

    repeated = draft_for(second, "two-repeated", "真的很謝謝你！")
    result = assert_valid([first, second], [first_draft, repeated])
    bounded = build_queue(result["latest_comments"], result["reply_states"], POLICY, "bounded_auto")
    if bounded["bounded_auto_candidates"]:
        raise AssertionError("repeated reply text bypassed the repetition gate")

    weak = sample_comment("weak-auto", strong=False)
    weak_draft = draft_for(weak, "weak-auto")
    result = assert_valid([weak], [weak_draft])
    bounded = build_queue(result["latest_comments"], result["reply_states"], POLICY, "bounded_auto")
    if bounded["bounded_auto_candidates"]:
        raise AssertionError("weak comment identity was allowed to auto-send")


def check_one_shot_permit_lifecycle() -> None:
    comment = sample_comment("lifecycle")
    draft = draft_for(comment, "lifecycle")
    approval = approval_for(comment, draft, "lifecycle")
    started = send_start_for(comment, draft, approval, "lifecycle")
    verified = finish_for(comment, draft, started, "sent_verified")
    result = assert_valid([comment], [draft, approval, started, verified])
    if result["reply_states"][comment["comment_key"]]["status"] != "sent_verified":
        raise AssertionError("verified reply did not reach terminal state")
    if result["queue"]["items"]:
        raise AssertionError("sent comment remained in the pending queue")
    assert_invalid([comment], [draft, started], "cannot start send from drafted")
    retry = send_start_for(
        comment, draft, approval, "lifecycle-retry",
        occurred_at="2026-08-28T10:03:30+08:00",
    )
    assert_invalid([comment], [draft, approval, started, retry], "cannot start send from send_started")


def check_uncertain_send_and_reconcile() -> None:
    comment = sample_comment("unknown")
    draft = draft_for(comment, "unknown")
    approval = approval_for(comment, draft, "unknown")
    started = send_start_for(comment, draft, approval, "unknown")
    uncertain = finish_for(comment, draft, started, "needs_reconcile")
    assert_valid([comment], [draft, approval, started, uncertain])
    retry = send_start_for(
        comment, draft, approval, "unknown-retry",
        occurred_at="2026-08-28T10:04:30+08:00",
    )
    assert_invalid(
        [comment], [draft, approval, started, uncertain, retry],
        "cannot start send from needs_reconcile",
    )
    reconciled = finish_for(
        comment, draft, started, "reconciled_sent",
        occurred_at="2026-08-28T10:05:00+08:00", evidence="reply found after page reload",
    )
    assert_valid([comment], [draft, approval, started, uncertain, reconciled])


def check_stale_and_multiline_rejection() -> None:
    original = sample_comment("edited")
    draft = draft_for(original, "edited")
    edited = sample_comment(
        "edited", observed_at="2026-08-28T10:01:30+08:00", body="太厲害了！請問怎麼做？",
    )
    approval = approval_for(edited, draft, "edited", "2026-08-28T10:02:00+08:00")
    assert_invalid([original, edited], [draft, approval], "draft became stale before approval")
    multiline = draft_for(original, "multiline", "第一行\n第二行")
    assert_invalid([original], [multiline], "single line")


def check_redraft_and_event_order_guards() -> None:
    comment = sample_comment("redraft-started")
    draft = draft_for(comment, "redraft-started")
    approval = approval_for(comment, draft, "redraft-started")
    started = send_start_for(comment, draft, approval, "redraft-started")
    replacement = draft_for(
        comment, "redraft-started-replacement", "另一個回覆",
        occurred_at="2026-08-28T10:04:00+08:00",
    )
    assert_invalid(
        [comment], [draft, approval, started, replacement],
        "cannot draft from send_started",
    )

    uncertain = finish_for(comment, draft, started, "needs_reconcile")
    later_replacement = draft_for(
        comment, "redraft-uncertain-replacement", "不能重新送出的回覆",
        occurred_at="2026-08-28T10:05:00+08:00",
    )
    assert_invalid(
        [comment], [draft, approval, started, uncertain, later_replacement],
        "cannot draft from needs_reconcile",
    )
    early_start = send_start_for(
        comment, draft, approval, "early-start",
        occurred_at="2026-08-28T10:01:30+08:00",
    )
    assert_invalid([comment], [draft, approval, early_start], "moves backwards")


def check_global_permit_uniqueness() -> None:
    first = sample_comment("permit-one")
    second = sample_comment("permit-two")
    first_draft = draft_for(first, "permit-one")
    second_draft = draft_for(second, "permit-two", occurred_at="2026-08-28T10:01:10+08:00")
    first_approval = approval_for(
        first, first_draft, "permit-one", permit_id="permit-global-collision",
    )
    second_approval = approval_for(
        second, second_draft, "permit-two", "2026-08-28T10:02:10+08:00",
        permit_id="permit-global-collision",
    )
    assert_invalid(
        [first, second], [first_draft, second_draft, first_approval, second_approval],
        "duplicate permit_id",
    )


def check_batch_confirmation_hard_gates() -> None:
    cases = (
        ("own", {"is_own": True}, "own comment"),
        ("already", {"has_own_reply": True}, "already has own reply"),
        ("incomplete", {"body_complete": False}, "incomplete comment body"),
    )
    for suffix, overrides, expected in cases:
        comment = sample_comment(f"hard-{suffix}", **overrides)
        draft = draft_for(comment, f"hard-{suffix}")
        approval = approval_for(comment, draft, f"hard-{suffix}")
        assert_invalid([comment], [draft, approval], expected)


def check_session_and_reconciliation_binding() -> None:
    comment = sample_comment("session-binding")
    draft = draft_for(comment, "session-binding")
    approval = approval_for(comment, draft, "session-binding")
    started = send_start_for(comment, draft, approval, "session-binding")
    wrong_finish = finish_for(
        comment, draft, started, "sent_verified", session_id="other-session",
    )
    assert_invalid(
        [comment], [draft, approval, started, wrong_finish],
        "session_id does not match send attempt",
    )
    uncertain = finish_for(comment, draft, started, "needs_reconcile")
    wrong_attempt = finish_for(
        comment, draft, started, "reconciled_sent",
        occurred_at="2026-08-28T10:05:00+08:00",
        session_id="reconcile-session", attempt_session_id="other-attempt-session",
    )
    assert_invalid(
        [comment], [draft, approval, started, uncertain, wrong_attempt],
        "attempt_session_id does not match send attempt",
    )


def check_optimistic_comment_store() -> None:
    with tempfile.TemporaryDirectory(prefix="social-comment-store-") as raw:
        data_dir = Path(raw) / "data"
        first_revision = comment_store_revision(data_dir)
        first = {"comments": [sample_comment("first")], "replies": []}
        second = {"comments": [sample_comment("second")], "replies": []}
        commit_comment_records(first, data_dir=data_dir, expected_revision=first_revision)
        try:
            commit_comment_records(second, data_dir=data_dir, expected_revision=first_revision)
        except RuntimeError:
            pass
        else:
            raise AssertionError("stale comment writer was not rejected")


def run_state_tests() -> None:
    check_platform_normalization_and_identity()
    check_auto_gate_and_repetition()
    check_one_shot_permit_lifecycle()
    check_uncertain_send_and_reconcile()
    check_stale_and_multiline_rejection()
    check_redraft_and_event_order_guards()
    check_global_permit_uniqueness()
    check_batch_confirmation_hard_gates()
    check_session_and_reconciliation_binding()
    check_optimistic_comment_store()

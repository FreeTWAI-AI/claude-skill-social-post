#!/usr/bin/env python3
"""Authorization-grant, policy-version, language, and history tests."""

from __future__ import annotations

from comment_policy import build_queue
from comment_test_support import (
    POLICY,
    approval_for,
    assert_invalid,
    assert_valid,
    draft_for,
    finish_for,
    grant_for,
    revoke_grant_for,
    sample_comment,
    send_start_for,
)


def check_grant_required_and_binding() -> None:
    comment = sample_comment("grant-required")
    draft = draft_for(comment, "grant-required")
    missing = approval_for(
        comment, draft, "grant-required", approval_mode="bounded_auto",
    )
    assert_invalid([comment], [draft, missing], "bounded_auto approval requires grant_id")

    unknown = approval_for(
        comment, draft, "grant-unknown", approval_mode="bounded_auto",
        grant_id="grant-does-not-exist",
    )
    assert_invalid([comment], [draft, unknown], "references unknown grant_id")

    other = sample_comment("grant-other")
    other_draft = draft_for(other, "grant-other")
    scoped = grant_for(comment, "scope")
    wrong_scope = approval_for(
        other, other_draft, "grant-other", approval_mode="bounded_auto",
        grant_id=scoped["grant_id"],
    )
    assert_invalid(
        [comment, other], [other_draft, scoped, wrong_scope],
        "grant scope does not match approval",
    )
    wrong_session = approval_for(
        comment, draft, "grant-session", approval_mode="bounded_auto",
        grant_id=scoped["grant_id"], session_id="other-session",
    )
    assert_invalid(
        [comment], [draft, scoped, wrong_session],
        "grant session_id does not match approval",
    )


def check_grant_caps() -> None:
    post_key = "post-shared-cap"
    first = sample_comment("grant-cap-one", post_key=post_key)
    second = sample_comment("grant-cap-two", post_key=post_key)
    first_draft = draft_for(first, "grant-cap-one")
    second_draft = draft_for(
        second, "grant-cap-two", occurred_at="2026-08-28T10:01:10+08:00",
    )
    capped = grant_for(first, "cap", maximum_actions=1)
    first_approval = approval_for(
        first, first_draft, "grant-cap-one", approval_mode="bounded_auto",
        grant_id=capped["grant_id"],
    )
    second_approval = approval_for(
        second, second_draft, "grant-cap-two", "2026-08-28T10:02:10+08:00",
        approval_mode="bounded_auto", grant_id=capped["grant_id"],
    )
    assert_invalid(
        [first, second],
        [first_draft, second_draft, capped, first_approval, second_approval],
        "bounded_auto grant action cap exceeded",
    )
    over_policy = grant_for(
        first, "over-policy",
        maximum_actions=int(POLICY["maximum_actions_per_run"]) + 1,
    )
    assert_invalid([first], [over_policy], "maximum_actions exceeds policy limit")


def check_grant_revocation() -> None:
    comment = sample_comment("grant-revoked")
    draft = draft_for(comment, "grant-revoked")
    grant = grant_for(comment, "revoked")
    revoked = revoke_grant_for(grant)
    after_revoke = approval_for(
        comment, draft, "grant-revoked", "2026-08-28T10:03:00+08:00",
        approval_mode="bounded_auto", grant_id=grant["grant_id"],
    )
    assert_invalid(
        [comment], [draft, grant, revoked, after_revoke], "grant is not active",
    )


def check_valid_grant_consumption() -> None:
    comment = sample_comment("grant-valid")
    draft = draft_for(comment, "grant-valid")
    grant = grant_for(comment, "valid")
    approval = approval_for(
        comment, draft, "grant-valid", approval_mode="bounded_auto",
        grant_id=grant["grant_id"],
    )
    result = assert_valid([comment], [draft, grant, approval])
    grants = result.get("authorization_grants")
    if not isinstance(grants, dict) or grant["grant_id"] not in grants:
        raise AssertionError("validate_comment_store did not return authorization_grants")
    if grants[grant["grant_id"]].get("used_actions") != 1:
        raise AssertionError("bounded approval did not consume exactly one grant action")


def check_sent_history_repetition() -> None:
    sent_comment = sample_comment("history-sent")
    sent_draft = draft_for(sent_comment, "history-sent", "謝謝你支持！")
    sent_approval = approval_for(sent_comment, sent_draft, "history-sent")
    sent_started = send_start_for(sent_comment, sent_draft, sent_approval, "history-sent")
    sent = finish_for(sent_comment, sent_draft, sent_started, "sent_verified")
    pending_comment = sample_comment("history-pending")
    pending_draft = draft_for(
        pending_comment, "history-pending", "謝謝你支持！",
        occurred_at="2026-08-28T10:05:00+08:00",
    )
    result = assert_valid(
        [sent_comment, pending_comment],
        [sent_draft, sent_approval, sent_started, sent, pending_draft],
    )
    bounded = build_queue(
        result["latest_comments"], result["reply_states"], POLICY, "bounded_auto",
    )
    pending = next(
        item for item in bounded["items"]
        if item["comment_key"] == pending_comment["comment_key"]
    )
    if "repeated_reply_text" not in pending["gate_reasons"]:
        raise AssertionError("sent reply history was ignored by the repetition gate")


def check_policy_version_gate() -> None:
    comment = sample_comment("policy-mismatch")
    draft = draft_for(
        comment, "policy-mismatch", policy_version=POLICY["policy_version"] + 1,
    )
    result = assert_valid([comment], [draft])
    item = build_queue(
        result["latest_comments"], result["reply_states"], POLICY, "bounded_auto",
    )["items"][0]
    if "policy_version_mismatch" not in item["gate_reasons"]:
        raise AssertionError("stale/future draft policy version was auto eligible")


def check_language_gates() -> None:
    cases = (
        ("unknown-language", "und", "zh-Hant", "unknown_comment_language"),
        ("mismatched-language", "zh-Hant", "en", "reply_language_mismatch"),
    )
    for suffix, comment_language, draft_language, expected in cases:
        comment = sample_comment(suffix, language=comment_language)
        draft = draft_for(comment, suffix, language=draft_language)
        result = assert_valid([comment], [draft])
        item = build_queue(
            result["latest_comments"], result["reply_states"], POLICY, "bounded_auto",
        )["items"][0]
        if expected not in item["gate_reasons"] or item["bounded_auto_eligible"]:
            raise AssertionError(f"language safety gate missing {expected}: {item}")


def run_authorization_tests() -> None:
    check_grant_required_and_binding()
    check_grant_caps()
    check_grant_revocation()
    check_valid_grant_consumption()
    check_sent_history_repetition()
    check_policy_version_gate()
    check_language_gates()

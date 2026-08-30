#!/usr/bin/env python3
"""Preflight, result, reinspection, and legacy-gate browser contract tests."""

from __future__ import annotations

import tempfile
from pathlib import Path

from comment_test_browser_adapter import LocalFixtureCommentAdapter
from comment_test_cli import draft_cli_fixture, prepare_cli_fixture, run_cli
from comment_test_support import ROOT
from comment_test_browser_contract_support import (
    SESSION_ID,
    assert_ledger_unchanged,
    assert_status,
    begin_browser_send,
    capture_receipt_commit,
    finish_browser_send,
    ingest_browser_scan,
    intent_state,
    now_iso,
    preflight_for,
    prepare_action,
    provenance_envelope,
    rebind_preparation,
    reinspection_for,
    result_for,
    reject_browser_finish,
    run_browser_reconcile,
    scan_envelope,
    write_json,
)


def _check_contradictory_reinspection_presence(
    script: Path, root: Path, source: Path, intent_id: str,
    reply_path: Path, before: str, base: dict[str, object],
) -> None:
    cases = (
        dict(
            base, exact_reply_visible=True, own_author_verified=False,
            absence_verified=False, own_author_reply_count=1,
            reinspection_total_reply_count=1,
        ),
        dict(
            base, exact_reply_visible=True, own_author_verified=True,
            absence_verified=False, own_author_reply_count=0,
        ),
    )
    for receipt in cases:
        run_browser_reconcile(
            script, root, source, intent_id, receipt, expected=2,
        )
        assert_ledger_unchanged(
            reply_path, before, "contradictory own reply presence mutated the ledger",
        )


def run_contract_lifecycle(platform: str, *, verified: bool) -> None:
    adapter = LocalFixtureCommentAdapter(platform)
    with tempfile.TemporaryDirectory(prefix=f"social-{platform}-contract-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
        comment = ingest_browser_scan(script, root, scan_envelope(adapter))
        _reply_path, intent_id = draft_cli_fixture(script, root, comment)
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "batch_confirm", "--session-id", SESSION_ID, "--write",
        )
        action = prepare_action(script, root, intent_id)
        adapter.fill_composer(action["reply_text"])
        begin_browser_send(script, root, action, adapter)
        adapter.click_submit("verified" if verified else "ambiguous")
        finish_browser_send(script, root, action, adapter)
        assert_status(root, intent_id, "sent_verified" if verified else "needs_reconcile")


def check_preflight_guards() -> None:
    adapter = LocalFixtureCommentAdapter("facebook")
    with tempfile.TemporaryDirectory(prefix="social-preflight-guards-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
        comment = ingest_browser_scan(script, root, scan_envelope(adapter))
        reply_path, intent_id = draft_cli_fixture(script, root, comment)
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "batch_confirm", "--session-id", SESSION_ID, "--write",
        )
        action = prepare_action(script, root, intent_id)
        adapter.fill_composer(action["reply_text"])
        bad = preflight_for(action, adapter)
        bad["composer_empty_before_fill"] = "true"
        source = root / "bad-preflight.json"
        write_json(source, bad)
        before = reply_path.read_text(encoding="utf-8")
        run_cli(
            script, root, "browser-begin", str(source), "--intent-id", intent_id,
            "--session-id", SESSION_ID, "--write", expected=2,
        )
        if reply_path.read_text(encoding="utf-8") != before:
            raise AssertionError("invalid preflight mutated the ledger")
        stale = preflight_for(action, adapter, observed_at=now_iso(-120))
        write_json(source, stale)
        run_cli(
            script, root, "browser-begin", str(source), "--intent-id", intent_id,
            "--session-id", SESSION_ID, "--write", expected=2,
        )
        if reply_path.read_text(encoding="utf-8") != before:
            raise AssertionError("invalid preflight mutated the ledger")
        wrong_post = preflight_for(action, adapter)
        wrong_post["observed_url"] = "https://www.facebook.com/test/posts/other-post"
        rebind_preparation(wrong_post)
        write_json(source, wrong_post)
        run_cli(
            script, root, "browser-begin", str(source), "--intent-id", intent_id,
            "--session-id", SESSION_ID, "--write", expected=2,
        )
        for label, bad_url in (
            ("credentials", "https://user@www.facebook.com/test/posts/post-facebook"),
            ("non-default port", "https://www.facebook.com:444/test/posts/post-facebook"),
            ("alternate host", "https://m.facebook.com/test/posts/post-facebook"),
        ):
            bad_url_receipt = preflight_for(action, adapter)
            bad_url_receipt["observed_url"] = bad_url
            rebind_preparation(bad_url_receipt)
            write_json(source, bad_url_receipt)
            rejected = run_cli(
                script, root, "browser-begin", str(source), "--intent-id", intent_id,
                "--session-id", SESSION_ID, "--write", expected=2,
            )
            if label not in rejected.stderr and "host differs" not in rejected.stderr:
                raise AssertionError(f"browser preflight did not reject {label}")
        wrong_schema = preflight_for(action, adapter)
        wrong_schema["schema_version"] = True
        write_json(source, wrong_schema)
        run_cli(
            script, root, "browser-begin", str(source), "--intent-id", intent_id,
            "--session-id", SESSION_ID, "--write", expected=2,
        )
        test_only = preflight_for(action, adapter)
        test_only["test_only"] = True
        write_json(source, test_only)
        run_cli(
            script, root, "browser-begin", str(source), "--intent-id", intent_id,
            "--session-id", SESSION_ID, "--write", expected=2,
        )
        if reply_path.read_text(encoding="utf-8") != before:
            raise AssertionError("invalid preflight mutated the ledger")


def check_result_guards() -> None:
    adapter = LocalFixtureCommentAdapter("instagram")
    with tempfile.TemporaryDirectory(prefix="social-result-guards-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
        comment = ingest_browser_scan(script, root, scan_envelope(adapter))
        reply_path, intent_id = draft_cli_fixture(script, root, comment)
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "batch_confirm", "--session-id", SESSION_ID, "--write",
        )
        action = prepare_action(script, root, intent_id)
        adapter.fill_composer(action["reply_text"])
        begin_browser_send(script, root, action, adapter)
        replay_source = root / "browser-preflight.json"
        before_replay = reply_path.read_text(encoding="utf-8")
        replay = run_cli(
            script, root, "browser-begin", str(replay_source),
            "--intent-id", intent_id, "--session-id", SESSION_ID,
            "--write", expected=2,
        )
        if "requires approved status" not in replay.stderr:
            raise AssertionError("durable submit claim replay did not fail closed")
        if reply_path.read_text(encoding="utf-8") != before_replay:
            raise AssertionError("durable submit claim replay mutated the ledger")
        adapter.click_submit("verified")
        current = intent_state(root, intent_id)
        receipt = result_for(
            action, adapter, current["attempt"]["browser_preflight_id"],
        )
        before = reply_path.read_text(encoding="utf-8")
        source = root / "bad-result.json"
        bad_action = dict(receipt, action_id="wrong-action")
        reject_browser_finish(script, root, source, intent_id, bad_action)
        missing_total = dict(receipt)
        missing_total.pop("post_submit_total_reply_count")
        reject_browser_finish(script, root, source, intent_id, missing_total)
        for key, value in (
            ("preparation_id", "0" * 64),
            ("claim_id", "wrong-claim"),
        ):
            bad_binding = dict(receipt, **{key: value})
            reject_browser_finish(script, root, source, intent_id, bad_binding)
        stale = dict(receipt, observed_at=now_iso(-400))
        reject_browser_finish(script, root, source, intent_id, stale)
        predates_attempt = dict(receipt, observed_at=now_iso(-30))
        reject_browser_finish(script, root, source, intent_id, predates_attempt)
        wrong_schema = dict(receipt, schema_version=1.0)
        reject_browser_finish(script, root, source, intent_id, wrong_schema)
        test_only = dict(receipt, test_only=True)
        reject_browser_finish(script, root, source, intent_id, test_only)
        assert_ledger_unchanged(
            reply_path, before, "invalid browser result mutated the ledger",
        )


def run_truth_table_guard() -> None:
    adapter = LocalFixtureCommentAdapter("instagram")
    with tempfile.TemporaryDirectory(prefix="social-result-truth-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
        comment = ingest_browser_scan(script, root, scan_envelope(adapter))
        _reply_path, intent_id = draft_cli_fixture(script, root, comment)
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "batch_confirm", "--session-id", SESSION_ID, "--write",
        )
        action = prepare_action(script, root, intent_id)
        adapter.fill_composer(action["reply_text"])
        begin_browser_send(script, root, action, adapter)
        adapter.click_submit("verified")
        current = intent_state(root, intent_id)
        adapter.hide_submit_control()
        receipt = result_for(
            action, adapter, current["attempt"]["browser_preflight_id"],
        )
        source = root / "contradictory-result.json"
        write_json(source, provenance_envelope(
            root, intent_id, "browser-finish", receipt,
        ))
        completed = run_cli(
            script, root, "browser-finish", str(source), "--intent-id", intent_id,
            "--session-id", SESSION_ID, "--write",
        )
        capture_receipt_commit(root, intent_id, completed.stdout)
        assert_status(root, intent_id, "needs_reconcile")


def run_reinspection_lifecycle(*, found: bool) -> None:
    adapter = LocalFixtureCommentAdapter("threads")
    with tempfile.TemporaryDirectory(prefix="social-reinspection-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
        comment = ingest_browser_scan(script, root, scan_envelope(adapter))
        _reply_path, intent_id = draft_cli_fixture(script, root, comment)
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "batch_confirm", "--session-id", SESSION_ID, "--write",
        )
        action = prepare_action(script, root, intent_id)
        adapter.fill_composer(action["reply_text"])
        begin_browser_send(script, root, action, adapter)
        adapter.click_submit("ambiguous")
        finish_browser_send(script, root, action, adapter)
        current = intent_state(root, intent_id)
        receipt = reinspection_for(
            action, current["attempt"], found=found,
        )
        source = root / "browser-reinspection.json"
        write_json(source, provenance_envelope(
            root, intent_id, "browser-reconcile", receipt,
        ))
        completed = run_cli(
            script, root, "browser-reconcile", str(source), "--intent-id", intent_id,
            "--session-id", SESSION_ID, "--write",
        )
        capture_receipt_commit(root, intent_id, completed.stdout)
        assert_status(
            root, intent_id, "reconciled_sent" if found else "reconciled_not_sent",
        )


def check_reinspection_own_reply_count_guards() -> None:
    adapter = LocalFixtureCommentAdapter("threads")
    with tempfile.TemporaryDirectory(prefix="social-reinspection-count-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
        comment = ingest_browser_scan(script, root, scan_envelope(adapter))
        reply_path, intent_id = draft_cli_fixture(script, root, comment)
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "batch_confirm", "--session-id", SESSION_ID, "--write",
        )
        action = prepare_action(script, root, intent_id)
        adapter.fill_composer(action["reply_text"])
        begin_browser_send(script, root, action, adapter)
        adapter.click_submit("ambiguous")
        finish_browser_send(script, root, action, adapter)
        current = intent_state(root, intent_id)
        base = reinspection_for(action, current["attempt"], found=False)
        source = root / "browser-reinspection-count.json"

        missing_count = dict(base)
        missing_count.pop("own_author_reply_count")
        before = reply_path.read_text(encoding="utf-8")
        run_browser_reconcile(
            script, root, source, intent_id, missing_count, expected=2,
        )
        assert_ledger_unchanged(
            reply_path, before, "missing own reply count mutated the ledger",
        )

        missing_total = dict(base)
        missing_total.pop("reinspection_total_reply_count")
        run_browser_reconcile(
            script, root, source, intent_id, missing_total, expected=2,
        )
        assert_ledger_unchanged(
            reply_path, before, "missing reinspection total count mutated the ledger",
        )

        _check_contradictory_reinspection_presence(
            script, root, source, intent_id, reply_path, before, base,
        )

        forged_absence = dict(
            base, own_author_reply_count=1, reinspection_total_reply_count=1,
        )
        run_browser_reconcile(
            script, root, source, intent_id, forged_absence, expected=2,
        )
        assert_ledger_unchanged(
            reply_path, before, "forged absence with an own reply mutated the ledger",
        )

        nonexact_own_reply = dict(
            base, own_author_reply_count=1, reinspection_total_reply_count=1,
            absence_verified=False,
        )
        uncertain = run_browser_reconcile(
            script, root, source, intent_id, nonexact_own_reply,
        )
        committed = [
            line for line in uncertain.stdout.splitlines()
            if line.startswith("RECEIPT_COMMIT ")
        ]
        if len(committed) != 1 or '"outcome":"unknown"' not in committed[0]:
            raise AssertionError("nonexact own reply did not remain uncertain")
        if reply_path.read_text(encoding="utf-8") == before:
            raise AssertionError("uncertain nonexact own reply did not consume capability")
        assert_status(root, intent_id, "needs_reconcile")

        before = reply_path.read_text(encoding="utf-8")
        run_browser_reconcile(script, root, source, intent_id, base)
        assert_status(root, intent_id, "reconciled_not_sent")


def check_reinspection_total_count_regression() -> None:
    adapter = LocalFixtureCommentAdapter("threads")
    with tempfile.TemporaryDirectory(prefix="social-reinspection-virtualized-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
        comment = ingest_browser_scan(script, root, scan_envelope(adapter))
        reply_path, intent_id = draft_cli_fixture(script, root, comment)
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "batch_confirm", "--session-id", SESSION_ID, "--write",
        )
        action = prepare_action(script, root, intent_id)
        adapter.show_own_reply("先前不同的回覆")
        adapter.fill_composer(action["reply_text"])
        begin_browser_send(script, root, action, adapter)
        adapter.click_submit("ambiguous")
        finish_browser_send(script, root, action, adapter)
        current = intent_state(root, intent_id)
        if current["attempt"].get("browser_baseline_total_reply_count") != 1:
            raise AssertionError("send attempt did not preserve the preparation reply baseline")
        source = root / "browser-reinspection-virtualized.json"
        regressed = reinspection_for(action, current["attempt"], found=False)
        regressed["absence_verified"] = False
        write_json(source, provenance_envelope(
            root, intent_id, "browser-reconcile", regressed,
        ))
        before = reply_path.read_text(encoding="utf-8")
        uncertain = run_cli(
            script, root, "browser-reconcile", str(source),
            "--intent-id", intent_id, "--session-id", SESSION_ID, "--write",
        )
        committed = capture_receipt_commit(root, intent_id, uncertain.stdout)
        if committed["outcome"] != "unknown":
            raise AssertionError("reply-count regression did not remain uncertain")
        if reply_path.read_text(encoding="utf-8") == before:
            raise AssertionError("uncertain reinspection did not consume its capability")
        assert_status(root, intent_id, "needs_reconcile")

        forged_absence = dict(regressed, absence_verified=True)
        after_unknown = reply_path.read_text(encoding="utf-8")
        write_json(source, provenance_envelope(
            root, intent_id, "browser-reconcile", forged_absence,
        ))
        run_cli(
            script, root, "browser-reconcile", str(source),
            "--intent-id", intent_id, "--session-id", SESSION_ID,
            "--write", expected=2,
        )
        if reply_path.read_text(encoding="utf-8") != after_unknown:
            raise AssertionError("forged absence after reply-count regression mutated the ledger")


def check_equal_total_exact_remains_uncertain() -> None:
    adapter = LocalFixtureCommentAdapter("instagram")
    with tempfile.TemporaryDirectory(prefix="social-equal-total-exact-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
        comment = ingest_browser_scan(script, root, scan_envelope(adapter))
        reply_path, intent_id = draft_cli_fixture(script, root, comment)
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "batch_confirm", "--session-id", SESSION_ID, "--write",
        )
        action = prepare_action(script, root, intent_id)
        adapter.show_own_reply("先前不同的回覆")
        adapter.fill_composer(action["reply_text"])
        begin_browser_send(script, root, action, adapter)
        adapter.click_submit("ambiguous")
        adapter.visible_own_replies[:] = [action["reply_text"]]
        finish_browser_send(script, root, action, adapter)
        assert_status(root, intent_id, "needs_reconcile")
        current = intent_state(root, intent_id)
        if current["attempt"].get("browser_baseline_total_reply_count") != 1:
            raise AssertionError("equal-total fixture lost its preparation baseline")

        receipt = reinspection_for(action, current["attempt"], found=True)
        source = root / "browser-reinspection-equal-total.json"
        write_json(source, provenance_envelope(
            root, intent_id, "browser-reconcile", receipt,
        ))
        before = reply_path.read_text(encoding="utf-8")
        uncertain = run_cli(
            script, root, "browser-reconcile", str(source),
            "--intent-id", intent_id, "--session-id", SESSION_ID, "--write",
        )
        committed = capture_receipt_commit(root, intent_id, uncertain.stdout)
        if committed["outcome"] != "unknown":
            raise AssertionError("equal-total exact reinspection did not remain uncertain")
        if reply_path.read_text(encoding="utf-8") == before:
            raise AssertionError("equal-total reinspection did not consume its capability")
        assert_status(root, intent_id, "needs_reconcile")


def check_live_legacy_bridge_gate() -> None:
    script = ROOT / "scripts" / "comment_assistant.py"
    cases = (
        ("begin-send",),
        ("finish-send", "--result", "sent", "--evidence", "unused"),
        ("reconcile", "--result", "sent", "--evidence", "unused"),
    )
    for case in cases:
        command, *extra = case
        completed = run_cli(
            script, ROOT, command, "--intent-id", "unused-intent",
            "--session-id", "unused-session", *extra, expected=2,
        )
        if "disabled on the live skill ledger" not in completed.stderr:
            raise AssertionError(f"{command} did not explain the live bridge requirement")


def run_browser_send_contract_tests() -> None:
    for platform in ("facebook", "instagram", "threads"):
        run_contract_lifecycle(platform, verified=True)
    run_contract_lifecycle("threads", verified=False)
    check_preflight_guards()
    check_result_guards()
    run_truth_table_guard()
    run_reinspection_lifecycle(found=True)
    run_reinspection_lifecycle(found=False)
    check_reinspection_own_reply_count_guards()
    check_reinspection_total_count_regression()
    check_equal_total_exact_remains_uncertain()
    check_live_legacy_bridge_gate()

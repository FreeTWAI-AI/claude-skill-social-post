#!/usr/bin/env python3
"""End-to-end tests for structured Chrome scan, preflight, and receipt commands."""

from __future__ import annotations

import json
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from comment_state import validate_comment_store
from comment_store import load_comment_records
from comment_test_browser_adapter import LocalFixtureCommentAdapter, REPLY_TEXT
from comment_test_browser_regressions import run_browser_regression_tests
from comment_test_cli import draft_cli_fixture, prepare_cli_fixture, run_cli
from comment_test_support import POLICY, ROOT


PLATFORM_URLS = {
    "facebook": "https://www.facebook.com/test/posts/post-facebook",
    "instagram": "https://www.instagram.com/p/post-instagram",
    "threads": "https://www.threads.com/@test/post/post-threads",
}
SESSION_ID = "session-cli"


def now_iso(offset_seconds: int = 0) -> str:
    return (
        datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)
    ).isoformat(timespec="seconds")


def scan_envelope(adapter: LocalFixtureCommentAdapter) -> dict:
    comment = adapter.scan()
    platform = adapter.spec.platform
    page_url = PLATFORM_URLS[platform]
    comment.update({
        "post_permalink": page_url,
        "comment_permalink": f"{page_url}/comment/{comment['platform_comment_id']}",
        "observed_parent_post_permalink": page_url,
        "observed_at": now_iso(),
    })
    return {
        "schema_version": 1,
        "platform": platform,
        "account_key": comment["account_key"],
        "post_key": comment["post_key"],
        "post_permalink": page_url,
        "observed_url": page_url,
        "observed_at": comment["observed_at"],
        "authentication_state": "authenticated",
        "account_verified": True,
        "post_verified": True,
        "comments": [comment],
    }


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def create_scan_request(script: Path, root: Path, envelope: dict) -> dict:
    request_path = root / "data" / "browser_scan_requests.jsonl"
    request_path.touch(exist_ok=True)
    before = request_path.read_text(encoding="utf-8").splitlines()
    scan_session_id = f"{SESSION_ID}-scan-{len(before) + 1}"
    args = (
        "browser-scan-request", "--platform", envelope["platform"],
        "--account-key", envelope["account_key"], "--post-key", envelope["post_key"],
        "--post-permalink", envelope["post_permalink"], "--session-id", scan_session_id,
        "--ttl-minutes", "5",
    )
    dry = run_cli(script, root, *args)
    after_dry = request_path.read_text(encoding="utf-8").splitlines()
    if "DRY_RUN valid" not in dry.stdout or after_dry != before:
        raise AssertionError("scan request dry-run mutated its ledger")
    run_cli(script, root, *args, "--write")
    rows = request_path.read_text(encoding="utf-8").splitlines()
    if len(rows) != len(before) + 1:
        raise AssertionError("browser-scan-request did not append exactly one request")
    return json.loads(rows[-1])


def bind_scan_request(envelope: dict, request: dict) -> dict:
    bound = json.loads(json.dumps(envelope))
    observed_at = now_iso()
    bound["scan_request_id"] = request["scan_request_id"]
    bound["session_id"] = request["session_id"]
    bound["observed_at"] = observed_at
    for comment in bound["comments"]:
        comment["observed_parent_post_permalink"] = bound["post_permalink"]
        comment["observed_at"] = observed_at
    return bound


def browser_scan_args(request: dict) -> tuple[str, ...]:
    return (
        "--scan-request-id", request["scan_request_id"],
        "--session-id", request["session_id"],
    )


def ingest_browser_scan(script: Path, root: Path, envelope: dict) -> dict:
    request = create_scan_request(script, root, envelope)
    envelope = bind_scan_request(envelope, request)
    source = root / "browser-scan.json"
    write_json(source, envelope)
    scan_args = browser_scan_args(request)
    dry = run_cli(script, root, "browser-scan", str(source), *scan_args)
    comment_path = root / "data" / "comment_events.jsonl"
    if "DRY_RUN valid" not in dry.stdout or comment_path.read_text(encoding="utf-8"):
        raise AssertionError("browser-scan dry-run mutated the ledger")
    run_cli(script, root, "browser-scan", str(source), *scan_args, "--write")
    rows = comment_path.read_text(encoding="utf-8").splitlines()
    if len(rows) != 1:
        raise AssertionError("browser-scan did not append exactly one observation")
    return json.loads(rows[0])


def prepare_action(script: Path, root: Path, intent_id: str) -> dict:
    completed = run_cli(
        script, root, "browser-action", "--intent-id", intent_id,
        "--session-id", "session-cli",
    )
    action = json.loads(completed.stdout)
    if action["reply_text"] != REPLY_TEXT or action["intent_id"] != intent_id:
        raise AssertionError("browser-action returned the wrong approved intent")
    return action


def preflight_for(
    action: dict, adapter: LocalFixtureCommentAdapter,
    *, observed_at: str | None = None,
) -> dict:
    return adapter.preflight_receipt(action, observed_at or now_iso())


def begin_browser_send(
    script: Path, root: Path, action: dict, adapter: LocalFixtureCommentAdapter,
) -> None:
    source = root / "browser-preflight.json"
    write_json(source, preflight_for(action, adapter))
    run_cli(
        script, root, "browser-begin", str(source),
        "--intent-id", action["intent_id"], "--session-id", "session-cli", "--write",
    )


def result_for(
    action: dict, adapter: LocalFixtureCommentAdapter, preflight_id: str,
) -> dict:
    return adapter.result_receipt(action, preflight_id, now_iso())


def finish_browser_send(
    script: Path, root: Path, action: dict, adapter: LocalFixtureCommentAdapter,
) -> None:
    source = root / "browser-result.json"
    records = load_comment_records(root / "data")
    replay = validate_comment_store(records["comments"], records["replies"], POLICY)
    current = next(
        row for row in replay["reply_states"].values()
        if row.get("intent_id") == action["intent_id"]
    )
    receipt = result_for(
        action, adapter, current["attempt"]["browser_preflight_id"],
    )
    write_json(source, receipt)
    run_cli(
        script, root, "browser-finish", str(source),
        "--intent-id", action["intent_id"], "--session-id", "session-cli", "--write",
    )


def assert_status(root: Path, intent_id: str, expected: str) -> None:
    records = load_comment_records(root / "data")
    result = validate_comment_store(records["comments"], records["replies"], POLICY)
    if not result["valid"]:
        raise AssertionError(result["errors"])
    state = next(
        row for row in result["reply_states"].values() if row.get("intent_id") == intent_id
    )
    if state["status"] != expected:
        raise AssertionError(f"expected {expected}, found {state['status']}")


def intent_state(root: Path, intent_id: str) -> dict:
    records = load_comment_records(root / "data")
    result = validate_comment_store(records["comments"], records["replies"], POLICY)
    if not result["valid"]:
        raise AssertionError(result["errors"])
    return next(
        row for row in result["reply_states"].values()
        if row.get("intent_id") == intent_id
    )


def run_contract_lifecycle(platform: str, *, verified: bool) -> None:
    adapter = LocalFixtureCommentAdapter(platform)
    with tempfile.TemporaryDirectory(prefix=f"social-{platform}-contract-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root)
        comment = ingest_browser_scan(script, root, scan_envelope(adapter))
        _reply_path, intent_id = draft_cli_fixture(script, root, comment)
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "batch_confirm", "--session-id", "session-cli", "--write",
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
        script, _unused = prepare_cli_fixture(root)
        comment = ingest_browser_scan(script, root, scan_envelope(adapter))
        reply_path, intent_id = draft_cli_fixture(script, root, comment)
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "batch_confirm", "--session-id", "session-cli", "--write",
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
            "--session-id", "session-cli", "--write", expected=2,
        )
        if reply_path.read_text(encoding="utf-8") != before:
            raise AssertionError("invalid preflight mutated the ledger")
        stale = preflight_for(action, adapter, observed_at=now_iso(-120))
        write_json(source, stale)
        run_cli(
            script, root, "browser-begin", str(source), "--intent-id", intent_id,
            "--session-id", "session-cli", "--write", expected=2,
        )
        if reply_path.read_text(encoding="utf-8") != before:
            raise AssertionError("invalid preflight mutated the ledger")
        wrong_post = preflight_for(action, adapter)
        wrong_post["observed_url"] = "https://www.facebook.com/test/posts/other-post"
        write_json(source, wrong_post)
        run_cli(
            script, root, "browser-begin", str(source), "--intent-id", intent_id,
            "--session-id", "session-cli", "--write", expected=2,
        )
        wrong_schema = preflight_for(action, adapter)
        wrong_schema["schema_version"] = True
        write_json(source, wrong_schema)
        run_cli(
            script, root, "browser-begin", str(source), "--intent-id", intent_id,
            "--session-id", "session-cli", "--write", expected=2,
        )
        if reply_path.read_text(encoding="utf-8") != before:
            raise AssertionError("invalid preflight mutated the ledger")


def check_scan_guards() -> None:
    adapter = LocalFixtureCommentAdapter("facebook")
    with tempfile.TemporaryDirectory(prefix="social-scan-guards-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root)
        source = root / "bad-scan.json"
        comment_path = root / "data" / "comment_events.jsonl"
        for case in ("schema", "stale", "comment-time", "post"):
            envelope = scan_envelope(adapter)
            request = create_scan_request(script, root, envelope)
            payload = bind_scan_request(envelope, request)
            if case == "schema":
                payload["schema_version"] = True
            elif case == "stale":
                payload["observed_at"] = now_iso(-400)
                payload["comments"][0]["observed_at"] = payload["observed_at"]
            elif case == "comment-time":
                payload["comments"][0]["observed_at"] = now_iso(-10)
            else:
                payload["observed_url"] = "https://www.facebook.com/test/posts/other-post"
            write_json(source, payload)
            run_cli(
                script, root, "browser-scan", str(source),
                *browser_scan_args(request), "--write", expected=2,
            )
        if comment_path.read_text(encoding="utf-8"):
            raise AssertionError("invalid browser scan mutated the ledger")


def check_result_guards() -> None:
    adapter = LocalFixtureCommentAdapter("instagram")
    with tempfile.TemporaryDirectory(prefix="social-result-guards-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root)
        comment = ingest_browser_scan(script, root, scan_envelope(adapter))
        reply_path, intent_id = draft_cli_fixture(script, root, comment)
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "batch_confirm", "--session-id", "session-cli", "--write",
        )
        action = prepare_action(script, root, intent_id)
        adapter.fill_composer(action["reply_text"])
        begin_browser_send(script, root, action, adapter)
        adapter.click_submit("verified")
        current = intent_state(root, intent_id)
        receipt = result_for(
            action, adapter, current["attempt"]["browser_preflight_id"],
        )
        before = reply_path.read_text(encoding="utf-8")
        source = root / "bad-result.json"
        bad_action = dict(receipt, action_id="wrong-action")
        write_json(source, bad_action)
        run_cli(
            script, root, "browser-finish", str(source), "--intent-id", intent_id,
            "--session-id", "session-cli", "--write", expected=2,
        )
        stale = dict(receipt, observed_at=now_iso(-400))
        write_json(source, stale)
        run_cli(
            script, root, "browser-finish", str(source), "--intent-id", intent_id,
            "--session-id", "session-cli", "--write", expected=2,
        )
        predates_attempt = dict(receipt, observed_at=now_iso(-30))
        write_json(source, predates_attempt)
        run_cli(
            script, root, "browser-finish", str(source), "--intent-id", intent_id,
            "--session-id", "session-cli", "--write", expected=2,
        )
        wrong_schema = dict(receipt, schema_version=1.0)
        write_json(source, wrong_schema)
        run_cli(
            script, root, "browser-finish", str(source), "--intent-id", intent_id,
            "--session-id", "session-cli", "--write", expected=2,
        )
        if reply_path.read_text(encoding="utf-8") != before:
            raise AssertionError("invalid browser result mutated the ledger")


def run_truth_table_guard() -> None:
    adapter = LocalFixtureCommentAdapter("instagram")
    with tempfile.TemporaryDirectory(prefix="social-result-truth-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root)
        comment = ingest_browser_scan(script, root, scan_envelope(adapter))
        _reply_path, intent_id = draft_cli_fixture(script, root, comment)
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "batch_confirm", "--session-id", "session-cli", "--write",
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
        write_json(source, receipt)
        run_cli(
            script, root, "browser-finish", str(source), "--intent-id", intent_id,
            "--session-id", "session-cli", "--write",
        )
        assert_status(root, intent_id, "needs_reconcile")


def reinspection_for(action: dict, preflight_id: str, *, found: bool) -> dict:
    return {
        "schema_version": 1,
        "action_id": action["action_id"],
        "preflight_id": preflight_id,
        "intent_id": action["intent_id"],
        "session_id": "session-reinspect",
        "attempt_session_id": action["session_id"],
        "scope": action["scope"],
        "comment_fingerprint": action["comment_fingerprint"],
        "reply_hash": action["reply_hash"],
        "observed_url": action["post_permalink"],
        "observed_at": now_iso(),
        "account_verified": True,
        "post_verified": True,
        "target_verified": True,
        "parent_verified": True,
        "exact_reply_visible": found,
        "own_author_verified": found,
        "absence_verified": not found,
        "evidence": "fixture browser reinspection completed",
    }


def run_reinspection_lifecycle(*, found: bool) -> None:
    adapter = LocalFixtureCommentAdapter("threads")
    with tempfile.TemporaryDirectory(prefix="social-reinspection-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root)
        comment = ingest_browser_scan(script, root, scan_envelope(adapter))
        _reply_path, intent_id = draft_cli_fixture(script, root, comment)
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "batch_confirm", "--session-id", "session-cli", "--write",
        )
        action = prepare_action(script, root, intent_id)
        adapter.fill_composer(action["reply_text"])
        begin_browser_send(script, root, action, adapter)
        adapter.click_submit("ambiguous")
        finish_browser_send(script, root, action, adapter)
        current = intent_state(root, intent_id)
        receipt = reinspection_for(
            action, current["attempt"]["browser_preflight_id"], found=found,
        )
        source = root / "browser-reinspection.json"
        write_json(source, receipt)
        run_cli(
            script, root, "browser-reconcile", str(source), "--intent-id", intent_id,
            "--session-id", "session-reinspect", "--write",
        )
        assert_status(
            root, intent_id, "reconciled_sent" if found else "reconciled_not_sent",
        )


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


def run_browser_contract_tests() -> None:
    for platform in ("facebook", "instagram", "threads"):
        run_contract_lifecycle(platform, verified=True)
    run_contract_lifecycle("threads", verified=False)
    check_scan_guards()
    check_preflight_guards()
    check_result_guards()
    run_truth_table_guard()
    run_reinspection_lifecycle(found=True)
    run_reinspection_lifecycle(found=False)
    check_live_legacy_bridge_gate()
    run_browser_regression_tests()

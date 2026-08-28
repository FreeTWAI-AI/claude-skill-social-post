#!/usr/bin/env python3
"""Default-deny policy tests for every live Chrome ledger mutation boundary."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from comment_test_browser_adapter import LocalFixtureCommentAdapter
from comment_test_browser_contract_support import (
    SESSION_ID,
    begin_browser_send,
    bind_scan_request,
    browser_scan_args,
    create_scan_request,
    finish_browser_send,
    ingest_browser_scan,
    intent_state,
    preflight_for,
    prepare_action,
    reinspection_for,
    result_for,
    scan_envelope,
    write_json,
)
from comment_test_cli import draft_cli_fixture, prepare_cli_fixture, run_cli


LEDGER_PATHS = (
    "data/comment_events.jsonl",
    "data/reply_events.jsonl",
    "data/browser_scan_requests.jsonl",
)
DISABLED_ERROR = "live browser ledger mutation is disabled by policy"


def _ledger_snapshot(root: Path) -> dict[str, bytes]:
    return {
        relative: (root / relative).read_bytes()
        for relative in LEDGER_PATHS
    }


def _set_live_gate(root: Path, enabled: bool) -> None:
    path = root / "references" / "comment-policy.json"
    policy = json.loads(path.read_text(encoding="utf-8"))
    policy["live_browser_actuation_enabled"] = enabled
    path.write_text(json.dumps(policy), encoding="utf-8")


def _assert_write_denied_without_mutation(
    script: Path, root: Path, *args: str,
) -> None:
    before = _ledger_snapshot(root)
    rejected = run_cli(script, root, *args, "--write", expected=2)
    if DISABLED_ERROR not in rejected.stderr:
        raise AssertionError(f"live mutation gate gave the wrong error: {rejected.stderr}")
    if _ledger_snapshot(root) != before:
        raise AssertionError(f"disabled live command mutated a ledger: {args}")


def _approved_fixture(root: Path, platform: str) -> tuple[Path, LocalFixtureCommentAdapter, dict]:
    script, _unused = prepare_cli_fixture(
        root, live_browser_actuation_enabled=True,
    )
    adapter = LocalFixtureCommentAdapter(platform)
    comment = ingest_browser_scan(script, root, scan_envelope(adapter))
    _reply_path, intent_id = draft_cli_fixture(script, root, comment)
    run_cli(
        script, root, "approve", "--intent-id", intent_id,
        "--approval-mode", "batch_confirm", "--session-id", SESSION_ID, "--write",
    )
    action = prepare_action(script, root, intent_id)
    adapter.fill_composer(action["reply_text"])
    return script, adapter, action


def check_browser_scan_default_denied() -> None:
    with tempfile.TemporaryDirectory(prefix="social-browser-scan-disabled-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root)
        envelope = scan_envelope(LocalFixtureCommentAdapter("instagram"))
        request = create_scan_request(script, root, envelope)
        envelope = bind_scan_request(envelope, request)
        source = root / "browser-scan-disabled.json"
        write_json(source, envelope)
        args = ("browser-scan", str(source), *browser_scan_args(request))
        preview = run_cli(script, root, *args)
        if "DRY_RUN valid" not in preview.stdout:
            raise AssertionError("disabled live scan was not available as a safe preview")
        _assert_write_denied_without_mutation(script, root, *args)


def check_browser_begin_default_denied() -> None:
    with tempfile.TemporaryDirectory(prefix="social-browser-begin-disabled-") as raw:
        root = Path(raw)
        script, adapter, action = _approved_fixture(root, "facebook")
        source = root / "browser-begin-disabled.json"
        write_json(source, preflight_for(action, adapter))
        args = (
            "browser-begin", str(source), "--intent-id", action["intent_id"],
            "--session-id", SESSION_ID,
        )
        if "DRY_RUN valid" not in run_cli(script, root, *args).stdout:
            raise AssertionError("disabled browser-begin was not available as a safe preview")
        _set_live_gate(root, False)
        _assert_write_denied_without_mutation(script, root, *args)


def check_browser_finish_default_denied() -> None:
    with tempfile.TemporaryDirectory(prefix="social-browser-finish-disabled-") as raw:
        root = Path(raw)
        script, adapter, action = _approved_fixture(root, "instagram")
        begin_browser_send(script, root, action, adapter)
        adapter.click_submit("verified")
        current = intent_state(root, action["intent_id"])
        source = root / "browser-finish-disabled.json"
        write_json(
            source,
            result_for(action, adapter, current["attempt"]["browser_preflight_id"]),
        )
        args = (
            "browser-finish", str(source), "--intent-id", action["intent_id"],
            "--session-id", SESSION_ID,
        )
        if "DRY_RUN valid" not in run_cli(script, root, *args).stdout:
            raise AssertionError("disabled browser-finish was not available as a safe preview")
        _set_live_gate(root, False)
        _assert_write_denied_without_mutation(script, root, *args)


def check_browser_reconcile_default_denied() -> None:
    with tempfile.TemporaryDirectory(prefix="social-browser-reconcile-disabled-") as raw:
        root = Path(raw)
        script, adapter, action = _approved_fixture(root, "threads")
        begin_browser_send(script, root, action, adapter)
        adapter.click_submit("ambiguous")
        finish_browser_send(script, root, action, adapter)
        current = intent_state(root, action["intent_id"])
        source = root / "browser-reconcile-disabled.json"
        write_json(source, reinspection_for(action, current["attempt"], found=False))
        args = (
            "browser-reconcile", str(source), "--intent-id", action["intent_id"],
            "--session-id", "session-reinspect",
        )
        if "DRY_RUN valid" not in run_cli(script, root, *args).stdout:
            raise AssertionError("disabled browser-reconcile was not available as a safe preview")
        _set_live_gate(root, False)
        _assert_write_denied_without_mutation(script, root, *args)


def run_browser_policy_gate_tests() -> None:
    check_browser_scan_default_denied()
    check_browser_begin_default_denied()
    check_browser_finish_default_denied()
    check_browser_reconcile_default_denied()


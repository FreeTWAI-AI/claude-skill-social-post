#!/usr/bin/env python3
"""Scan-ledger and same-scope reconciliation browser contract tests."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from comment_browser_contract import replay_browser_scan_requests
from comment_test_browser_adapter import LocalFixtureCommentAdapter, REPLY_TEXT
from comment_test_cli import prepare_cli_fixture, run_cli
from comment_test_browser_contract_support import (
    SESSION_ID,
    assert_status,
    begin_browser_send,
    bind_scan_request,
    bound_preflight_for,
    browser_scan_args,
    create_scan_request,
    finish_browser_send,
    intent_state,
    now_iso,
    prepare_action,
    reinspection_for,
    scan_envelope,
    write_json,
)


def check_scan_guards() -> None:
    adapter = LocalFixtureCommentAdapter("facebook")
    with tempfile.TemporaryDirectory(prefix="social-scan-guards-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
        source = root / "bad-scan.json"
        comment_path = root / "data" / "comment_events.jsonl"
        for case in (
            "schema", "test-only", "stale", "comment-time", "post",
            "missing-expansion", "false-expansion",
        ):
            envelope = scan_envelope(adapter)
            request = create_scan_request(script, root, envelope)
            payload = bind_scan_request(envelope, request)
            if case == "schema":
                payload["schema_version"] = True
            elif case == "test-only":
                payload["test_only"] = True
            elif case == "stale":
                payload["observed_at"] = now_iso(-400)
                payload["comments"][0]["observed_at"] = payload["observed_at"]
            elif case == "comment-time":
                payload["comments"][0]["observed_at"] = now_iso(-10)
            elif case == "post":
                payload["observed_url"] = "https://www.facebook.com/test/posts/other-post"
            elif case == "missing-expansion":
                payload.pop("thread_expansion_evidence", None)
            else:
                payload["thread_expansion_evidence"] = {
                    "provided": False,
                    "comments_expanded": False,
                    "replies_expanded": False,
                    "evidence": "fixture deliberately did not expand the thread",
                }
            write_json(source, payload)
            run_cli(
                script, root, "browser-scan", str(source),
                *browser_scan_args(request), "--write", expected=2,
            )
        if comment_path.read_text(encoding="utf-8"):
            raise AssertionError("invalid browser scan mutated the ledger")


def check_scan_completion_events() -> None:
    adapter = LocalFixtureCommentAdapter("threads")
    with tempfile.TemporaryDirectory(prefix="social-scan-completion-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
        envelope = scan_envelope(adapter)
        request = create_scan_request(script, root, envelope)
        request_path = root / "data" / "browser_scan_requests.jsonl"
        pending_rows = [
            json.loads(row)
            for row in request_path.read_text(encoding="utf-8").splitlines()
        ]
        replayed, errors = replay_browser_scan_requests(pending_rows)
        if errors or replayed[request["scan_request_id"]]["execution_status"] != "pending":
            raise AssertionError("unexecuted browser scan request was not replayed as pending")

        zero_scan = bind_scan_request(envelope, request)
        zero_scan["comments"] = []
        source = root / "zero-browser-scan.json"
        write_json(source, zero_scan)
        before = request_path.read_text(encoding="utf-8")
        dry = run_cli(
            script, root, "browser-scan", str(source), *browser_scan_args(request),
        )
        if "DRY_RUN valid" not in dry.stdout or request_path.read_text(encoding="utf-8") != before:
            raise AssertionError("zero-result browser scan dry-run mutated completion ledger")
        run_cli(
            script, root, "browser-scan", str(source),
            *browser_scan_args(request), "--write",
        )
        rows = [
            json.loads(row)
            for row in request_path.read_text(encoding="utf-8").splitlines()
        ]
        if len(rows) != 2 or rows[-1].get("event_type") != "browser_scan_completed":
            raise AssertionError("browser scan did not append exactly one completion event")
        replayed, errors = replay_browser_scan_requests(rows)
        state = replayed[request["scan_request_id"]]
        completion = state["last_completion"]
        if errors or state["execution_status"] != "completed":
            raise AssertionError("completed browser scan was not distinguishable from pending")
        if completion["comment_count"] != 0 or completion["zero_result"] is not True:
            raise AssertionError("zero-result scan completion lost its result cardinality")
        if completion["thread_expansion_evidence"]["provided"] is not True:
            raise AssertionError("scan completion lost thread-expansion evidence")

        repeated = run_cli(
            script, root, "browser-scan", str(source),
            *browser_scan_args(request), "--write",
        )
        repeated_rows = request_path.read_text(encoding="utf-8").splitlines()
        if len(repeated_rows) != 2 or '"completion_status": "unchanged"' not in repeated.stdout:
            raise AssertionError("identical scan completion was not idempotent")

        invalid = json.loads(json.dumps(rows))
        invalid[-1]["comment_count"] = 1
        _replayed, invalid_errors = replay_browser_scan_requests(invalid)
        if not any("zero_result disagrees" in error for error in invalid_errors):
            raise AssertionError("scan completion replay accepted inconsistent zero-result evidence")

        incomplete = json.loads(json.dumps(rows))
        incomplete[-1]["thread_expansion_evidence"] = {
            "provided": False,
            "comments_expanded": False,
            "replies_expanded": False,
            "evidence": "fixture incomplete expansion",
        }
        _replayed, incomplete_errors = replay_browser_scan_requests(incomplete)
        if not any("requires verified complete" in error for error in incomplete_errors):
            raise AssertionError("scan completion replay accepted incomplete expansion evidence")


def _setup_scope_lock_comments(
    script: Path, root: Path, adapter: LocalFixtureCommentAdapter,
) -> list[dict]:
    envelope = scan_envelope(adapter)
    second = json.loads(json.dumps(envelope["comments"][0]))
    second["platform_comment_id"] += "-second"
    second["comment_permalink"] = (
        f"{envelope['post_permalink']}/comment/{second['platform_comment_id']}"
    )
    envelope["comments"].append(second)
    request = create_scan_request(script, root, envelope)
    source = root / "two-comment-scan.json"
    write_json(source, bind_scan_request(envelope, request))
    run_cli(
        script, root, "browser-scan", str(source),
        *browser_scan_args(request), "--write",
    )
    comments = [
        json.loads(row)
        for row in (root / "data" / "comment_events.jsonl").read_text(
            encoding="utf-8"
        ).splitlines()
    ]
    if len(comments) != 2:
        raise AssertionError("scope lock fixture did not ingest two comments")
    return comments


def _setup_scope_lock_intents(
    script: Path, root: Path, comments: list[dict],
) -> list[str]:
    intent_ids: list[str] = []
    reply_path = root / "data" / "reply_events.jsonl"
    for comment in comments:
        run_cli(
            script, root, "draft", "--comment-key", comment["comment_key"],
            "--session-id", SESSION_ID, "--text", REPLY_TEXT,
            "--classification", "positive_reaction", "--risk", "low",
            "--confidence", "0.99", "--language", "zh-Hant", "--write",
        )
        reply_rows = [
            json.loads(row)
            for row in reply_path.read_text(encoding="utf-8").splitlines()
        ]
        intent_ids.append(reply_rows[-1]["intent_id"])
    approve_args: list[str] = ["approve"]
    for intent_id in intent_ids:
        approve_args.extend(("--intent-id", intent_id))
    approve_args.extend((
        "--approval-mode", "batch_confirm", "--session-id", SESSION_ID, "--write",
    ))
    run_cli(script, root, *approve_args)
    return intent_ids


def _setup_active_scope_reconciliation(
    script: Path, root: Path, adapter: LocalFixtureCommentAdapter,
    intent_ids: list[str],
) -> tuple[dict, dict]:
    first_action = prepare_action(script, root, intent_ids[0])
    second_action = prepare_action(script, root, intent_ids[1])
    adapter.fill_composer(first_action["reply_text"])
    begin_browser_send(script, root, first_action, adapter)
    adapter.click_submit("ambiguous")
    finish_browser_send(script, root, first_action, adapter)
    assert_status(root, intent_ids[0], "needs_reconcile")
    return first_action, second_action


def _assert_scope_reconciliation_blocks_followup(
    script: Path, root: Path, second_intent_id: str, second_action: dict,
) -> None:
    blocked_action = run_cli(
        script, root, "browser-action", "--intent-id", second_intent_id,
        "--session-id", SESSION_ID, expected=2,
    )
    if "halted by active needs_reconcile" not in blocked_action.stderr:
        raise AssertionError("browser-action was not blocked by same-scope reconciliation")
    blocked_preflight_path = root / "blocked-second-preflight.json"
    write_json(blocked_preflight_path, bound_preflight_for(second_action))
    blocked_begin = run_cli(
        script, root, "browser-begin", str(blocked_preflight_path),
        "--intent-id", second_intent_id, "--session-id", SESSION_ID,
        "--write", expected=2,
    )
    if "halted by active needs_reconcile" not in blocked_begin.stderr:
        raise AssertionError("browser-begin was not blocked by same-scope reconciliation")


def _reconcile_scope_as_not_sent(
    script: Path, root: Path, intent_id: str, action: dict,
) -> None:
    state = intent_state(root, intent_id)
    receipt = reinspection_for(
        action, state["attempt"], found=False,
    )
    source = root / "unlock-reinspection.json"
    write_json(source, receipt)
    run_cli(
        script, root, "browser-reconcile", str(source),
        "--intent-id", intent_id, "--session-id", "session-reinspect", "--write",
    )
    assert_status(root, intent_id, "reconciled_not_sent")


def _assert_scope_reconciliation_releases_followup(
    script: Path, root: Path, intent_id: str,
) -> None:
    action = prepare_action(script, root, intent_id)
    source = root / "unlocked-second-preflight.json"
    write_json(source, bound_preflight_for(action))
    run_cli(
        script, root, "browser-begin", str(source),
        "--intent-id", intent_id, "--session-id", SESSION_ID, "--write",
    )
    assert_status(root, intent_id, "send_started")


def check_scope_reconciliation_circuit_breaker() -> None:
    adapter = LocalFixtureCommentAdapter("facebook")
    with tempfile.TemporaryDirectory(prefix="social-scope-reconcile-lock-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
        comments = _setup_scope_lock_comments(script, root, adapter)
        intent_ids = _setup_scope_lock_intents(script, root, comments)
        first_action, second_action = _setup_active_scope_reconciliation(
            script, root, adapter, intent_ids,
        )
        _assert_scope_reconciliation_blocks_followup(
            script, root, intent_ids[1], second_action,
        )
        _reconcile_scope_as_not_sent(script, root, intent_ids[0], first_action)
        _assert_scope_reconciliation_releases_followup(script, root, intent_ids[1])


def run_browser_scan_contract_tests() -> None:
    check_scan_guards()
    check_scan_completion_events()
    check_scope_reconciliation_circuit_breaker()

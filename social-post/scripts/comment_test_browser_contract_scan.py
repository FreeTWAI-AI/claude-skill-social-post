#!/usr/bin/env python3
"""Scan-ledger and same-scope reconciliation browser contract tests."""

from __future__ import annotations

import json
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

from comment_browser_contract import replay_browser_scan_requests
from comment_scan_provenance import (
    ACTION_PROVENANCE_DIGEST_FIELD,
    DRAFT_PROVENANCE_DIGEST_FIELD,
    SCAN_PROVENANCE_DIGEST_FIELD,
    consume_scan_receipt_envelope,
)
from comment_test_browser_adapter import LocalFixtureCommentAdapter, REPLY_TEXT
from comment_test_cli import draft_cli_fixture, prepare_cli_fixture, run_cli
from comment_test_browser_contract_support import (
    SESSION_ID,
    add_scan_provenance_evidence,
    assert_status,
    begin_browser_send,
    bind_scan_request,
    bound_preflight_for,
    browser_scan_args,
    create_scan_request,
    capture_receipt_commit,
    finish_browser_send,
    ingest_browser_scan,
    intent_state,
    now_iso,
    prepare_action,
    provenance_envelope,
    reinspection_for,
    scan_envelope,
    scan_provenance_envelope,
    write_json,
    write_scan_json,
)


def _expect_scan_rejection(
    script: Path, root: Path, source: Path, request: dict, payload: dict,
    expected_message: str,
) -> None:
    write_json(source, payload)
    rejected = run_cli(
        script, root, "browser-scan", str(source), *browser_scan_args(request),
        "--write", expected=2,
    )
    if expected_message not in rejected.stderr:
        raise AssertionError(f"scan rejection missed {expected_message}: {rejected.stderr}")


def _assert_scan_expiry_boundary(envelope: dict, request: dict) -> None:
    expiry = datetime.fromisoformat(request["expires_at"])
    for label, expired_at in (
        ("exact expiry", expiry),
        ("after expiry", expiry + timedelta(seconds=1)),
    ):
        try:
            consume_scan_receipt_envelope(envelope, request, now=expired_at)
        except ValueError as exc:
            if "capability expired" not in str(exc):
                raise AssertionError(
                    f"{label} scan gave the wrong error: {exc}"
                ) from exc
        else:
            raise AssertionError(f"browser scan capability was accepted at {label}")


def _assert_scan_bearer_not_persisted(root: Path, envelope: dict) -> None:
    ledgers = "".join(
        (root / relative).read_text(encoding="utf-8")
        for relative in (
            "data/comment_events.jsonl", "data/reply_events.jsonl",
            "data/browser_scan_requests.jsonl",
        )
    )
    if '"nonce"' in ledgers or envelope["provenance"]["nonce"] in ledgers:
        raise AssertionError("browser scan bearer leaked into a canonical ledger")


def check_scan_one_shot_capability_boundary() -> None:
    adapter = LocalFixtureCommentAdapter("instagram")
    with tempfile.TemporaryDirectory(prefix="social-scan-capability-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
        receipt = scan_envelope(adapter)
        request = create_scan_request(script, root, receipt)
        receipt = bind_scan_request(receipt, request)
        source = root / "scan-capability.json"
        comment_path = root / "data" / "comment_events.jsonl"

        _expect_scan_rejection(
            script, root, source, request, receipt,
            "requires a one-shot provenance envelope",
        )
        envelope = scan_provenance_envelope(root, request, receipt)
        cases = (
            ("capability id", {
                **envelope,
                "provenance": {**envelope["provenance"], "capability_id": "f" * 32},
            }, "capability id was not issued"),
            ("nonce", {
                **envelope,
                "provenance": {**envelope["provenance"], "nonce": "z" * 43},
            }, "capability nonce is invalid"),
            ("request", {
                **envelope,
                "receipt": {**envelope["receipt"], "scan_request_id": "wrong-request"},
            }, "differs from its stored scan request"),
            ("session", {
                **envelope,
                "receipt": {**envelope["receipt"], "session_id": "wrong-session"},
            }, "session differs from its stored scan request"),
            ("scope", {
                **envelope,
                "receipt": {**envelope["receipt"], "account_key": "wrong-account"},
            }, "scope differs from its stored scan request"),
        )
        for _label, candidate, message in cases:
            _expect_scan_rejection(script, root, source, request, candidate, message)
        if comment_path.read_text(encoding="utf-8"):
            raise AssertionError("rejected scan capabilities mutated the comment ledger")

        _assert_scan_expiry_boundary(envelope, request)

        write_json(source, envelope)
        committed = run_cli(
            script, root, "browser-scan", str(source), *browser_scan_args(request),
            "--write",
        )
        if "SCAN_COMMIT " not in committed.stdout or "nonce" in committed.stdout:
            raise AssertionError("scan commit leaked bearer authority or omitted its receipt")
        _assert_scan_bearer_not_persisted(root, envelope)
        rows = [
            json.loads(row) for row in (
                root / "data" / "browser_scan_requests.jsonl"
            ).read_text(encoding="utf-8").splitlines()
        ]
        completion = rows[-1]
        for key in (
            "browser_scan_receipt_capability_id",
            "browser_scan_receipt_binding_digest",
            "browser_scan_receipt_digest",
        ):
            if not completion.get(key):
                raise AssertionError(f"scan completion lost nonce-free {key}")
        replay = run_cli(
            script, root, "browser-scan", str(source), *browser_scan_args(request),
            "--write", expected=2,
        )
        if "one-shot request already completed" not in replay.stderr:
            raise AssertionError("browser scan bearer replay did not fail closed")


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
            write_scan_json(root, source, request, payload)
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
        write_scan_json(root, source, request, zero_scan)
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
            *browser_scan_args(request), "--write", expected=2,
        )
        repeated_rows = request_path.read_text(encoding="utf-8").splitlines()
        if len(repeated_rows) != 2 or "one-shot request already completed" not in repeated.stderr:
            raise AssertionError("identical scan completion replay was not rejected")

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


def check_scan_provenance_carry_chain() -> None:
    adapter = LocalFixtureCommentAdapter("instagram")
    with tempfile.TemporaryDirectory(prefix="social-scan-provenance-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
        comment = ingest_browser_scan(script, root, scan_envelope(adapter))
        provenance = comment.get("scan_provenance")
        scan_digest = comment.get(SCAN_PROVENANCE_DIGEST_FIELD)
        if not isinstance(provenance, dict) or provenance.get("provenance_digest") != scan_digest:
            raise AssertionError("browser scan did not persist its provenance envelope")
        if (
            provenance.get("evidence_scope") != "scan_receipt_continuity_only"
            or provenance.get("capability_promotion_eligible") is not False
            or provenance.get("full_lifecycle_bound") is not False
        ):
            raise AssertionError("scan provenance overstated its evidence scope")
        for key in (
            "scan_request_id", "scan_id", "scan_receipt_digest", "adapter_id",
            "adapter_version", "mapping_digest", "exhaustion_digest",
            "reply_exhaustion_digest",
        ):
            if not provenance.get(key):
                raise AssertionError(f"scan provenance lost {key}")

        request_rows = [
            json.loads(row)
            for row in (root / "data" / "browser_scan_requests.jsonl").read_text(
                encoding="utf-8"
            ).splitlines()
        ]
        completion = request_rows[-1]
        if (
            completion.get("event_type") != "browser_scan_completed"
            or completion.get(SCAN_PROVENANCE_DIGEST_FIELD) != scan_digest
            or completion.get("scan_provenance") != provenance
        ):
            raise AssertionError("scan completion did not preserve scan provenance")

        _reply_path, intent_id = draft_cli_fixture(script, root, comment)
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "batch_confirm", "--session-id", SESSION_ID, "--write",
        )
        action = prepare_action(script, root, intent_id)
        if action.get(SCAN_PROVENANCE_DIGEST_FIELD) != scan_digest:
            raise AssertionError("browser action drifted from its scan provenance")
        for key in (DRAFT_PROVENANCE_DIGEST_FIELD, ACTION_PROVENANCE_DIGEST_FIELD):
            if not action.get(key):
                raise AssertionError(f"browser action lost {key}")

        adapter.fill_composer(action["reply_text"])
        claim = begin_browser_send(script, root, action, adapter)
        state = intent_state(root, intent_id)
        attempt = state["attempt"]
        for key in (
            SCAN_PROVENANCE_DIGEST_FIELD,
            DRAFT_PROVENANCE_DIGEST_FIELD,
            ACTION_PROVENANCE_DIGEST_FIELD,
        ):
            if claim.get(key) != action.get(key) or attempt.get(key) != action.get(key):
                raise AssertionError(f"claim/send_started drifted from action {key}")


def check_legacy_scan_cannot_mint_browser_action() -> None:
    adapter = LocalFixtureCommentAdapter("facebook")
    with tempfile.TemporaryDirectory(prefix="social-legacy-scan-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
        envelope = scan_envelope(adapter)
        request = create_scan_request(script, root, envelope)
        source = root / "legacy-browser-scan.json"
        write_scan_json(root, source, request, bind_scan_request(envelope, request))
        run_cli(
            script, root, "browser-scan", str(source),
            *browser_scan_args(request), "--write",
        )
        comment = json.loads(
            (root / "data" / "comment_events.jsonl").read_text(
                encoding="utf-8"
            ).splitlines()[0]
        )
        if comment.get("scan_provenance") is not None:
            raise AssertionError("legacy scan unexpectedly acquired provenance")
        _reply_path, intent_id = draft_cli_fixture(script, root, comment)
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "batch_confirm", "--session-id", SESSION_ID, "--write",
        )
        rejected = run_cli(
            script, root, "browser-action", "--intent-id", intent_id,
            "--session-id", SESSION_ID, expected=2,
        )
        if "requires a provenance-bound browser scan observation" not in rejected.stderr:
            raise AssertionError("legacy scan did not fail closed at browser-action")


def check_scan_provenance_evidence_tamper_guard() -> None:
    adapter = LocalFixtureCommentAdapter("threads")
    with tempfile.TemporaryDirectory(prefix="social-scan-provenance-tamper-") as raw:
        root = Path(raw)
        script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
        envelope = add_scan_provenance_evidence(scan_envelope(adapter))
        request = create_scan_request(script, root, envelope)
        payload = bind_scan_request(envelope, request)
        payload["stable_node_frame_mapping_evidence"]["adapter_version"] = "drifted"
        source = root / "tampered-browser-scan.json"
        write_scan_json(root, source, request, payload)
        rejected = run_cli(
            script, root, "browser-scan", str(source),
            *browser_scan_args(request), "--write", expected=2,
        )
        # `run_cli(..., expected=2)` already proves that the fused boundary
        # rejected the modified receipt.  Do not couple this test to whichever
        # integrity layer fires first (outer capability binding, receipt
        # digest, or the inner mapping attestation); the durable no-write check
        # below is the behavior that must remain invariant.
        if (root / "data" / "comment_events.jsonl").read_text(encoding="utf-8"):
            raise AssertionError("tampered provenance evidence mutated the comment ledger")


def _setup_scope_lock_comments(
    script: Path, root: Path, adapter: LocalFixtureCommentAdapter,
) -> list[dict]:
    envelope = scan_envelope(adapter)
    second = json.loads(json.dumps(envelope["comments"][0]))
    second["platform_comment_id"] += "-second"
    if envelope["platform"] == "threads":
        author = second.get("author_key") or second.get("author_display") or "fixture_author"
        second["comment_permalink"] = (
            f"https://www.threads.com/@{author}/post/{second['platform_comment_id']}"
        )
    else:
        second["comment_permalink"] = (
            f"{envelope['post_permalink']}/comment/{second['platform_comment_id']}"
        )
    envelope["comments"].append(second)
    envelope = add_scan_provenance_evidence(envelope)
    request = create_scan_request(script, root, envelope)
    source = root / "two-comment-scan.json"
    write_scan_json(root, source, request, bind_scan_request(envelope, request))
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
    write_json(source, provenance_envelope(
        root, intent_id, "browser-reconcile", receipt,
    ))
    completed = run_cli(
        script, root, "browser-reconcile", str(source),
        "--intent-id", intent_id, "--session-id", SESSION_ID, "--write",
    )
    capture_receipt_commit(root, intent_id, completed.stdout)
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
    check_scan_one_shot_capability_boundary()
    check_scan_guards()
    check_scan_completion_events()
    check_scan_provenance_carry_chain()
    check_legacy_scan_cannot_mint_browser_action()
    check_scan_provenance_evidence_tamper_guard()
    check_scope_reconciliation_circuit_breaker()

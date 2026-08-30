#!/usr/bin/env python3
"""Shared fixtures for structured Chrome scan and send contract tests."""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from comment_browser_common import _json_digest
from comment_scan_provenance import (
    ACTION_PROVENANCE_DIGEST_FIELD,
    DRAFT_PROVENANCE_DIGEST_FIELD,
    SCAN_PROVENANCE_DIGEST_FIELD,
)
from comment_state import validate_comment_store
from comment_store import load_comment_records
from comment_test_browser_adapter import LocalFixtureCommentAdapter, REPLY_TEXT
from comment_test_cli import draft_cli_fixture, prepare_cli_fixture, run_cli
from comment_test_support import POLICY


PLATFORM_URLS = {
    "facebook": "https://www.facebook.com/test/posts/post-facebook",
    "instagram": "https://www.instagram.com/p/post-instagram",
    "threads": "https://www.threads.com/@test/post/post-threads",
}
SESSION_ID = "session-cli"
PREPARATION_CORE_KEYS = (
    "action_digest", "plan_digest", "observed_url", "observed_at",
    "baseline_exact_reply_count", "baseline_total_reply_count", "test_only",
)
_RECEIPT_CAPABILITIES: dict[tuple[str, str, str], dict] = {}
_SCAN_CAPABILITIES: dict[tuple[str, str], dict] = {}


def _capability_key(root: Path, intent_id: str, operation: str) -> tuple[str, str, str]:
    return (str(root.resolve()), intent_id, operation)


def remember_receipt_capability(
    root: Path, intent_id: str, capability: dict,
) -> None:
    operation = str(capability.get("operation") or "")
    if operation not in {"browser-finish", "browser-reconcile"}:
        raise AssertionError("test bridge received an unsupported receipt capability")
    _RECEIPT_CAPABILITIES[_capability_key(root, intent_id, operation)] = capability


def provenance_envelope(
    root: Path, intent_id: str, operation: str, receipt: dict,
    *, capability: dict | None = None,
) -> dict:
    bearer = capability or _RECEIPT_CAPABILITIES.get(
        _capability_key(root, intent_id, operation)
    )
    if not isinstance(bearer, dict):
        raise AssertionError(f"test has no {operation} receipt capability for {intent_id}")
    return {"provenance": json.loads(json.dumps(bearer)), "receipt": receipt}


def scan_provenance_envelope(
    root: Path, request: dict, receipt: dict,
) -> dict:
    bearer = _SCAN_CAPABILITIES.get(
        (str(root.resolve()), str(request.get("scan_request_id") or ""))
    )
    if not isinstance(bearer, dict):
        raise AssertionError("test has no browser-scan receipt capability")
    return {
        "provenance": json.loads(json.dumps(bearer)),
        "receipt": json.loads(json.dumps(receipt)),
    }


def capture_receipt_commit(root: Path, intent_id: str, stdout: str) -> dict:
    lines = [
        line.removeprefix("RECEIPT_COMMIT ") for line in stdout.splitlines()
        if line.startswith("RECEIPT_COMMIT ")
    ]
    if len(lines) != 1:
        raise AssertionError("browser receipt command emitted no unique commit receipt")
    committed = json.loads(lines[0])
    next_capability = committed.get("next_capability")
    if next_capability is not None:
        remember_receipt_capability(root, intent_id, next_capability)
    return committed


def assert_ledger_unchanged(reply_path: Path, before: str, message: str) -> None:
    if reply_path.read_text(encoding="utf-8") != before:
        raise AssertionError(message)


def reject_browser_finish(
    script: Path, root: Path, source: Path, intent_id: str,
    receipt: dict[str, object],
) -> None:
    write_json(source, provenance_envelope(
        root, intent_id, "browser-finish", receipt,
    ))
    run_cli(
        script, root, "browser-finish", str(source), "--intent-id", intent_id,
        "--session-id", SESSION_ID, "--write", expected=2,
    )


def run_browser_reconcile(
    script: Path, root: Path, source: Path, intent_id: str,
    receipt: dict[str, object], *, expected: int = 0,
) -> subprocess.CompletedProcess[str]:
    write_json(source, provenance_envelope(
        root, intent_id, "browser-reconcile", receipt,
    ))
    completed = run_cli(
        script, root, "browser-reconcile", str(source), "--intent-id", intent_id,
        "--session-id", SESSION_ID, "--write", expected=expected,
    )
    if expected == 0:
        capture_receipt_commit(root, intent_id, completed.stdout)
    return completed


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
        "test_only": False,
        "platform": platform,
        "account_key": comment["account_key"],
        "post_key": comment["post_key"],
        "post_permalink": page_url,
        "observed_url": page_url,
        "observed_at": comment["observed_at"],
        "authentication_state": "authenticated",
        "account_verified": True,
        "post_verified": True,
        "thread_expansion_evidence": {
            "provided": True,
            "comments_expanded": True,
            "replies_expanded": True,
            "evidence": f"local {platform} fixture expanded visible comment threads",
        },
        "comments": [comment],
    }


def add_scan_provenance_evidence(envelope: dict) -> dict:
    """Attach integrity-checked, non-promotable evidence for Python contract tests."""
    result = json.loads(json.dumps(envelope))
    platform = result["platform"]
    adapter_id = f"offline-python-{platform}-scan-fixture"
    adapter_version = "1.0-test"
    comment_count = len(result["comments"])
    expansion_core = {
        "schema_version": 1,
        "test_only": result["test_only"],
        "platform": platform,
        "adapter_id": adapter_id,
        "adapter_version": adapter_version,
        "terminal_evidence": True,
        "terminal_discovered_count": comment_count,
        "evidence_scope": "offline_python_contract_fixture",
        "capability_promotion_eligible": False,
    }
    expansion = {
        **expansion_core,
        "attestation_id": _json_digest(expansion_core),
    }
    result["thread_expansion_evidence"]["adapter_attestation"] = expansion
    mapping_core = {
        "schema_version": 1,
        "test_only": result["test_only"],
        "platform": platform,
        "adapter_id": adapter_id,
        "adapter_version": adapter_version,
        "row_count": comment_count,
        "coverage": "offline_test_only_final_scan_comment_nodes",
        "full_lifecycle_bound": False,
        "reply_exhaustion_sha256": _json_digest({
            "platform": platform,
            "comment_count": comment_count,
            "terminal": True,
        }),
        "capability_promotion_eligible": False,
    }
    result["stable_node_frame_mapping_evidence"] = {
        **mapping_core,
        "mapping_attestation_id": _json_digest(mapping_core),
    }
    return result


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def write_scan_json(root: Path, path: Path, request: dict, receipt: dict) -> None:
    write_json(path, scan_provenance_envelope(root, request, receipt))


def create_scan_request(script: Path, root: Path, envelope: dict) -> dict:
    request_path = root / "data" / "browser_scan_requests.jsonl"
    request_path.touch(exist_ok=True)
    before = request_path.read_text(encoding="utf-8").splitlines()
    scan_session_id = f"{SESSION_ID}-scan-{len(before) + 1}"
    args = (
        "browser-scan-request", "--platform", envelope["platform"],
        "--account-key", envelope["account_key"], "--post-key", envelope["post_key"],
        "--post-permalink", envelope["post_permalink"], "--session-id", scan_session_id,
        "--ttl-minutes", "5", "--internal-fused",
    )
    dry = run_cli(script, root, *args)
    after_dry = request_path.read_text(encoding="utf-8").splitlines()
    if "DRY_RUN valid" not in dry.stdout or after_dry != before:
        raise AssertionError("scan request dry-run mutated its ledger")
    completed = run_cli(script, root, *args, "--write")
    rows = request_path.read_text(encoding="utf-8").splitlines()
    if len(rows) != len(before) + 1:
        raise AssertionError("browser-scan-request did not append exactly one request")
    request = json.loads(rows[-1])
    capability_lines = [
        line.removeprefix("INTERNAL_SCAN_CAPABILITY ")
        for line in completed.stdout.splitlines()
        if line.startswith("INTERNAL_SCAN_CAPABILITY ")
    ]
    if len(capability_lines) != 1:
        raise AssertionError("browser-scan-request emitted no unique scan capability")
    internal = json.loads(capability_lines[0])
    if internal.get("scan_request") != request:
        raise AssertionError("scan capability request differs from its ledger row")
    capability = internal.get("receipt_capability")
    if not isinstance(capability, dict) or "nonce" not in capability:
        raise AssertionError("browser-scan-request did not issue a private bearer")
    _SCAN_CAPABILITIES[(str(root.resolve()), request["scan_request_id"])] = capability
    if "nonce" in json.dumps(request):
        raise AssertionError("browser scan bearer leaked into its request ledger row")
    return request


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
    envelope = add_scan_provenance_evidence(envelope)
    request = create_scan_request(script, root, envelope)
    envelope = bind_scan_request(envelope, request)
    source = root / "browser-scan.json"
    write_json(source, scan_provenance_envelope(root, request, envelope))
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
        "--session-id", SESSION_ID,
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


def bound_preflight_for(action: dict) -> dict:
    """Build a valid receipt without coupling tests to fixture DOM identity."""
    receipt = {
        "schema_version": 1,
        "test_only": False,
        "action_id": action["action_id"],
        "intent_id": action["intent_id"],
        "session_id": action["session_id"],
        "permit_id": action["permit_id"],
        "scope": action["scope"],
        "comment_fingerprint": action["comment_fingerprint"],
        "reply_hash": action["reply_hash"],
        "action_digest": _json_digest(action),
        "plan_digest": _json_digest({"bound_fixture_plan": action["action_id"]}),
        "observed_url": action["post_permalink"],
        "observed_at": now_iso(),
        "baseline_exact_reply_count": 0,
        "baseline_total_reply_count": 0,
        "account_verified": True,
        "post_verified": True,
        "target_verified": True,
        "body_complete": True,
        "composer_empty_before_fill": True,
        "composer_matches_reply": True,
        "reply_control_verified": True,
        "evidence": "fixture preflight is bound to the approved second intent",
    }
    return rebind_preparation(receipt)


def rebind_preparation(receipt: dict) -> dict:
    receipt["preparation_id"] = _json_digest({
        key: receipt[key] for key in PREPARATION_CORE_KEYS
    })
    return receipt


def begin_browser_send(
    script: Path, root: Path, action: dict, adapter: LocalFixtureCommentAdapter,
) -> dict:
    source = root / "browser-preflight.json"
    write_json(source, preflight_for(action, adapter))
    completed = run_cli(
        script, root, "browser-begin", str(source),
        "--intent-id", action["intent_id"], "--session-id", SESSION_ID, "--write",
    )
    claim_lines = [
        line.removeprefix("SUBMIT_CLAIM ") for line in completed.stdout.splitlines()
        if line.startswith("SUBMIT_CLAIM ")
    ]
    if len(claim_lines) != 1:
        raise AssertionError("browser-begin did not emit exactly one post-commit submit claim")
    claim = json.loads(claim_lines[0])
    for key in (
        "action_id", "intent_id", "session_id", "permit_id", "reply_hash",
        "action_digest", "plan_digest", "preparation_id", "preflight_id", "claim_id",
        SCAN_PROVENANCE_DIGEST_FIELD, DRAFT_PROVENANCE_DIGEST_FIELD,
        ACTION_PROVENANCE_DIGEST_FIELD,
    ):
        if not isinstance(claim.get(key), str) or not claim[key]:
            raise AssertionError(f"browser-begin submit claim is missing {key}")
    if claim["decision"] != "WRITE_OK" or claim["action_id"] != action["action_id"]:
        raise AssertionError("browser-begin submit claim is not bound to the approved action")
    capability = claim.get("receipt_capability")
    if not isinstance(capability, dict):
        raise AssertionError("browser-begin did not issue a finish receipt capability")
    remember_receipt_capability(root, action["intent_id"], capability)
    return claim


def approved_browser_send(
    root: Path, platform: str,
) -> tuple[Path, LocalFixtureCommentAdapter, dict, dict]:
    """Build one approved, claimed fixture send for provenance/recovery tests."""
    script, _unused = prepare_cli_fixture(
        root, live_browser_actuation_enabled=True,
    )
    adapter = LocalFixtureCommentAdapter(platform)
    comment = ingest_browser_scan(script, root, scan_envelope(adapter))
    _reply_path, intent_id = draft_cli_fixture(script, root, comment)
    run_cli(
        script, root, "approve", "--intent-id", intent_id,
        "--approval-mode", "batch_confirm", "--session-id", SESSION_ID,
        "--write",
    )
    action = prepare_action(script, root, intent_id)
    adapter.fill_composer(action["reply_text"])
    claim = begin_browser_send(script, root, action, adapter)
    return script, adapter, action, claim


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
    receipt = result_for(action, adapter, current["attempt"]["browser_preflight_id"])
    write_json(source, provenance_envelope(
        root, action["intent_id"], "browser-finish", receipt,
    ))
    completed = run_cli(
        script, root, "browser-finish", str(source),
        "--intent-id", action["intent_id"], "--session-id", SESSION_ID, "--write",
    )
    capture_receipt_commit(root, action["intent_id"], completed.stdout)


def assert_status(root: Path, intent_id: str, expected: str) -> None:
    state = intent_state(root, intent_id)
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


def reinspection_for(action: dict, attempt: dict, *, found: bool) -> dict:
    return {
        "schema_version": 1,
        "test_only": False,
        "action_id": action["action_id"],
        "preflight_id": attempt["browser_preflight_id"],
        "preparation_id": attempt["browser_preparation_id"],
        "claim_id": attempt["browser_submit_claim_id"],
        "intent_id": action["intent_id"],
        "session_id": action["session_id"],
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
        "own_author_reply_count": 1 if found else 0,
        "reinspection_total_reply_count": 1 if found else 0,
        "evidence": "fixture browser reinspection completed",
    }

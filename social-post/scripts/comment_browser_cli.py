#!/usr/bin/env python3
"""CLI application boundary for structured Chrome scans and send receipts."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from comment_browser_contract import (
    build_browser_action, build_browser_scan_completion, build_browser_scan_request,
    classify_browser_reinspection, classify_browser_result, normalize_browser_scan,
    validate_browser_preflight,
)
from comment_browser_provenance import (
    build_receipt_binding, consume_receipt_envelope, issue_receipt_capability,
    issue_reconcile_receipt_capability, reconcile_receipt_binding_from_issuer,
)
from comment_browser_send_contract import build_browser_recovery_action
from comment_canary import canary_settlement_allowed, require_canary_lease
from comment_canary_cli import register_canary_commands
from comment_browser_target_cli import register_target_observation_commands
from comment_cli_support import (
    SKILL_ROOT, commit_or_preview, load_state, now_iso, read_json_source, require_valid,
)
from comment_domain import normalize_reply_event, stable_id
from comment_scan_provenance import (
    ACTION_PROVENANCE_DIGEST_FIELD,
    DRAFT_PROVENANCE_DIGEST_FIELD,
    SCAN_PROVENANCE_DIGEST_FIELD,
    consume_scan_receipt_envelope,
    issue_scan_receipt_capability,
)


def _require_live_browser_mutation_enabled(
    policy: dict[str, Any], args: argparse.Namespace, operation: str,
    *, state: dict[str, Any] | None = None, action: dict[str, Any] | None = None,
) -> None:
    """Fail closed before a live Chrome receipt can mutate the canonical ledger."""
    scan_only_enabled = (
        operation == "browser-scan"
        and policy.get("live_browser_scan_enabled") is True
    )
    canary_enabled = False
    if operation == "browser-begin" and getattr(args, "canary_lease_id", None):
        if state is None or action is None:
            raise ValueError("canary begin requires the canonical approved action")
        require_canary_lease(state, args.canary_lease_id, args.intent_id, args.session_id, action=action)
        canary_enabled = True
    elif operation in {"browser-finish", "browser-reconcile", "browser-recover-reconcile"} and state is not None:
        canary_enabled = canary_settlement_allowed(state)
    if (
        args.write
        and policy.get("live_browser_actuation_enabled") is not True
        and not scan_only_enabled
        and not canary_enabled
    ):
        raise ValueError(
            f"{operation} live browser ledger mutation is disabled by policy"
        )


def _append_scan_rows(
    records: dict[str, list[dict[str, Any]]], latest: dict[str, dict[str, Any]],
    rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    event_ids = {row.get("event_id") for row in records["comments"]}
    added: list[dict[str, Any]] = []
    unchanged: list[str] = []
    for row in rows:
        previous = latest.get(row["comment_key"])
        if row["event_id"] in event_ids or (
            previous and previous.get("raw_fingerprint") == row.get("raw_fingerprint")
        ):
            unchanged.append(row["comment_key"])
            continue
        records["comments"].append(row)
        latest[row["comment_key"]] = row
        event_ids.add(row["event_id"])
        added.append(row)
    return added, unchanged


def command_browser_scan_request(args: argparse.Namespace) -> None:
    records, policy, result = load_state(args.root)
    require_valid(result)
    if args.ttl_minutes < 1:
        raise ValueError("ttl-minutes must be positive")
    maximum_ttl = int(policy.get("maximum_browser_scan_request_ttl_seconds", 600))
    if args.ttl_minutes * 60 > maximum_ttl:
        raise ValueError(
            f"ttl-minutes exceeds policy maximum of {maximum_ttl // 60} minutes"
        )
    requested_at = now_iso()
    expires_at = (
        datetime.fromisoformat(requested_at.replace("Z", "+00:00"))
        + timedelta(minutes=args.ttl_minutes)
    ).isoformat()
    request = build_browser_scan_request(
        platform=args.platform, account_key=args.account_key, post_key=args.post_key,
        post_permalink=args.post_permalink, session_id=args.session_id,
        requested_at=requested_at, expires_at=expires_at,
    )
    receipt_capability, capability_metadata = issue_scan_receipt_capability(request)
    request = {**request, **capability_metadata}
    if request["scan_request_id"] in result["browser_scan_requests"]:
        raise ValueError("duplicate browser scan request")
    records["scan_requests"].append(request)
    revision = commit_or_preview(
        records, policy, result["revision"], request,
        root=args.root, write=args.write,
    )
    if revision is not None and args.internal_fused:
        print("INTERNAL_SCAN_CAPABILITY " + json.dumps({
            "schema_version": 1,
            "decision": "SCAN_AUTHORIZED",
            "scan_request": request,
            "receipt_capability": receipt_capability,
        }, ensure_ascii=False, separators=(",", ":")))


def command_browser_scan(args: argparse.Namespace) -> None:
    source_value = read_json_source(args.source)
    records, policy, result = load_state(args.root)
    require_valid(result)
    _require_live_browser_mutation_enabled(policy, args, "browser-scan")
    request = result["browser_scan_requests"].get(args.scan_request_id)
    if not request:
        raise ValueError(f"unknown browser scan request {args.scan_request_id}")
    if request["session_id"] != args.session_id:
        raise ValueError("browser scan session differs from stored scan request")
    if request.get("completion_events"):
        raise ValueError("browser-scan one-shot request already completed")
    receipt_consumption = None
    if isinstance(source_value, dict) and set(source_value) == {"provenance", "receipt"}:
        raw, receipt_consumption = consume_scan_receipt_envelope(
            source_value, request,
        )
    else:
        if not isinstance(source_value, dict) or source_value.get("test_only") is not True:
            raise ValueError(
                "browser-scan live receipt requires a one-shot provenance envelope"
            )
        raw = source_value
    scan = normalize_browser_scan(raw, policy, request)
    added, unchanged = _append_scan_rows(
        records, result["latest_comments"], scan["comments"],
    )
    completion = build_browser_scan_completion(
        scan, request, raw.get("thread_expansion_evidence"), receipt_consumption,
    )
    records["scan_requests"].append(completion)
    payload = {
        "scan_id": scan["scan_id"], "scope": scan["scope"],
        "added": added, "unchanged": unchanged, "completion": completion,
        "completion_status": "appended",
    }
    revision = commit_or_preview(
        records, policy, result["revision"], payload,
        root=args.root, write=args.write,
    )
    if revision is not None:
        receipt_digest = (
            receipt_consumption or {}
        ).get("browser_scan_receipt_digest")
        print("SCAN_COMMIT " + json.dumps({
            "schema_version": 1,
            "operation": "browser-scan",
            "scan_request_id": request["scan_request_id"],
            "scan_id": scan["scan_id"],
            "receipt_digest": receipt_digest,
            "comment_count": len(scan["comments"]),
            "added_count": len(added),
            "unchanged_count": len(unchanged),
            "zero_result": not scan["comments"],
        }, ensure_ascii=False, separators=(",", ":")))


def command_browser_action(args: argparse.Namespace) -> None:
    _records, _policy, result = load_state(args.root)
    require_valid(result)
    action = build_browser_action(
        result["latest_comments"], result["reply_states"],
        args.intent_id, args.session_id,
    )
    if getattr(args, "canary_lease_id", None):
        _key, state = _active_intent(result["reply_states"], args.intent_id)
        require_canary_lease(state, args.canary_lease_id, args.intent_id, args.session_id, action=action)
    print(json.dumps(action, ensure_ascii=False, indent=2))


def command_browser_recovery_action(args: argparse.Namespace) -> None:
    """Read original uncertain-send bindings; never issue a submit or capability."""
    records, _policy, result = load_state(args.root)
    require_valid(result)
    recovery = build_browser_recovery_action(
        result["latest_comments"], result["reply_states"], args.intent_id, args.session_id,
        reply_rows=records["replies"],
    )
    print(json.dumps(recovery, ensure_ascii=False, indent=2))


def command_browser_begin(args: argparse.Namespace) -> None:
    raw = read_json_source(args.source)
    records, policy, result = load_state(args.root)
    require_valid(result)
    _key, initial_state = _active_intent(result["reply_states"], args.intent_id)
    action = build_browser_action(result["latest_comments"], result["reply_states"], args.intent_id, args.session_id)
    _require_live_browser_mutation_enabled(policy, args, "browser-begin", state=initial_state, action=action)
    preflight = validate_browser_preflight(
        raw, result["latest_comments"], result["reply_states"], policy,
        args.intent_id, args.session_id,
        canary_lease_id=getattr(args, "canary_lease_id", None),
    )
    state = preflight["state"]
    comment = preflight["comment"]
    permit = state["permit"]
    occurred_at = now_iso()
    claim = {
        "decision": "WRITE_OK",
        "claim_id": stable_id(
            "browser-submit-claim", preflight["action_id"],
            preflight["preflight_id"], preflight["preparation_id"],
        ),
        "preflight_id": preflight["preflight_id"],
        "action_id": preflight["action_id"],
        "intent_id": args.intent_id,
        "session_id": args.session_id,
        "permit_id": permit["permit_id"],
        "reply_hash": state["draft"]["reply_hash"],
        "action_digest": preflight["action_digest"],
        "plan_digest": preflight["plan_digest"],
        "preparation_id": preflight["preparation_id"],
        SCAN_PROVENANCE_DIGEST_FIELD: preflight[SCAN_PROVENANCE_DIGEST_FIELD],
        DRAFT_PROVENANCE_DIGEST_FIELD: preflight[DRAFT_PROVENANCE_DIGEST_FIELD],
        ACTION_PROVENANCE_DIGEST_FIELD: preflight[ACTION_PROVENANCE_DIGEST_FIELD],
    }
    event_payload = {
        "event_type": "send_started",
        "intent_id": args.intent_id,
        "comment_key": preflight["comment_key"],
        "occurred_at": occurred_at,
        "session_id": args.session_id,
        "permit_id": permit["permit_id"],
        "reply_hash": state["draft"]["reply_hash"],
        "comment_fingerprint": comment["raw_fingerprint"],
        "scope": permit["scope"],
        "browser_action_id": preflight["action_id"],
        "browser_preflight_id": preflight["preflight_id"],
        "browser_preparation_id": preflight["preparation_id"],
        "browser_action_digest": preflight["action_digest"],
        "browser_plan_digest": preflight["plan_digest"],
        "browser_preflight_evidence": preflight["evidence"],
        "browser_baseline_total_reply_count": preflight["baseline_total_reply_count"],
        "browser_submit_claim_id": claim["claim_id"],
        SCAN_PROVENANCE_DIGEST_FIELD: preflight[SCAN_PROVENANCE_DIGEST_FIELD],
        DRAFT_PROVENANCE_DIGEST_FIELD: preflight[DRAFT_PROVENANCE_DIGEST_FIELD],
        ACTION_PROVENANCE_DIGEST_FIELD: preflight[ACTION_PROVENANCE_DIGEST_FIELD],
    }
    if getattr(args, "canary_lease_id", None):
        lease = require_canary_lease(state, args.canary_lease_id, args.intent_id, args.session_id, action=action)
        event_payload.update(browser_canary_lease_id=lease["lease_id"], browser_canary_lease_digest=lease["lease_digest"])
    for key in ("composer_initial_state", "composer_initial_text", "selected_parent_evidence", "selected_parent_evidence_digest"):
        if key in preflight:
            event_payload[f"browser_{key}"] = preflight[key]
    finish_binding = build_receipt_binding("browser-finish", event_payload)
    finish_capability, capability_metadata = issue_receipt_capability(
        "browser-finish", finish_binding, occurred_at,
        int(policy.get("maximum_browser_finish_capability_ttl_seconds", 300)),
    )
    event_payload.update(capability_metadata)
    event = normalize_reply_event(event_payload, result["latest_comments"])
    claim["receipt_capability"] = finish_capability
    records["replies"].append(event)
    revision = commit_or_preview(
        records, policy, result["revision"],
        {"preflight_id": preflight["preflight_id"], "event": event},
        root=args.root, write=args.write,
    )
    if revision is not None:
        print("SUBMIT_CLAIM " + json.dumps(claim, ensure_ascii=False, separators=(",", ":")))


def _finish_event(
    outcome: dict[str, Any], intent_id: str, session_id: str,
    comment_key: str, attempt_session_id: str, provenance: dict[str, Any],
    next_capability_metadata: dict[str, Any] | None,
) -> dict[str, Any]:
    mapping = {"sent": "sent_verified", "unknown": "needs_reconcile", "failed": "failed"}
    event_type = mapping[outcome["result"]]
    event = {
        "event_type": event_type,
        "intent_id": intent_id,
        "comment_key": comment_key,
        "occurred_at": now_iso(),
        "session_id": session_id,
        "attempt_session_id": attempt_session_id,
        "browser_evidence": outcome.get("evidence"),
        "browser_observed_at": outcome.get("observed_at"),
        "reason_code": outcome.get("reason") if event_type == "needs_reconcile" else None,
        "submission_possible": False if event_type == "failed" else None,
        "browser_receipt_id": stable_id(
            "browser-receipt", intent_id, provenance["browser_receipt_digest"],
        ),
        **provenance,
    }
    if next_capability_metadata:
        event.update(next_capability_metadata)
    return event


def _active_intent(
    states: dict[str, dict[str, Any]], intent_id: str,
) -> tuple[str, dict[str, Any]]:
    matches = [
        (key, state) for key, state in states.items()
        if state.get("intent_id") == intent_id
    ]
    if len(matches) != 1:
        raise ValueError(f"expected one active intent_id {intent_id}")
    return matches[0]


def _emit_receipt_commit(
    operation: str, outcome: dict[str, Any], provenance: dict[str, Any],
    next_capability: dict[str, Any] | None,
) -> None:
    payload = {
        "schema_version": 1,
        "operation": operation,
        "outcome": outcome["result"],
        "receipt_digest": provenance["browser_receipt_digest"],
        "next_capability": next_capability,
    }
    print("RECEIPT_COMMIT " + json.dumps(
        payload, ensure_ascii=False, separators=(",", ":"),
    ))


def _emit_internal_reconcile_recovery(
    event: dict[str, Any], attempt: dict[str, Any], capability: dict[str, Any],
) -> None:
    payload = {
        "schema_version": 1,
        "decision": "RECONCILE_ONLY",
        "operation": "browser-reconcile",
        "intent_id": event["intent_id"],
        "action_id": attempt["browser_action_id"],
        "claim_id": attempt["browser_submit_claim_id"],
        "preflight_id": attempt["browser_preflight_id"],
        "preparation_id": attempt["browser_preparation_id"],
        "attempt_session_id": event["attempt_session_id"],
        "recovery_session_id": event["session_id"],
        "receipt_capability": capability,
    }
    print("INTERNAL_RECOVERY_CAPABILITY " + json.dumps(
        payload, ensure_ascii=False, separators=(",", ":"),
    ))


def command_browser_recover_reconcile(args: argparse.Namespace) -> None:
    """Rotate lost/expired receipt authority without creating another send claim."""
    records, policy, result = load_state(args.root)
    require_valid(result)
    comment_key, state = _active_intent(result["reply_states"], args.intent_id)
    _require_live_browser_mutation_enabled(
        policy, args, "browser-recover-reconcile", state=state,
    )
    if state.get("status") not in {"send_started", "needs_reconcile"}:
        raise ValueError(
            "browser-recover-reconcile requires an authoritative uncertain send, "
            f"found {state.get('status')}"
        )
    attempt = state.get("attempt") or {}
    attempt_session_id = str(attempt.get("session_id") or "")
    current_issuer = state.get("reconcile_capability") or state.get("last_event") or {}
    previous_reconcile_session = current_issuer.get(
        "browser_reconcile_authorized_session_id"
    )
    if args.session_id == attempt_session_id or args.session_id == previous_reconcile_session:
        raise ValueError(
            "browser-recover-reconcile requires a fresh current session"
        )
    occurred_at = now_iso()
    capability, metadata = issue_reconcile_receipt_capability(
        attempt, args.session_id, occurred_at,
        int(policy.get("maximum_browser_reconcile_capability_ttl_seconds", 86400)),
    )
    event = normalize_reply_event({
        "event_type": "reconcile_recovery_issued",
        "intent_id": args.intent_id,
        "comment_key": comment_key,
        "occurred_at": occurred_at,
        "session_id": args.session_id,
        "attempt_session_id": attempt_session_id,
        "reconciliation_basis": "browser_recovery",
        "reason_code": args.reason,
        **metadata,
    }, result["latest_comments"])
    records["replies"].append(event)
    revision = commit_or_preview(
        records, policy, result["revision"], {"event": event},
        root=args.root, write=args.write,
    )
    if revision is not None:
        _emit_internal_reconcile_recovery(event, attempt, capability)


def command_browser_finish(args: argparse.Namespace) -> None:
    envelope = read_json_source(args.source)
    records, policy, result = load_state(args.root)
    require_valid(result)
    comment_key, state = _active_intent(result["reply_states"], args.intent_id)
    _require_live_browser_mutation_enabled(policy, args, "browser-finish", state=state)
    attempt = state.get("attempt") or {}
    if args.session_id != attempt.get("session_id"):
        raise ValueError("browser-finish session differs from receipt capability session")
    binding = build_receipt_binding("browser-finish", attempt)
    raw, provenance = consume_receipt_envelope(
        envelope, "browser-finish", binding, attempt,
    )
    outcome = classify_browser_result(
        raw, result["latest_comments"], result["reply_states"], policy,
        args.intent_id, args.session_id,
    )
    attempt_session_id = str(attempt.get("session_id") or "")
    next_capability = None
    next_metadata = None
    if outcome["result"] == "unknown":
        next_capability, next_metadata = issue_reconcile_receipt_capability(
            attempt, args.session_id, now_iso(),
            int(policy.get("maximum_browser_reconcile_capability_ttl_seconds", 86400)),
        )
    event = normalize_reply_event(
        _finish_event(
            outcome, args.intent_id, args.session_id,
            comment_key, attempt_session_id, provenance, next_metadata,
        ),
        result["latest_comments"],
    )
    records["replies"].append(event)
    revision = commit_or_preview(
        records, policy, result["revision"], {"outcome": outcome, "event": event},
        root=args.root, write=args.write,
    )
    if revision is not None:
        _emit_receipt_commit("browser-finish", outcome, provenance, next_capability)


def command_browser_reconcile(args: argparse.Namespace) -> None:
    envelope = read_json_source(args.source)
    records, policy, result = load_state(args.root)
    require_valid(result)
    comment_key, state = _active_intent(result["reply_states"], args.intent_id)
    _require_live_browser_mutation_enabled(policy, args, "browser-reconcile", state=state)
    attempt = state.get("attempt") or {}
    issuer = state.get("reconcile_capability") or state.get("last_event") or {}
    binding = reconcile_receipt_binding_from_issuer(
        attempt, issuer, args.session_id,
    )
    raw, provenance = consume_receipt_envelope(
        envelope, "browser-reconcile", binding, issuer,
    )
    outcome = classify_browser_reinspection(
        raw, result["latest_comments"], result["reply_states"], policy,
        args.intent_id, args.session_id,
    )
    attempt_session_id = str(attempt.get("session_id") or "")
    next_capability = None
    next_metadata = None
    if outcome["result"] == "unknown":
        next_capability, next_metadata = issue_reconcile_receipt_capability(
            attempt, args.session_id, now_iso(),
            int(policy.get("maximum_browser_reconcile_capability_ttl_seconds", 86400)),
        )
    event_payload = {
        "event_type": {
            "sent": "reconciled_sent",
            "not-sent": "reconciled_not_sent",
            "unknown": "browser_reinspection_observed",
        }[outcome["result"]],
        "intent_id": args.intent_id,
        "comment_key": comment_key,
        "occurred_at": now_iso(),
        "session_id": args.session_id,
        "attempt_session_id": attempt_session_id,
        "reconciliation_basis": "browser_reinspection",
        "browser_evidence": outcome["evidence"],
        "browser_observed_at": outcome["observed_at"],
        "reason_code": outcome.get("reason"),
        "browser_receipt_id": stable_id(
            "browser-reinspection", args.intent_id,
            provenance["browser_receipt_digest"],
        ),
        **provenance,
    }
    if next_metadata:
        event_payload.update(next_metadata)
    event = normalize_reply_event(event_payload, result["latest_comments"])
    records["replies"].append(event)
    revision = commit_or_preview(
        records, policy, result["revision"], {"outcome": outcome, "event": event},
        root=args.root, write=args.write,
    )
    if revision is not None:
        _emit_receipt_commit("browser-reconcile", outcome, provenance, next_capability)


def _add_root(parser: argparse.ArgumentParser, *, write: bool) -> None:
    parser.add_argument("--root", type=Path, default=SKILL_ROOT)
    if write:
        parser.add_argument("--write", action="store_true")


def register_browser_commands(sub: argparse._SubParsersAction) -> None:
    register_canary_commands(sub)
    register_target_observation_commands(sub)
    request = sub.add_parser("browser-scan-request")
    request.add_argument("--platform", required=True, choices=("facebook", "instagram", "threads"))
    request.add_argument("--account-key", required=True)
    request.add_argument("--post-key", required=True)
    request.add_argument("--post-permalink", required=True)
    request.add_argument("--session-id", required=True)
    request.add_argument("--ttl-minutes", type=int, default=10)
    request.add_argument("--internal-fused", action="store_true", help=argparse.SUPPRESS)
    _add_root(request, write=True)
    request.set_defaults(handler=command_browser_scan_request)

    scan = sub.add_parser("browser-scan")
    scan.add_argument("source", help="structured live Chrome scan JSON file or -")
    scan.add_argument("--scan-request-id", required=True)
    scan.add_argument("--session-id", required=True)
    _add_root(scan, write=True)
    scan.set_defaults(handler=command_browser_scan)

    action = sub.add_parser("browser-action")
    action.add_argument("--intent-id", required=True)
    action.add_argument("--session-id", required=True)
    action.add_argument("--canary-lease-id")
    _add_root(action, write=False)
    action.set_defaults(handler=command_browser_action)

    recovery_action = sub.add_parser("browser-recovery-action")
    recovery_action.add_argument("--intent-id", required=True)
    recovery_action.add_argument("--session-id", required=True)
    _add_root(recovery_action, write=False)
    recovery_action.set_defaults(handler=command_browser_recovery_action)

    begin = sub.add_parser("browser-begin")
    begin.add_argument("source", help="fresh structured Chrome preflight JSON file or -")
    begin.add_argument("--intent-id", required=True)
    begin.add_argument("--session-id", required=True)
    begin.add_argument("--canary-lease-id")
    _add_root(begin, write=True)
    begin.set_defaults(handler=command_browser_begin)

    finish = sub.add_parser("browser-finish")
    finish.add_argument("source", help="versioned provenance envelope JSON file or -")
    finish.add_argument("--intent-id", required=True)
    finish.add_argument("--session-id", required=True)
    _add_root(finish, write=True)
    finish.set_defaults(handler=command_browser_finish)

    recovery = sub.add_parser(
        "browser-recover-reconcile",
        help="internal shell-free Node bridge ceremony; not a production user API",
    )
    recovery.add_argument("--intent-id", required=True)
    recovery.add_argument("--session-id", required=True)
    recovery.add_argument(
        "--reason", required=True,
        choices=("browser_process_restarted", "receipt_capability_expired"),
    )
    _add_root(recovery, write=True)
    recovery.set_defaults(handler=command_browser_recover_reconcile)

    reconcile = sub.add_parser("browser-reconcile")
    reconcile.add_argument("source", help="versioned reinspection provenance envelope JSON file or -")
    reconcile.add_argument("--intent-id", required=True)
    reconcile.add_argument("--session-id", required=True)
    _add_root(reconcile, write=True)
    reconcile.set_defaults(handler=command_browser_reconcile)

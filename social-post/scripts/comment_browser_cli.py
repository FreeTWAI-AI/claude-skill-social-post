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
from comment_cli_support import (
    SKILL_ROOT, commit_or_preview, load_state, now_iso, read_json_source, require_valid,
)
from comment_domain import normalize_reply_event, stable_id


def _require_live_browser_mutation_enabled(
    policy: dict[str, Any], args: argparse.Namespace, operation: str,
) -> None:
    """Fail closed before a live Chrome receipt can mutate the canonical ledger."""
    if args.write and policy.get("live_browser_actuation_enabled") is not True:
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
    if request["scan_request_id"] in result["browser_scan_requests"]:
        raise ValueError("duplicate browser scan request")
    records["scan_requests"].append(request)
    commit_or_preview(
        records, policy, result["revision"], request,
        root=args.root, write=args.write,
    )


def command_browser_scan(args: argparse.Namespace) -> None:
    raw = read_json_source(args.source)
    records, policy, result = load_state(args.root)
    require_valid(result)
    _require_live_browser_mutation_enabled(policy, args, "browser-scan")
    request = result["browser_scan_requests"].get(args.scan_request_id)
    if not request:
        raise ValueError(f"unknown browser scan request {args.scan_request_id}")
    if request["session_id"] != args.session_id:
        raise ValueError("browser scan session differs from stored scan request")
    scan = normalize_browser_scan(raw, policy, request)
    added, unchanged = _append_scan_rows(
        records, result["latest_comments"], scan["comments"],
    )
    completion = build_browser_scan_completion(
        scan, request, raw.get("thread_expansion_evidence"),
    )
    known_completion_ids = {
        row.get("completion_event_id")
        for row in request.get("completion_events", [])
    }
    completion_status = "unchanged"
    if completion["completion_event_id"] not in known_completion_ids:
        records["scan_requests"].append(completion)
        completion_status = "appended"
    payload = {
        "scan_id": scan["scan_id"], "scope": scan["scope"],
        "added": added, "unchanged": unchanged, "completion": completion,
        "completion_status": completion_status,
    }
    commit_or_preview(
        records, policy, result["revision"], payload,
        root=args.root, write=args.write,
    )


def command_browser_action(args: argparse.Namespace) -> None:
    _records, _policy, result = load_state(args.root)
    require_valid(result)
    action = build_browser_action(
        result["latest_comments"], result["reply_states"],
        args.intent_id, args.session_id,
    )
    print(json.dumps(action, ensure_ascii=False, indent=2))


def command_browser_begin(args: argparse.Namespace) -> None:
    raw = read_json_source(args.source)
    records, policy, result = load_state(args.root)
    require_valid(result)
    _require_live_browser_mutation_enabled(policy, args, "browser-begin")
    preflight = validate_browser_preflight(
        raw, result["latest_comments"], result["reply_states"], policy,
        args.intent_id, args.session_id,
    )
    state = preflight["state"]
    comment = preflight["comment"]
    permit = state["permit"]
    event = normalize_reply_event({
        "event_type": "send_started",
        "intent_id": args.intent_id,
        "comment_key": preflight["comment_key"],
        "occurred_at": now_iso(),
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
    }, result["latest_comments"])
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
    }
    event["browser_submit_claim_id"] = claim["claim_id"]
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
    comment_key: str, attempt_session_id: str,
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
        "browser_receipt_id": stable_id("browser-receipt", intent_id, outcome),
    }
    return event


def command_browser_finish(args: argparse.Namespace) -> None:
    raw = read_json_source(args.source)
    records, policy, result = load_state(args.root)
    require_valid(result)
    _require_live_browser_mutation_enabled(policy, args, "browser-finish")
    outcome = classify_browser_result(
        raw, result["latest_comments"], result["reply_states"], policy,
        args.intent_id, args.session_id,
    )
    matches = [
        (key, state) for key, state in result["reply_states"].items()
        if state.get("intent_id") == args.intent_id
    ]
    if len(matches) != 1:
        raise ValueError(f"expected one active intent_id {args.intent_id}")
    comment_key, state = matches[0]
    attempt_session_id = str((state.get("attempt") or {}).get("session_id") or "")
    event = normalize_reply_event(
        _finish_event(
            outcome, args.intent_id, args.session_id,
            comment_key, attempt_session_id,
        ),
        result["latest_comments"],
    )
    records["replies"].append(event)
    commit_or_preview(
        records, policy, result["revision"], {"outcome": outcome, "event": event},
        root=args.root, write=args.write,
    )


def command_browser_reconcile(args: argparse.Namespace) -> None:
    raw = read_json_source(args.source)
    records, policy, result = load_state(args.root)
    require_valid(result)
    _require_live_browser_mutation_enabled(policy, args, "browser-reconcile")
    outcome = classify_browser_reinspection(
        raw, result["latest_comments"], result["reply_states"], policy,
        args.intent_id, args.session_id,
    )
    if outcome["result"] == "unknown":
        print(json.dumps({"outcome": outcome}, ensure_ascii=False, indent=2))
        print("NO_CHANGE reinspection remains uncertain; do not resend")
        return
    matches = [
        (key, state) for key, state in result["reply_states"].items()
        if state.get("intent_id") == args.intent_id
    ]
    if len(matches) != 1:
        raise ValueError(f"expected one active intent_id {args.intent_id}")
    comment_key, state = matches[0]
    attempt_session_id = str((state.get("attempt") or {}).get("session_id") or "")
    event = normalize_reply_event({
        "event_type": (
            "reconciled_sent" if outcome["result"] == "sent"
            else "reconciled_not_sent"
        ),
        "intent_id": args.intent_id,
        "comment_key": comment_key,
        "occurred_at": now_iso(),
        "session_id": args.session_id,
        "attempt_session_id": attempt_session_id,
        "reconciliation_basis": "browser_reinspection",
        "browser_evidence": outcome["evidence"],
        "browser_observed_at": outcome["observed_at"],
        "browser_receipt_id": stable_id("browser-reinspection", args.intent_id, outcome),
    }, result["latest_comments"])
    records["replies"].append(event)
    commit_or_preview(
        records, policy, result["revision"], {"outcome": outcome, "event": event},
        root=args.root, write=args.write,
    )


def _add_root(parser: argparse.ArgumentParser, *, write: bool) -> None:
    parser.add_argument("--root", type=Path, default=SKILL_ROOT)
    if write:
        parser.add_argument("--write", action="store_true")


def register_browser_commands(sub: argparse._SubParsersAction) -> None:
    request = sub.add_parser("browser-scan-request")
    request.add_argument("--platform", required=True, choices=("facebook", "instagram", "threads"))
    request.add_argument("--account-key", required=True)
    request.add_argument("--post-key", required=True)
    request.add_argument("--post-permalink", required=True)
    request.add_argument("--session-id", required=True)
    request.add_argument("--ttl-minutes", type=int, default=10)
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
    _add_root(action, write=False)
    action.set_defaults(handler=command_browser_action)

    begin = sub.add_parser("browser-begin")
    begin.add_argument("source", help="fresh structured Chrome preflight JSON file or -")
    begin.add_argument("--intent-id", required=True)
    begin.add_argument("--session-id", required=True)
    _add_root(begin, write=True)
    begin.set_defaults(handler=command_browser_begin)

    finish = sub.add_parser("browser-finish")
    finish.add_argument("source", help="structured live Chrome receipt JSON file or -")
    finish.add_argument("--intent-id", required=True)
    finish.add_argument("--session-id", required=True)
    _add_root(finish, write=True)
    finish.set_defaults(handler=command_browser_finish)

    reconcile = sub.add_parser("browser-reconcile")
    reconcile.add_argument("source", help="structured fresh Chrome reinspection JSON file or -")
    reconcile.add_argument("--intent-id", required=True)
    reconcile.add_argument("--session-id", required=True)
    _add_root(reconcile, write=True)
    reconcile.set_defaults(handler=command_browser_reconcile)

#!/usr/bin/env python3
"""Dry-run-first CLI for zero-API, Chrome-controlled social comment replies."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from comment_browser_cli import register_browser_commands
from comment_cli_support import (
    SKILL_ROOT, commit_or_preview, configure_utf8_streams, intent_state, load_state,
    now_iso, read_json_source, require_valid,
)
from comment_domain import normalize_comment, normalize_reply_event, stable_id
from comment_policy import build_queue


def command_validate(args: argparse.Namespace) -> None:
    _records, _policy, result = load_state(args.root)
    value = {
        "valid": result["valid"], "revision": result["revision"], "counts": result["counts"],
        "errors": result["errors"], "warnings": result["warnings"],
    }
    print(json.dumps(value, ensure_ascii=False, indent=2))
    if not result["valid"]:
        raise ValueError("validation failed")


def command_queue(args: argparse.Namespace) -> None:
    _records, policy, result = load_state(args.root)
    require_valid(result)
    queue = build_queue(result["latest_comments"], result["reply_states"], policy, args.mode)
    if args.format == "json":
        print(json.dumps(queue, ensure_ascii=False, indent=2))
        return
    print(
        f"mode={queue['mode']} pending={len(queue['items'])} "
        f"bounded_auto={len(queue['bounded_auto_candidates'])} "
        f"deferred_by_cap={queue['bounded_auto_deferred_count']}"
    )
    for item in queue["items"]:
        author = item.get("author_display") or "unknown"
        reasons = ",".join(item["gate_reasons"]) or "eligible"
        print(f"{item['platform']} {item['status']} {author}: {item['body']} [{reasons}]")


def command_ingest(args: argparse.Namespace) -> None:
    payload = read_json_source(args.source)
    if isinstance(payload, dict):
        payload = payload.get("comments", [payload])
    if not isinstance(payload, list) or any(not isinstance(row, dict) for row in payload):
        raise ValueError("ingest input must be a comment object or a list/comments array")
    records, policy, result = load_state(args.root)
    require_valid(result)
    base_revision = result["revision"]
    latest = result["latest_comments"]
    existing_event_ids = {row.get("event_id") for row in records["comments"]}
    added: list[dict[str, Any]] = []
    unchanged: list[str] = []
    for raw in payload:
        row = normalize_comment(raw)
        if row["event_id"] in existing_event_ids:
            unchanged.append(row["comment_key"])
            continue
        previous = latest.get(row["comment_key"])
        if previous and previous.get("raw_fingerprint") == row.get("raw_fingerprint"):
            unchanged.append(row["comment_key"])
            continue
        records["comments"].append(row)
        latest[row["comment_key"]] = row
        existing_event_ids.add(row["event_id"])
        added.append(row)
    commit_or_preview(
        records, policy, base_revision, {"added": added, "unchanged": unchanged},
        root=args.root, write=args.write,
    )


def command_draft(args: argparse.Namespace) -> None:
    records, policy, result = load_state(args.root)
    require_valid(result)
    if args.comment_key not in result["latest_comments"]:
        raise ValueError(f"unknown comment_key {args.comment_key}")
    event = normalize_reply_event({
        "event_type": "drafted",
        "comment_key": args.comment_key,
        "occurred_at": args.occurred_at or now_iso(),
        "session_id": args.session_id,
        "reply_text": args.text,
        "classification": args.classification,
        "risk": args.risk,
        "confidence": args.confidence,
        "language": args.language,
        "policy_version": policy["policy_version"],
    }, result["latest_comments"])
    records["replies"].append(event)
    commit_or_preview(
        records, policy, result["revision"], event, root=args.root, write=args.write,
    )


def command_grant_auto(args: argparse.Namespace) -> None:
    records, policy, result = load_state(args.root)
    require_valid(result)
    if args.maximum_actions < 1:
        raise ValueError("maximum-actions must be positive")
    policy_cap = int(policy["maximum_actions_per_run"])
    if args.maximum_actions > policy_cap:
        raise ValueError(f"maximum-actions exceeds policy cap {policy_cap}")
    if args.ttl_minutes < 1:
        raise ValueError("ttl-minutes must be positive")
    occurred = now_iso()
    expires = (
        datetime.fromisoformat(occurred.replace("Z", "+00:00"))
        + timedelta(minutes=args.ttl_minutes)
    ).isoformat()
    scope = {
        "platform": args.platform,
        "account_key": args.account_key,
        "post_key": args.post_key,
    }
    event = normalize_reply_event({
        "event_type": "session_granted",
        "occurred_at": occurred,
        "session_id": args.session_id,
        "grant_id": stable_id("auto-grant", args.session_id, scope, occurred),
        "expires_at": expires,
        "maximum_actions": args.maximum_actions,
        "scope": scope,
        "authorization_basis": "current_session_user_instruction",
    }, result["latest_comments"])
    records["replies"].append(event)
    commit_or_preview(
        records, policy, result["revision"], event, root=args.root, write=args.write,
    )


def command_revoke_grant(args: argparse.Namespace) -> None:
    records, policy, result = load_state(args.root)
    require_valid(result)
    grant = result.get("authorization_grants", {}).get(args.grant_id)
    if not grant:
        raise ValueError(f"unknown grant_id {args.grant_id}")
    if grant.get("session_id") != args.session_id:
        raise ValueError("current session does not own this authorization grant")
    event = normalize_reply_event({
        "event_type": "session_revoked",
        "occurred_at": now_iso(),
        "session_id": args.session_id,
        "grant_id": args.grant_id,
        "reason_code": args.reason,
    }, result["latest_comments"])
    records["replies"].append(event)
    commit_or_preview(
        records, policy, result["revision"], event, root=args.root, write=args.write,
    )


def command_approve(args: argparse.Namespace) -> None:
    records, policy, result = load_state(args.root)
    require_valid(result)
    if args.ttl_minutes < 1:
        raise ValueError("ttl-minutes must be positive")
    occurred = now_iso()
    expires = (datetime.fromisoformat(occurred.replace("Z", "+00:00")) + timedelta(minutes=args.ttl_minutes)).isoformat()
    auto_eligible: set[str] = set()
    grant: dict[str, Any] | None = None
    if args.approval_mode == "bounded_auto":
        if not args.grant_id:
            raise ValueError("bounded_auto approval requires --grant-id")
        grant = result.get("authorization_grants", {}).get(args.grant_id)
        if not grant:
            raise ValueError(f"unknown grant_id {args.grant_id}")
        grant_expiry = datetime.fromisoformat(str(grant["expires_at"]).replace("Z", "+00:00"))
        permit_expiry = datetime.fromisoformat(expires.replace("Z", "+00:00"))
        expires = min(permit_expiry, grant_expiry).isoformat()
        queue = build_queue(result["latest_comments"], result["reply_states"], policy, "bounded_auto")
        auto_eligible = {item["intent_id"] for item in queue["bounded_auto_candidates"]}
    events = []
    staged_states = dict(result["reply_states"])
    for intent_id in args.intent_id:
        comment_key, state = intent_state(staged_states, intent_id)
        if args.approval_mode == "bounded_auto" and intent_id not in auto_eligible:
            raise ValueError(f"intent {intent_id} is not eligible for bounded_auto")
        comment = result["latest_comments"][comment_key]
        if comment.get("is_own"):
            raise ValueError(f"intent {intent_id} belongs to the authenticated account")
        if comment.get("has_own_reply"):
            raise ValueError(f"intent {intent_id} already has an own-account reply")
        if not comment.get("body_complete"):
            raise ValueError(f"intent {intent_id} has an incomplete visible body")
        event = normalize_reply_event({
            "event_type": "approved",
            "intent_id": intent_id,
            "comment_key": comment_key,
            "occurred_at": occurred,
            "session_id": args.session_id,
            "approval_mode": args.approval_mode,
            "authorization_basis": (
                "current_session_user_instruction"
                if args.approval_mode == "bounded_auto"
                else "batch_confirm_user_confirmation"
            ),
            "grant_id": args.grant_id if args.approval_mode == "bounded_auto" else None,
            "permit_id": stable_id("send-permit", args.session_id, intent_id, occurred),
            "expires_at": expires,
            "one_shot": True,
            "reply_hash": state["draft"]["reply_hash"],
            "scope": {
                "platform": comment["platform"], "account_key": comment["account_key"],
                "post_key": comment["post_key"], "comment_key": comment_key,
            },
        }, result["latest_comments"])
        records["replies"].append(event)
        events.append(event)
        staged_states[comment_key] = {**state, "status": "approved", "permit": event}
    commit_or_preview(
        records, policy, result["revision"], events, root=args.root, write=args.write,
    )


def command_begin_send(args: argparse.Namespace) -> None:
    _require_legacy_test_root(args.root, "begin-send")
    records, policy, result = load_state(args.root)
    require_valid(result)
    comment_key, state = intent_state(result["reply_states"], args.intent_id)
    if state.get("status") != "approved":
        raise ValueError(f"intent must be approved before send_started, found {state.get('status')}")
    permit = state["permit"]
    if permit.get("session_id") != args.session_id:
        raise ValueError("current session does not match the one-shot permit")
    comment = result["latest_comments"][comment_key]
    event = normalize_reply_event({
        "event_type": "send_started",
        "intent_id": args.intent_id,
        "comment_key": comment_key,
        "occurred_at": now_iso(),
        "session_id": args.session_id,
        "permit_id": permit["permit_id"],
        "reply_hash": state["draft"]["reply_hash"],
        "comment_fingerprint": comment["raw_fingerprint"],
        "scope": permit["scope"],
    }, result["latest_comments"])
    records["replies"].append(event)
    commit_or_preview(
        records, policy, result["revision"], event, root=args.root, write=args.write,
    )


def command_finish_send(args: argparse.Namespace) -> None:
    _require_legacy_test_root(args.root, "finish-send")
    records, policy, result = load_state(args.root)
    require_valid(result)
    comment_key, state = intent_state(result["reply_states"], args.intent_id)
    if state.get("status") != "send_started":
        raise ValueError(f"finish-send requires send_started, found {state.get('status')}")
    attempt = state.get("send_attempt") or state.get("last_event") or {}
    attempt_session_id = attempt.get("session_id")
    if attempt_session_id != args.session_id:
        raise ValueError("finish-send session does not match the original send attempt")
    mapping = {"sent": "sent_verified", "unknown": "needs_reconcile", "failed": "failed"}
    event = normalize_reply_event({
        "event_type": mapping[args.result],
        "intent_id": args.intent_id,
        "comment_key": comment_key,
        "occurred_at": now_iso(),
        "session_id": args.session_id,
        "attempt_session_id": attempt_session_id,
        "browser_evidence": args.evidence if args.result == "sent" else None,
        "reason_code": args.reason if args.result == "unknown" else None,
        "submission_possible": False if args.result == "failed" else None,
    }, result["latest_comments"])
    records["replies"].append(event)
    commit_or_preview(
        records, policy, result["revision"], event, root=args.root, write=args.write,
    )


def command_reconcile(args: argparse.Namespace) -> None:
    _require_legacy_test_root(args.root, "reconcile")
    records, policy, result = load_state(args.root)
    require_valid(result)
    comment_key, state = intent_state(result["reply_states"], args.intent_id)
    if state.get("status") not in {"needs_reconcile", "send_started"}:
        raise ValueError(f"reconcile requires an uncertain send, found {state.get('status')}")
    attempt = state.get("send_attempt") or state.get("last_event") or {}
    attempt_session_id = attempt.get("session_id")
    if not isinstance(attempt_session_id, str) or not attempt_session_id:
        raise ValueError("uncertain send has no recorded attempt session")
    occurred = now_iso()
    if state.get("status") == "send_started":
        uncertain = normalize_reply_event({
            "event_type": "needs_reconcile", "intent_id": args.intent_id,
            "comment_key": comment_key, "occurred_at": occurred,
            "session_id": attempt_session_id,
            "attempt_session_id": attempt_session_id,
            "recorded_by_session_id": args.session_id,
            "reason_code": "prior_run_ended_after_send_started",
        }, result["latest_comments"])
        records["replies"].append(uncertain)
    event = normalize_reply_event({
        "event_type": "reconciled_sent" if args.result == "sent" else "reconciled_not_sent",
        "intent_id": args.intent_id,
        "comment_key": comment_key,
        "occurred_at": occurred,
        "session_id": args.session_id,
        "attempt_session_id": attempt_session_id,
        "reconciliation_basis": "browser_reinspection",
        "browser_evidence": args.evidence,
    }, result["latest_comments"])
    records["replies"].append(event)
    commit_or_preview(
        records, policy, result["revision"], event, root=args.root, write=args.write,
    )


def command_disposition(args: argparse.Namespace) -> None:
    records, policy, result = load_state(args.root)
    require_valid(result)
    comment_key, _state = intent_state(result["reply_states"], args.intent_id)
    event = normalize_reply_event({
        "event_type": args.command,
        "intent_id": args.intent_id,
        "comment_key": comment_key,
        "occurred_at": now_iso(),
        "session_id": args.session_id,
        "reason_code": args.reason,
    }, result["latest_comments"])
    records["replies"].append(event)
    commit_or_preview(
        records, policy, result["revision"], event, root=args.root, write=args.write,
    )


def add_write_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--root", type=Path, default=SKILL_ROOT)
    parser.add_argument("--write", action="store_true")


def _require_legacy_test_root(root: Path, command: str) -> None:
    if root.resolve() == SKILL_ROOT.resolve():
        raise ValueError(
            f"{command} is disabled on the live skill ledger; use browser-begin/browser-finish"
        )


def add_session_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--session-id", required=True)
    add_write_flags(parser)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    register_browser_commands(sub)
    validate = sub.add_parser("validate")
    validate.add_argument("--root", type=Path, default=SKILL_ROOT)
    validate.set_defaults(handler=command_validate)
    queue = sub.add_parser("queue")
    queue.add_argument("--root", type=Path, default=SKILL_ROOT)
    queue.add_argument("--mode", choices=("draft_only", "batch_confirm", "bounded_auto"))
    queue.add_argument("--format", choices=("human", "json"), default="human")
    queue.set_defaults(handler=command_queue)
    ingest = sub.add_parser("ingest")
    ingest.add_argument("source", help="JSON file or - for stdin")
    add_write_flags(ingest)
    ingest.set_defaults(handler=command_ingest)
    draft = sub.add_parser("draft")
    draft.add_argument("--comment-key", required=True)
    draft.add_argument("--session-id", required=True)
    draft.add_argument("--text", required=True)
    draft.add_argument("--classification", required=True)
    draft.add_argument("--risk", choices=("low", "medium", "high"), required=True)
    draft.add_argument("--confidence", type=float, required=True)
    draft.add_argument("--language", required=True)
    draft.add_argument("--occurred-at")
    add_write_flags(draft)
    draft.set_defaults(handler=command_draft)
    grant = sub.add_parser("grant-auto")
    grant.add_argument("--session-id", required=True)
    grant.add_argument("--platform", choices=("facebook", "instagram", "threads"), required=True)
    grant.add_argument("--account-key", required=True)
    grant.add_argument("--post-key", required=True)
    grant.add_argument("--maximum-actions", type=int, required=True)
    grant.add_argument("--ttl-minutes", type=int, default=15)
    add_write_flags(grant)
    grant.set_defaults(handler=command_grant_auto)
    revoke_grant = sub.add_parser("revoke-grant")
    revoke_grant.add_argument("--grant-id", required=True)
    revoke_grant.add_argument("--session-id", required=True)
    revoke_grant.add_argument("--reason", required=True)
    add_write_flags(revoke_grant)
    revoke_grant.set_defaults(handler=command_revoke_grant)
    approve = sub.add_parser("approve")
    approve.add_argument("--intent-id", action="append", required=True)
    approve.add_argument("--approval-mode", choices=("batch_confirm", "bounded_auto"), required=True)
    approve.add_argument("--grant-id")
    approve.add_argument("--ttl-minutes", type=int, default=15)
    add_session_flags(approve)
    approve.set_defaults(handler=command_approve)
    begin = sub.add_parser("begin-send")
    begin.add_argument("--intent-id", required=True)
    add_session_flags(begin)
    begin.set_defaults(handler=command_begin_send)
    finish = sub.add_parser("finish-send")
    finish.add_argument("--intent-id", required=True)
    finish.add_argument("--result", choices=("sent", "unknown", "failed"), required=True)
    finish.add_argument("--evidence")
    finish.add_argument("--reason", default="send_result_uncertain")
    add_session_flags(finish)
    finish.set_defaults(handler=command_finish_send)
    reconcile = sub.add_parser("reconcile")
    reconcile.add_argument("--intent-id", required=True)
    reconcile.add_argument("--result", choices=("sent", "not-sent"), required=True)
    reconcile.add_argument("--evidence", required=True)
    add_session_flags(reconcile)
    reconcile.set_defaults(handler=command_reconcile)
    for name in ("deferred", "skipped", "revoked"):
        disposition = sub.add_parser(name)
        disposition.add_argument("--intent-id", required=True)
        disposition.add_argument("--reason", required=True)
        add_session_flags(disposition)
        disposition.set_defaults(handler=command_disposition)
    return parser


def main() -> int:
    configure_utf8_streams()
    args = build_parser().parse_args()
    try:
        args.handler(args)
        return 0
    except (OSError, RuntimeError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
        print(f"comment assistant error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

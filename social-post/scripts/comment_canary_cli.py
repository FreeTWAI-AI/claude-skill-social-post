#!/usr/bin/env python3
"""Canonical one-action canary lease issuance and read-only freshness checks."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from comment_browser_send_contract import build_browser_action
from comment_canary import CANARY_AUTHORIZATION_BASIS, CANARY_EVENT, issue_canary_lease, require_canary_lease
from comment_cli_support import SKILL_ROOT, commit_or_preview, intent_state, load_state, require_valid
from comment_domain import normalize_reply_event


def command_browser_canary_lease(args: argparse.Namespace) -> None:
    records, policy, result = load_state(args.root)
    require_valid(result)
    action = build_browser_action(result["latest_comments"], result["reply_states"], args.intent_id, args.session_id)
    lease = issue_canary_lease(action, args.authorization_basis, args.ttl_seconds)
    event = normalize_reply_event({
        "event_type": CANARY_EVENT, "intent_id": args.intent_id, "session_id": args.session_id,
        "comment_key": action["scope"]["comment_key"], "occurred_at": lease["issued_at"],
        "canary_lease": lease,
    }, result["latest_comments"])
    records["replies"].append(event)
    revision = commit_or_preview(records, policy, result["revision"], {"event": event}, root=args.root, write=args.write)
    if revision is not None:
        print("CANARY_LEASE " + json.dumps(lease, ensure_ascii=False, separators=(",", ":")))


def command_browser_canary_check(args: argparse.Namespace) -> None:
    _records, _policy, result = load_state(args.root)
    require_valid(result)
    _key, state = intent_state(result["reply_states"], args.intent_id)
    action = None if args.claim_id else build_browser_action(
        result["latest_comments"], result["reply_states"], args.intent_id, args.session_id,
    )
    lease = require_canary_lease(state, args.canary_lease_id, args.intent_id, args.session_id,
                                 action=action, claim_id=args.claim_id)
    print(json.dumps({
        "schema_version": 1, "decision": "CANARY_CLAIMED" if args.claim_id else "CANARY_READY",
        **{key: lease[key] for key in ("lease_id", "lease_digest", "intent_id", "session_id", "action_id", "action_digest", "expires_at", "source_digest")},
        "claim_id": args.claim_id,
    }, ensure_ascii=False, separators=(",", ":")))


def register_canary_commands(sub: argparse._SubParsersAction) -> None:
    lease = sub.add_parser("browser-canary-lease", help="authorize one already-approved action; never enable production")
    lease.add_argument("--intent-id", required=True)
    lease.add_argument("--session-id", required=True)
    lease.add_argument("--authorization-basis", required=True, choices=(CANARY_AUTHORIZATION_BASIS,))
    lease.add_argument("--ttl-seconds", type=int, default=300)
    lease.add_argument("--root", type=Path, default=SKILL_ROOT)
    lease.add_argument("--write", action="store_true")
    lease.set_defaults(handler=command_browser_canary_lease)
    check = sub.add_parser("browser-canary-check", help="read-only exact lease/claim/source validation")
    check.add_argument("--intent-id", required=True)
    check.add_argument("--session-id", required=True)
    check.add_argument("--canary-lease-id", required=True)
    check.add_argument("--claim-id")
    check.add_argument("--root", type=Path, default=SKILL_ROOT)
    check.set_defaults(handler=command_browser_canary_check)

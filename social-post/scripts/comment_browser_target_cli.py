#!/usr/bin/env python3
"""Private bridge intake for one explicitly scoped native comment observation.

Unlike a whole-post scan this operation makes no exhaustion or absence claim.
Only the fused Chrome bridge receives and consumes the request bearer.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta
import json
from pathlib import Path

from comment_browser_scan_contract import (
    build_browser_scan_request, build_browser_target_completion,
    normalize_browser_target_observation,
)
from comment_cli_support import (
    SKILL_ROOT, commit_or_preview, load_state, now_iso, read_json_source, require_valid,
)
from comment_scan_provenance import (
    consume_scan_receipt_envelope, issue_scan_receipt_capability,
)


def command_browser_target_observation_request(args: argparse.Namespace) -> None:
    records, policy, result = load_state(args.root)
    require_valid(result)
    maximum = int(policy.get("maximum_browser_scan_request_ttl_seconds", 600))
    if not 1 <= args.ttl_minutes * 60 <= maximum:
        raise ValueError("target observation ttl-minutes exceeds the policy window")
    requested_at = now_iso()
    expires_at = (datetime.fromisoformat(requested_at) + timedelta(minutes=args.ttl_minutes)).isoformat()
    request = build_browser_scan_request(
        platform=args.platform, account_key=args.account_key, post_key=args.post_key,
        post_permalink=args.post_permalink, session_id=args.session_id,
        requested_at=requested_at, expires_at=expires_at,
        observation_scope="target_comment", target={
            "platform_comment_id": args.platform_comment_id,
            "comment_permalink": args.comment_permalink,
        },
    )
    bearer, metadata = issue_scan_receipt_capability(request)
    request.update(metadata)
    if request["scan_request_id"] in result["browser_scan_requests"]:
        raise ValueError("duplicate target observation request")
    records["scan_requests"].append(request)
    revision = commit_or_preview(
        records, policy, result["revision"], request, root=args.root, write=args.write,
    )
    if revision is not None and args.internal_fused:
        print("INTERNAL_SCAN_CAPABILITY " + json.dumps({
            "schema_version": 1, "decision": "SCAN_AUTHORIZED",
            "scan_request": request, "receipt_capability": bearer,
        }, ensure_ascii=False, separators=(",", ":")))


def command_browser_target_observation(args: argparse.Namespace) -> None:
    envelope = read_json_source(args.source)
    records, policy, result = load_state(args.root)
    require_valid(result)
    if args.write and policy.get("live_browser_scan_enabled") is not True:
        raise ValueError("target observation live scan intake is disabled by policy")
    request = result["browser_scan_requests"].get(args.scan_request_id)
    if not request or request.get("observation_scope") != "target_comment":
        raise ValueError("target observation requires a stored target-only request")
    if request["session_id"] != args.session_id:
        raise ValueError("target observation session differs from its request")
    if request.get("completion_events"):
        raise ValueError("target observation one-shot request already completed")
    # No raw/test-only receipt fallback. Capability operation retains the common
    # scan name, but its binding includes the exact target and coverage class.
    raw, consumption = consume_scan_receipt_envelope(envelope, request)
    observation = normalize_browser_target_observation(raw, policy, request)
    comment = observation["comment"]
    if any(row.get("event_id") == comment["event_id"] for row in records["comments"]):
        raise ValueError("target observation event was already recorded")
    # Re-observing an unchanged body must still preserve the new request and
    # provenance. Fingerprint-only deduplication would sever that chain.
    records["comments"].append(comment)
    completion = build_browser_target_completion(observation, request, consumption)
    records["scan_requests"].append(completion)
    revision = commit_or_preview(
        records, policy, result["revision"],
        {"comment": comment, "completion": completion}, root=args.root, write=args.write,
    )
    if revision is not None:
        print("TARGET_OBSERVATION_COMMIT " + json.dumps({
            "schema_version": 1, "operation": "browser-target-observation",
            "scan_request_id": request["scan_request_id"],
            "scan_id": observation["scan_id"], "comment_key": comment["comment_key"],
            "receipt_digest": consumption["browser_scan_receipt_digest"],
            "observation_scope": "target_comment", "comment_count": 1,
            "whole_post_complete": False, "reply_thread_complete": False,
        }, ensure_ascii=False, separators=(",", ":")))


def register_target_observation_commands(sub: argparse._SubParsersAction) -> None:
    request = sub.add_parser("browser-target-observation-request")
    request.add_argument("--platform", required=True, choices=("facebook", "instagram", "threads"))
    for key in ("account-key", "post-key", "post-permalink", "platform-comment-id", "comment-permalink", "session-id"):
        request.add_argument("--" + key, required=True)
    request.add_argument("--ttl-minutes", type=int, default=10)
    request.add_argument("--internal-fused", action="store_true", help=argparse.SUPPRESS)
    request.add_argument("--root", type=Path, default=SKILL_ROOT)
    request.add_argument("--write", action="store_true")
    request.set_defaults(handler=command_browser_target_observation_request)
    commit = sub.add_parser("browser-target-observation")
    commit.add_argument("source", help="private source-bound observation envelope or -")
    commit.add_argument("--scan-request-id", required=True)
    commit.add_argument("--session-id", required=True)
    commit.add_argument("--root", type=Path, default=SKILL_ROOT)
    commit.add_argument("--write", action="store_true")
    commit.set_defaults(handler=command_browser_target_observation)

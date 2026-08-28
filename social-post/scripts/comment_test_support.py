#!/usr/bin/env python3
"""Shared fixtures and assertions for comment-operation behavioral tests."""

from __future__ import annotations

import json
from pathlib import Path

from comment_domain import normalize_comment, normalize_reply_event
from comment_state import validate_comment_store


ROOT = Path(__file__).resolve().parents[1]
POLICY = json.loads((ROOT / "references" / "comment-policy.json").read_text(encoding="utf-8"))


def sample_comment(
    suffix: str, *, platform: str = "instagram",
    observed_at: str = "2026-08-28T10:00:00+08:00", strong: bool = True,
    body: str = "太厲害了！", body_complete: object = True, is_own: object = False,
    has_own_reply: object = False, language: str = "zh-Hant",
    comment_permalink: str | None = None, post_key: str | None = None,
) -> dict:
    raw = {
        "platform": platform,
        "account_key": "creator-test",
        "post_key": post_key or f"post-{suffix}",
        "post_permalink": f"https://example.com/post/{suffix}",
        "platform_comment_id": f"comment-{suffix}" if strong else None,
        "comment_permalink": comment_permalink,
        "author_key": f"viewer-{suffix}",
        "author_display": f"Viewer {suffix}",
        "body": body,
        "body_complete": body_complete,
        "is_own": is_own,
        "has_own_reply": has_own_reply,
        "observed_at": observed_at,
        "language": language,
        "identity_confidence": "strong" if strong else "weak",
    }
    return normalize_comment(raw)


def draft_for(
    comment: dict, suffix: str, text: str = "謝謝你喜歡這一集！", *,
    occurred_at: str = "2026-08-28T10:01:00+08:00", session_id: str = "session-test",
    language: str = "zh-Hant", policy_version: int | None = None,
) -> dict:
    return normalize_reply_event({
        "event_type": "drafted",
        "comment_key": comment["comment_key"],
        "occurred_at": occurred_at,
        "session_id": session_id,
        "intent_id": f"intent-{suffix}",
        "reply_text": text,
        "classification": "positive_reaction",
        "risk": "low",
        "confidence": 0.99,
        "language": language,
        "policy_version": POLICY["policy_version"] if policy_version is None else policy_version,
    }, {comment["comment_key"]: comment})


def approval_for(
    comment: dict, draft: dict, suffix: str,
    occurred_at: str = "2026-08-28T10:02:00+08:00", *,
    approval_mode: str = "batch_confirm", grant_id: str | None = None,
    session_id: str = "session-test", permit_id: str | None = None,
) -> dict:
    return normalize_reply_event({
        "event_type": "approved",
        "comment_key": comment["comment_key"],
        "intent_id": draft["intent_id"],
        "occurred_at": occurred_at,
        "session_id": session_id,
        "approval_mode": approval_mode,
        "authorization_basis": (
            "current_session_user_instruction"
            if approval_mode == "bounded_auto"
            else "batch_confirm_user_confirmation"
        ),
        "grant_id": grant_id if approval_mode == "bounded_auto" else None,
        "permit_id": permit_id or f"permit-{suffix}",
        "expires_at": "2026-08-28T10:20:00+08:00",
        "one_shot": True,
        "reply_hash": draft["reply_hash"],
        "scope": {
            "platform": comment["platform"],
            "account_key": comment["account_key"],
            "post_key": comment["post_key"],
            "comment_key": comment["comment_key"],
        },
    }, {comment["comment_key"]: comment})


def grant_for(
    comment: dict, suffix: str, *, session_id: str = "session-test",
    occurred_at: str = "2026-08-28T10:01:30+08:00",
    expires_at: str = "2026-08-28T10:20:00+08:00", maximum_actions: int = 1,
    post_key: str | None = None,
) -> dict:
    return normalize_reply_event({
        "event_type": "session_granted",
        "occurred_at": occurred_at,
        "session_id": session_id,
        "grant_id": f"grant-{suffix}",
        "expires_at": expires_at,
        "maximum_actions": maximum_actions,
        "authorization_basis": "current_session_user_instruction",
        "scope": {
            "platform": comment["platform"],
            "account_key": comment["account_key"],
            "post_key": post_key or comment["post_key"],
        },
    }, {comment["comment_key"]: comment})


def revoke_grant_for(
    grant: dict, *, occurred_at: str = "2026-08-28T10:02:30+08:00",
    session_id: str | None = None,
) -> dict:
    return normalize_reply_event({
        "event_type": "session_revoked",
        "occurred_at": occurred_at,
        "session_id": session_id or grant["session_id"],
        "grant_id": grant["grant_id"],
        "reason_code": "user_revoked_current_session_authorization",
    }, {})


def send_start_for(
    comment: dict, draft: dict, approval: dict, suffix: str, *,
    occurred_at: str = "2026-08-28T10:03:00+08:00", session_id: str | None = None,
) -> dict:
    return normalize_reply_event({
        "event_type": "send_started",
        "comment_key": comment["comment_key"],
        "intent_id": draft["intent_id"],
        "occurred_at": occurred_at,
        "session_id": session_id or approval["session_id"],
        "permit_id": approval["permit_id"],
        "reply_hash": draft["reply_hash"],
        "comment_fingerprint": comment["raw_fingerprint"],
        "scope": approval["scope"],
        "attempt_key": f"attempt-{suffix}",
    }, {comment["comment_key"]: comment})


def finish_for(
    comment: dict, draft: dict, started: dict, event_type: str, *,
    occurred_at: str = "2026-08-28T10:04:00+08:00", session_id: str | None = None,
    attempt_session_id: str | None = None, evidence: str | None = None,
) -> dict:
    payload = {
        "event_type": event_type,
        "comment_key": comment["comment_key"],
        "intent_id": draft["intent_id"],
        "occurred_at": occurred_at,
        "session_id": session_id or started["session_id"],
        "attempt_session_id": attempt_session_id or started["session_id"],
        "attempt_key": started.get("attempt_key"),
    }
    if event_type == "sent_verified":
        payload["browser_evidence"] = evidence or "exact reply visible under target comment"
    elif event_type == "needs_reconcile":
        payload["reason_code"] = "browser_disconnected_after_click"
    elif event_type == "failed":
        payload["submission_possible"] = False
    elif event_type in {"reconciled_sent", "reconciled_not_sent"}:
        payload["browser_evidence"] = evidence or "target comment re-inspected in browser"
        payload["reconciliation_basis"] = "browser_reinspection"
    return normalize_reply_event(payload, {comment["comment_key"]: comment})


def assert_valid(comments: list[dict], replies: list[dict]) -> dict:
    result = validate_comment_store(comments, replies, POLICY)
    if not result["valid"]:
        raise AssertionError(result["errors"])
    return result


def assert_invalid(comments: list[dict], replies: list[dict], expected: str) -> None:
    result = validate_comment_store(comments, replies, POLICY)
    if result["valid"] or not any(expected in error for error in result["errors"]):
        raise AssertionError(f"expected invalid store containing {expected!r}: {result['errors']}")

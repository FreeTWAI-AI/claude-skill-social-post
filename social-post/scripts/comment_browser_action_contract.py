#!/usr/bin/env python3
"""Approved browser actions and read-only original-attempt recovery envelopes."""

from __future__ import annotations

from typing import Any

from comment_browser_common import _json_digest, _require_post_url, _required_digest, _required_string
from comment_browser_send_common import (
    _find_intent, _require_no_scope_reconciliation, _require_non_negative_integer,
)
from comment_canary import CANARY_ATTEMPT_FIELDS, canary_settlement_allowed
from comment_identity import stable_id
from comment_scan_provenance import browser_action_provenance_fields


def build_browser_action(
    latest_comments: dict[str, dict[str, Any]], states: dict[str, dict[str, Any]],
    intent_id: str, session_id: str,
) -> dict[str, Any]:
    """Build an immutable live-Chrome action envelope from an approved intent."""
    comment_key, state = _find_intent(states, intent_id)
    if state.get("status") != "approved":
        raise ValueError(f"browser action requires approved status, found {state.get('status')}")
    permit = state.get("permit") or {}
    if permit.get("session_id") != session_id:
        raise ValueError("browser action session does not match approval permit")
    _require_no_scope_reconciliation(states, state, intent_id, session_id)
    return _browser_action_from_ledger(latest_comments[comment_key], state, intent_id, session_id)


def _browser_action_from_ledger(
    comment: dict[str, Any], state: dict[str, Any], intent_id: str, session_id: str,
) -> dict[str, Any]:
    """Construct the unchanged action shape; callers enforce their own state gate."""
    permit = state.get("permit") or {}
    draft = state["draft"]
    anchor = {
        "platform_comment_id": comment.get("platform_comment_id"),
        "comment_permalink": comment.get("comment_permalink"),
    }
    action = {
        "schema_version": 1,
        "action_id": stable_id("browser-action", permit.get("permit_id"), intent_id),
        "intent_id": intent_id,
        "session_id": session_id,
        "permit_id": permit.get("permit_id"),
        "scope": permit.get("scope"),
        "post_permalink": comment["post_permalink"],
        "comment_anchor": anchor,
        "author_key": comment.get("author_key"),
        "author_display": comment.get("author_display"),
        "expected_body": comment["body"],
        "comment_fingerprint": comment["raw_fingerprint"],
        "reply_text": draft["reply_text"],
        "reply_hash": draft["reply_hash"],
        "expires_at": permit.get("expires_at"),
        "submission_boundary": "run browser-begin immediately before one submit action",
        "verification_rule": "exact own-account reply visible under the target comment",
    }
    provenance = comment.get("scan_provenance") or {}
    if provenance.get("evidence_scope") == "target_comment_receipt_continuity_only":
        action["observation_scope"] = "target_comment"
        action["observation_target"] = provenance.get("target")
    return {
        **action,
        **browser_action_provenance_fields(action, draft, comment),
    }


def _require_recovery_session(
    state: dict[str, Any], session_id: str,
) -> tuple[dict[str, Any], str, str]:
    if state.get("status") not in {"send_started", "needs_reconcile"}:
        raise ValueError("browser recovery action requires an authoritative uncertain send")
    attempt = state.get("attempt") or {}
    attempt_session_id = _required_string(attempt, "session_id")
    recovery_session_id = _required_string({"session_id": session_id}, "session_id")
    issuer = state.get("reconcile_capability") or state.get("last_event") or {}
    if recovery_session_id in {
        attempt_session_id, issuer.get("browser_reconcile_authorized_session_id"),
    }:
        raise ValueError("browser recovery action requires a fresh current session")
    return attempt, attempt_session_id, recovery_session_id


def _require_original_recovery_approval(
    reply_rows: list[dict[str, Any]], intent_id: str,
    attempt: dict[str, Any], attempt_session_id: str,
) -> dict[str, Any]:
    permit_id = _required_string(attempt, "permit_id")
    original_approvals = [
        row for row in reply_rows
        if row.get("event_type") == "approved" and row.get("intent_id") == intent_id
        and row.get("permit_id") == permit_id and row.get("session_id") == attempt_session_id
    ]
    if len(original_approvals) != 1:
        raise ValueError("browser recovery requires one original approval for the send attempt")
    return original_approvals[0]


def _require_original_recovery_action(
    comment: dict[str, Any], state: dict[str, Any], intent_id: str,
    attempt_session_id: str, attempt: dict[str, Any], original_approval: dict[str, Any],
) -> tuple[dict[str, Any], str]:
    attempt_scope = attempt.get("scope")
    if not isinstance(attempt_scope, dict):
        raise ValueError("browser recovery send attempt has no original scope")
    for key in ("platform", "account_key", "post_key", "comment_key"):
        if comment.get(key) != _required_string(attempt_scope, key):
            raise ValueError(f"browser recovery comment {key} differs from the original scope")
    # Replay consumes the permit at send_started. Reconstruct from the original
    # approval only in this temporary view; never restore an approved state.
    recovery_state = {**state, "permit": original_approval}
    action = _browser_action_from_ledger(comment, recovery_state, intent_id, attempt_session_id)
    action_digest = _required_digest(attempt, "browser_action_digest")
    if _json_digest(action) != action_digest:
        raise ValueError("browser recovery action digest differs from the original send attempt")
    for action_key, attempt_key in (
        ("action_id", "browser_action_id"), ("permit_id", "permit_id"),
        ("reply_hash", "reply_hash"), ("comment_fingerprint", "comment_fingerprint"),
        ("scope", "scope"),
    ):
        if action.get(action_key) != attempt.get(attempt_key):
            raise ValueError(f"browser recovery {action_key} differs from the original send attempt")
    _require_post_url(
        comment["platform"], _required_string(comment, "observed_parent_post_permalink"),
        action["post_permalink"], "observed_parent_post_permalink",
    )
    return action, action_digest


def _recovery_canary_fields(state: dict[str, Any], attempt: dict[str, Any]) -> dict[str, str]:
    if any(key in attempt for key in CANARY_ATTEMPT_FIELDS):
        if not canary_settlement_allowed(state):
            raise ValueError("browser recovery canary marker has no consumed canonical lease")
        return {
            "canary_lease_id": attempt["browser_canary_lease_id"],
            "canary_lease_digest": attempt["browser_canary_lease_digest"],
        }
    return {}


def build_browser_recovery_action(
    latest_comments: dict[str, dict[str, Any]], states: dict[str, dict[str, Any]],
    intent_id: str, session_id: str, *, reply_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    """Read the exact original action for reinspection, without creating authority."""
    comment_key, state = _find_intent(states, intent_id)
    attempt, attempt_session_id, recovery_session_id = _require_recovery_session(state, session_id)
    original_approval = _require_original_recovery_approval(
        reply_rows, intent_id, attempt, attempt_session_id,
    )
    action, action_digest = _require_original_recovery_action(
        latest_comments[comment_key], state, intent_id, attempt_session_id, attempt, original_approval,
    )
    baseline = _require_non_negative_integer(
        attempt.get("browser_baseline_total_reply_count"),
        "browser recovery attempt has no valid baseline total reply count",
    )
    preparation_id = _required_digest(attempt, "browser_preparation_id")
    canary_attempt = _recovery_canary_fields(state, attempt)
    return {
        "schema_version": 1, "decision": "RECONCILE_ONLY", "operation": "browser-reconcile",
        "recovery_session_id": recovery_session_id,
        "action": action,
        "preparation": {
            "test_only": False, "action_id": action["action_id"],
            "permit_id": action["permit_id"], "reply_hash": action["reply_hash"],
            "scope": action["scope"], "action_digest": action_digest,
            "plan_digest": _required_digest(attempt, "browser_plan_digest"),
            "preparation_id": preparation_id, "baseline_total_reply_count": baseline,
        },
        "attempt": {
            "action_id": action["action_id"], "preparation_id": preparation_id,
            "claim_id": _required_string(attempt, "browser_submit_claim_id"),
            "preflight_id": _required_string(attempt, "browser_preflight_id"),
            "attempt_session_id": attempt_session_id,
            **canary_attempt,
        },
    }

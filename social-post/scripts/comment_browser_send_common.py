#!/usr/bin/env python3
"""Shared browser-send flags, intent scope, observation URL, and count checks."""

from __future__ import annotations

from typing import Any

from comment_browser_common import (
    _require_comment_permalink_for_post, _require_platform_url, _require_post_url,
    _required_string,
)


RESULT_FLAGS = (
    "account_verified", "post_verified", "target_verified",
    "parent_verified", "exact_reply_visible", "own_author_verified",
)
REINSPECTION_CONTEXT_FLAGS = (
    "account_verified", "post_verified", "target_verified", "parent_verified",
)
PREFLIGHT_FLAGS = (
    "account_verified", "post_verified", "target_verified",
    "body_complete", "composer_empty_before_fill", "composer_matches_reply",
    "reply_control_verified",
)
CANARY_COMPOSER_FIELDS = (
    "composer_initial_state", "composer_initial_text",
    "selected_parent_evidence", "selected_parent_evidence_digest",
)


def _find_intent(
    states: dict[str, dict[str, Any]], intent_id: str,
) -> tuple[str, dict[str, Any]]:
    matches = [(key, state) for key, state in states.items() if state.get("intent_id") == intent_id]
    if len(matches) != 1:
        raise ValueError(f"expected one active intent_id {intent_id}, found {len(matches)}")
    return matches[0]


def _scope_key(scope: Any) -> tuple[Any, Any, Any]:
    if not isinstance(scope, dict):
        return (None, None, None)
    return tuple(scope.get(key) for key in ("platform", "account_key", "post_key"))


def _require_no_scope_reconciliation(
    states: dict[str, dict[str, Any]], target_state: dict[str, Any],
    target_intent_id: str, session_id: str,
) -> None:
    """Stop a run while another send in the same session/scope is uncertain."""
    target_scope = (target_state.get("permit") or {}).get("scope")
    if _scope_key(target_scope) == (None, None, None):
        return
    for state in states.values():
        if state.get("intent_id") == target_intent_id:
            continue
        if state.get("status") != "needs_reconcile":
            continue
        attempt = state.get("attempt") or {}
        reconcile_issuer = state.get("reconcile_capability") or {}
        active_sessions = {
            attempt.get("session_id"),
            reconcile_issuer.get("browser_reconcile_authorized_session_id"),
        }
        if session_id not in active_sessions:
            continue
        if _scope_key(attempt.get("scope")) == _scope_key(target_scope):
            raise ValueError(
                "browser scope is halted by active needs_reconcile intent "
                f"{state.get('intent_id')}; reconcile it before another action"
            )


def _require_send_observed_url(comment: dict[str, Any], observed_url: str) -> str:
    """Allow the approved post (including IG aliases) or its stored reply anchor.

    Threads reply pages show the original parent and target comment together.
    Their separate path is acceptable only when the ledger already binds that
    exact query-free anchor to the approved parent; receipt fields cannot add a
    new target. Instagram's native anchor must bind the same shortcode and
    stored comment ID. Facebook retains the original post-only rule.
    """
    platform = comment["platform"]
    post_permalink = comment["post_permalink"]
    if platform in {"threads", "instagram"} and comment.get("comment_permalink"):
        stored_anchor = _require_comment_permalink_for_post(
            platform, _required_string(comment, "comment_permalink"), post_permalink,
            comment.get("platform_comment_id"),
        )
        current = _require_platform_url(platform, observed_url, "observed_url")
        if current == stored_anchor:
            _require_post_url(
                platform, _required_string(comment, "observed_parent_post_permalink"),
                post_permalink, "observed_parent_post_permalink",
            )
            return current
    return _require_post_url(platform, observed_url, post_permalink, "observed_url")


def _require_non_negative_integer(value: Any, message: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(message)
    return value

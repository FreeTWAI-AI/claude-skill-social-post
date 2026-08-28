#!/usr/bin/env python3
"""Orchestrate comment schema validation, state replay, and policy queueing."""

from __future__ import annotations

from typing import Any

from comment_domain import replay_reply_events, validate_comment_events
from comment_policy import build_queue, validate_policy


def validate_comment_store(
    comment_rows: list[dict[str, Any]], reply_rows: list[dict[str, Any]], policy: dict[str, Any],
) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    validate_policy(policy, errors)
    latest = validate_comment_events(comment_rows, errors, warnings)
    states, authorization_grants = replay_reply_events(
        reply_rows, comment_rows, errors, warnings,
        maximum_actions_limit=policy.get("maximum_actions_per_run"),
    )
    queue = None
    if not errors:
        queue = build_queue(latest, states, policy)
    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "latest_comments": latest,
        "reply_states": states,
        "authorization_grants": authorization_grants,
        "queue": queue,
    }

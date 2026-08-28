#!/usr/bin/env python3
"""Policy validation and bounded-auto eligibility for comment reply queues."""

from __future__ import annotations

import re
from typing import Any

from comment_domain import TERMINAL_STATES, normalized_text


URL_PATTERN = re.compile(r"(?:https?://|www\.)", re.IGNORECASE)
MODES = {"draft_only", "batch_confirm", "bounded_auto"}
UNKNOWN_LANGUAGES = {"", "und", "unknown"}


def validate_policy(policy: dict[str, Any], errors: list[str]) -> None:
    if policy.get("schema_version") != 1:
        errors.append("comment policy schema_version must be 1")
    if policy.get("default_mode") not in MODES:
        errors.append("comment policy default_mode is invalid")
    version = policy.get("policy_version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        errors.append("comment policy policy_version must be a positive integer")
    for name in ("auto_classifications", "review_required_classifications"):
        value = policy.get(name)
        if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
            errors.append(f"comment policy {name} must be a list of non-empty strings")
    confidence = policy.get("minimum_auto_confidence")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not 0 <= confidence <= 1:
        errors.append("comment policy minimum_auto_confidence must be from 0..1")
    maximum = policy.get("maximum_actions_per_run")
    if not isinstance(maximum, int) or isinstance(maximum, bool) or maximum < 1:
        errors.append("comment policy maximum_actions_per_run must be a positive integer")
    scan_maximum = policy.get("maximum_comments_per_scan", 100)
    if not isinstance(scan_maximum, int) or isinstance(scan_maximum, bool) or scan_maximum < 1:
        errors.append("comment policy maximum_comments_per_scan must be a positive integer")
    scan_age = policy.get("maximum_browser_scan_age_seconds", 300)
    if not isinstance(scan_age, int) or isinstance(scan_age, bool) or scan_age < 1:
        errors.append(
            "comment policy maximum_browser_scan_age_seconds must be a positive integer"
        )
    preflight_maximum = policy.get("maximum_browser_preflight_age_seconds", 60)
    if (
        not isinstance(preflight_maximum, int)
        or isinstance(preflight_maximum, bool)
        or preflight_maximum < 1
    ):
        errors.append(
            "comment policy maximum_browser_preflight_age_seconds must be a positive integer"
        )
    result_maximum = policy.get("maximum_browser_result_age_seconds", 300)
    if (
        not isinstance(result_maximum, int)
        or isinstance(result_maximum, bool)
        or result_maximum < 1
    ):
        errors.append(
            "comment policy maximum_browser_result_age_seconds must be a positive integer"
        )
    max_chars = policy.get("maximum_reply_characters")
    if not isinstance(max_chars, int) or isinstance(max_chars, bool) or max_chars < 1:
        errors.append("comment policy maximum_reply_characters must be a positive integer")
    for name in (
        "live_browser_actuation_enabled", "allow_external_links_auto",
        "allow_private_messages", "allow_media_replies",
    ):
        if not isinstance(policy.get(name), bool):
            errors.append(f"comment policy {name} must be boolean")


def _auto_reasons(
    comment: dict[str, Any], state: dict[str, Any] | None, policy: dict[str, Any], mode: str,
) -> list[str]:
    reasons: list[str] = []
    if mode != "bounded_auto":
        reasons.append("mode_requires_confirmation")
    if comment.get("identity_confidence") != "strong":
        reasons.append("weak_comment_identity")
    if not comment.get("body_complete"):
        reasons.append("incomplete_comment_body")
    if comment.get("is_own"):
        reasons.append("own_comment")
    if comment.get("has_own_reply"):
        reasons.append("already_replied")
    if state is None or state.get("status") != "drafted":
        reasons.append("no_current_draft")
        return reasons
    draft = state["draft"]
    if draft.get("comment_fingerprint") != comment.get("raw_fingerprint"):
        reasons.append("stale_draft")
    if draft.get("classification") not in policy.get("auto_classifications", []):
        reasons.append("classification_not_allowlisted")
    if draft.get("classification") in policy.get("review_required_classifications", []):
        reasons.append("classification_requires_review")
    if draft.get("risk") != "low":
        reasons.append("risk_not_low")
    if draft.get("policy_version") != policy.get("policy_version"):
        reasons.append("policy_version_mismatch")
    comment_language = str(comment.get("language") or "").strip().casefold()
    draft_language = str(draft.get("language") or "").strip().casefold()
    if comment_language in UNKNOWN_LANGUAGES:
        reasons.append("unknown_comment_language")
    elif draft_language in UNKNOWN_LANGUAGES:
        reasons.append("unknown_draft_language")
    elif comment_language != draft_language:
        reasons.append("reply_language_mismatch")
    if float(draft.get("confidence", 0)) < float(policy.get("minimum_auto_confidence", 1)):
        reasons.append("confidence_below_threshold")
    text = str(draft.get("reply_text", ""))
    if len(text) > int(policy.get("maximum_reply_characters", 1)):
        reasons.append("reply_too_long")
    if URL_PATTERN.search(text) and not policy.get("allow_external_links_auto", False):
        reasons.append("external_link_requires_review")
    return reasons


def build_queue(
    comments: dict[str, dict[str, Any]], states: dict[str, dict[str, Any]],
    policy: dict[str, Any], mode: str | None = None,
) -> dict[str, Any]:
    selected_mode = mode or policy["default_mode"]
    if selected_mode not in MODES:
        raise ValueError(f"invalid comment mode: {selected_mode}")
    items: list[dict[str, Any]] = []
    duplicate_text: dict[str, int] = {}
    for state in states.values():
        if isinstance(state.get("draft"), dict):
            text = normalized_text(str(state["draft"].get("reply_text", ""))).casefold()
            duplicate_text[text] = duplicate_text.get(text, 0) + 1
    for comment_key, comment in sorted(comments.items(), key=lambda row: row[1]["observed_at"]):
        state = states.get(comment_key)
        status = state.get("status") if state else "untriaged"
        if status in TERMINAL_STATES:
            continue
        reasons = _auto_reasons(comment, state, policy, selected_mode)
        if state and state.get("status") == "drafted":
            text_key = normalized_text(str(state["draft"].get("reply_text", ""))).casefold()
            if duplicate_text.get(text_key, 0) > 1:
                reasons.append("repeated_reply_text")
        items.append({
            "comment_key": comment_key,
            "platform": comment["platform"],
            "account_key": comment["account_key"],
            "post_key": comment["post_key"],
            "post_permalink": comment["post_permalink"],
            "author_display": comment.get("author_display"),
            "body": comment["body"],
            "language": comment.get("language"),
            "identity_confidence": comment["identity_confidence"],
            "raw_fingerprint": comment["raw_fingerprint"],
            "status": status,
            "intent_id": state.get("intent_id") if state else None,
            "draft": state.get("draft") if state else None,
            "bounded_auto_eligible": not reasons,
            "gate_reasons": sorted(set(reasons)),
        })
    eligible = [item for item in items if item["bounded_auto_eligible"]]
    maximum = int(policy["maximum_actions_per_run"])
    return {
        "mode": selected_mode,
        "items": items,
        "bounded_auto_candidates": eligible[:maximum],
        "bounded_auto_deferred_count": max(0, len(eligible) - maximum),
        "maximum_actions_per_run": maximum,
    }

#!/usr/bin/env python3
"""Browser reply action, preflight, result, and reinspection contracts."""

from __future__ import annotations

from typing import Any

from comment_browser_common import (
    _json_digest, _require_comment_permalink_for_post, _require_live_receipt,
    _require_platform_url, _require_post_url, _require_recent_observation,
    _require_schema_version, _required_digest,
    _required_boolean, _required_string,
)
from comment_domain import stable_id
from comment_scan_provenance import (
    ACTION_PROVENANCE_DIGEST_FIELD,
    DRAFT_PROVENANCE_DIGEST_FIELD,
    SCAN_PROVENANCE_DIGEST_FIELD,
    browser_action_provenance_fields,
)
from social_validation import parse_time


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
    return {
        **action,
        **browser_action_provenance_fields(action, draft, comment),
    }


def build_browser_recovery_action(
    latest_comments: dict[str, dict[str, Any]], states: dict[str, dict[str, Any]],
    intent_id: str, session_id: str, *, reply_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    """Read the exact original action for reinspection, without creating authority."""
    comment_key, state = _find_intent(states, intent_id)
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
    permit_id = _required_string(attempt, "permit_id")
    original_approvals = [
        row for row in reply_rows
        if row.get("event_type") == "approved" and row.get("intent_id") == intent_id
        and row.get("permit_id") == permit_id and row.get("session_id") == attempt_session_id
    ]
    if len(original_approvals) != 1:
        raise ValueError("browser recovery requires one original approval for the send attempt")
    comment = latest_comments[comment_key]
    attempt_scope = attempt.get("scope")
    if not isinstance(attempt_scope, dict):
        raise ValueError("browser recovery send attempt has no original scope")
    for key in ("platform", "account_key", "post_key", "comment_key"):
        if comment.get(key) != _required_string(attempt_scope, key):
            raise ValueError(f"browser recovery comment {key} differs from the original scope")
    # Replay consumes the permit at send_started. Reconstruct from the original
    # approval only in this temporary view; never restore an approved state.
    recovery_state = {**state, "permit": original_approvals[0]}
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
    baseline = _require_non_negative_integer(
        attempt.get("browser_baseline_total_reply_count"),
        "browser recovery attempt has no valid baseline total reply count",
    )
    preparation_id = _required_digest(attempt, "browser_preparation_id")
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
        },
    }


def _require_action_binding(
    raw: dict[str, Any], state: dict[str, Any], comment: dict[str, Any],
    intent_id: str, session_id: str,
) -> None:
    permit = state.get("permit") or {}
    expected_action_id = stable_id("browser-action", permit.get("permit_id"), intent_id)
    if raw.get("action_id") != expected_action_id:
        raise ValueError("browser preflight action_id differs from approved action")
    if raw.get("intent_id") != intent_id or raw.get("session_id") != session_id:
        raise ValueError("browser preflight identity differs from current action")
    if raw.get("permit_id") != permit.get("permit_id"):
        raise ValueError("browser preflight permit differs from approval")
    if raw.get("scope") != permit.get("scope"):
        raise ValueError("browser preflight scope differs from approval")
    if raw.get("comment_fingerprint") != comment.get("raw_fingerprint"):
        raise ValueError("browser preflight comment fingerprint differs from observation")
    if raw.get("reply_hash") != state.get("draft", {}).get("reply_hash"):
        raise ValueError("browser preflight reply hash differs from approved draft")


def _require_preparation_binding(
    raw: dict[str, Any], expected_action: dict[str, Any],
) -> dict[str, Any]:
    action_digest = _required_digest(raw, "action_digest")
    if action_digest != _json_digest(expected_action):
        raise ValueError("browser preflight action_digest differs from approved action")
    plan_digest = _required_digest(raw, "plan_digest")
    exact_count = raw.get("baseline_exact_reply_count")
    total_count = raw.get("baseline_total_reply_count")
    if not isinstance(exact_count, int) or isinstance(exact_count, bool) or exact_count != 0:
        raise ValueError("browser preflight requires a zero exact-own reply baseline")
    if not isinstance(total_count, int) or isinstance(total_count, bool) or total_count < 0:
        raise ValueError("browser preflight baseline_total_reply_count must be non-negative")
    core = {
        "action_digest": action_digest,
        "plan_digest": plan_digest,
        "observed_url": _required_string(raw, "observed_url"),
        "observed_at": _required_string(raw, "observed_at"),
        "baseline_exact_reply_count": exact_count,
        "baseline_total_reply_count": total_count,
        "test_only": False,
    }
    preparation_id = _required_digest(raw, "preparation_id")
    if preparation_id != _json_digest(core):
        raise ValueError("browser preflight preparation_id integrity check failed")
    return {
        "action_digest": action_digest,
        "plan_digest": plan_digest,
        "preparation_id": preparation_id,
        "baseline_exact_reply_count": exact_count,
        "baseline_total_reply_count": total_count,
    }


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


def validate_browser_preflight(
    raw: dict[str, Any], latest_comments: dict[str, dict[str, Any]],
    states: dict[str, dict[str, Any]], policy: dict[str, Any],
    intent_id: str, session_id: str,
) -> dict[str, Any]:
    """Validate a fresh, read-only Chrome preflight before send_started."""
    if not isinstance(raw, dict):
        raise ValueError("browser preflight must be a JSON object")
    _require_schema_version(raw, "browser preflight")
    _require_live_receipt(raw, "browser preflight")
    comment_key, state = _find_intent(states, intent_id)
    if state.get("status") != "approved":
        raise ValueError(f"browser preflight requires approved status, found {state.get('status')}")
    permit = state.get("permit") or {}
    if permit.get("session_id") != session_id:
        raise ValueError("browser preflight session differs from approval")
    _require_no_scope_reconciliation(states, state, intent_id, session_id)
    comment = latest_comments[comment_key]
    _require_action_binding(raw, state, comment, intent_id, session_id)
    expected_action = build_browser_action(latest_comments, states, intent_id, session_id)
    _require_send_observed_url(comment, _required_string(raw, "observed_url"))
    observed_at = _require_recent_observation(
        raw, policy, "maximum_browser_preflight_age_seconds", 60, "browser preflight",
    )
    observed = parse_time(observed_at)
    if observed < parse_time(_required_string(permit, "occurred_at")):
        raise ValueError("browser preflight predates approval")
    if observed > parse_time(_required_string(permit, "expires_at")):
        raise ValueError("browser preflight occurred after permit expiry")
    preparation = _require_preparation_binding(raw, expected_action)
    for key in PREFLIGHT_FLAGS:
        if not _required_boolean(raw, key):
            raise ValueError(f"browser preflight {key} was not verified")
    evidence = _required_string(raw, "evidence")
    preflight_id = stable_id(
        "browser-preflight", intent_id, preparation["preparation_id"], observed_at, evidence,
    )
    return {
        "preflight_id": preflight_id,
        "action_id": raw["action_id"],
        "observed_at": observed_at,
        "evidence": evidence,
        "comment_key": comment_key,
        "comment": comment,
        "state": state,
        **preparation,
        SCAN_PROVENANCE_DIGEST_FIELD: expected_action[SCAN_PROVENANCE_DIGEST_FIELD],
        DRAFT_PROVENANCE_DIGEST_FIELD: expected_action[DRAFT_PROVENANCE_DIGEST_FIELD],
        ACTION_PROVENANCE_DIGEST_FIELD: expected_action[ACTION_PROVENANCE_DIGEST_FIELD],
    }


def _result_scope_matches(
    value: dict[str, Any], state: dict[str, Any], comment: dict[str, Any],
) -> None:
    attempt = state.get("attempt") or {}
    if value.get("action_id") != attempt.get("browser_action_id"):
        raise ValueError("browser result action_id differs from send attempt")
    if value.get("preflight_id") != attempt.get("browser_preflight_id"):
        raise ValueError("browser result preflight_id differs from send attempt")
    expected = attempt.get("scope")
    if value.get("scope") != expected:
        raise ValueError("browser result scope differs from send attempt")
    if value.get("comment_fingerprint") != comment.get("raw_fingerprint"):
        raise ValueError("browser result comment fingerprint differs from latest observation")
    if value.get("reply_hash") != state.get("draft", {}).get("reply_hash"):
        raise ValueError("browser result reply hash differs from approved draft")
    if value.get("preparation_id") != attempt.get("browser_preparation_id"):
        raise ValueError("browser result preparation_id differs from send attempt")
    if value.get("claim_id") != attempt.get("browser_submit_claim_id"):
        raise ValueError("browser result claim_id differs from send attempt")


def classify_browser_result(
    raw: dict[str, Any], latest_comments: dict[str, dict[str, Any]],
    states: dict[str, dict[str, Any]], policy: dict[str, Any],
    intent_id: str, session_id: str,
) -> dict[str, Any]:
    """Convert structured post-submit browser evidence to a ledger outcome."""
    if not isinstance(raw, dict):
        raise ValueError("browser result must be a JSON object")
    _require_schema_version(raw, "browser result")
    _require_live_receipt(raw, "browser result")
    comment_key, state = _find_intent(states, intent_id)
    if state.get("status") != "send_started":
        raise ValueError(f"browser result requires send_started, found {state.get('status')}")
    attempt = state.get("attempt") or {}
    if attempt.get("session_id") != session_id:
        raise ValueError("browser result session differs from original send attempt")
    if raw.get("intent_id") != intent_id or raw.get("session_id") != session_id:
        raise ValueError("browser result identity differs from current action")
    comment = latest_comments[comment_key]
    _result_scope_matches(raw, state, comment)
    _require_send_observed_url(comment, _required_string(raw, "observed_url"))
    observed_at = _require_recent_observation(
        raw, policy, "maximum_browser_result_age_seconds", 300, "browser result",
    )
    if parse_time(observed_at) < parse_time(str(attempt.get("occurred_at", ""))):
        raise ValueError("browser result predates send_started")
    attempted = _required_boolean(raw, "submission_attempted")
    possible = _required_boolean(raw, "submission_possible")
    evidence = _required_string(raw, "evidence")
    flags = [_required_boolean(raw, key) for key in RESULT_FLAGS]
    post_submit_total_reply_count = raw.get("post_submit_total_reply_count")
    if (
        not isinstance(post_submit_total_reply_count, int)
        or isinstance(post_submit_total_reply_count, bool)
        or post_submit_total_reply_count < 0
    ):
        raise ValueError(
            "browser result post-submit total reply count must be a non-negative integer"
        )
    baseline_total_reply_count = attempt.get("browser_baseline_total_reply_count")
    if (
        not isinstance(baseline_total_reply_count, int)
        or isinstance(baseline_total_reply_count, bool)
        or baseline_total_reply_count < 0
    ):
        raise ValueError("browser send attempt has no valid baseline total reply count")
    count_supports_new_reply = (
        post_submit_total_reply_count >= baseline_total_reply_count + 1
    )
    if attempted and possible and all(flags) and count_supports_new_reply:
        return {"result": "sent", "evidence": evidence, "observed_at": observed_at}
    exact_reply_visible = flags[RESULT_FLAGS.index("exact_reply_visible")]
    own_author_verified = flags[RESULT_FLAGS.index("own_author_verified")]
    if (
        not attempted and not possible
        and not exact_reply_visible and not own_author_verified
    ):
        return {"result": "failed", "evidence": evidence, "observed_at": observed_at}
    return {
        "result": "unknown",
        "evidence": evidence,
        "observed_at": observed_at,
        "reason": "browser_result_uncertain_after_submission" if attempted else "browser_preflight_state_changed",
    }


def _require_non_negative_integer(value: Any, message: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(message)
    return value


def _require_reinspection_evidence_flags(
    raw: dict[str, Any],
) -> tuple[bool, bool, bool]:
    for key in REINSPECTION_CONTEXT_FLAGS:
        if not _required_boolean(raw, key):
            raise ValueError(f"browser reinspection {key} was not verified")
    return tuple(
        _required_boolean(raw, key)
        for key in ("exact_reply_visible", "own_author_verified", "absence_verified")
    )


def classify_browser_reinspection(
    raw: dict[str, Any], latest_comments: dict[str, dict[str, Any]],
    states: dict[str, dict[str, Any]], policy: dict[str, Any],
    intent_id: str, session_id: str,
) -> dict[str, Any]:
    """Classify a fresh reinspection without allowing an uncertain duplicate send."""
    if not isinstance(raw, dict):
        raise ValueError("browser reinspection must be a JSON object")
    _require_schema_version(raw, "browser reinspection")
    _require_live_receipt(raw, "browser reinspection")
    comment_key, state = _find_intent(states, intent_id)
    if state.get("status") != "needs_reconcile":
        raise ValueError(
            f"browser reinspection requires needs_reconcile, found {state.get('status')}"
        )
    attempt = state.get("attempt") or {}
    if raw.get("intent_id") != intent_id or raw.get("session_id") != session_id:
        raise ValueError("browser reinspection identity differs from current action")
    if raw.get("attempt_session_id") != attempt.get("session_id"):
        raise ValueError("browser reinspection attempt_session_id differs from send attempt")
    comment = latest_comments[comment_key]
    _result_scope_matches(raw, state, comment)
    _require_send_observed_url(comment, _required_string(raw, "observed_url"))
    observed_at = _require_recent_observation(
        raw, policy, "maximum_browser_result_age_seconds", 300,
        "browser reinspection",
    )
    if parse_time(observed_at) < parse_time(str(attempt.get("occurred_at", ""))):
        raise ValueError("browser reinspection predates send_started")
    exact, own, absent = _require_reinspection_evidence_flags(raw)
    own_author_reply_count = _require_non_negative_integer(
        raw.get("own_author_reply_count"),
        "browser reinspection own_author_reply_count must be a non-negative integer",
    )
    reinspection_total_reply_count = _require_non_negative_integer(
        raw.get("reinspection_total_reply_count"),
        "browser reinspection total reply count must be a non-negative integer",
    )
    baseline_total_reply_count = _require_non_negative_integer(
        attempt.get("browser_baseline_total_reply_count"),
        "browser send attempt has no valid baseline total reply count",
    )
    if own_author_reply_count > reinspection_total_reply_count:
        raise ValueError(
            "browser reinspection own-author reply count exceeds total reply count"
        )
    if exact != own:
        raise ValueError(
            "browser reinspection exact reply and own-author verification must agree"
        )
    if exact and own_author_reply_count < 1:
        raise ValueError(
            "browser reinspection exact own reply requires a positive own-author reply count"
        )
    count_at_or_above_baseline = (
        reinspection_total_reply_count >= baseline_total_reply_count
    )
    count_supports_new_reply = (
        reinspection_total_reply_count >= baseline_total_reply_count + 1
    )
    verified_absence = (
        count_at_or_above_baseline
        and own_author_reply_count == 0 and not exact and not own
    )
    if absent != verified_absence:
        raise ValueError(
            "browser reinspection absence_verified conflicts with own-account reply evidence"
        )
    evidence = _required_string(raw, "evidence")
    base = {"evidence": evidence, "observed_at": observed_at}
    if exact and own and count_supports_new_reply:
        return {**base, "result": "sent"}
    if verified_absence:
        return {**base, "result": "not-sent"}
    return {**base, "result": "unknown", "reason": "browser_reinspection_uncertain"}

#!/usr/bin/env python3
"""Reply-event schema and state replay, with backward-compatible public exports."""

from __future__ import annotations

from typing import Any

from comment_authorization import (
    APPROVAL_MODES,
    AUTHORIZATION_BASES,
    GRANT_EVENT_TYPES,
    apply_grant_event,
    consume_grant_action,
    event_time_is_monotonic,
    require_non_empty_strings,
    validate_approval_shape,
    validate_bounded_approval,
    validate_grant_shape,
    validate_scope,
)
from comment_identity import (
    IDENTITY_CONFIDENCE,
    PLATFORMS,
    comment_fingerprint,
    normalize_comment,
    normalized_text,
    reply_hash,
    stable_id,
    validate_comment_events,
)
from social_validation import parse_time


RISK_LEVELS = {"low", "medium", "high"}
REPLY_EVENT_TYPES = {
    "drafted", "approved", "send_started", "sent_verified", "needs_reconcile",
    "reconciled_sent", "reconciled_not_sent", "failed", "deferred", "skipped", "revoked",
}
EVENT_TYPES = REPLY_EVENT_TYPES | GRANT_EVENT_TYPES
TERMINAL_STATES = {"sent_verified", "reconciled_sent", "skipped"}


def normalize_reply_event(
    raw: dict[str, Any], latest_comments: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    value = dict(raw)
    event_type = str(value.get("event_type", "")).strip()
    occurred_at = str(value.get("occurred_at", "")).strip()
    comment_key = str(value.get("comment_key", "")).strip()
    result = dict(value)
    result.update({
        "schema_version": 1, "event_type": event_type,
        "occurred_at": occurred_at, "comment_key": comment_key,
    })
    if event_type == "session_granted":
        _normalize_grant_event(result, value, occurred_at)
    elif event_type == "drafted":
        _normalize_draft_event(result, value, latest_comments.get(comment_key, {}))
    result["audit_id"] = value.get("audit_id") or stable_id(
        "reply-audit", event_type, result.get("intent_id"), comment_key, occurred_at,
        result.get("reply_hash"), result.get("permit_id"), result.get("grant_id"),
    )
    return result


def _normalize_grant_event(
    result: dict[str, Any], value: dict[str, Any], occurred_at: str,
) -> None:
    scope = value.get("scope") if isinstance(value.get("scope"), dict) else {}
    result["scope"] = {
        "platform": str(scope.get("platform", "")).lower().strip(),
        "account_key": str(scope.get("account_key", "")).strip(),
        "post_key": str(scope.get("post_key", "")).strip(),
    }
    result["grant_id"] = value.get("grant_id") or stable_id(
        "session-grant", value.get("session_id"), result["scope"], occurred_at,
    )


def _normalize_draft_event(
    result: dict[str, Any], value: dict[str, Any], comment: dict[str, Any],
) -> None:
    text = normalized_text(str(value.get("reply_text", "")))
    result["reply_text"] = text
    result["reply_hash"] = value.get("reply_hash") or reply_hash(text)
    result["comment_fingerprint"] = (
        value.get("comment_fingerprint") or comment.get("raw_fingerprint")
    )
    result["intent_id"] = value.get("intent_id") or stable_id(
        "reply-intent", result["comment_key"], result["occurred_at"], result["reply_hash"],
    )
    result.setdefault("policy_version", 1)


def _validate_draft_shape(row: dict[str, Any], label: str, errors: list[str]) -> None:
    required = (
        "reply_text", "reply_hash", "classification", "risk", "confidence",
        "comment_fingerprint", "language", "policy_version",
    )
    for key in required:
        if key not in row:
            errors.append(f"{label} drafted event missing {key}")
    text = row.get("reply_text")
    if not isinstance(text, str) or not text:
        errors.append(f"{label} reply_text must be non-empty")
    elif "\n" in text or "\r" in text:
        errors.append(f"{label} reply_text must be a single line")
    elif row.get("reply_hash") != reply_hash(text):
        errors.append(f"{label} reply_hash does not match reply_text")
    if row.get("risk") not in RISK_LEVELS:
        errors.append(f"{label} risk must be one of {sorted(RISK_LEVELS)}")
    confidence = row.get("confidence")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
        errors.append(f"{label} confidence must be from 0..1")
    elif not 0 <= confidence <= 1:
        errors.append(f"{label} confidence must be from 0..1")
    if not isinstance(row.get("language"), str) or not row.get("language", "").strip():
        errors.append(f"{label} language must be a non-empty string")
    version = row.get("policy_version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        errors.append(f"{label} policy_version must be a positive integer")


def _validate_outcome_shape(
    row: dict[str, Any], event_type: str, label: str, errors: list[str],
) -> None:
    if event_type == "send_started":
        required = ("permit_id", "session_id", "reply_hash", "comment_fingerprint", "scope")
        for key in required:
            if key not in row:
                errors.append(f"{label} send_started event missing {key}")
        validate_scope(row.get("scope"), label, errors, include_comment=True)
    elif event_type == "sent_verified":
        require_non_empty_strings(row, ("session_id", "browser_evidence"), label, errors)
    elif event_type in {"reconciled_sent", "reconciled_not_sent"}:
        require_non_empty_strings(
            row, ("session_id", "attempt_session_id", "browser_evidence"), label, errors,
        )
        if row.get("reconciliation_basis") != "browser_reinspection":
            errors.append(f"{label} reconciliation_basis must be browser_reinspection")
    else:
        _validate_other_outcome(row, event_type, label, errors)


def _validate_other_outcome(
    row: dict[str, Any], event_type: str, label: str, errors: list[str],
) -> None:
    if event_type == "failed":
        require_non_empty_strings(row, ("session_id",), label, errors)
        if row.get("submission_possible") is not False:
            errors.append(f"{label} failed is allowed only when submission_possible is false")
    elif event_type == "needs_reconcile":
        require_non_empty_strings(row, ("session_id", "reason_code"), label, errors)
    elif event_type in {"deferred", "skipped", "revoked"}:
        require_non_empty_strings(row, ("reason_code",), label, errors)


def _validate_reply_event_shape(row: dict[str, Any], label: str, errors: list[str]) -> None:
    event_type = row.get("event_type")
    require_non_empty_strings(row, ("audit_id", "event_type", "occurred_at"), label, errors)
    if event_type not in GRANT_EVENT_TYPES:
        require_non_empty_strings(row, ("intent_id", "comment_key"), label, errors)
    if event_type not in EVENT_TYPES:
        errors.append(f"{label} invalid event_type {event_type}")
    try:
        parse_time(row.get("occurred_at", ""))
    except ValueError:
        errors.append(f"{label} occurred_at must be ISO 8601 with UTC offset")
    if event_type in GRANT_EVENT_TYPES:
        validate_grant_shape(row, str(event_type), label, errors)
    elif event_type == "drafted":
        _validate_draft_shape(row, label, errors)
    elif event_type == "approved":
        validate_approval_shape(row, label, errors)
    else:
        _validate_outcome_shape(row, str(event_type), label, errors)


def _comment_at(
    observations: dict[str, list[dict[str, Any]]], comment_key: str, occurred_at: str,
) -> dict[str, Any] | None:
    moment = parse_time(occurred_at)
    eligible = [
        row for row in observations.get(comment_key, [])
        if parse_time(row["observed_at"]) <= moment
    ]
    return max(eligible, key=lambda row: parse_time(row["observed_at"])) if eligible else None


def _approval_scope(comment: dict[str, Any] | None, comment_key: str) -> dict[str, Any]:
    return {
        "platform": comment.get("platform") if comment else None,
        "account_key": comment.get("account_key") if comment else None,
        "post_key": comment.get("post_key") if comment else None,
        "comment_key": comment_key,
    }


def _validate_comment_guards(
    comment: dict[str, Any] | None, draft: dict[str, Any],
    label: str, errors: list[str],
) -> None:
    if comment is None or draft.get("comment_fingerprint") != comment.get("raw_fingerprint"):
        errors.append(f"{label} draft became stale before approval")
    if comment is None:
        return
    if not comment.get("body_complete"):
        errors.append(f"{label} cannot approve an incomplete comment body")
    if comment.get("is_own"):
        errors.append(f"{label} cannot approve a reply to own comment")
    if comment.get("has_own_reply"):
        errors.append(f"{label} cannot approve a comment that already has own reply")


def _validate_approval_context(
    draft: dict[str, Any], row: dict[str, Any], comment: dict[str, Any] | None,
    expected: dict[str, Any], label: str, errors: list[str],
) -> None:
    if row.get("reply_hash") != draft.get("reply_hash"):
        errors.append(f"{label} approval reply_hash differs from draft")
    if row.get("scope") != expected:
        errors.append(f"{label} approval scope does not match visible comment")
    _validate_comment_guards(comment, draft, label, errors)


def _apply_approval(
    current: dict[str, Any], row: dict[str, Any], comment_key: str,
    observations: dict[str, list[dict[str, Any]]],
    grants: dict[str, dict[str, Any]], label: str, errors: list[str],
) -> None:
    initial_error_count = len(errors)
    status = current.get("status")
    if status not in {"drafted", "failed", "reconciled_not_sent", "revoked", "deferred"}:
        errors.append(f"{label} cannot approve from {status}")
        return
    draft = current["draft"]
    comment = _comment_at(observations, comment_key, row["occurred_at"])
    expected = _approval_scope(comment, comment_key)
    _validate_approval_context(draft, row, comment, expected, label, errors)
    grant = None
    if row.get("approval_mode") == "bounded_auto":
        grant = validate_bounded_approval(row, expected, grants, label, errors)
    if grant is not None and len(errors) == initial_error_count:
        consume_grant_action(grant)
    current.update(status="approved", permit=row, last_event=row)


def _apply_send_started(
    current: dict[str, Any], row: dict[str, Any], comment_key: str,
    observations: dict[str, list[dict[str, Any]]], label: str, errors: list[str],
) -> None:
    status = current.get("status")
    if status != "approved":
        errors.append(f"{label} cannot start send from {status}")
        return
    permit = current.get("permit") or {}
    draft = current["draft"]
    if row.get("permit_id") != permit.get("permit_id"):
        errors.append(f"{label} permit_id does not match approval")
    if row.get("session_id") != permit.get("session_id"):
        errors.append(f"{label} session_id does not match approval")
    if row.get("reply_hash") != draft.get("reply_hash"):
        errors.append(f"{label} send hash differs from approved draft")
    _validate_send_expiry(row, permit, label, errors)
    comment = _comment_at(observations, comment_key, row["occurred_at"])
    _validate_send_comment(row, draft, comment, label, errors)
    if row.get("scope") != permit.get("scope"):
        errors.append(f"{label} send scope differs from approval")
    current.update(status="send_started", last_event=row, attempt=row, permit=None)


def _validate_send_expiry(
    row: dict[str, Any], permit: dict[str, Any], label: str, errors: list[str],
) -> None:
    try:
        if parse_time(row["occurred_at"]) > parse_time(permit.get("expires_at", "")):
            errors.append(f"{label} permit expired before send")
    except ValueError:
        pass


def _validate_send_comment(
    row: dict[str, Any], draft: dict[str, Any], comment: dict[str, Any] | None,
    label: str, errors: list[str],
) -> None:
    if comment is None or row.get("comment_fingerprint") != comment.get("raw_fingerprint"):
        errors.append(f"{label} visible comment changed before send")
    if comment is None or draft.get("comment_fingerprint") != comment.get("raw_fingerprint"):
        errors.append(f"{label} approved draft is stale")


def _apply_finish(
    current: dict[str, Any], row: dict[str, Any], event_type: str,
    label: str, errors: list[str],
) -> None:
    status = current.get("status")
    if status != "send_started":
        errors.append(f"{label} cannot record {event_type} from {status}")
    elif row.get("session_id") != (current.get("attempt") or {}).get("session_id"):
        errors.append(f"{label} finish session_id does not match send attempt")
    else:
        current.update(status=event_type, last_event=row, permit=None)


def _apply_reconciliation(
    current: dict[str, Any], row: dict[str, Any], event_type: str,
    label: str, errors: list[str],
) -> None:
    status = current.get("status")
    if status != "needs_reconcile":
        errors.append(f"{label} cannot record {event_type} from {status}")
    elif row.get("attempt_session_id") != (current.get("attempt") or {}).get("session_id"):
        errors.append(f"{label} attempt_session_id does not match send attempt")
    elif row.get("reconciliation_basis") != "browser_reinspection":
        errors.append(f"{label} reconciliation requires browser_reinspection")
    else:
        current.update(status=event_type, last_event=row, permit=None)


def _apply_disposition(
    current: dict[str, Any], row: dict[str, Any], event_type: str,
    label: str, errors: list[str],
) -> None:
    status = current.get("status")
    allowed = {"drafted", "failed", "reconciled_not_sent", "revoked", "deferred"}
    if status not in allowed:
        errors.append(f"{label} cannot record {event_type} from {status}")
    else:
        current.update(status=event_type, last_event=row)


def _apply_reply_transition(
    current: dict[str, Any], row: dict[str, Any], comment_key: str,
    observations: dict[str, list[dict[str, Any]]], grants: dict[str, dict[str, Any]],
    label: str, errors: list[str], warnings: list[str],
) -> None:
    event_type = row.get("event_type")
    if event_type == "approved":
        _apply_approval(current, row, comment_key, observations, grants, label, errors)
    elif event_type == "send_started":
        _apply_send_started(current, row, comment_key, observations, label, errors)
    elif event_type in {"sent_verified", "needs_reconcile", "failed"}:
        _apply_finish(current, row, str(event_type), label, errors)
    elif event_type in {"reconciled_sent", "reconciled_not_sent"}:
        _apply_reconciliation(current, row, str(event_type), label, errors)
    elif event_type in {"deferred", "skipped"}:
        _apply_disposition(current, row, str(event_type), label, errors)
    elif event_type == "revoked":
        if current.get("status") != "approved":
            errors.append(f"{label} cannot revoke from {current.get('status')}")
        else:
            current.update(status="revoked", last_event=row, permit=None)
    else:
        warnings.append(f"{label} was not applied because its event type is invalid")


def _observations_by_comment(
    comment_rows: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    observations: dict[str, list[dict[str, Any]]] = {}
    for comment in comment_rows:
        observations.setdefault(str(comment.get("comment_key")), []).append(comment)
    return observations


def _record_audit_id(
    row: dict[str, Any], label: str, seen: set[str], errors: list[str],
) -> None:
    audit_id = row.get("audit_id")
    if isinstance(audit_id, str):
        if audit_id in seen:
            errors.append(f"{label} duplicate audit_id {audit_id}")
        seen.add(audit_id)


def _permit_is_new(
    row: dict[str, Any], label: str, seen: set[str], errors: list[str],
) -> bool:
    permit_id = row.get("permit_id")
    if permit_id in seen:
        errors.append(f"{label} duplicate permit_id {permit_id}")
        return False
    seen.add(str(permit_id))
    return True


def _intent_is_valid(
    intent_id: Any, comment_key: Any, intents: dict[str, str],
    label: str, errors: list[str],
) -> bool:
    if isinstance(intent_id, str) and intent_id in intents:
        if intents[intent_id] != comment_key:
            errors.append(f"{label} intent_id is reused across comments")
            return False
    if isinstance(intent_id, str):
        intents[intent_id] = str(comment_key)
    return True


def _apply_draft(
    states: dict[str, dict[str, Any]], comment_key: str,
    intent_id: Any, row: dict[str, Any], label: str, errors: list[str],
) -> None:
    current = states.get(comment_key)
    if current:
        blocked = TERMINAL_STATES | {"approved", "send_started", "needs_reconcile"}
        if current.get("status") in blocked:
            errors.append(f"{label} cannot draft from {current.get('status')}")
            return
        if not event_time_is_monotonic(current, row, label, errors):
            return
    states[comment_key] = {
        "status": "drafted", "intent_id": intent_id, "draft": row,
        "last_event": row, "permit": None, "attempt": None,
    }


def _apply_reply_row(
    row: dict[str, Any], label: str, observations: dict[str, list[dict[str, Any]]],
    states: dict[str, dict[str, Any]], grants: dict[str, dict[str, Any]],
    intents: dict[str, str], errors: list[str], warnings: list[str],
) -> None:
    comment_key = row.get("comment_key")
    intent_id = row.get("intent_id")
    if comment_key not in observations:
        errors.append(f"{label} references unknown comment_key {comment_key}")
        return
    if not _intent_is_valid(intent_id, comment_key, intents, label, errors):
        return
    key = str(comment_key)
    if row.get("event_type") == "drafted":
        _apply_draft(states, key, intent_id, row, label, errors)
        return
    current = states.get(key)
    if current is None or current.get("intent_id") != intent_id:
        errors.append(f"{label} has no matching active draft")
        return
    if not event_time_is_monotonic(current, row, label, errors):
        return
    _apply_reply_transition(
        current, row, key, observations, grants, label, errors, warnings,
    )


def replay_reply_events(
    reply_rows: list[dict[str, Any]], comment_rows: list[dict[str, Any]],
    errors: list[str], warnings: list[str], maximum_actions_limit: int | None = None,
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    seen_audits: set[str] = set()
    seen_permits: set[str] = set()
    observations = _observations_by_comment(comment_rows)
    states: dict[str, dict[str, Any]] = {}
    grants: dict[str, dict[str, Any]] = {}
    intents: dict[str, str] = {}
    for index, row in enumerate(reply_rows, start=1):
        label = f"reply_events.jsonl:{index}"
        errors_before_shape = len(errors)
        _validate_reply_event_shape(row, label, errors)
        shape_invalid = len(errors) > errors_before_shape
        _record_audit_id(row, label, seen_audits, errors)
        if shape_invalid:
            continue
        if row.get("event_type") in GRANT_EVENT_TYPES:
            apply_grant_event(grants, row, label, errors, maximum_actions_limit)
            continue
        if row.get("event_type") == "approved":
            if not _permit_is_new(row, label, seen_permits, errors):
                continue
        _apply_reply_row(
            row, label, observations, states, grants, intents, errors, warnings,
        )
    return states, grants

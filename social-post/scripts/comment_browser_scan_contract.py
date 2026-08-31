#!/usr/bin/env python3
"""Browser scan request, completion, and visible-comment contracts."""

from __future__ import annotations

from typing import Any

from comment_browser_common import (
    PLATFORM_HOSTS, _canonical_url, _require_comment_permalink_for_post,
    _require_platform_url, _require_post_url, _require_recent_observation,
    _json_digest, _require_live_receipt, _require_schema_version, _required_boolean,
    _required_string,
)
from comment_domain import normalize_comment, stable_id
from comment_scan_provenance import (
    SCAN_PROVENANCE_DIGEST_FIELD,
    build_scan_capability_binding,
    build_scan_provenance,
    normalize_scan_capability_metadata,
    normalize_scan_receipt_consumption,
    validate_scan_provenance,
)
from social_validation import parse_time


SCAN_COMPLETION_EVENT_TYPE = "browser_scan_completed"


def normalize_browser_scan_request(raw: dict[str, Any]) -> dict[str, Any]:
    """Validate one user-created, append-only target request."""
    if not isinstance(raw, dict):
        raise ValueError("browser scan request must be a JSON object")
    _require_schema_version(raw, "browser scan request")
    platform = _required_string(raw, "platform").lower()
    if platform not in PLATFORM_HOSTS:
        raise ValueError(f"unsupported browser platform {platform}")
    scope = {
        "platform": platform,
        "account_key": _required_string(raw, "account_key"),
        "post_key": _required_string(raw, "post_key"),
        "post_permalink": _require_platform_url(
            platform, _required_string(raw, "post_permalink"), "post_permalink",
        ),
    }
    requested_at = _required_string(raw, "requested_at")
    expires_at = _required_string(raw, "expires_at")
    if parse_time(expires_at) <= parse_time(requested_at):
        raise ValueError("browser scan request expires_at must follow requested_at")
    session_id = _required_string(raw, "session_id")
    expected_id = stable_id(
        "browser-scan-request", session_id, scope, requested_at, expires_at,
    )
    if raw.get("scan_request_id") != expected_id:
        raise ValueError("browser scan request id does not match its immutable fields")
    if raw.get("authorization_basis") != "current_session_user_instruction":
        raise ValueError("browser scan request lacks current-session authorization basis")
    capability_metadata = normalize_scan_capability_metadata(raw)
    result = {
        "schema_version": 1, "scan_request_id": expected_id,
        "session_id": session_id, "requested_at": requested_at,
        "expires_at": expires_at, "authorization_basis": raw["authorization_basis"],
        **scope, **capability_metadata,
    }
    if capability_metadata and _json_digest(build_scan_capability_binding(result)) != (
        capability_metadata["browser_scan_capability_binding_digest"]
    ):
        raise ValueError("browser scan capability binding differs from request fields")
    return result


def build_browser_scan_request(
    *, platform: str, account_key: str, post_key: str, post_permalink: str,
    session_id: str, requested_at: str, expires_at: str,
) -> dict[str, Any]:
    """Create a target request before Chrome is allowed to report a scan."""
    provisional = {
        "schema_version": 1, "platform": platform, "account_key": account_key,
        "post_key": post_key, "post_permalink": post_permalink,
        "session_id": session_id, "requested_at": requested_at,
        "expires_at": expires_at,
        "authorization_basis": "current_session_user_instruction",
    }
    normalized_platform = _required_string(provisional, "platform").lower()
    if normalized_platform not in PLATFORM_HOSTS:
        raise ValueError(f"unsupported browser platform {normalized_platform}")
    normalized_scope = {
        "platform": normalized_platform,
        "account_key": _required_string(provisional, "account_key"),
        "post_key": _required_string(provisional, "post_key"),
        "post_permalink": _require_platform_url(
            normalized_platform, _required_string(provisional, "post_permalink"),
            "post_permalink",
        ),
    }
    normalized_session = _required_string(provisional, "session_id")
    normalized_requested_at = _required_string(provisional, "requested_at")
    normalized_expires_at = _required_string(provisional, "expires_at")
    provisional["scan_request_id"] = stable_id(
        "browser-scan-request", normalized_session, normalized_scope,
        normalized_requested_at, normalized_expires_at,
    )
    return normalize_browser_scan_request(provisional)


def replay_browser_scan_requests(
    rows: list[dict[str, Any]], maximum_ttl_seconds: int = 600,
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """Validate the append-only request ledger and index it by request id."""
    requests: dict[str, dict[str, Any]] = {}
    completion_ids: set[str] = set()
    errors: list[str] = []
    for index, raw in enumerate(rows, 1):
        if isinstance(raw, dict) and raw.get("event_type") == SCAN_COMPLETION_EVENT_TYPE:
            request_id = raw.get("scan_request_id")
            request = requests.get(request_id) if isinstance(request_id, str) else None
            if request is None:
                errors.append(
                    f"browser scan request row {index}: completion references "
                    "an unknown or not-yet-recorded scan_request_id"
                )
                continue
            if request["completion_events"]:
                errors.append(
                    f"browser scan request row {index}: one-shot scan request already completed"
                )
                continue
            try:
                completion = normalize_browser_scan_completion(raw, request)
            except (KeyError, TypeError, ValueError) as exc:
                errors.append(f"browser scan request row {index}: {exc}")
                continue
            completion_id = completion["completion_event_id"]
            if completion_id in completion_ids:
                errors.append(
                    f"browser scan request row {index}: duplicate completion_event_id"
                )
                continue
            completion_ids.add(completion_id)
            request["completion_events"].append(completion)
            request["last_completion"] = completion
            request["execution_status"] = "completed"
            continue
        try:
            request = normalize_browser_scan_request(raw)
        except (KeyError, TypeError, ValueError) as exc:
            errors.append(f"browser scan request row {index}: {exc}")
            continue
        duration = (
            parse_time(request["expires_at"]) - parse_time(request["requested_at"])
        ).total_seconds()
        if duration > maximum_ttl_seconds:
            errors.append(
                f"browser scan request row {index}: ttl exceeds {maximum_ttl_seconds} seconds"
            )
            continue
        request_id = request["scan_request_id"]
        if request_id in requests:
            errors.append(f"browser scan request row {index}: duplicate scan_request_id")
            continue
        requests[request_id] = {
            **request,
            "execution_status": "pending",
            "completion_events": [],
            "last_completion": None,
        }
    return requests, errors


def _normalize_thread_expansion_evidence(raw: Any) -> dict[str, Any]:
    """Keep an explicit, honest record of what the actuator expanded."""
    if raw is None:
        return {
            "provided": False,
            "comments_expanded": False,
            "replies_expanded": False,
            "evidence": "thread expansion evidence was not supplied by the browser adapter",
        }
    if not isinstance(raw, dict):
        raise ValueError("thread_expansion_evidence must be an object")
    provided = _required_boolean(raw, "provided")
    comments_expanded = _required_boolean(raw, "comments_expanded")
    replies_expanded = _required_boolean(raw, "replies_expanded")
    evidence = _required_string(raw, "evidence")
    if not provided and (comments_expanded or replies_expanded):
        raise ValueError(
            "thread_expansion_evidence cannot claim expansion when provided is false"
        )
    return {
        "provided": provided,
        "comments_expanded": comments_expanded,
        "replies_expanded": replies_expanded,
        "evidence": evidence,
    }


def _require_complete_thread_expansion(raw: Any, label: str) -> dict[str, Any]:
    """Reject live scan evidence unless comments and replies were both exhausted."""
    expansion = _normalize_thread_expansion_evidence(raw)
    if not (
        expansion["provided"]
        and expansion["comments_expanded"]
        and expansion["replies_expanded"]
    ):
        raise ValueError(
            f"{label} requires verified complete comment and reply expansion"
        )
    return expansion


def normalize_browser_scan_completion(
    raw: dict[str, Any], request: dict[str, Any],
) -> dict[str, Any]:
    """Validate one append-only record proving that a scan request executed."""
    if not isinstance(raw, dict):
        raise ValueError("browser scan completion must be a JSON object")
    _require_schema_version(raw, "browser scan completion")
    if raw.get("event_type") != SCAN_COMPLETION_EVENT_TYPE:
        raise ValueError("browser scan completion has the wrong event_type")
    clean_request = normalize_browser_scan_request(request)
    if raw.get("scan_request_id") != clean_request["scan_request_id"]:
        raise ValueError("browser scan completion differs from its scan request")
    if raw.get("session_id") != clean_request["session_id"]:
        raise ValueError("browser scan completion session differs from its scan request")
    expected_scope = {
        key: clean_request[key]
        for key in ("platform", "account_key", "post_key", "post_permalink")
    }
    if raw.get("scope") != expected_scope:
        raise ValueError("browser scan completion scope differs from its scan request")
    observed_at = _required_string(raw, "observed_at")
    observed = parse_time(observed_at)
    if observed < parse_time(clean_request["requested_at"]):
        raise ValueError("browser scan completion predates its scan request")
    if observed > parse_time(clean_request["expires_at"]):
        raise ValueError("browser scan completion follows scan request expiry")
    comment_count = raw.get("comment_count")
    if not isinstance(comment_count, int) or isinstance(comment_count, bool) or comment_count < 0:
        raise ValueError("browser scan completion comment_count must be a non-negative integer")
    zero_result = _required_boolean(raw, "zero_result")
    if zero_result != (comment_count == 0):
        raise ValueError("browser scan completion zero_result disagrees with comment_count")
    expansion = _require_complete_thread_expansion(
        raw.get("thread_expansion_evidence"), "browser scan completion",
    )
    test_only = raw.get("test_only")
    if not isinstance(test_only, bool):
        raise ValueError("browser scan completion test_only must be explicit boolean")
    consumption = normalize_scan_receipt_consumption(
        raw, clean_request,
        required=(test_only is False and bool(normalize_scan_capability_metadata(clean_request))),
    )
    immutable = {
        "schema_version": 1,
        "event_type": SCAN_COMPLETION_EVENT_TYPE,
        "scan_request_id": clean_request["scan_request_id"],
        "session_id": clean_request["session_id"],
        "scope": expected_scope,
        "observed_at": observed_at,
        "comment_count": comment_count,
        "zero_result": zero_result,
        "test_only": test_only,
        "thread_expansion_evidence": expansion,
        **consumption,
    }
    raw_provenance = raw.get("scan_provenance")
    raw_provenance_digest = raw.get(SCAN_PROVENANCE_DIGEST_FIELD)
    if raw_provenance is not None or raw_provenance_digest is not None:
        provenance = validate_scan_provenance(raw_provenance)
        if raw_provenance_digest != provenance["provenance_digest"]:
            raise ValueError("browser scan completion provenance digest differs")
        if provenance.get("scan_request_id") != clean_request["scan_request_id"]:
            raise ValueError("browser scan completion provenance request differs")
        if provenance.get("scope") != expected_scope:
            raise ValueError("browser scan completion provenance scope differs")
        if provenance.get("observed_at") != observed_at:
            raise ValueError("browser scan completion provenance time differs")
        scan_id = _required_string(raw, "scan_id")
        if provenance.get("scan_id") != scan_id:
            raise ValueError("browser scan completion provenance scan_id differs")
        immutable.update({
            "scan_id": scan_id,
            "scan_provenance": provenance,
            SCAN_PROVENANCE_DIGEST_FIELD: raw_provenance_digest,
        })
    expected_id = stable_id("browser-scan-completion", immutable)
    supplied_id = raw.get("completion_event_id")
    if supplied_id not in (None, expected_id):
        raise ValueError("browser scan completion id does not match its immutable fields")
    return {**immutable, "completion_event_id": expected_id}


def build_browser_scan_completion(
    scan: dict[str, Any], request: dict[str, Any], raw_evidence: Any,
    receipt_consumption: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the durable completion event for an accepted browser scan."""
    provisional = {
        "schema_version": 1,
        "event_type": SCAN_COMPLETION_EVENT_TYPE,
        "scan_request_id": scan["scan_request_id"],
        "session_id": request["session_id"],
        "scope": scan["scope"],
        "observed_at": scan["observed_at"],
        "comment_count": len(scan["comments"]),
        "zero_result": not scan["comments"],
        "test_only": scan["test_only"],
        "thread_expansion_evidence": raw_evidence,
        **(receipt_consumption or {}),
    }
    if scan.get("scan_provenance") is not None:
        provisional.update({
            "scan_id": scan["scan_id"],
            "scan_provenance": scan["scan_provenance"],
            SCAN_PROVENANCE_DIGEST_FIELD: scan[SCAN_PROVENANCE_DIGEST_FIELD],
        })
    return normalize_browser_scan_completion(provisional, request)


def _scope_from_scan(
    value: dict[str, Any], request: dict[str, Any],
) -> dict[str, str]:
    platform = _required_string(value, "platform").lower()
    if platform not in PLATFORM_HOSTS:
        raise ValueError(f"unsupported browser platform {platform}")
    expected = {
        key: str(request[key])
        for key in ("platform", "account_key", "post_key", "post_permalink")
    }
    supplied = {
        "platform": platform,
        "account_key": _required_string(value, "account_key"),
        "post_key": _required_string(value, "post_key"),
        "post_permalink": _require_platform_url(
            platform, _required_string(value, "post_permalink"), "post_permalink",
        ),
    }
    if supplied != expected:
        raise ValueError("browser scan scope differs from the stored scan request")
    return expected


def _verify_scan_context(
    value: dict[str, Any], scope: dict[str, str], request: dict[str, Any],
    policy: dict[str, Any],
) -> None:
    _require_schema_version(value, "browser scan")
    _require_live_receipt(value, "browser scan")
    if value.get("authentication_state") != "authenticated":
        raise ValueError("browser scan is not authenticated")
    if not _required_boolean(value, "account_verified"):
        raise ValueError("browser scan account was not verified")
    if not _required_boolean(value, "post_verified"):
        raise ValueError("browser scan post was not verified")
    if value.get("scan_request_id") != request.get("scan_request_id"):
        raise ValueError("browser scan is not bound to the stored scan request")
    if value.get("session_id") != request.get("session_id"):
        raise ValueError("browser scan session differs from the stored scan request")
    observed_url = _required_string(value, "observed_url")
    _require_post_url(
        scope["platform"], observed_url, scope["post_permalink"], "observed_url",
    )
    observed_at = _require_recent_observation(
        value, policy, "maximum_browser_scan_age_seconds", 300, "browser scan",
    )
    observed = parse_time(observed_at)
    if observed < parse_time(request["requested_at"]):
        raise ValueError("browser scan predates its stored scan request")
    if observed > parse_time(request["expires_at"]):
        raise ValueError("browser scan request expired before observation")


def _comment_scope(raw: dict[str, Any], scope: dict[str, str]) -> dict[str, Any]:
    result = dict(raw)
    for key in ("platform", "account_key", "post_key", "post_permalink"):
        supplied = result.get(key)
        if supplied not in (None, "", scope[key]):
            raise ValueError(f"browser comment {key} differs from scan scope")
        result[key] = scope[key]
    return result


def _normalize_scanned_comment(
    raw: dict[str, Any], scope: dict[str, str], observed_at: str,
) -> dict[str, Any]:
    value = _comment_scope(raw, scope)
    supplied_at = value.get("observed_at")
    if supplied_at not in (None, "", observed_at):
        raise ValueError("browser comment observed_at differs from scan envelope")
    value["observed_at"] = observed_at
    value.setdefault("language", "und")
    for key in ("body_complete", "is_own", "has_own_reply"):
        _required_boolean(value, key)
    body = _required_string(value, "body")
    value["body"] = body
    comment_permalink = value.get("comment_permalink")
    if comment_permalink:
        value["comment_permalink"] = _require_comment_permalink_for_post(
            scope["platform"], str(comment_permalink), scope["post_permalink"],
            value.get("platform_comment_id"),
        )
    parent = _required_string(value, "observed_parent_post_permalink")
    parent = _require_post_url(
        scope["platform"], parent, scope["post_permalink"],
        "observed_parent_post_permalink",
    )
    value["observed_parent_post_permalink"] = parent
    normalized = normalize_comment(value)
    normalized["observed_parent_post_permalink"] = parent
    return normalized


def normalize_browser_scan(
    raw: dict[str, Any], policy: dict[str, Any], request: dict[str, Any],
) -> dict[str, Any]:
    """Validate one authenticated live-page scan and return ingest-ready rows."""
    if not isinstance(raw, dict):
        raise ValueError("browser scan must be a JSON object")
    request = normalize_browser_scan_request(request)
    scope = _scope_from_scan(raw, request)
    _verify_scan_context(raw, scope, request, policy)
    _require_complete_thread_expansion(
        raw.get("thread_expansion_evidence"), "live browser scan",
    )
    comments = raw.get("comments")
    if not isinstance(comments, list) or any(not isinstance(row, dict) for row in comments):
        raise ValueError("browser scan comments must be a list of objects")
    maximum = int(policy.get("maximum_comments_per_scan", 100))
    if len(comments) > maximum:
        raise ValueError(f"browser scan exceeds maximum_comments_per_scan={maximum}")
    observed_at = _required_string(raw, "observed_at")
    normalized = [
        _normalize_scanned_comment(row, scope, observed_at) for row in comments
    ]
    scan_id = stable_id(
        "browser-scan", request["scan_request_id"], scope, observed_at,
        [row["raw_fingerprint"] for row in normalized],
    )
    observed_url = _canonical_url(_required_string(raw, "observed_url"))
    provenance = build_scan_provenance(
        raw, scan_id=scan_id, scope=scope, observed_url=observed_url,
        observed_at=observed_at, comments=normalized,
    )
    if provenance is not None:
        bound_comments = []
        for row in normalized:
            rebound = normalize_comment({
                **row,
                "event_id": None,
                "scan_provenance": provenance,
                SCAN_PROVENANCE_DIGEST_FIELD: provenance["provenance_digest"],
            })
            rebound["observed_parent_post_permalink"] = row[
                "observed_parent_post_permalink"
            ]
            bound_comments.append(rebound)
        normalized = bound_comments
    result = {
        "schema_version": 1,
        "test_only": raw["test_only"],
        "scan_request_id": request["scan_request_id"],
        "scan_id": scan_id,
        "scope": scope,
        "observed_url": observed_url,
        "observed_at": observed_at,
        "comments": normalized,
    }
    if provenance is not None:
        result.update({
            "scan_provenance": provenance,
            SCAN_PROVENANCE_DIGEST_FIELD: provenance["provenance_digest"],
        })
    return result

#!/usr/bin/env python3
"""Typed contracts between the comment ledger and live Chrome observations."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from comment_domain import normalize_comment, reply_hash, stable_id
from social_validation import parse_time


PLATFORM_HOSTS = {
    "facebook": {"facebook.com", "www.facebook.com", "m.facebook.com"},
    "instagram": {"instagram.com", "www.instagram.com"},
    "threads": {"threads.com", "www.threads.com", "threads.net", "www.threads.net"},
}
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


def _required_string(value: dict[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result.strip():
        raise ValueError(f"browser payload {key} must be a non-empty string")
    return result.strip()


def _required_boolean(value: dict[str, Any], key: str) -> bool:
    result = value.get(key)
    if not isinstance(result, bool):
        raise ValueError(f"browser payload {key} must be boolean")
    return result


def _require_schema_version(value: dict[str, Any], label: str) -> None:
    version = value.get("schema_version")
    if not isinstance(version, int) or isinstance(version, bool) or version != 1:
        raise ValueError(f"{label} schema_version must be integer 1")


def _canonical_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("browser payload URLs must use https")
    return urlunsplit((
        parsed.scheme, parsed.netloc.lower(), parsed.path.rstrip("/") or "/",
        parsed.query, "",
    ))


def _require_platform_url(platform: str, value: str, label: str) -> str:
    canonical = _canonical_url(value)
    hostname = (urlsplit(canonical).hostname or "").lower()
    if hostname not in PLATFORM_HOSTS[platform]:
        raise ValueError(f"{label} host does not match {platform}")
    return canonical


def _require_post_url(
    platform: str, observed: str, expected: str, label: str,
) -> str:
    current = _require_platform_url(platform, observed, label)
    target = _require_platform_url(platform, expected, "post_permalink")
    current_parts = urlsplit(current)
    target_parts = urlsplit(target)
    if current_parts.path != target_parts.path:
        raise ValueError(f"{label} path differs from approved post_permalink")
    expected_query = Counter(parse_qsl(target_parts.query, keep_blank_values=True))
    current_query = Counter(parse_qsl(current_parts.query, keep_blank_values=True))
    if any(current_query[pair] < count for pair, count in expected_query.items()):
        raise ValueError(f"{label} query differs from approved post_permalink")
    return current


def _require_comment_permalink_for_post(
    platform: str, observed: str, expected_post: str,
) -> str:
    """Accept only comment anchors whose URL remains under the approved post."""
    comment = _require_platform_url(platform, observed, "comment_permalink")
    post = _require_platform_url(platform, expected_post, "post_permalink")
    comment_parts = urlsplit(comment)
    post_parts = urlsplit(post)
    post_path = post_parts.path.rstrip("/") or "/"
    if not (
        comment_parts.path == post_path
        or comment_parts.path.startswith(post_path + "/")
    ):
        raise ValueError("comment_permalink does not belong to approved post path")
    expected_query = Counter(parse_qsl(post_parts.query, keep_blank_values=True))
    comment_query = Counter(parse_qsl(comment_parts.query, keep_blank_values=True))
    if any(comment_query[pair] < count for pair, count in expected_query.items()):
        raise ValueError("comment_permalink does not retain approved post query")
    return comment


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
    return {
        "schema_version": 1, "scan_request_id": expected_id,
        "session_id": session_id, "requested_at": requested_at,
        "expires_at": expires_at, "authorization_basis": raw["authorization_basis"],
        **scope,
    }


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
    errors: list[str] = []
    for index, raw in enumerate(rows, 1):
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
        requests[request_id] = request
    return requests, errors


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
    return {
        "schema_version": 1,
        "scan_request_id": request["scan_request_id"],
        "scan_id": stable_id(
            "browser-scan", request["scan_request_id"], scope, observed_at,
            [row["raw_fingerprint"] for row in normalized],
        ),
        "scope": scope,
        "observed_url": _canonical_url(_required_string(raw, "observed_url")),
        "observed_at": observed_at,
        "comments": normalized,
    }


def _find_intent(
    states: dict[str, dict[str, Any]], intent_id: str,
) -> tuple[str, dict[str, Any]]:
    matches = [(key, state) for key, state in states.items() if state.get("intent_id") == intent_id]
    if len(matches) != 1:
        raise ValueError(f"expected one active intent_id {intent_id}, found {len(matches)}")
    return matches[0]


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
    comment = latest_comments[comment_key]
    draft = state["draft"]
    anchor = {
        "platform_comment_id": comment.get("platform_comment_id"),
        "comment_permalink": comment.get("comment_permalink"),
    }
    return {
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


def _require_recent_observation(
    raw: dict[str, Any], policy: dict[str, Any], policy_key: str,
    default_seconds: int, label: str,
) -> str:
    observed_at = _required_string(raw, "observed_at")
    observed = parse_time(observed_at)
    now = datetime.now(timezone.utc)
    age = (now - observed.astimezone(timezone.utc)).total_seconds()
    maximum = int(policy.get(policy_key, default_seconds))
    if age < -5 or age > maximum:
        raise ValueError(f"{label} must be no older than {maximum} seconds")
    return observed_at


def validate_browser_preflight(
    raw: dict[str, Any], latest_comments: dict[str, dict[str, Any]],
    states: dict[str, dict[str, Any]], policy: dict[str, Any],
    intent_id: str, session_id: str,
) -> dict[str, Any]:
    """Validate a fresh, read-only Chrome preflight before send_started."""
    if not isinstance(raw, dict):
        raise ValueError("browser preflight must be a JSON object")
    _require_schema_version(raw, "browser preflight")
    comment_key, state = _find_intent(states, intent_id)
    if state.get("status") != "approved":
        raise ValueError(f"browser preflight requires approved status, found {state.get('status')}")
    permit = state.get("permit") or {}
    if permit.get("session_id") != session_id:
        raise ValueError("browser preflight session differs from approval")
    comment = latest_comments[comment_key]
    _require_action_binding(raw, state, comment, intent_id, session_id)
    _require_post_url(
        comment["platform"], _required_string(raw, "observed_url"),
        comment["post_permalink"], "observed_url",
    )
    observed_at = _require_recent_observation(
        raw, policy, "maximum_browser_preflight_age_seconds", 60, "browser preflight",
    )
    observed = parse_time(observed_at)
    if observed < parse_time(_required_string(permit, "occurred_at")):
        raise ValueError("browser preflight predates approval")
    if observed > parse_time(_required_string(permit, "expires_at")):
        raise ValueError("browser preflight occurred after permit expiry")
    for key in PREFLIGHT_FLAGS:
        if not _required_boolean(raw, key):
            raise ValueError(f"browser preflight {key} was not verified")
    evidence = _required_string(raw, "evidence")
    return {
        "preflight_id": stable_id("browser-preflight", intent_id, observed_at, evidence),
        "action_id": raw["action_id"],
        "observed_at": observed_at,
        "evidence": evidence,
        "comment_key": comment_key,
        "comment": comment,
        "state": state,
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


def classify_browser_result(
    raw: dict[str, Any], latest_comments: dict[str, dict[str, Any]],
    states: dict[str, dict[str, Any]], policy: dict[str, Any],
    intent_id: str, session_id: str,
) -> dict[str, Any]:
    """Convert structured post-submit browser evidence to a ledger outcome."""
    if not isinstance(raw, dict):
        raise ValueError("browser result must be a JSON object")
    _require_schema_version(raw, "browser result")
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
    _require_post_url(
        comment["platform"], _required_string(raw, "observed_url"),
        comment["post_permalink"], "observed_url",
    )
    observed_at = _require_recent_observation(
        raw, policy, "maximum_browser_result_age_seconds", 300, "browser result",
    )
    if parse_time(observed_at) < parse_time(str(attempt.get("occurred_at", ""))):
        raise ValueError("browser result predates send_started")
    attempted = _required_boolean(raw, "submission_attempted")
    possible = _required_boolean(raw, "submission_possible")
    evidence = _required_string(raw, "evidence")
    flags = [_required_boolean(raw, key) for key in RESULT_FLAGS]
    if attempted and possible and all(flags):
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


def classify_browser_reinspection(
    raw: dict[str, Any], latest_comments: dict[str, dict[str, Any]],
    states: dict[str, dict[str, Any]], policy: dict[str, Any],
    intent_id: str, session_id: str,
) -> dict[str, Any]:
    """Classify a fresh reinspection without allowing an uncertain duplicate send."""
    if not isinstance(raw, dict):
        raise ValueError("browser reinspection must be a JSON object")
    _require_schema_version(raw, "browser reinspection")
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
    _require_post_url(
        comment["platform"], _required_string(raw, "observed_url"),
        comment["post_permalink"], "observed_url",
    )
    observed_at = _require_recent_observation(
        raw, policy, "maximum_browser_result_age_seconds", 300,
        "browser reinspection",
    )
    if parse_time(observed_at) < parse_time(str(attempt.get("occurred_at", ""))):
        raise ValueError("browser reinspection predates send_started")
    for key in REINSPECTION_CONTEXT_FLAGS:
        if not _required_boolean(raw, key):
            raise ValueError(f"browser reinspection {key} was not verified")
    exact = _required_boolean(raw, "exact_reply_visible")
    own = _required_boolean(raw, "own_author_verified")
    absent = _required_boolean(raw, "absence_verified")
    if exact and absent:
        raise ValueError("browser reinspection cannot verify presence and absence together")
    evidence = _required_string(raw, "evidence")
    base = {"evidence": evidence, "observed_at": observed_at}
    if exact and own:
        return {**base, "result": "sent"}
    if not exact and not own and absent:
        return {**base, "result": "not-sent"}
    return {**base, "result": "unknown", "reason": "browser_reinspection_uncertain"}

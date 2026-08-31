#!/usr/bin/env python3
"""Browser scan request, completion, and visible-comment contracts."""

from __future__ import annotations

from typing import Any
import re
from urllib.parse import parse_qsl, urlsplit

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
    build_target_observation_provenance,
    validate_scan_provenance,
)
from social_validation import parse_time


SCAN_COMPLETION_EVENT_TYPE = "browser_scan_completed"
TARGET_COMPLETION_EVENT_TYPE = "browser_target_observation_completed"


def _target_scope(raw: dict[str, Any], scope: dict[str, Any]) -> dict[str, Any]:
    """Keep exact-comment coverage separate from exhaustive post scans."""
    observation_scope = raw.get("observation_scope")
    if observation_scope is None:
        if raw.get("target") is not None:
            raise ValueError("target requires explicit target_comment observation scope")
        return {}
    if observation_scope != "target_comment":
        raise ValueError("unsupported browser observation_scope")
    target = raw.get("target")
    if not isinstance(target, dict) or set(target) != {
        "platform_comment_id", "comment_permalink",
    }:
        raise ValueError("target observation requires exactly a native id and permalink")
    comment_id = _required_string(target, "platform_comment_id")
    permalink = _require_comment_permalink_for_post(
        scope["platform"], _required_string(target, "comment_permalink"),
        scope["post_permalink"], comment_id,
    )
    parsed = urlsplit(permalink)
    if scope["platform"] == "instagram":
        # A child /r/R URL must never be mistaken for the requested parent.
        if not re.fullmatch(r"/p/[A-Za-z0-9_-]+/c/[0-9]+", parsed.path):
            raise ValueError("target Instagram observation requires a native parent comment URL")
        if parsed.path.split("/")[2] != scope["post_key"]:
            raise ValueError("target Instagram post_key differs from native shortcode")
    elif scope["platform"] == "facebook":
        ids = [v for k, v in parse_qsl(parsed.query) if k == "comment_id"]
        if ids != [comment_id] or any(
            k in {"reply_comment_id", "reply_id"} for k, _ in parse_qsl(parsed.query)
        ):
            raise ValueError("target Facebook observation requires one exact comment_id")
    else:
        raise ValueError("target observation intake currently supports Facebook and Instagram only")
    return {
        "observation_scope": "target_comment",
        "target": {"platform_comment_id": comment_id, "comment_permalink": permalink},
    }


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
    target_scope = _target_scope(raw, scope)
    requested_at = _required_string(raw, "requested_at")
    expires_at = _required_string(raw, "expires_at")
    if parse_time(expires_at) <= parse_time(requested_at):
        raise ValueError("browser scan request expires_at must follow requested_at")
    session_id = _required_string(raw, "session_id")
    expected_id = stable_id(
        "browser-scan-request", session_id, {**scope, **target_scope}, requested_at, expires_at,
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
        **scope, **target_scope, **capability_metadata,
    }
    if capability_metadata and _json_digest(build_scan_capability_binding(result)) != (
        capability_metadata["browser_scan_capability_binding_digest"]
    ):
        raise ValueError("browser scan capability binding differs from request fields")
    return result


def build_browser_scan_request(
    *, platform: str, account_key: str, post_key: str, post_permalink: str,
    session_id: str, requested_at: str, expires_at: str,
    observation_scope: str | None = None, target: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Create a target request before Chrome is allowed to report a scan."""
    provisional = {
        "schema_version": 1, "platform": platform, "account_key": account_key,
        "post_key": post_key, "post_permalink": post_permalink,
        "session_id": session_id, "requested_at": requested_at,
        "expires_at": expires_at,
        "authorization_basis": "current_session_user_instruction",
    }
    if observation_scope is not None or target is not None:
        provisional.update(observation_scope=observation_scope, target=target)
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
    target_scope = _target_scope(provisional, normalized_scope)
    provisional["scan_request_id"] = stable_id(
        "browser-scan-request", normalized_session, {**normalized_scope, **target_scope},
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
        if isinstance(raw, dict) and raw.get("event_type") in {
            SCAN_COMPLETION_EVENT_TYPE, TARGET_COMPLETION_EVENT_TYPE,
        }:
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
                completion = (
                    normalize_browser_target_completion(raw, request)
                    if raw["event_type"] == TARGET_COMPLETION_EVENT_TYPE
                    else normalize_browser_scan_completion(raw, request)
                )
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
    if clean_request.get("observation_scope") == "target_comment":
        raise ValueError("target observation cannot receive whole-post scan completion")
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
    if request.get("observation_scope") == "target_comment":
        raise ValueError("target observation request cannot be consumed as a whole-post scan")
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


def normalize_browser_target_observation(
    raw: dict[str, Any], policy: dict[str, Any], request: dict[str, Any],
) -> dict[str, Any]:
    """Normalize one native comment without representing a complete post/thread."""
    if not isinstance(raw, dict):
        raise ValueError("target observation must be a JSON object")
    request = normalize_browser_scan_request(request)
    if request.get("observation_scope") != "target_comment":
        raise ValueError("target observation requires a target-only request")
    if request.get("completion_events"):
        raise ValueError("target observation request already completed")
    expected_fields = {
        "schema_version", "test_only", "observation_scope", "scan_request_id",
        "session_id", "platform", "account_key", "post_key", "post_permalink",
        "observed_url", "observed_at", "authentication_state", "account_verified",
        "post_verified", "target_verified", "comment", "observation_evidence",
    }
    if set(raw) != expected_fields:
        raise ValueError("target observation fields differ from the target-only contract")
    _require_schema_version(raw, "target observation")
    _require_live_receipt(raw, "target observation")
    if raw.get("observation_scope") != "target_comment":
        raise ValueError("target observation scope must be target_comment")
    scope = _scope_from_scan(raw, request)
    if raw.get("authentication_state") != "authenticated":
        raise ValueError("target observation is not authenticated")
    for key in ("account_verified", "post_verified", "target_verified"):
        if not _required_boolean(raw, key):
            raise ValueError(f"target observation {key} was not verified")
    for key in ("scan_request_id", "session_id"):
        if raw.get(key) != request[key]:
            raise ValueError(f"target observation {key} differs from its request")
    if _canonical_url(_required_string(raw, "observed_url")) != request["target"]["comment_permalink"]:
        raise ValueError("target observation URL differs from its native parent")
    observed_at = _require_recent_observation(
        raw, policy, "maximum_browser_scan_age_seconds", 300, "target observation",
    )
    if not (parse_time(request["requested_at"]) <= parse_time(observed_at) <= parse_time(request["expires_at"])):
        raise ValueError("target observation is outside its request time window")
    comment = raw.get("comment")
    comment_fields = {
        "platform_comment_id", "comment_permalink", "observed_parent_post_permalink",
        "author_key", "author_display", "body", "body_complete", "is_own",
        "has_own_reply", "language",
    }
    if not isinstance(comment, dict) or set(comment) not in (
        comment_fields, comment_fields | {"displayed_at"},
    ):
        raise ValueError("target observation requires exactly one complete comment object")
    for key, value in request["target"].items():
        if comment.get(key) != value:
            raise ValueError(f"target observation comment {key} differs from requested target")
    _required_string(comment, "author_key")
    _required_string(comment, "author_display")
    _required_string(comment, "language")
    if comment.get("body_complete") is not True:
        raise ValueError("target observation body must be complete")
    normalized = _normalize_scanned_comment(comment, scope, observed_at)
    evidence = raw.get("observation_evidence")
    evidence_fields = {
        "schema_version", "adapter_id", "adapter_version", "document_binding",
        "stable_read_count", "first_read_digest", "second_read_digest",
    }
    if not isinstance(evidence, dict) or set(evidence) != evidence_fields:
        raise ValueError("target observation requires exact stable-read evidence fields")
    _require_schema_version(evidence, "target observation evidence")
    for key in ("adapter_id", "adapter_version"):
        _required_string(evidence, key)
    # The Chrome proxy exposes no physical document epoch. This records only
    # source-owned tab + URL + target continuity; never imply reload detection.
    document = evidence.get("document_binding")
    if not isinstance(document, dict) or set(document) != {
        "schema_version", "kind", "tab_id", "observed_url", "target_digest",
    }:
        raise ValueError("target observation requires exact UI continuity binding fields")
    _require_schema_version(document, "target UI continuity binding")
    if document.get("kind") != "source_owned_ui_continuity":
        raise ValueError("target observation requires source-owned UI continuity only")
    _required_string(document, "tab_id")
    if document.get("observed_url") != request["target"]["comment_permalink"]:
        raise ValueError("target UI continuity URL differs from the exact native target")
    target_digest = _json_digest({
        "account_key": scope["account_key"].removeprefix("@"),
        "comment_permalink": request["target"]["comment_permalink"],
        "author_key": comment["author_key"], "body": comment["body"],
    })
    if document.get("target_digest") != target_digest:
        raise ValueError("target UI continuity digest differs from the observed full comment")
    if type(evidence.get("stable_read_count")) is not int or evidence["stable_read_count"] != 2:
        raise ValueError("target observation requires two stable reads")
    expected_digest = _json_digest(comment)
    if evidence.get("first_read_digest") != expected_digest or evidence.get("second_read_digest") != expected_digest:
        raise ValueError("target observation reads differ from the complete comment")
    scan_id = stable_id(
        "browser-target-observation", request["scan_request_id"], scope,
        request["target"], observed_at, normalized["raw_fingerprint"],
    )
    provenance = build_target_observation_provenance(
        raw, scan_id=scan_id, scope=scope, target=request["target"], comment=normalized,
    )
    bound = normalize_comment({
        **normalized, "event_id": None, "scan_provenance": provenance,
        SCAN_PROVENANCE_DIGEST_FIELD: provenance["provenance_digest"],
    })
    bound["observed_parent_post_permalink"] = normalized["observed_parent_post_permalink"]
    return {
        "schema_version": 1, "test_only": False, "observation_scope": "target_comment",
        "scan_request_id": request["scan_request_id"], "scan_id": scan_id,
        "scope": scope, "target": request["target"], "observed_at": observed_at,
        "comment": bound, "scan_provenance": provenance,
        SCAN_PROVENANCE_DIGEST_FIELD: provenance["provenance_digest"],
    }


def normalize_browser_target_completion(
    raw: dict[str, Any], request: dict[str, Any],
) -> dict[str, Any]:
    """Validate durable one-target completion, never a zero-result/exhaustion claim."""
    if not isinstance(raw, dict):
        raise ValueError("target observation completion must be an object")
    _require_schema_version(raw, "target observation completion")
    clean = normalize_browser_scan_request(request)
    if clean.get("observation_scope") != "target_comment":
        raise ValueError("target completion requires a target-only request")
    if raw.get("event_type") != TARGET_COMPLETION_EVENT_TYPE:
        raise ValueError("target observation completion event_type is invalid")
    for key in ("scan_request_id", "session_id", "observation_scope", "target"):
        if raw.get(key) != clean.get(key):
            raise ValueError(f"target completion {key} differs from its request")
    scope = {key: clean[key] for key in ("platform", "account_key", "post_key", "post_permalink")}
    if raw.get("scope") != scope:
        raise ValueError("target completion scope differs from request")
    if raw.get("test_only") is not False or type(raw.get("comment_count")) is not int or raw["comment_count"] != 1:
        raise ValueError("target completion must record exactly one live comment")
    for key in ("whole_post_complete", "reply_thread_complete"):
        if raw.get(key) is not False:
            raise ValueError(f"target completion cannot claim {key}")
    if any(key in raw for key in ("zero_result", "thread_expansion_evidence")):
        raise ValueError("target completion cannot claim zero result or scan exhaustion")
    observed_at = _required_string(raw, "observed_at")
    if not (parse_time(clean["requested_at"]) <= parse_time(observed_at) <= parse_time(clean["expires_at"])):
        raise ValueError("target completion is outside request time window")
    provenance = validate_scan_provenance(raw.get("scan_provenance"))
    if provenance.get("observation_scope") != "target_comment":
        raise ValueError("target completion requires target-only provenance")
    for key in ("scan_request_id", "scan_id", "scope", "target", "observed_at"):
        if provenance.get(key) != raw.get(key):
            raise ValueError(f"target completion provenance {key} differs")
    if raw.get(SCAN_PROVENANCE_DIGEST_FIELD) != provenance["provenance_digest"]:
        raise ValueError("target completion provenance digest differs")
    consumption = normalize_scan_receipt_consumption(raw, clean, required=True)
    if consumption["browser_scan_receipt_digest"] != provenance["scan_receipt_digest"]:
        raise ValueError("target completion receipt digest differs from provenance")
    immutable = {
        "schema_version": 1, "event_type": TARGET_COMPLETION_EVENT_TYPE,
        "scan_request_id": clean["scan_request_id"], "session_id": clean["session_id"],
        "observation_scope": "target_comment", "target": clean["target"],
        "scope": scope, "observed_at": observed_at, "comment_count": 1,
        "test_only": False, "whole_post_complete": False, "reply_thread_complete": False,
        "scan_id": _required_string(raw, "scan_id"), "scan_provenance": provenance,
        SCAN_PROVENANCE_DIGEST_FIELD: provenance["provenance_digest"], **consumption,
    }
    expected_id = stable_id("browser-target-observation-completion", immutable)
    if raw.get("completion_event_id") not in (None, expected_id):
        raise ValueError("target completion id differs from immutable fields")
    return {**immutable, "completion_event_id": expected_id}


def build_browser_target_completion(
    observation: dict[str, Any], request: dict[str, Any], consumption: dict[str, Any],
) -> dict[str, Any]:
    return normalize_browser_target_completion({
        **{key: observation[key] for key in (
            "scan_request_id", "scan_id", "observation_scope", "target", "scope",
            "observed_at", "scan_provenance", SCAN_PROVENANCE_DIGEST_FIELD,
        )},
        "schema_version": 1, "event_type": TARGET_COMPLETION_EVENT_TYPE,
        "session_id": request["session_id"], "test_only": False,
        "comment_count": 1, "whole_post_complete": False, "reply_thread_complete": False,
        **consumption,
    }, request)

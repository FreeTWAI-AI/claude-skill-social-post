#!/usr/bin/env python3
"""Shared validation helpers for browser scan and send contracts."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import re
from typing import Any
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from social_validation import parse_time


PLATFORM_HOSTS = {
    "facebook": {"facebook.com", "www.facebook.com", "m.facebook.com"},
    "instagram": {"instagram.com", "www.instagram.com"},
    "threads": {"threads.com", "www.threads.com", "threads.net", "www.threads.net"},
}
DIGEST_PATTERN = re.compile(r"^[0-9a-f]{64}$")


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


def _required_digest(value: dict[str, Any], key: str) -> str:
    result = _required_string(value, key)
    if not DIGEST_PATTERN.fullmatch(result):
        raise ValueError(f"browser payload {key} must be a lowercase SHA-256 digest")
    return result


def _json_digest(value: Any) -> str:
    """Match the actuator's recursively key-sorted JSON SHA-256 digest."""
    payload = json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _require_schema_version(value: dict[str, Any], label: str) -> None:
    version = value.get("schema_version")
    if not isinstance(version, int) or isinstance(version, bool) or version != 1:
        raise ValueError(f"{label} schema_version must be integer 1")


def _require_live_receipt(value: dict[str, Any], label: str) -> None:
    test_only = value.get("test_only")
    if not isinstance(test_only, bool):
        raise ValueError(f"{label} test_only must be explicit boolean")
    if test_only:
        raise ValueError(f"{label} test-only evidence cannot enter the live ledger")


def _canonical_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("browser payload URLs must use https")
    if parsed.username or parsed.password:
        raise ValueError("browser payload URLs cannot contain credentials")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("browser payload URL port is invalid") from exc
    if port not in (None, 443):
        raise ValueError("browser payload URLs cannot use non-default ports")
    hostname = parsed.hostname.lower()
    return urlunsplit((
        parsed.scheme, hostname, parsed.path.rstrip("/") or "/",
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
    if current_parts.hostname != target_parts.hostname:
        raise ValueError(f"{label} host differs from approved post_permalink")
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
    if comment_parts.hostname != post_parts.hostname:
        raise ValueError("comment_permalink host differs from approved post")
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

#!/usr/bin/env python3
"""Offline-verifiable boundary for an existing trusted Chrome host session.

This module never starts or controls a browser.  It challenges a source-wired,
process-bound authority that already owns a Chrome session, then binds the
in-memory response to one promotion receipt.  The production resolver remains
unavailable until the Chrome control runtime deliberately supplies that
authority; static JSON and test fixtures therefore stay fail-closed.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import secrets
from typing import Any, Callable

from comment_capability_promotion_contract import (
    HEX_256,
    PLATFORMS,
    fail,
    require_exact_keys,
)
from comment_capability_receipt_support import parse_utc


OBLIGATION_ID = "TRUSTED_CHROME_HOST_RESOLVER"
AUTHORITY_SCHEMA_VERSION = 1
AUTHORITY_TRUST_DOMAIN = "codex.chrome.control"
EXISTING_SESSION_KIND = "existing_chrome_session"
VERIFY_OPERATION = "verify_existing_chrome_host_read_only"

DESCRIPTOR_KEYS = {
    "schema_version", "trust_domain", "session_kind", "authority_id_sha256",
    "session_id_sha256", "connected", "read_only", "can_launch_browser",
    "can_mutate_browser", "test_only",
}
RESPONSE_KEYS = {
    "schema_version", "operation", "challenge_nonce", "authority_id_sha256",
    "session_id_sha256", "run_id", "source_snapshot_sha256", "verified_at",
    "existing_session", "read_only", "browser_launch_count", "mutation_count",
    "platform_results",
}
PLATFORM_RESULT_KEYS = {
    "platform", "authenticated", "account_verified", "exact_post_verified",
    "trusted_runtime_provenance_verified", "document_epoch_verified",
    "frame_topology_verified", "mutation_count", "post_id_sha256",
    "account_id_sha256", "runtime_provenance_sha256",
}


AuthorityResolver = Callable[[], Any]
TrustedVerifier = Callable[[dict[str, Any], str, str, Path, datetime], None]


def _is_exact_int(value: Any, expected: int) -> bool:
    return type(value) is int and value == expected


def _runtime_authority_unavailable() -> None:
    """Production hook: a browser session must be attached by source code."""
    return None


def _authority_descriptor(authority: Any, allow_test_authority: bool) -> dict[str, Any]:
    describe = getattr(authority, "describe_existing_session", None)
    verify = getattr(authority, "verify_existing_session", None)
    if not callable(describe) or not callable(verify):
        fail(OBLIGATION_ID, "requires a process-bound existing-session authority")
    try:
        descriptor = describe()
    except Exception as exc:
        raise ValueError(
            f"obligation {OBLIGATION_ID} promotion evidence authority descriptor failed"
        ) from exc
    descriptor = require_exact_keys(
        descriptor, DESCRIPTOR_KEYS, "trusted authority descriptor", OBLIGATION_ID
    )
    if (
        not _is_exact_int(
            descriptor.get("schema_version"), AUTHORITY_SCHEMA_VERSION
        )
        or descriptor.get("trust_domain") != AUTHORITY_TRUST_DOMAIN
        or descriptor.get("session_kind") != EXISTING_SESSION_KIND
    ):
        fail(OBLIGATION_ID, "authority is not the trusted existing Chrome session domain")
    if not HEX_256.fullmatch(str(descriptor.get("authority_id_sha256", ""))):
        fail(OBLIGATION_ID, "authority identity digest is invalid")
    if not HEX_256.fullmatch(str(descriptor.get("session_id_sha256", ""))):
        fail(OBLIGATION_ID, "authority session digest is invalid")
    if (
        descriptor.get("connected") is not True
        or descriptor.get("read_only") is not True
        or descriptor.get("can_launch_browser") is not False
        or descriptor.get("can_mutate_browser") is not False
    ):
        fail(OBLIGATION_ID, "authority must own one connected read-only existing session")
    if descriptor.get("test_only") is not False and not (
        allow_test_authority and descriptor.get("test_only") is True
    ):
        fail(OBLIGATION_ID, "test-only authority cannot verify production promotion")
    return descriptor


def _platform_bindings(receipt: dict[str, Any]) -> list[dict[str, Any]]:
    rows = receipt.get("results")
    if not isinstance(rows, list) or len(rows) != len(PLATFORMS):
        fail(OBLIGATION_ID, "trusted host receipt has no exact platform bindings")
    bindings = []
    for index, platform in enumerate(PLATFORMS):
        row = require_exact_keys(
            rows[index], PLATFORM_RESULT_KEYS, "trusted host platform result", OBLIGATION_ID
        )
        if row.get("platform") != platform:
            fail(OBLIGATION_ID, "trusted host platform binding order drifted")
        bindings.append(dict(row))
    return bindings


def _verification_request(
    receipt: dict[str, Any], version: str, revision: str,
) -> dict[str, Any]:
    return {
        "schema_version": AUTHORITY_SCHEMA_VERSION,
        "operation": VERIFY_OPERATION,
        "challenge_nonce": secrets.token_hex(32),
        "obligation_id": OBLIGATION_ID,
        "product_version": version,
        "source_revision_basis": revision,
        "run_id": receipt["run_id"],
        "session_id_sha256": receipt["session_id_sha256"],
        "source_snapshot_sha256": receipt["source_snapshot_sha256"],
        "platform_bindings": _platform_bindings(receipt),
    }


def _validate_response_identity(
    response: dict[str, Any], request: dict[str, Any], descriptor: dict[str, Any],
) -> None:
    if (
        not _is_exact_int(
            response.get("schema_version"), AUTHORITY_SCHEMA_VERSION
        )
    ):
        fail(OBLIGATION_ID, "authority response schema version is invalid")
    expected = {
        "operation": VERIFY_OPERATION,
        "challenge_nonce": request["challenge_nonce"],
        "authority_id_sha256": descriptor["authority_id_sha256"],
        "session_id_sha256": request["session_id_sha256"],
        "run_id": request["run_id"],
        "source_snapshot_sha256": request["source_snapshot_sha256"],
    }
    if any(response.get(key) != value for key, value in expected.items()):
        fail(OBLIGATION_ID, "authority response is replayed or bound to another receipt")
    if descriptor["session_id_sha256"] != request["session_id_sha256"]:
        fail(OBLIGATION_ID, "authority belongs to another Chrome session")
    if (
        response.get("existing_session") is not True
        or response.get("read_only") is not True
        or not _is_exact_int(response.get("browser_launch_count"), 0)
        or not _is_exact_int(response.get("mutation_count"), 0)
    ):
        fail(OBLIGATION_ID, "authority launched or mutated a browser during verification")


def _validate_response_time(
    response: dict[str, Any], receipt: dict[str, Any], now: datetime,
) -> None:
    verified = parse_utc(response.get("verified_at"), "verified_at", OBLIGATION_ID)
    observed = parse_utc(receipt.get("observed_at"), "observed_at", OBLIGATION_ID)
    expires = parse_utc(receipt.get("expires_at"), "expires_at", OBLIGATION_ID)
    if now.tzinfo != timezone.utc:
        fail(OBLIGATION_ID, "trusted authority verifier clock must be UTC")
    if verified < observed or verified > min(expires, now):
        fail(OBLIGATION_ID, "authority response is outside the receipt verification window")


def _validate_platform_response(
    response: dict[str, Any], request: dict[str, Any],
) -> None:
    results = response.get("platform_results")
    if results != request["platform_bindings"]:
        fail(OBLIGATION_ID, "authority platform bindings differ from the receipt")
    for row in results:
        for key in (
            "authenticated", "account_verified", "exact_post_verified",
            "trusted_runtime_provenance_verified", "document_epoch_verified",
            "frame_topology_verified",
        ):
            if row.get(key) is not True:
                fail(OBLIGATION_ID, f"authority did not verify {key}")
        if not _is_exact_int(row.get("mutation_count"), 0):
            fail(OBLIGATION_ID, "authority platform verification was not read-only")


def _call_authority(authority: Any, request: dict[str, Any]) -> dict[str, Any]:
    try:
        response = authority.verify_existing_session(request)
    except Exception as exc:
        raise ValueError(
            f"obligation {OBLIGATION_ID} promotion evidence authority challenge failed"
        ) from exc
    return require_exact_keys(
        response, RESPONSE_KEYS, "trusted authority response", OBLIGATION_ID
    )


def build_trusted_host_verifier(
    authority_resolver: AuthorityResolver, *, allow_test_authority: bool = False,
) -> TrustedVerifier:
    """Build a verifier around one source-wired existing-session resolver."""
    if not callable(authority_resolver):
        raise TypeError("trusted host authority resolver must be callable")

    def verify(
        receipt: dict[str, Any], version: str, revision: str,
        _root: Path, now: datetime,
    ) -> None:
        try:
            authority = authority_resolver()
        except Exception as exc:
            raise ValueError(
                f"obligation {OBLIGATION_ID} promotion evidence authority resolver failed"
            ) from exc
        if authority is None:
            fail(
                OBLIGATION_ID,
                "cannot promote: trusted existing Chrome session authority is unavailable",
            )
        descriptor = _authority_descriptor(authority, allow_test_authority)
        request = _verification_request(receipt, version, revision)
        response = _call_authority(authority, request)
        _validate_response_identity(response, request, descriptor)
        _validate_response_time(response, receipt, now)
        _validate_platform_response(response, request)

    return verify


# Callable production boundary is installed, but its source-wired runtime
# resolver intentionally has no authority until Chrome control attaches an
# already-running session.  No JSON receipt can change this state.
verify_trusted_chrome_host_receipt = build_trusted_host_verifier(
    _runtime_authority_unavailable
)


__all__ = [
    "AUTHORITY_SCHEMA_VERSION",
    "AUTHORITY_TRUST_DOMAIN",
    "EXISTING_SESSION_KIND",
    "OBLIGATION_ID",
    "VERIFY_OPERATION",
    "build_trusted_host_verifier",
    "verify_trusted_chrome_host_receipt",
]

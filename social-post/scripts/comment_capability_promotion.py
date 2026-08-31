#!/usr/bin/env python3
"""Fail-closed public facade for browser comment capability promotion.

Schema calibration may use synthetic receipts, but production promotion stays
closed until a trusted runtime producer and callable child verifier are wired
into ``TRUSTED_PRODUCER_VERIFIERS``. Static JSON is never live promotion
authority. A requirement whose contract fixes ``promotion`` to false may have
a source-bound verifier for localhost evidence, but cannot open live successors.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from comment_capability_promotion_contract import (
    BASE_SOURCES,
    CANONICALIZATION,
    CANONICAL_HASH_GOLDEN_SHA256,
    CANONICAL_HASH_GOLDEN_VALUE,
    COMMON_KEYS,
    FIXTURE_RUNTIME_SOURCES,
    HASH_ALGORITHM,
    HEX_256,
    MAX_RECEIPT_BYTES,
    OBLIGATION_KEYS,
    PLATFORMS,
    PROMOTION_DEPENDENCIES,
    REQUIREMENTS,
    RFC3339_UTC,
    SOURCE_PATH,
    UUID_V4,
    fail,
    require_exact_keys,
    validate_promotion_dependency_graph,
)
from comment_capability_promotion_semantics import SEMANTIC_VALIDATORS
from comment_capability_trusted_host_verifier import (
    verify_trusted_chrome_host_receipt,
)
from comment_fixture_promotion_envelope import (
    verify_three_platform_fixture_envelope,
)
from comment_capability_receipt_support import (
    canonical_json_bytes,
    capability_contract_hash,
    json_hash,
    load_canonical_receipt,
    safe_file,
    source_rows,
    stable_read,
    validate_common_receipt,
    validate_hash_golden,
)


TrustedVerifier = Callable[[dict[str, Any], str, str, Path, datetime], None]

# Deliberately closed for live authority. The host row has a callable
# challenge/response boundary, while the localhost fixture row only verifies a
# promotion=false envelope cross-bound to the rich raw Browser receipt. The
# remaining live successors stay unwired. Receipt booleans, hashes, fixtures,
# and projection summaries cannot install or replace authenticated authority.
TRUSTED_PRODUCER_VERIFIERS: dict[str, TrustedVerifier | None] = {
    obligation_id: None for obligation_id in REQUIREMENTS
}
TRUSTED_PRODUCER_VERIFIERS["TRUSTED_CHROME_HOST_RESOLVER"] = (
    verify_trusted_chrome_host_receipt
)
TRUSTED_PRODUCER_VERIFIERS["THREE_PLATFORM_BROWSER_FIXTURE"] = (
    verify_three_platform_fixture_envelope
)


def required_promotion_receipt(row: dict[str, Any]) -> str | None:
    obligation_id = row.get("id")
    requirement = REQUIREMENTS.get(obligation_id)
    if requirement is None:
        return None
    evidence = row.get("evidence")
    matches = [
        entry
        for entry in evidence or []
        if isinstance(entry, dict) and entry.get("kind") == "promotion_receipt"
    ]
    if len(matches) != 1 or matches[0].get("value") != requirement["path"]:
        fail(
            obligation_id,
            f"requires one promotion_receipt at {requirement['path']}",
        )
    return requirement["path"]


def validate_promotion_receipt(
    obligation_id: str,
    receipt: Any,
    version: str,
    revision: str,
    root: Path,
    *,
    calibration_only: bool = False,
    now: datetime | None = None,
) -> None:
    requirement = REQUIREMENTS.get(obligation_id)
    if requirement is None:
        return
    if not calibration_only and requirement.get("promotion") is not True:
        fail(
            obligation_id,
            "cannot promote: contract fixes promotion=false; test-only quality "
            "evidence cannot become a verified capability",
        )
    require_exact_keys(
        receipt,
        COMMON_KEYS | OBLIGATION_KEYS[obligation_id],
        "receipt",
        obligation_id,
    )
    verifier_now = now or datetime.now(timezone.utc)
    validate_common_receipt(
        receipt, obligation_id, version, revision, root, verifier_now
    )
    SEMANTIC_VALIDATORS[obligation_id](receipt, obligation_id)
    if calibration_only:
        return
    verifier = TRUSTED_PRODUCER_VERIFIERS[obligation_id]
    if verifier is None:
        fail(
            obligation_id,
            "cannot promote: no trusted Chrome runtime producer verifier is "
            "integrated; static JSON is never promotion authority",
        )
    verifier(receipt, version, revision, root, verifier_now)


def validate_promotion_evidence(
    row: dict[str, Any], version: str, revision: str, root: Path,
) -> None:
    requirement = REQUIREMENTS.get(row.get("id"))
    if requirement is not None and requirement.get("promotion") is not True:
        fail(
            row["id"],
            "cannot promote: contract fixes promotion=false; test-only quality "
            "evidence cannot satisfy a verified ledger row",
        )
    relative = required_promotion_receipt(row)
    if relative is None:
        return
    path = safe_file(root, relative, row["id"])
    receipt = load_canonical_receipt(path, row["id"])
    validate_promotion_receipt(row["id"], receipt, version, revision, root)


__all__ = [
    "BASE_SOURCES",
    "CANONICALIZATION",
    "CANONICAL_HASH_GOLDEN_SHA256",
    "CANONICAL_HASH_GOLDEN_VALUE",
    "COMMON_KEYS",
    "FIXTURE_RUNTIME_SOURCES",
    "HASH_ALGORITHM",
    "HEX_256",
    "MAX_RECEIPT_BYTES",
    "OBLIGATION_KEYS",
    "PLATFORMS",
    "PROMOTION_DEPENDENCIES",
    "REQUIREMENTS",
    "RFC3339_UTC",
    "SEMANTIC_VALIDATORS",
    "SOURCE_PATH",
    "TRUSTED_PRODUCER_VERIFIERS",
    "UUID_V4",
    "canonical_json_bytes",
    "capability_contract_hash",
    "json_hash",
    "load_canonical_receipt",
    "required_promotion_receipt",
    "safe_file",
    "source_rows",
    "stable_read",
    "validate_hash_golden",
    "validate_promotion_dependency_graph",
    "validate_promotion_evidence",
    "validate_promotion_receipt",
    "verify_trusted_chrome_host_receipt",
]

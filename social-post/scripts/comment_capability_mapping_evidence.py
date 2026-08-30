#!/usr/bin/env python3
"""Validate non-authoritative test-only full-lifecycle mapping evidence.

This schema is deliberately outside promotion ``REQUIREMENTS``.  It recognizes
offline contract evidence but has no receipt path, writer, trusted verifier, or
capability promotion authority.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from comment_capability_promotion_contract import (
    PLATFORMS,
    TEST_ONLY_FULL_LIFECYCLE_MAPPING_CLASS,
    TEST_ONLY_FULL_LIFECYCLE_MAPPING_COVERAGE,
    TEST_ONLY_FULL_LIFECYCLE_MAPPING_KEYS,
    TEST_ONLY_FULL_LIFECYCLE_MAPPING_SOURCES,
    TEST_ONLY_FULL_LIFECYCLE_NEGATIVE_KEYS,
    TEST_ONLY_FULL_LIFECYCLE_NEGATIVES,
    TEST_ONLY_FULL_LIFECYCLE_PHASES,
    TEST_ONLY_FULL_LIFECYCLE_PLATFORM_KEYS,
    TEST_ONLY_FULL_LIFECYCLE_STAGE_KEYS,
    TEST_ONLY_NATIVE_LIFECYCLE_KEYS,
    TEST_ONLY_NATIVE_LIFECYCLE_STAGE_KEYS,
    TEST_ONLY_NATIVE_REPLY_CARDINALITY_KEYS,
    exact_int,
    fail,
    require_bool,
    require_exact_keys,
    require_hex,
    require_nonempty_string,
)
from comment_capability_receipt_support import json_hash, safe_file, stable_read


OBLIGATION_ID = "STABLE_NODE_FRAME_MAPPING"


def _validate_native_reply_cardinality(
    value: Any, phase_index: int, baseline: int | None,
) -> int:
    row = require_exact_keys(
        value, TEST_ONLY_NATIVE_REPLY_CARDINALITY_KEYS,
        "serialized native lifecycle reply cardinality", OBLIGATION_ID,
    )
    for key in (
        "cursor", "discovered_count", "total_reply_count",
        "exact_own_reply_count", "own_author_reply_count",
    ):
        if not exact_int(row.get(key)) or row[key] < 0:
            fail(OBLIGATION_ID, f"native lifecycle {key} must be a non-negative integer")
    require_bool(row, "terminal", True, OBLIGATION_ID)
    if row["discovered_count"] != row["total_reply_count"]:
        fail(OBLIGATION_ID, "native lifecycle reply coverage is not terminal-complete")
    current = row["total_reply_count"]
    base = current if baseline is None else baseline
    if phase_index < 4:
        if current != base or row["exact_own_reply_count"] != 0:
            fail(OBLIGATION_ID, "native lifecycle pre-submit cardinality drifted")
    elif (
        current != base + 1 or row["exact_own_reply_count"] != 1
        or row["own_author_reply_count"] < 1
    ):
        fail(OBLIGATION_ID, "native lifecycle finish cardinality is not exact")
    return base


def _validate_native_stage(value: Any, phase: str, index: int, baseline: int | None) -> int:
    row = require_exact_keys(
        value, TEST_ONLY_NATIVE_LIFECYCLE_STAGE_KEYS,
        f"serialized native lifecycle stage {phase}", OBLIGATION_ID,
    )
    if row.get("stage") != phase:
        fail(OBLIGATION_ID, "serialized native lifecycle stages are incomplete or reordered")
    require_hex(row.get("snapshot_digest"), "native lifecycle snapshot", OBLIGATION_ID)
    require_hex(row.get("role_bindings_sha256"), "native lifecycle roles", OBLIGATION_ID)
    if not exact_int(row.get("role_count")) or row["role_count"] < 1:
        fail(OBLIGATION_ID, "native lifecycle role_count must be a positive integer")
    require_bool(row, "expansion_terminal", index != 0, OBLIGATION_ID)
    return _validate_native_reply_cardinality(row.get("reply_cardinality"), index, baseline)


def _validate_native_attestation(value: Any) -> dict[str, Any]:
    """Validate serialized JS output as a non-authoritative structural report.

    Python cannot preserve the JS module's process brand.  Passing this schema
    therefore proves only closed-world structure; it never proves trusted host
    provenance and is never a promotion receipt.
    """
    row = require_exact_keys(
        value, TEST_ONLY_NATIVE_LIFECYCLE_KEYS,
        "serialized native lifecycle attestation", OBLIGATION_ID,
    )
    if not exact_int(row.get("schema_version"), 1):
        fail(OBLIGATION_ID, "native lifecycle schema_version must be integer 1")
    if (
        row.get("evidence_class") != TEST_ONLY_FULL_LIFECYCLE_MAPPING_CLASS
        or row.get("coverage") != TEST_ONLY_FULL_LIFECYCLE_MAPPING_COVERAGE
        or row.get("platform") not in PLATFORMS
    ):
        fail(OBLIGATION_ID, "native lifecycle identity, coverage, or platform drifted")
    for key, expected in (
        ("test_only", True), ("capability_promotion_eligible", False),
        ("live_browser_actuation_enabled", False), ("live_plan_minting", False),
        ("browser_receipt_eligible", False),
        ("test_only_full_lifecycle_bound", True), ("live_full_lifecycle_bound", False),
        ("previous_stage_one_time_consume", True),
    ):
        require_bool(row, key, expected, OBLIGATION_ID)
    if row.get("stage_order") != TEST_ONLY_FULL_LIFECYCLE_PHASES:
        fail(OBLIGATION_ID, "native lifecycle stage order is incomplete")
    if not exact_int(row.get("stage_count"), len(TEST_ONLY_FULL_LIFECYCLE_PHASES)):
        fail(OBLIGATION_ID, "native lifecycle stage_count is not exact")
    if not exact_int(row.get("stable_reads_per_stage"), 2):
        fail(OBLIGATION_ID, "native lifecycle requires two stable reads per stage")
    for key in ("adapter_id", "adapter_version"):
        require_nonempty_string(row.get(key), f"native lifecycle {key}", OBLIGATION_ID)
    for key in (
        "lifecycle_session_id", "plan_digest", "final_stage_attestation_id",
        "lifecycle_attestation_id",
    ):
        require_hex(row.get(key), f"native lifecycle {key}", OBLIGATION_ID)
    stages = row.get("stages")
    if not isinstance(stages, list) or len(stages) != len(TEST_ONLY_FULL_LIFECYCLE_PHASES):
        fail(OBLIGATION_ID, "native lifecycle requires six stages")
    baseline = None
    for index, phase in enumerate(TEST_ONLY_FULL_LIFECYCLE_PHASES):
        baseline = _validate_native_stage(stages[index], phase, index, baseline)
    core = {key: item for key, item in row.items() if key != "lifecycle_attestation_id"}
    if row["lifecycle_attestation_id"] != json_hash(core):
        fail(OBLIGATION_ID, "native lifecycle attestation digest is invalid")
    return row


def _validate_sources(value: dict[str, Any], root: Path) -> None:
    rows = value.get("source_files")
    expected = TEST_ONLY_FULL_LIFECYCLE_MAPPING_SOURCES
    if not isinstance(rows, list) or len(rows) != len(expected):
        fail(OBLIGATION_ID, "test-only lifecycle evidence requires exact sources")
    for index, relative in enumerate(expected):
        row = require_exact_keys(
            rows[index], {"path", "exists", "size", "sha256"},
            f"test-only lifecycle source {index}", OBLIGATION_ID,
        )
        if row.get("path") != relative or row.get("exists") is not True:
            fail(OBLIGATION_ID, "test-only lifecycle source path/order drifted")
        if not exact_int(row.get("size")) or row["size"] < 0:
            fail(OBLIGATION_ID, "test-only lifecycle source size is invalid")
        payload = stable_read(safe_file(root, relative, OBLIGATION_ID), OBLIGATION_ID)
        if row["size"] != len(payload) or row.get("sha256") != hashlib.sha256(payload).hexdigest():
            fail(OBLIGATION_ID, f"test-only lifecycle source is stale: {relative}")
    if value.get("source_snapshot_sha256") != json_hash(rows):
        fail(OBLIGATION_ID, "test-only lifecycle source snapshot is stale")


def _validate_boundary(value: dict[str, Any]) -> None:
    require_exact_keys(
        value, TEST_ONLY_FULL_LIFECYCLE_MAPPING_KEYS,
        "test-only full lifecycle evidence", OBLIGATION_ID,
    )
    if not exact_int(value.get("schema_version"), 1):
        fail(OBLIGATION_ID, "test-only lifecycle schema_version must be integer 1")
    if (
        value.get("evidence_class") != TEST_ONLY_FULL_LIFECYCLE_MAPPING_CLASS
        or value.get("production_obligation_id") != OBLIGATION_ID
        or value.get("coverage") != TEST_ONLY_FULL_LIFECYCLE_MAPPING_COVERAGE
    ):
        fail(OBLIGATION_ID, "test-only lifecycle identity or coverage drifted")
    require_bool(value, "test_only", True, OBLIGATION_ID)
    require_bool(value, "capability_promotion_eligible", False, OBLIGATION_ID)
    require_bool(value, "live_browser_actuation_enabled", False, OBLIGATION_ID)
    require_bool(value, "live_plan_minting", False, OBLIGATION_ID)
    require_bool(value, "browser_receipt_eligible", False, OBLIGATION_ID)
    require_bool(value, "test_only_full_lifecycle_bound", True, OBLIGATION_ID)
    require_bool(value, "live_full_lifecycle_bound", False, OBLIGATION_ID)
    if value.get("phase_order") != TEST_ONLY_FULL_LIFECYCLE_PHASES:
        fail(OBLIGATION_ID, "test-only lifecycle phase order is incomplete")
    if value.get("platform_order") != PLATFORMS:
        fail(OBLIGATION_ID, "test-only lifecycle platform order is incomplete")


def _validate_stage(
    stage: Any, phase: str, previous: str, identity: tuple[str, ...] | None,
) -> tuple[str, tuple[str, ...]]:
    row = require_exact_keys(
        stage, TEST_ONLY_FULL_LIFECYCLE_STAGE_KEYS,
        f"test-only lifecycle stage {phase}", OBLIGATION_ID,
    )
    if row.get("phase") != phase or not exact_int(row.get("stable_read_count"), 2):
        fail(OBLIGATION_ID, "each lifecycle phase requires two stable reads")
    hash_keys = (
        "frame_id_sha256", "document_epoch_sha256", "comment_identity_sha256",
        "parent_anchor_sha256", "node_roles_sha256", "previous_stage_sha256",
        "stage_binding_sha256",
    )
    for key in hash_keys:
        require_hex(row.get(key), key, OBLIGATION_ID)
    if row["previous_stage_sha256"] != previous:
        fail(OBLIGATION_ID, "lifecycle previous-stage binding is stale or replayed")
    core = {key: item for key, item in row.items() if key != "stage_binding_sha256"}
    if row["stage_binding_sha256"] != json_hash(core):
        fail(OBLIGATION_ID, "lifecycle stage binding hash is invalid")
    current_identity = tuple(row[key] for key in hash_keys[:4])
    if identity is not None and current_identity != identity:
        fail(OBLIGATION_ID, "frame/document/comment/parent changed across lifecycle")
    return row["stage_binding_sha256"], current_identity


def _validate_platform(result: Any, platform: str) -> None:
    row = require_exact_keys(
        result, TEST_ONLY_FULL_LIFECYCLE_PLATFORM_KEYS,
        f"test-only lifecycle platform {platform}", OBLIGATION_ID,
    )
    if row.get("platform") != platform or row.get("fixture_environment") != "fixture_testonly":
        fail(OBLIGATION_ID, "test-only lifecycle platform/environment drifted")
    require_bool(row, "full_lifecycle_bound", True, OBLIGATION_ID)
    if not exact_int(row.get("stable_read_count"), 2):
        fail(OBLIGATION_ID, "platform lifecycle stable_read_count must be integer 2")
    for key in ("browser_launch_count", "mutation_count"):
        if not exact_int(row.get(key), 0):
            fail(OBLIGATION_ID, f"test-only lifecycle {key} must be integer 0")
    stages = row.get("stage_bindings")
    if not isinstance(stages, list) or len(stages) != len(TEST_ONLY_FULL_LIFECYCLE_PHASES):
        fail(OBLIGATION_ID, "test-only lifecycle requires every stage exactly once")
    previous = json_hash({"platform": platform, "lifecycle_start": True})
    identity = None
    bindings = []
    for index, phase in enumerate(TEST_ONLY_FULL_LIFECYCLE_PHASES):
        previous, identity = _validate_stage(stages[index], phase, previous, identity)
        bindings.append(previous)
    if len(bindings) != len(set(bindings)):
        fail(OBLIGATION_ID, "lifecycle stage bindings must be unique")
    lifecycle = json_hash(stages)
    if row.get("lifecycle_binding_sha256") != lifecycle:
        fail(OBLIGATION_ID, "full lifecycle binding hash is invalid")
    replay = json_hash({
        "evidence_class": TEST_ONLY_FULL_LIFECYCLE_MAPPING_CLASS,
        "platform": platform,
        "lifecycle_binding_sha256": lifecycle,
    })
    if row.get("replay_binding_sha256") != replay:
        fail(OBLIGATION_ID, "full lifecycle replay binding hash is invalid")


def _validate_negatives(value: dict[str, Any]) -> None:
    rows = value.get("negative_cases")
    if not isinstance(rows, list) or len(rows) != len(TEST_ONLY_FULL_LIFECYCLE_NEGATIVES):
        fail(OBLIGATION_ID, "test-only lifecycle negative set is incomplete")
    for index, name in enumerate(TEST_ONLY_FULL_LIFECYCLE_NEGATIVES):
        row = require_exact_keys(
            rows[index], TEST_ONLY_FULL_LIFECYCLE_NEGATIVE_KEYS,
            "test-only lifecycle negative", OBLIGATION_ID,
        )
        if row.get("name") != name or row.get("passed") is not True:
            fail(OBLIGATION_ID, "test-only lifecycle negatives are reordered or failed")
        require_hex(row.get("evidence_sha256"), "negative evidence", OBLIGATION_ID)


def validate_test_only_full_lifecycle_mapping_evidence(
    value: Any, root: Path,
) -> dict[str, Any]:
    """Recognize test-only structure without granting promotion authority."""
    if isinstance(value, dict) and "lifecycle_attestation_id" in value:
        return _validate_native_attestation(value)
    _validate_boundary(value)
    _validate_sources(value, root)
    results = value.get("results")
    if not isinstance(results, list) or len(results) != len(PLATFORMS):
        fail(OBLIGATION_ID, "test-only lifecycle requires exactly three platforms")
    for index, platform in enumerate(PLATFORMS):
        _validate_platform(results[index], platform)
    _validate_negatives(value)
    payload = {key: item for key, item in value.items() if key != "evidence_sha256"}
    if value.get("evidence_sha256") != json_hash(payload):
        fail(OBLIGATION_ID, "test-only lifecycle evidence hash is invalid")
    return value


__all__ = ["validate_test_only_full_lifecycle_mapping_evidence"]

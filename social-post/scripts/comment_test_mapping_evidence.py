#!/usr/bin/env python3
"""Negative calibration for non-promotable full-lifecycle mapping evidence."""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any, Callable

from comment_capability_mapping_evidence import (
    validate_test_only_full_lifecycle_mapping_evidence,
)
from comment_capability_promotion import (
    PLATFORMS,
    REQUIREMENTS,
    json_hash,
    validate_promotion_receipt,
)
from comment_capability_promotion_fixtures import (
    FIXED_NOW,
    native_test_only_full_lifecycle_mapping_attestation,
    test_only_full_lifecycle_mapping_evidence,
)


def _expect_rejected(check: Callable[[], None], label: str) -> None:
    try:
        check()
    except (AssertionError, OSError, TypeError, ValueError):
        return
    raise AssertionError(f"test-only lifecycle mapping negative was accepted: {label}")


def _reject(value: dict[str, Any], root: Path, label: str) -> None:
    _expect_rejected(
        lambda: validate_test_only_full_lifecycle_mapping_evidence(value, root), label
    )


def _boundary_negatives(base: dict[str, Any], root: Path) -> None:
    cases = {
        "boolean schema": ("schema_version", True),
        "floating schema": ("schema_version", 1.0),
        "wrong evidence class": ("evidence_class", "production_mapping"),
        "wrong production obligation": ("production_obligation_id", "LIVE_BATCH_CONFIRM"),
        "wrong coverage": ("coverage", "test_only_final_scan_comment_nodes"),
        "not test-only": ("test_only", False),
        "promotion eligible": ("capability_promotion_eligible", True),
        "live browser enabled": ("live_browser_actuation_enabled", True),
        "live plan minting": ("live_plan_minting", True),
        "browser receipt eligible": ("browser_receipt_eligible", True),
        "partial lifecycle boundary": ("test_only_full_lifecycle_bound", False),
        "live lifecycle boundary": ("live_full_lifecycle_bound", True),
    }
    for label, (key, value) in cases.items():
        candidate = copy.deepcopy(base)
        candidate[key] = value
        _reject(candidate, root, label)
    extra = copy.deepcopy(base)
    extra["receipt_path"] = ".rd/receipts/stable-node-frame-mapping.json"
    _reject(extra, root, "receipt path injection")


def _source_negatives(base: dict[str, Any], root: Path) -> None:
    cases = []
    missing = copy.deepcopy(base)
    missing["source_files"].pop()
    cases.append(("missing lifecycle source", missing))
    reordered = copy.deepcopy(base)
    reordered["source_files"][0], reordered["source_files"][1] = (
        reordered["source_files"][1], reordered["source_files"][0]
    )
    cases.append(("reordered lifecycle sources", reordered))
    stale = copy.deepcopy(base)
    stale["source_files"][0]["sha256"] = "0" * 64
    cases.append(("stale lifecycle source", stale))
    floating = copy.deepcopy(base)
    floating["source_files"][0]["size"] = float(floating["source_files"][0]["size"])
    cases.append(("floating lifecycle source size", floating))
    for label, candidate in cases:
        _reject(candidate, root, label)


def _stage_negatives(base: dict[str, Any], root: Path) -> None:
    cases = []
    missing = copy.deepcopy(base)
    missing["results"][0]["stage_bindings"].pop()
    cases.append(("missing lifecycle stage", missing))
    reordered = copy.deepcopy(base)
    stages = reordered["results"][0]["stage_bindings"]
    stages[0], stages[1] = stages[1], stages[0]
    cases.append(("reordered lifecycle stage", reordered))
    read_once = copy.deepcopy(base)
    read_once["results"][0]["stage_bindings"][2]["stable_read_count"] = 1
    cases.append(("single stage read", read_once))
    frame_drift = copy.deepcopy(base)
    frame_drift["results"][0]["stage_bindings"][3]["frame_id_sha256"] = "1" * 64
    cases.append(("cross-stage frame drift", frame_drift))
    stale_previous = copy.deepcopy(base)
    stale_previous["results"][0]["stage_bindings"][4]["previous_stage_sha256"] = "2" * 64
    cases.append(("stale previous-stage binding", stale_previous))
    stale_binding = copy.deepcopy(base)
    stale_binding["results"][0]["stage_bindings"][5]["stage_binding_sha256"] = "3" * 64
    cases.append(("stale stage binding", stale_binding))
    for label, candidate in cases:
        _reject(candidate, root, label)


def _platform_and_negative_cases(base: dict[str, Any], root: Path) -> None:
    cases = []
    wrong_platform = copy.deepcopy(base)
    wrong_platform["results"][1]["platform"] = "facebook"
    cases.append(("cross-platform lifecycle result", wrong_platform))
    not_full = copy.deepcopy(base)
    not_full["results"][0]["full_lifecycle_bound"] = False
    cases.append(("partial lifecycle result", not_full))
    launched = copy.deepcopy(base)
    launched["results"][0]["browser_launch_count"] = 1
    cases.append(("browser launch", launched))
    float_launch = copy.deepcopy(base)
    float_launch["results"][0]["browser_launch_count"] = 0.0
    cases.append(("floating browser launch count", float_launch))
    mutated = copy.deepcopy(base)
    mutated["results"][0]["mutation_count"] = 1
    cases.append(("browser mutation", mutated))
    missing_negative = copy.deepcopy(base)
    missing_negative["negative_cases"].pop()
    cases.append(("missing negative case", missing_negative))
    failed_negative = copy.deepcopy(base)
    failed_negative["negative_cases"][0]["passed"] = False
    cases.append(("failed negative case", failed_negative))
    for label, candidate in cases:
        _reject(candidate, root, label)


def _rehash_native(value: dict[str, Any]) -> None:
    value["lifecycle_attestation_id"] = json_hash({
        key: item for key, item in value.items() if key != "lifecycle_attestation_id"
    })


def _native_attestation_negatives(base: dict[str, Any], root: Path) -> None:
    cases = []
    for label, key, value in (
        ("native browser receipt eligible", "browser_receipt_eligible", True),
        ("native production eligible", "capability_promotion_eligible", True),
        ("native live lifecycle", "live_full_lifecycle_bound", True),
        ("native floating stable reads", "stable_reads_per_stage", 2.0),
    ):
        candidate = copy.deepcopy(base)
        candidate[key] = value
        _rehash_native(candidate)
        cases.append((label, candidate))
    reordered = copy.deepcopy(base)
    reordered["stages"][0], reordered["stages"][1] = (
        reordered["stages"][1], reordered["stages"][0]
    )
    _rehash_native(reordered)
    cases.append(("native reordered stages", reordered))
    float_role = copy.deepcopy(base)
    float_role["stages"][1]["role_count"] = 9.0
    _rehash_native(float_role)
    cases.append(("native floating role count", float_role))
    nonterminal = copy.deepcopy(base)
    nonterminal["stages"][2]["expansion_terminal"] = False
    _rehash_native(nonterminal)
    cases.append(("native nonterminal post-expand", nonterminal))
    cardinality = copy.deepcopy(base)
    cardinality["stages"][4]["reply_cardinality"]["exact_own_reply_count"] = 0
    _rehash_native(cardinality)
    cases.append(("native finish cardinality", cardinality))
    extra = copy.deepcopy(base)
    extra["receipt_path"] = ".rd/receipts/stable-node-frame-mapping.json"
    cases.append(("native receipt path injection", extra))
    stale = copy.deepcopy(base)
    stale["lifecycle_attestation_id"] = "f" * 64
    cases.append(("native stale attestation digest", stale))
    for label, candidate in cases:
        _reject(candidate, root, label)


def _prove_no_production_route(
    base: dict[str, Any], root: Path, version: str, revision: str,
) -> None:
    if "test_only_full_lifecycle_mapping" in REQUIREMENTS:
        raise AssertionError("test-only mapping evidence entered promotion REQUIREMENTS")
    if base.get("capability_promotion_eligible") is not False:
        raise AssertionError("test-only mapping evidence became promotion eligible")
    for key in (
        "browser_receipt_eligible", "live_browser_actuation_enabled",
        "live_plan_minting", "live_full_lifecycle_bound",
    ):
        if base.get(key) is not False:
            raise AssertionError(f"test-only mapping evidence crossed boundary: {key}")
    forbidden = {"gate", "status", "run_id", "session_id_sha256", "observed_at", "expires_at"}
    if forbidden & set(base):
        raise AssertionError("test-only mapping evidence acquired receipt authority fields")
    _expect_rejected(
        lambda: validate_promotion_receipt(
            "STABLE_NODE_FRAME_MAPPING", base, version, revision, root,
            calibration_only=True, now=FIXED_NOW,
        ),
        "test-only evidence used as production stable mapping receipt",
    )


def run_test_only_mapping_evidence_calibration(
    root: Path, version: str, revision: str,
) -> None:
    base = test_only_full_lifecycle_mapping_evidence(root)
    validate_test_only_full_lifecycle_mapping_evidence(base, root)
    _boundary_negatives(base, root)
    _source_negatives(base, root)
    _stage_negatives(base, root)
    _platform_and_negative_cases(base, root)
    bad_hash = copy.deepcopy(base)
    bad_hash["evidence_sha256"] = "f" * 64
    _reject(bad_hash, root, "stale outer evidence hash")
    _prove_no_production_route(base, root, version, revision)
    for platform in PLATFORMS:
        native = native_test_only_full_lifecycle_mapping_attestation(platform)
        validate_test_only_full_lifecycle_mapping_evidence(native, root)
        _prove_no_production_route(native, root, version, revision)
    _native_attestation_negatives(
        native_test_only_full_lifecycle_mapping_attestation(), root,
    )


__all__ = ["run_test_only_mapping_evidence_calibration"]

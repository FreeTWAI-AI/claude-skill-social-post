#!/usr/bin/env python3
"""Task-shaped calibration for comment capability promotion contracts."""

from __future__ import annotations

import copy
import os
import tempfile
from pathlib import Path
from typing import Any, Callable

from comment_capability_promotion import (
    MAX_RECEIPT_BYTES,
    PROMOTION_DEPENDENCIES,
    REQUIREMENTS,
    TRUSTED_PRODUCER_VERIFIERS,
    canonical_json_bytes,
    json_hash,
    load_canonical_receipt,
    safe_file,
    validate_hash_golden,
    validate_promotion_dependency_graph,
    validate_promotion_receipt,
)
from comment_capability_trusted_host_verifier import (
    verify_trusted_chrome_host_receipt,
)
from comment_fixture_promotion_envelope import (
    verify_three_platform_fixture_envelope,
)
from comment_test_mapping_evidence import run_test_only_mapping_evidence_calibration
from comment_capability_promotion_fixtures import (
    FIXED_NOW,
    digest,
    positive_receipt,
)


EXPECTED_PROMOTION_DEPENDENCIES = {
    "TRUSTED_CHROME_HOST_RESOLVER": [],
    "STABLE_NODE_FRAME_MAPPING": ["TRUSTED_CHROME_HOST_RESOLVER"],
    "THREE_PLATFORM_BROWSER_FIXTURE": [
        "TRUSTED_CHROME_HOST_RESOLVER", "STABLE_NODE_FRAME_MAPPING",
    ],
    "THREE_PLATFORM_LIVE_DRAFT": ["THREE_PLATFORM_BROWSER_FIXTURE"],
    "LIVE_BATCH_CONFIRM": ["THREE_PLATFORM_LIVE_DRAFT"],
    "LIVE_BOUNDED_AUTO": ["LIVE_BATCH_CONFIRM"],
}


def _expect_rejected(check: Callable[[], None], label: str) -> None:
    try:
        check()
    except (AssertionError, OSError, ValueError):
        return
    raise AssertionError(f"negative promotion fixture was accepted: {label}")


def _validate_calibration(
    obligation_id: str, receipt: dict[str, Any], version: str,
    revision: str, root: Path,
) -> None:
    validate_promotion_receipt(
        obligation_id, receipt, version, revision, root,
        calibration_only=True, now=FIXED_NOW,
    )


def _reject_receipt(
    obligation_id: str, receipt: dict[str, Any], version: str,
    revision: str, root: Path, label: str,
) -> None:
    _expect_rejected(
        lambda: _validate_calibration(obligation_id, receipt, version, revision, root),
        label,
    )


def _dependency_graph_negatives() -> None:
    if PROMOTION_DEPENDENCIES != EXPECTED_PROMOTION_DEPENDENCIES:
        raise AssertionError("promotion dependency graph drifted from the calibration golden")
    validate_promotion_dependency_graph(PROMOTION_DEPENDENCIES)
    candidates: list[tuple[str, dict[str, list[str]]]] = []
    missing = copy.deepcopy(PROMOTION_DEPENDENCIES)
    missing.pop("LIVE_BOUNDED_AUTO")
    candidates.append(("dependency graph missing node", missing))
    unknown = copy.deepcopy(PROMOTION_DEPENDENCIES)
    unknown["LIVE_BOUNDED_AUTO"] = ["UNKNOWN_NODE"]
    candidates.append(("dependency graph unknown predecessor", unknown))
    self_edge = copy.deepcopy(PROMOTION_DEPENDENCIES)
    self_edge["LIVE_BOUNDED_AUTO"] = ["LIVE_BOUNDED_AUTO"]
    candidates.append(("dependency graph self edge", self_edge))
    cycle = copy.deepcopy(PROMOTION_DEPENDENCIES)
    cycle["TRUSTED_CHROME_HOST_RESOLVER"] = ["LIVE_BOUNDED_AUTO"]
    candidates.append(("dependency graph cycle", cycle))
    for label, candidate in candidates:
        _expect_rejected(
            lambda item=candidate: validate_promotion_dependency_graph(item), label
        )


def _positive_and_production_closed(
    positives: dict[str, dict[str, Any]], version: str, revision: str, root: Path,
) -> None:
    for obligation_id, receipt in positives.items():
        _validate_calibration(obligation_id, receipt, version, revision, root)
        if obligation_id == "THREE_PLATFORM_BROWSER_FIXTURE":
            # Its production=false verifier is covered by the raw/envelope
            # binding suite; this synthetic receipt intentionally has no raw
            # Browser artifact to authenticate.
            continue
        _expect_rejected(
            lambda oid=obligation_id, item=receipt: validate_promotion_receipt(
                oid, item, version, revision, root, now=FIXED_NOW
            ),
            f"self-authored production receipt for {obligation_id}",
        )


def _trusted_verifier_registration() -> None:
    host = "TRUSTED_CHROME_HOST_RESOLVER"
    if TRUSTED_PRODUCER_VERIFIERS.get(host) is not verify_trusted_chrome_host_receipt:
        raise AssertionError("trusted host callable verifier is not source-wired")
    fixture = "THREE_PLATFORM_BROWSER_FIXTURE"
    if (
        TRUSTED_PRODUCER_VERIFIERS.get(fixture)
        is not verify_three_platform_fixture_envelope
    ):
        raise AssertionError("test-only Browser fixture verifier is not source-wired")
    successors = set(REQUIREMENTS) - {host, fixture}
    if any(TRUSTED_PRODUCER_VERIFIERS.get(item) is not None for item in successors):
        raise AssertionError("a live successor verifier opened without live evidence")


def _runtime_source_closure() -> None:
    runtime_source = "scripts/comment_chrome_runtime_authority.mjs"
    for obligation_id in ("TRUSTED_CHROME_HOST_RESOLVER", "STABLE_NODE_FRAME_MAPPING"):
        sources = REQUIREMENTS[obligation_id]["sources"]
        if sources.count(runtime_source) != 1:
            raise AssertionError(
                f"{obligation_id} must bind the source-wired Chrome runtime exactly once"
            )


def _common_negatives(
    positives: dict[str, dict[str, Any]], version: str, revision: str, root: Path,
) -> None:
    obligation_id = "TRUSTED_CHROME_HOST_RESOLVER"
    cases: list[tuple[str, dict[str, Any]]] = []
    bool_schema = copy.deepcopy(positives[obligation_id])
    bool_schema["schema_version"] = True
    cases.append(("boolean schema version", bool_schema))
    bool_count = copy.deepcopy(positives[obligation_id])
    bool_count["results"][0]["mutation_count"] = False
    cases.append(("boolean integer count", bool_count))
    wrong_scope = copy.deepcopy(positives[obligation_id])
    wrong_scope["evidence_scope"] = "localhost_test_only_candidate"
    cases.append(("wrong evidence scope", wrong_scope))
    expired = copy.deepcopy(positives[obligation_id])
    expired.update({
        "observed_at": "2030-01-02T11:00:00Z",
        "expires_at": "2030-01-02T11:05:00Z",
    })
    cases.append(("expired session receipt", expired))
    extra_source = copy.deepcopy(positives[obligation_id])
    extra_source["source_files"].append(copy.deepcopy(extra_source["source_files"][0]))
    extra_source["source_snapshot_sha256"] = json_hash(extra_source["source_files"])
    cases.append(("extra source row", extra_source))
    for label, candidate in cases:
        _reject_receipt(obligation_id, candidate, version, revision, root, label)


def _obligation_negatives(
    positives: dict[str, dict[str, Any]], version: str, revision: str, root: Path,
) -> None:
    cases: list[tuple[str, str, dict[str, Any]]] = []
    mapping = copy.deepcopy(positives["STABLE_NODE_FRAME_MAPPING"])
    mapping["negative_cases"].pop()
    cases.append(("STABLE_NODE_FRAME_MAPPING", "missing mapping negative", mapping))
    mapping_partial = copy.deepcopy(positives["STABLE_NODE_FRAME_MAPPING"])
    mapping_partial["results"][0]["full_lifecycle_bound"] = False
    cases.append(("STABLE_NODE_FRAME_MAPPING", "partial lifecycle mapping", mapping_partial))
    mapping_float = copy.deepcopy(positives["STABLE_NODE_FRAME_MAPPING"])
    mapping_float["results"][0]["browser_launch_count"] = 0.0
    cases.append(("STABLE_NODE_FRAME_MAPPING", "floating mapping launch count", mapping_float))
    fixture = copy.deepcopy(positives["THREE_PLATFORM_BROWSER_FIXTURE"])
    fixture["product_version"] = "0.0.0"
    cases.append(("THREE_PLATFORM_BROWSER_FIXTURE", "stale fixture release", fixture))
    fixture_path = copy.deepcopy(positives["THREE_PLATFORM_BROWSER_FIXTURE"])
    fixture_path["raw_fixture_receipt_path"] = ".rd/receipts/other.json"
    cases.append(("THREE_PLATFORM_BROWSER_FIXTURE", "raw fixture path drift", fixture_path))
    fixture_hash = copy.deepcopy(positives["THREE_PLATFORM_BROWSER_FIXTURE"])
    fixture_hash["raw_fixture_receipt_sha256"] = "invalid"
    cases.append(("THREE_PLATFORM_BROWSER_FIXTURE", "raw fixture hash invalid", fixture_hash))
    draft = copy.deepcopy(positives["THREE_PLATFORM_LIVE_DRAFT"])
    draft["results"][0]["draft_count"] = 0
    cases.append(("THREE_PLATFORM_LIVE_DRAFT", "empty live draft", draft))
    batch = copy.deepcopy(positives["LIVE_BATCH_CONFIRM"])
    batch["results"][0]["permit_id"] = ""
    cases.append(("LIVE_BATCH_CONFIRM", "batch without permit", batch))
    bounded = copy.deepcopy(positives["LIVE_BOUNDED_AUTO"])
    bounded.update({"clicked_count": 0, "verified_count": 0, "actions": []})
    cases.append(("LIVE_BOUNDED_AUTO", "vacuous bounded auto", bounded))
    for obligation_id, label, candidate in cases:
        _reject_receipt(obligation_id, candidate, version, revision, root, label)


def _batch_uniqueness_negatives(
    base: dict[str, Any], version: str, revision: str, root: Path,
) -> None:
    for key in ("permit_id", "claim_id", "action_receipt_sha256"):
        candidate = copy.deepcopy(base)
        candidate["results"][1][key] = candidate["results"][0][key]
        _reject_receipt(
            "LIVE_BATCH_CONFIRM", candidate, version, revision, root,
            f"duplicate live batch {key}",
        )


def _two_action_bounded(base: dict[str, Any]) -> dict[str, Any]:
    candidate = copy.deepcopy(base)
    candidate.update({"cap": 2, "clicked_count": 2, "verified_count": 2})
    candidate["grant_scope"]["max_replies"] = 2
    second = copy.deepcopy(candidate["actions"][0])
    second.update({
        "action_id": "bounded-action-002",
        "parent_comment_id": "bounded-parent-002",
        "post_id_sha256": digest("bounded:post:002"),
        "reply_text_sha256": digest("bounded:reply:002"),
        "permit_id": "bounded-permit-002",
        "claim_id": "bounded-claim-002",
        "execution_receipt_sha256": digest("bounded:execution:002"),
    })
    candidate["actions"].append(second)
    return candidate


def _bounded_uniqueness_negatives(
    base: dict[str, Any], version: str, revision: str, root: Path,
) -> None:
    valid_pair = _two_action_bounded(base)
    _validate_calibration("LIVE_BOUNDED_AUTO", valid_pair, version, revision, root)
    for key in ("action_id", "permit_id", "claim_id", "execution_receipt_sha256"):
        candidate = copy.deepcopy(valid_pair)
        candidate["actions"][1][key] = candidate["actions"][0][key]
        _reject_receipt(
            "LIVE_BOUNDED_AUTO", candidate, version, revision, root,
            f"duplicate bounded action {key}",
        )
    duplicate_parent = copy.deepcopy(valid_pair)
    duplicate_parent["actions"][1]["parent_comment_id"] = (
        duplicate_parent["actions"][0]["parent_comment_id"]
    )
    _reject_receipt(
        "LIVE_BOUNDED_AUTO", duplicate_parent, version, revision, root,
        "different action IDs for the same bounded parent",
    )


def _bounded_binding_negatives(
    base: dict[str, Any], version: str, revision: str, root: Path,
) -> None:
    cases: list[tuple[str, dict[str, Any]]] = []
    grant = copy.deepcopy(base)
    grant["actions"][0]["grant_id"] = "different-grant"
    cases.append(("bounded action grant binding", grant))
    session = copy.deepcopy(base)
    session["actions"][0]["session_id_sha256"] = digest("different-session")
    cases.append(("bounded action session binding", session))
    post_scope = copy.deepcopy(base)
    post_scope["actions"][0]["post_ids_scope_sha256"] = digest("different-post-scope")
    cases.append(("bounded action post scope binding", post_scope))
    grant_window = copy.deepcopy(base)
    grant_window["grant_expires_at"] = "2030-01-02T12:08:00Z"
    cases.append(("grant timestamp does not bind TTL", grant_window))
    outside = copy.deepcopy(base)
    outside["actions"][0]["executed_at"] = "2030-01-02T12:08:00Z"
    cases.append(("bounded action outside grant and receipt window", outside))
    for label, candidate in cases:
        _reject_receipt(
            "LIVE_BOUNDED_AUTO", candidate, version, revision, root, label
        )


def _receipt_file_negatives() -> None:
    obligation_id = "TRUSTED_CHROME_HOST_RESOLVER"
    with tempfile.TemporaryDirectory(prefix="social-post-promotion-receipt-") as raw:
        root = Path(raw)
        value = {"schema_version": 1, "marker": "calibration-only"}
        valid = root / "valid.json"
        valid.write_bytes(canonical_json_bytes(value))
        if load_canonical_receipt(valid, obligation_id) != value:
            raise AssertionError("canonical receipt loader changed a valid object")
        malformed = root / "malformed.json"
        malformed.write_bytes(b"{not-json}\n")
        _expect_rejected(
            lambda: load_canonical_receipt(malformed, obligation_id),
            "malformed on-disk receipt",
        )
        oversized = root / "oversized.json"
        oversized.write_bytes(b"x" * (MAX_RECEIPT_BYTES + 1))
        _expect_rejected(
            lambda: load_canonical_receipt(oversized, obligation_id),
            "oversized on-disk receipt",
        )
        target = root / "target.json"
        target.write_bytes(canonical_json_bytes(value))
        link = root / "alias.json"
        os.symlink(target, link)
        _expect_rejected(
            lambda: safe_file(root, "alias.json", obligation_id),
            "symlink/reparse receipt alias",
        )


def promotion_calibration_tests(root: Path, version: str, revision: str) -> None:
    """Calibrate every semantic detector and prove production stays closed."""
    validate_hash_golden()
    _dependency_graph_negatives()
    _trusted_verifier_registration()
    _runtime_source_closure()
    positives = {
        obligation_id: positive_receipt(root, obligation_id, version, revision)
        for obligation_id in REQUIREMENTS
    }
    _positive_and_production_closed(positives, version, revision, root)
    _common_negatives(positives, version, revision, root)
    _obligation_negatives(positives, version, revision, root)
    _batch_uniqueness_negatives(positives["LIVE_BATCH_CONFIRM"], version, revision, root)
    _bounded_uniqueness_negatives(positives["LIVE_BOUNDED_AUTO"], version, revision, root)
    _bounded_binding_negatives(positives["LIVE_BOUNDED_AUTO"], version, revision, root)
    _receipt_file_negatives()
    run_test_only_mapping_evidence_calibration(root, version, revision)


# Backward-compatible name retained for external test callers.
promotion_negative_tests = promotion_calibration_tests

#!/usr/bin/env python3
"""Positive test-only fixtures for promotion contract calibration."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from comment_capability_promotion import (
    CANONICALIZATION,
    HASH_ALGORITHM,
    PLATFORMS,
    REQUIREMENTS,
    capability_contract_hash,
    json_hash,
    safe_file,
    source_rows,
    stable_read,
)
from comment_capability_promotion_contract import (
    FULL_LIFECYCLE_MAPPING_PHASES,
    TEST_ONLY_FULL_LIFECYCLE_MAPPING_CLASS,
    TEST_ONLY_FULL_LIFECYCLE_MAPPING_COVERAGE,
    TEST_ONLY_FULL_LIFECYCLE_MAPPING_SOURCES,
    TEST_ONLY_FULL_LIFECYCLE_NEGATIVES,
    TEST_ONLY_FULL_LIFECYCLE_PHASES,
)


FIXED_NOW = datetime(2030, 1, 2, 12, 5, tzinfo=timezone.utc)
RUN_IDS = {
    obligation_id: f"00000000-0000-4000-8000-{index:012d}"
    for index, obligation_id in enumerate(REQUIREMENTS, start=1)
}


def digest(label: str) -> str:
    return hashlib.sha256(label.encode("utf-8")).hexdigest()


def _test_mapping_sources(root: Path) -> list[dict[str, Any]]:
    rows = []
    for relative in TEST_ONLY_FULL_LIFECYCLE_MAPPING_SOURCES:
        payload = stable_read(
            safe_file(root, relative, "STABLE_NODE_FRAME_MAPPING"),
            "STABLE_NODE_FRAME_MAPPING",
        )
        rows.append({
            "path": relative,
            "exists": True,
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        })
    return rows


def _test_mapping_stages(platform: str) -> list[dict[str, Any]]:
    previous = json_hash({"platform": platform, "lifecycle_start": True})
    rows = []
    for phase in TEST_ONLY_FULL_LIFECYCLE_PHASES:
        row = {
            "phase": phase,
            "stable_read_count": 2,
            "frame_id_sha256": digest(f"{platform}:lifecycle:frame"),
            "document_epoch_sha256": digest(f"{platform}:lifecycle:document"),
            "comment_identity_sha256": digest(f"{platform}:lifecycle:comment"),
            "parent_anchor_sha256": digest(f"{platform}:lifecycle:parent"),
            "node_roles_sha256": digest(f"{platform}:lifecycle:{phase}:roles"),
            "previous_stage_sha256": previous,
        }
        row["stage_binding_sha256"] = json_hash(row)
        previous = row["stage_binding_sha256"]
        rows.append(row)
    return rows


def _test_mapping_platform(platform: str) -> dict[str, Any]:
    stages = _test_mapping_stages(platform)
    lifecycle = json_hash(stages)
    return {
        "platform": platform,
        "fixture_environment": "fixture_testonly",
        "full_lifecycle_bound": True,
        "stable_read_count": 2,
        "browser_launch_count": 0,
        "mutation_count": 0,
        "stage_bindings": stages,
        "lifecycle_binding_sha256": lifecycle,
        "replay_binding_sha256": json_hash({
            "evidence_class": TEST_ONLY_FULL_LIFECYCLE_MAPPING_CLASS,
            "platform": platform,
            "lifecycle_binding_sha256": lifecycle,
        }),
    }


def test_only_full_lifecycle_mapping_evidence(root: Path) -> dict[str, Any]:
    """Build an in-memory calibration object; never writes or mints a receipt."""
    sources = _test_mapping_sources(root)
    value = {
        "schema_version": 1,
        "evidence_class": TEST_ONLY_FULL_LIFECYCLE_MAPPING_CLASS,
        "production_obligation_id": "STABLE_NODE_FRAME_MAPPING",
        "coverage": TEST_ONLY_FULL_LIFECYCLE_MAPPING_COVERAGE,
        "test_only": True,
        "capability_promotion_eligible": False,
        "live_browser_actuation_enabled": False,
        "live_plan_minting": False,
        "browser_receipt_eligible": False,
        "test_only_full_lifecycle_bound": True,
        "live_full_lifecycle_bound": False,
        "phase_order": TEST_ONLY_FULL_LIFECYCLE_PHASES,
        "platform_order": PLATFORMS,
        "source_files": sources,
        "source_snapshot_sha256": json_hash(sources),
        "results": [_test_mapping_platform(platform) for platform in PLATFORMS],
        "negative_cases": [{
            "name": name,
            "passed": True,
            "evidence_sha256": digest(f"test-only-lifecycle-negative:{name}"),
        } for name in TEST_ONLY_FULL_LIFECYCLE_NEGATIVES],
    }
    value["evidence_sha256"] = json_hash(value)
    return value


def _native_lifecycle_stage(phase: str, index: int) -> dict[str, Any]:
    after_submit = index >= 4
    return {
        "stage": phase,
        "snapshot_digest": digest(f"native:{phase}:snapshot"),
        "role_bindings_sha256": digest(f"native:{phase}:roles"),
        "role_count": 8 + index,
        "expansion_terminal": index != 0,
        "reply_cardinality": {
            "cursor": 0,
            "discovered_count": 1 if after_submit else 0,
            "terminal": True,
            "total_reply_count": 1 if after_submit else 0,
            "exact_own_reply_count": 1 if after_submit else 0,
            "own_author_reply_count": 1 if after_submit else 0,
        },
    }


def native_test_only_full_lifecycle_mapping_attestation(
    platform: str = "instagram",
) -> dict[str, Any]:
    """Mirror serialized JS output without claiming its in-process WeakSet brand."""
    stages = [
        _native_lifecycle_stage(phase, index)
        for index, phase in enumerate(TEST_ONLY_FULL_LIFECYCLE_PHASES)
    ]
    value = {
        "schema_version": 1,
        "evidence_class": TEST_ONLY_FULL_LIFECYCLE_MAPPING_CLASS,
        "test_only": True,
        "capability_promotion_eligible": False,
        "live_browser_actuation_enabled": False,
        "live_plan_minting": False,
        "browser_receipt_eligible": False,
        "coverage": TEST_ONLY_FULL_LIFECYCLE_MAPPING_COVERAGE,
        "test_only_full_lifecycle_bound": True,
        "live_full_lifecycle_bound": False,
        "lifecycle_session_id": digest(f"native:{platform}:session"),
        "platform": platform,
        "adapter_id": f"meta_{platform}_fixture",
        "adapter_version": "test-only-lifecycle-v1",
        "plan_digest": digest(f"native:{platform}:plan"),
        "stage_order": TEST_ONLY_FULL_LIFECYCLE_PHASES,
        "stage_count": len(TEST_ONLY_FULL_LIFECYCLE_PHASES),
        "stable_reads_per_stage": 2,
        "previous_stage_one_time_consume": True,
        "stages": stages,
        "final_stage_attestation_id": digest(f"native:{platform}:final-stage"),
    }
    value["lifecycle_attestation_id"] = json_hash(value)
    return value


def _platform_rows(factory: Callable[[str], dict[str, Any]]) -> list[dict[str, Any]]:
    return [factory(platform) for platform in PLATFORMS]


def _base_fixture(
    root: Path, obligation_id: str, version: str, revision: str,
) -> dict[str, Any]:
    requirement = REQUIREMENTS[obligation_id]
    sources = source_rows(root, obligation_id)
    policy = stable_read(
        safe_file(root, "references/comment-policy.json", obligation_id), obligation_id
    )
    return {
        "schema_version": 1,
        "gate": requirement["gate"],
        "status": "PASS",
        "evidence_scope": requirement["scope"],
        "capability_promotion_eligible": requirement["promotion"],
        "live_browser_actuation_enabled": False,
        "hash_algorithm": HASH_ALGORITHM,
        "canonicalization": CANONICALIZATION,
        "run_id": RUN_IDS[obligation_id],
        "session_id_sha256": digest(f"session:{obligation_id}"),
        "observed_at": "2030-01-02T12:03:00Z",
        "expires_at": "2030-01-02T12:07:00Z",
        "product_version": version,
        "source_revision_basis": revision,
        "capability_contract_sha256": capability_contract_hash(root, obligation_id),
        "policy_sha256": hashlib.sha256(policy).hexdigest(),
        "source_files": sources,
        "source_snapshot_sha256": json_hash(sources),
    }


def _host_fixture() -> dict[str, Any]:
    return {
        "read_only": True,
        "mutation_count": 0,
        "plan_minting_enabled": False,
        "platform_order": PLATFORMS,
        "results": _platform_rows(lambda platform: {
            "platform": platform,
            "authenticated": True,
            "account_verified": True,
            "exact_post_verified": True,
            "trusted_runtime_provenance_verified": True,
            "document_epoch_verified": True,
            "frame_topology_verified": True,
            "mutation_count": 0,
            "post_id_sha256": digest(f"{platform}:post"),
            "account_id_sha256": digest(f"{platform}:account"),
            "runtime_provenance_sha256": digest(f"{platform}:runtime"),
        }),
    }


def _mapping_fixture() -> dict[str, Any]:
    names = (
        "cross_frame", "cross_parent", "reparent", "node_id_reuse",
        "stale_node", "navigation", "same_url_reload", "recovery_replay",
        "collection_reorder", "same_identity_rerender", "duplicate_comment_identity",
        "reply_exhaustion_partial", "node_role_collision", "phase_reorder",
        "skipped_phase", "stale_previous_stage", "replayed_phase",
        "process_brand_or_clone", "document_epoch_change",
        "comment_identity_drift", "finish_cardinality", "recovery_rerender",
    )
    return {
        "platform_order": PLATFORMS,
        "phase_order": FULL_LIFECYCLE_MAPPING_PHASES,
        "negative_cases": [{
            "name": name,
            "passed": True,
            "evidence_sha256": digest(f"mapping-negative:{name}"),
        } for name in names],
        "results": _platform_rows(lambda platform: {
            "platform": platform,
            "native_frame_owner_verified": True,
            "document_epoch_bound": True,
            "node_id_bound": True,
            "parent_anchor_bound": True,
            "comment_identity_bound": True,
            "reply_exhaustion_bound": True,
            "full_lifecycle_bound": True,
            "mapping_verified": True,
            "stable_read_count": 2,
            "browser_launch_count": 0,
            "mutation_count": 0,
            "frame_id_sha256": digest(f"{platform}:frame"),
            "document_epoch_sha256": digest(f"{platform}:epoch"),
            "parent_anchor_sha256": digest(f"{platform}:parent"),
            "comment_identity_sha256": digest(f"{platform}:comment-identity"),
            "reply_exhaustion_sha256": digest(f"{platform}:reply-exhaustion"),
            "phase_bindings_sha256": digest(f"{platform}:phases"),
            "lifecycle_binding_sha256": digest(f"{platform}:lifecycle"),
            "replay_binding_sha256": digest(f"{platform}:lifecycle-replay"),
        }),
    }


def _browser_fixture() -> dict[str, Any]:
    return {
        "trusted_host_verified": False,
        "stable_node_frame_mapping_verified": False,
        "claim_authority": "in_memory_test_only",
        "platform_order": PLATFORMS,
        "raw_fixture_receipt_path": (
            ".rd/receipts/three-platform-browser-fixture.json"
        ),
        "raw_fixture_receipt_sha256": digest("browser-fixture-raw-receipt"),
        "results": _platform_rows(lambda platform: {
            "platform": platform,
            "exact_reply_visible": True,
            "own_author_verified": True,
            "parent_verified": True,
            "test_only": True,
            "submit_attempts": 1,
            "action_id": f"fixture-action-{platform}",
            "parent_comment_id": f"fixture-parent-{platform}",
            "phase_sha256": digest(f"{platform}:fixture-phases"),
        }),
    }


def _draft_fixture() -> dict[str, Any]:
    return {
        "mutation_count": 0,
        "platform_order": PLATFORMS,
        "results": _platform_rows(lambda platform: {
            "platform": platform,
            "authenticated": True,
            "account_verified": True,
            "exact_post_verified": True,
            "terminal_expansion_verified": True,
            "scan_complete": True,
            "draft_queue_revision_bound": True,
            "mutation_count": 0,
            "scanned_comment_count": 2,
            "draft_count": 1,
            "post_id_sha256": digest(f"{platform}:draft-post"),
            "draft_queue_sha256": digest(f"{platform}:draft-queue"),
        }),
    }


def _batch_fixture() -> dict[str, Any]:
    return {
        "unknown_outcome_count": 0,
        "platform_order": PLATFORMS,
        "results": _platform_rows(lambda platform: {
            "platform": platform,
            "approval_id": f"approval-{platform}",
            "permit_id": f"permit-{platform}",
            "claim_id": f"claim-{platform}",
            "comment_id": f"comment-{platform}",
            "parent_comment_id": f"parent-{platform}",
            "reply_text_sha256": digest(f"{platform}:reply"),
            "action_receipt_sha256": digest(f"{platform}:action-receipt"),
            "exact_parent_verified": True,
            "own_exact_text_verified": True,
            "fresh_reconciliation": True,
            "submit_attempts": 1,
            "outcome": "confirmed",
        }),
    }


def _bounded_fixture() -> dict[str, Any]:
    return {
        "current_session_only": True,
        "dedupe_verified": True,
        "circuit_breaker_verified": True,
        "no_auto_resend": True,
        "no_background_polling": True,
        "stopped_on_unknown": True,
        "cap": 1,
        "clicked_count": 1,
        "verified_count": 1,
        "uncertain_count": 0,
        "grant_ttl_seconds": 300,
        "grant_id": "bounded-grant-001",
        "grant_issued_at": "2030-01-02T12:02:00Z",
        "grant_expires_at": "2030-01-02T12:07:00Z",
        "grant_scope": {
            "mode": "bounded_auto",
            "platforms": ["facebook"],
            "post_ids_sha256": digest("bounded:posts"),
            "risk_class": "low",
            "max_replies": 1,
        },
        "platform": "facebook",
        "actions": [{
            "platform": "facebook",
            "action_id": "bounded-action-001",
            "parent_comment_id": "bounded-parent-001",
            "post_id_sha256": digest("bounded:post:001"),
            "post_ids_scope_sha256": digest("bounded:posts"),
            "reply_text_sha256": digest("bounded:reply"),
            "permit_id": "bounded-permit-001",
            "claim_id": "bounded-claim-001",
            "execution_receipt_sha256": digest("bounded:execution"),
            "grant_id": "bounded-grant-001",
            "session_id_sha256": digest("session:LIVE_BOUNDED_AUTO"),
            "executed_at": "2030-01-02T12:04:00Z",
            "outcome": "confirmed",
        }],
    }


FIXTURE_BUILDERS: dict[str, Callable[[], dict[str, Any]]] = {
    "TRUSTED_CHROME_HOST_RESOLVER": _host_fixture,
    "STABLE_NODE_FRAME_MAPPING": _mapping_fixture,
    "THREE_PLATFORM_BROWSER_FIXTURE": _browser_fixture,
    "THREE_PLATFORM_LIVE_DRAFT": _draft_fixture,
    "LIVE_BATCH_CONFIRM": _batch_fixture,
    "LIVE_BOUNDED_AUTO": _bounded_fixture,
}


def positive_receipt(
    root: Path, obligation_id: str, version: str, revision: str,
) -> dict[str, Any]:
    try:
        builder = FIXTURE_BUILDERS[obligation_id]
    except KeyError as exc:
        raise AssertionError(f"missing positive promotion fixture: {obligation_id}") from exc
    receipt = _base_fixture(root, obligation_id, version, revision)
    receipt.update(builder())
    return receipt


__all__ = [
    "FIXED_NOW",
    "digest",
    "native_test_only_full_lifecycle_mapping_attestation",
    "positive_receipt",
    "test_only_full_lifecycle_mapping_evidence",
]

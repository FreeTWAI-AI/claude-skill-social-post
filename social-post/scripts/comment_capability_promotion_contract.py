#!/usr/bin/env python3
"""Closed-world schemas and dependency contract for comment promotion."""

from __future__ import annotations

import re
from typing import Any


PLATFORMS = ["facebook", "instagram", "threads"]
HEX_256 = re.compile(r"^[0-9a-f]{64}$")
UUID_V4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
RFC3339_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")
SOURCE_PATH = re.compile(r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$")
MAX_RECEIPT_BYTES = 1024 * 1024
CANONICALIZATION = "social-post-json-c14n-v1"
HASH_ALGORITHM = "sha256"
CANONICAL_HASH_GOLDEN_VALUE = {
    "alpha": "A",
    "items": [{
        "exists": True,
        "path": "scripts/example.js",
        "sha256": "0" * 64,
        "size": 7,
    }],
    "version": 1,
}
CANONICAL_HASH_GOLDEN_SHA256 = (
    "0f6b0a7268cad54ffd0963fb0fad273704491301e56ac726f0d73a6908596307"
)


# Direct production-promotion prerequisites are closed-world.  Contract rows
# with promotion=false remain in the graph as test-only quality-evidence roots,
# but they may never become verified or appear as a predecessor of a live row.
# Transitive closure is enforced by comment_capability_gate.py before any
# promotable guarded row may become verified.
PROMOTION_DEPENDENCIES: dict[str, list[str]] = {
    "TRUSTED_CHROME_HOST_RESOLVER": [],
    "STABLE_NODE_FRAME_MAPPING": ["TRUSTED_CHROME_HOST_RESOLVER"],
    "THREE_PLATFORM_BROWSER_FIXTURE": [],
    "THREE_PLATFORM_LIVE_DRAFT": [
        "TRUSTED_CHROME_HOST_RESOLVER",
        "STABLE_NODE_FRAME_MAPPING",
    ],
    "LIVE_BATCH_CONFIRM": ["THREE_PLATFORM_LIVE_DRAFT"],
    "LIVE_BOUNDED_AUTO": ["LIVE_BATCH_CONFIRM"],
}


BASE_SOURCES = [
    "scripts/comment_capability_gate.py",
    "scripts/comment_capability_promotion.py",
    "scripts/comment_capability_promotion_contract.py",
    "scripts/comment_capability_receipt_support.py",
    "scripts/comment_capability_promotion_semantics.py",
    "scripts/comment_capability_trusted_host_verifier.py",
    "references/comment-policy.json",
]
FIXTURE_RUNTIME_SOURCES = [
    "scripts/comment_fixture_promotion_envelope.py",
    "scripts/comment_fixture_browser_e2e.mjs",
    "scripts/comment_chrome_common.mjs",
    "scripts/comment_chrome_node_frame_mapping.mjs",
    "scripts/comment_chrome_node_frame_lifecycle_snapshot_testonly.mjs",
    "scripts/comment_chrome_node_frame_lifecycle_testonly.mjs",
    "scripts/comment_chrome_node_frame_mapping_testonly.mjs",
    "scripts/comment_chrome_fixture_evidence_testonly.mjs",
    "scripts/comment_chrome_fixture_receipt_testonly.mjs",
    "scripts/comment_chrome_reply_exhaustion.mjs",
    "scripts/comment_chrome_scan.mjs",
    "scripts/comment_chrome_scan_adapters.mjs",
    "scripts/comment_chrome_scan_fixture_testonly.mjs",
    "scripts/comment_chrome_send.mjs",
    "scripts/comment_chrome_send_support.mjs",
    "scripts/comment_js_architecture_contract.mjs",
    "scripts/comment_js_architecture_core.mjs",
    "scripts/comment_js_architecture_gate.mjs",
    "scripts/comment_js_architecture_loaders.mjs",
    "scripts/comment_js_architecture_receipt.mjs",
    "scripts/comment_js_architecture_selftest.mjs",
    "scripts/comment_adapter_fixtures/facebook.html",
    "scripts/comment_adapter_fixtures/instagram.html",
    "scripts/comment_adapter_fixtures/threads.html",
    "scripts/comment_adapter_fixtures/fixture-runtime.js",
]

TEST_ONLY_FULL_LIFECYCLE_MAPPING_CLASS = "test_only_full_lifecycle_mapping"
TEST_ONLY_FULL_LIFECYCLE_MAPPING_COVERAGE = (
    "test_only_full_comment_reply_lifecycle"
)
FULL_LIFECYCLE_MAPPING_PHASES = [
    "expand",
    "reply_trigger",
    "composer_fill",
    "submit_preflight",
    "finish",
    "recovery_reinspection",
]
TEST_ONLY_FULL_LIFECYCLE_PHASES = list(FULL_LIFECYCLE_MAPPING_PHASES)
TEST_ONLY_FULL_LIFECYCLE_NEGATIVES = [
    "process_brand_or_clone",
    "phase_order",
    "previous_stage_replay",
    "cross_platform",
    "frame_drift",
    "document_epoch_change",
    "node_replacement_between_reads",
    "parent_drift",
    "comment_identity_drift",
    "node_role_collision",
    "finish_cardinality",
    "recovery_rerender",
    "live_authority_attempt",
    "live_plan_mint_attempt",
]
TEST_ONLY_FULL_LIFECYCLE_MAPPING_SOURCES = [
    "scripts/comment_capability_promotion_contract.py",
    "scripts/comment_capability_receipt_support.py",
    "scripts/comment_capability_mapping_evidence.py",
    "scripts/comment_chrome_actuator.mjs",
    "scripts/comment_chrome_claim_bridge.mjs",
    "scripts/comment_chrome_common.mjs",
    "scripts/comment_chrome_node_frame_lifecycle_snapshot_testonly.mjs",
    "scripts/comment_chrome_node_frame_lifecycle_test.mjs",
    "scripts/comment_chrome_node_frame_lifecycle_testonly.mjs",
    "scripts/comment_chrome_node_frame_mapping.mjs",
    "scripts/comment_chrome_node_frame_mapping_fixture_testonly.mjs",
    "scripts/comment_chrome_node_frame_mapping_test.mjs",
    "scripts/comment_chrome_node_frame_mapping_testonly.mjs",
    "scripts/comment_chrome_reply_exhaustion.mjs",
    "scripts/comment_chrome_scan.mjs",
    "scripts/comment_chrome_scan_adapters.mjs",
    "scripts/comment_chrome_scan_fixture_testonly.mjs",
    "scripts/comment_chrome_send.mjs",
    "scripts/comment_chrome_send_support.mjs",
]

TEST_ONLY_FULL_LIFECYCLE_MAPPING_KEYS = {
    "schema_version", "evidence_class", "production_obligation_id", "coverage",
    "test_only", "capability_promotion_eligible", "live_browser_actuation_enabled",
    "live_plan_minting", "browser_receipt_eligible",
    "test_only_full_lifecycle_bound", "live_full_lifecycle_bound",
    "phase_order", "platform_order", "source_files",
    "source_snapshot_sha256", "results", "negative_cases", "evidence_sha256",
}
TEST_ONLY_FULL_LIFECYCLE_PLATFORM_KEYS = {
    "platform", "fixture_environment", "full_lifecycle_bound", "stable_read_count",
    "browser_launch_count", "mutation_count", "stage_bindings",
    "lifecycle_binding_sha256", "replay_binding_sha256",
}
TEST_ONLY_FULL_LIFECYCLE_STAGE_KEYS = {
    "phase", "stable_read_count", "frame_id_sha256", "document_epoch_sha256",
    "comment_identity_sha256", "parent_anchor_sha256", "node_roles_sha256",
    "previous_stage_sha256", "stage_binding_sha256",
}
TEST_ONLY_FULL_LIFECYCLE_NEGATIVE_KEYS = {
    "name", "passed", "evidence_sha256",
}
TEST_ONLY_NATIVE_LIFECYCLE_KEYS = {
    "schema_version", "evidence_class", "test_only",
    "capability_promotion_eligible", "live_browser_actuation_enabled",
    "live_plan_minting", "browser_receipt_eligible", "coverage",
    "test_only_full_lifecycle_bound", "live_full_lifecycle_bound",
    "lifecycle_session_id", "platform", "adapter_id", "adapter_version",
    "plan_digest", "stage_order", "stage_count", "stable_reads_per_stage",
    "previous_stage_one_time_consume", "stages",
    "final_stage_attestation_id", "lifecycle_attestation_id",
}
TEST_ONLY_NATIVE_LIFECYCLE_STAGE_KEYS = {
    "stage", "snapshot_digest", "role_bindings_sha256", "role_count",
    "expansion_terminal", "reply_cardinality",
}
TEST_ONLY_NATIVE_REPLY_CARDINALITY_KEYS = {
    "cursor", "discovered_count", "terminal", "total_reply_count",
    "exact_own_reply_count", "own_author_reply_count",
}


REQUIREMENTS: dict[str, dict[str, Any]] = {
    "TRUSTED_CHROME_HOST_RESOLVER": {
        "path": ".rd/receipts/trusted-chrome-host-readonly-canary.json",
        "gate": "social-post-trusted-chrome-host-readonly-canary",
        "scope": "authenticated_meta_read_only",
        "promotion": True,
        "max_age_seconds": 900,
        "sources": BASE_SOURCES + [
            "scripts/comment_browser_provenance.py",
            "scripts/comment_chrome_common.mjs",
            "scripts/comment_chrome_host_authority.mjs",
            "scripts/comment_chrome_runtime_authority.mjs",
            "scripts/comment_chrome_scan_adapters.mjs",
        ],
    },
    "STABLE_NODE_FRAME_MAPPING": {
        "path": ".rd/receipts/stable-node-frame-mapping.json",
        "gate": "social-post-stable-node-frame-mapping",
        "scope": "controlled_browser_frame_mapping",
        "promotion": True,
        "max_age_seconds": 900,
        "sources": BASE_SOURCES + [
            "scripts/comment_chrome_actuator.mjs",
            "scripts/comment_chrome_common.mjs",
            "scripts/comment_chrome_host_authority.mjs",
            "scripts/comment_chrome_node_frame_mapping.mjs",
            "scripts/comment_chrome_runtime_authority.mjs",
            "scripts/comment_chrome_scan.mjs",
            "scripts/comment_chrome_scan_adapters.mjs",
            "scripts/comment_chrome_reply_exhaustion.mjs",
            "scripts/comment_chrome_send_support.mjs",
            "scripts/comment_chrome_send.mjs",
            "scripts/comment_chrome_claim_bridge.mjs",
        ],
    },
    "THREE_PLATFORM_BROWSER_FIXTURE": {
        "path": ".rd/receipts/three-platform-browser-fixture-promotion.json",
        "gate": "social-post-three-platform-browser-fixture",
        "scope": "localhost_test_only_candidate",
        "promotion": False,
        "max_age_seconds": 3600,
        "sources": BASE_SOURCES + FIXTURE_RUNTIME_SOURCES,
    },
    "THREE_PLATFORM_LIVE_DRAFT": {
        "path": ".rd/receipts/three-platform-live-draft.json",
        "gate": "social-post-three-platform-live-draft",
        "scope": "authenticated_meta_draft_only",
        "promotion": True,
        "max_age_seconds": 900,
        "sources": BASE_SOURCES + [
            "scripts/comment_browser_contract.py",
            "scripts/comment_browser_provenance.py",
            "scripts/comment_browser_scan_contract.py",
            "scripts/comment_chrome_common.mjs",
            "scripts/comment_chrome_host_authority.mjs",
            "scripts/comment_chrome_reply_exhaustion.mjs",
            "scripts/comment_chrome_scan.mjs",
            "scripts/comment_chrome_scan_adapters.mjs",
        ],
    },
    "LIVE_BATCH_CONFIRM": {
        "path": ".rd/receipts/three-platform-live-batch-confirm.json",
        "gate": "social-post-three-platform-live-batch-confirm",
        "scope": "current_session_explicitly_approved_send",
        "promotion": True,
        "max_age_seconds": 300,
        "sources": BASE_SOURCES + [
            "scripts/comment_authorization.py",
            "scripts/comment_browser_send_contract.py",
            "scripts/comment_chrome_claim_bridge.mjs",
            "scripts/comment_chrome_common.mjs",
            "scripts/comment_chrome_host_authority.mjs",
            "scripts/comment_chrome_send.mjs",
            "scripts/comment_chrome_send_support.mjs",
            "scripts/comment_domain.py",
            "scripts/comment_policy.py",
        ],
    },
    "LIVE_BOUNDED_AUTO": {
        "path": ".rd/receipts/live-bounded-auto-canary.json",
        "gate": "social-post-live-bounded-auto-canary",
        "scope": "current_session_bounded_auto_canary",
        "promotion": True,
        "max_age_seconds": 300,
        "sources": BASE_SOURCES + [
            "scripts/comment_assistant.py",
            "scripts/comment_authorization.py",
            "scripts/comment_browser_send_contract.py",
            "scripts/comment_chrome_claim_bridge.mjs",
            "scripts/comment_domain.py",
            "scripts/comment_policy.py",
            "scripts/comment_state.py",
        ],
    },
}


COMMON_KEYS = {
    "schema_version", "gate", "status", "evidence_scope",
    "capability_promotion_eligible", "live_browser_actuation_enabled",
    "hash_algorithm", "canonicalization", "run_id", "session_id_sha256",
    "observed_at", "expires_at", "product_version", "source_revision_basis",
    "capability_contract_sha256", "policy_sha256", "source_files",
    "source_snapshot_sha256",
}
OBLIGATION_KEYS = {
    "TRUSTED_CHROME_HOST_RESOLVER": {
        "read_only", "mutation_count", "plan_minting_enabled", "platform_order", "results",
    },
    "STABLE_NODE_FRAME_MAPPING": {
        "phase_order", "negative_cases", "platform_order", "results",
    },
    "THREE_PLATFORM_BROWSER_FIXTURE": {
        "trusted_host_verified", "stable_node_frame_mapping_verified",
        "claim_authority", "platform_order", "raw_fixture_receipt_path",
        "raw_fixture_receipt_sha256", "results",
    },
    "THREE_PLATFORM_LIVE_DRAFT": {"mutation_count", "platform_order", "results"},
    "LIVE_BATCH_CONFIRM": {"unknown_outcome_count", "platform_order", "results"},
    "LIVE_BOUNDED_AUTO": {
        "current_session_only", "dedupe_verified", "circuit_breaker_verified",
        "no_auto_resend", "no_background_polling", "stopped_on_unknown", "cap",
        "clicked_count", "verified_count", "uncertain_count", "grant_ttl_seconds",
        "grant_id", "grant_issued_at", "grant_expires_at", "grant_scope",
        "platform", "actions",
    },
}


def fail(obligation_id: str, message: str) -> None:
    raise ValueError(f"obligation {obligation_id} promotion evidence {message}")


def exact_int(value: Any, expected: int | None = None) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and (
        expected is None or value == expected
    )


def require_exact_keys(
    value: Any, expected: set[str], label: str, obligation_id: str,
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        fail(obligation_id, f"{label} must contain the exact schema keys")
    return value


def require_bool(
    receipt: dict[str, Any], key: str, expected: bool, obligation_id: str,
) -> None:
    if receipt.get(key) is not expected:
        fail(obligation_id, f"requires {key}={str(expected).lower()}")


def require_nonempty_string(value: Any, label: str, obligation_id: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        fail(obligation_id, f"requires non-empty {label}")
    return value


def require_hex(value: Any, label: str, obligation_id: str) -> str:
    if not isinstance(value, str) or not HEX_256.fullmatch(value):
        fail(obligation_id, f"requires SHA-256 {label}")
    return value


def validate_promotion_dependency_graph(graph: Any) -> None:
    expected_nodes = set(REQUIREMENTS)
    if not isinstance(graph, dict) or set(graph) != expected_nodes:
        raise ValueError("promotion dependency graph must contain the exact guarded nodes")
    for node, predecessors in graph.items():
        if (
            not isinstance(predecessors, list)
            or len(predecessors) != len(set(predecessors))
            or any(predecessor not in expected_nodes for predecessor in predecessors)
            or node in predecessors
        ):
            raise ValueError(f"promotion dependency graph has invalid predecessors for {node}")
    non_promotable = {
        obligation_id
        for obligation_id, requirement in REQUIREMENTS.items()
        if requirement.get("promotion") is not True
    }
    for node, predecessors in graph.items():
        forbidden = [item for item in predecessors if item in non_promotable]
        if forbidden:
            raise ValueError(
                f"promotion dependency graph cannot use non-promotable predecessor "
                f"{forbidden[0]} for {node}"
            )
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str) -> None:
        if node in visiting:
            raise ValueError("promotion dependency graph contains a cycle")
        if node in visited:
            return
        visiting.add(node)
        for predecessor in graph[node]:
            visit(predecessor)
        visiting.remove(node)
        visited.add(node)

    for node in graph:
        visit(node)

#!/usr/bin/env python3
"""Obligation-specific semantic validators for comment promotion receipts."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Callable

from comment_capability_promotion_contract import (
    FULL_LIFECYCLE_MAPPING_PHASES,
    PLATFORMS,
    exact_int,
    fail,
    require_bool,
    require_exact_keys,
    require_hex,
    require_nonempty_string,
)
from comment_capability_receipt_support import parse_utc


def _platform_results(
    receipt: dict[str, Any], obligation_id: str,
) -> list[dict[str, Any]]:
    if receipt.get("platform_order") != PLATFORMS:
        fail(obligation_id, "must cover facebook, instagram, and threads in exact order")
    results = receipt.get("results")
    if not isinstance(results, list) or len(results) != len(PLATFORMS):
        fail(obligation_id, "must contain exactly three platform results")
    for index, platform in enumerate(PLATFORMS):
        if not isinstance(results[index], dict) or results[index].get("platform") != platform:
            fail(obligation_id, "platform results differ from the exact order")
    return results


def _validate_host(receipt: dict[str, Any], obligation_id: str) -> None:
    require_bool(receipt, "read_only", True, obligation_id)
    if not exact_int(receipt.get("mutation_count"), 0):
        fail(obligation_id, "read-only canary mutation_count must equal integer 0")
    require_bool(receipt, "plan_minting_enabled", False, obligation_id)
    keys = {
        "platform", "authenticated", "account_verified", "exact_post_verified",
        "trusted_runtime_provenance_verified", "document_epoch_verified",
        "frame_topology_verified", "mutation_count", "post_id_sha256",
        "account_id_sha256", "runtime_provenance_sha256",
    }
    for result in _platform_results(receipt, obligation_id):
        require_exact_keys(result, keys, "host result", obligation_id)
        for key in (
            "authenticated", "account_verified", "exact_post_verified",
            "trusted_runtime_provenance_verified", "document_epoch_verified",
            "frame_topology_verified",
        ):
            require_bool(result, key, True, obligation_id)
        if not exact_int(result.get("mutation_count"), 0):
            fail(obligation_id, "each host canary must have integer mutation_count=0")
        for key in ("post_id_sha256", "account_id_sha256", "runtime_provenance_sha256"):
            require_hex(result.get(key), key, obligation_id)


def _validate_mapping(receipt: dict[str, Any], obligation_id: str) -> None:
    keys = {
        "platform", "native_frame_owner_verified", "document_epoch_bound",
        "node_id_bound", "parent_anchor_bound", "comment_identity_bound",
        "reply_exhaustion_bound", "full_lifecycle_bound", "mapping_verified",
        "stable_read_count", "browser_launch_count", "mutation_count",
        "frame_id_sha256", "document_epoch_sha256", "parent_anchor_sha256",
        "comment_identity_sha256", "reply_exhaustion_sha256", "phase_bindings_sha256",
        "lifecycle_binding_sha256", "replay_binding_sha256",
    }
    for result in _platform_results(receipt, obligation_id):
        require_exact_keys(result, keys, "mapping result", obligation_id)
        for key in (
            "native_frame_owner_verified", "document_epoch_bound", "node_id_bound",
            "parent_anchor_bound", "comment_identity_bound", "reply_exhaustion_bound",
            "full_lifecycle_bound", "mapping_verified",
        ):
            require_bool(result, key, True, obligation_id)
        if not exact_int(result.get("stable_read_count"), 2):
            fail(obligation_id, "stable mapping requires exactly two reads per phase")
        for key in ("browser_launch_count", "mutation_count"):
            if not exact_int(result.get(key), 0):
                fail(obligation_id, f"stable mapping {key} must be integer 0")
        for key in (
            "frame_id_sha256", "document_epoch_sha256", "parent_anchor_sha256",
            "comment_identity_sha256", "reply_exhaustion_sha256", "phase_bindings_sha256",
            "lifecycle_binding_sha256", "replay_binding_sha256",
        ):
            require_hex(result.get(key), key, obligation_id)
    if receipt.get("phase_order") != FULL_LIFECYCLE_MAPPING_PHASES:
        fail(obligation_id, "must bind every mutation and recovery phase")
    expected = [
        "cross_frame", "cross_parent", "reparent", "node_id_reuse",
        "stale_node", "navigation", "same_url_reload", "recovery_replay",
        "collection_reorder", "same_identity_rerender", "duplicate_comment_identity",
        "reply_exhaustion_partial", "node_role_collision", "phase_reorder",
        "skipped_phase", "stale_previous_stage", "replayed_phase",
        "process_brand_or_clone", "document_epoch_change",
        "comment_identity_drift", "finish_cardinality", "recovery_rerender",
    ]
    negatives = receipt.get("negative_cases")
    if not isinstance(negatives, list) or len(negatives) != len(expected):
        fail(obligation_id, "requires the exact mapping negative set")
    for index, name in enumerate(expected):
        item = require_exact_keys(
            negatives[index], {"name", "passed", "evidence_sha256"},
            "mapping negative", obligation_id,
        )
        if item.get("name") != name or item.get("passed") is not True:
            fail(obligation_id, "mapping negatives are incomplete or reordered")
        require_hex(item.get("evidence_sha256"), "negative evidence", obligation_id)


def _validate_fixture(receipt: dict[str, Any], obligation_id: str) -> None:
    require_bool(receipt, "trusted_host_verified", False, obligation_id)
    require_bool(receipt, "stable_node_frame_mapping_verified", False, obligation_id)
    if receipt.get("claim_authority") != "in_memory_test_only":
        fail(obligation_id, "fixture claim authority must remain test-only")
    if receipt.get("raw_fixture_receipt_path") != (
        ".rd/receipts/three-platform-browser-fixture.json"
    ):
        fail(obligation_id, "fixture envelope must bind the fixed raw receipt path")
    require_hex(
        receipt.get("raw_fixture_receipt_sha256"),
        "raw_fixture_receipt_sha256", obligation_id,
    )
    keys = {
        "platform", "exact_reply_visible", "own_author_verified", "parent_verified",
        "test_only", "submit_attempts", "action_id", "parent_comment_id",
        "phase_sha256",
    }
    for result in _platform_results(receipt, obligation_id):
        require_exact_keys(result, keys, "fixture result", obligation_id)
        for key in ("exact_reply_visible", "own_author_verified", "parent_verified", "test_only"):
            require_bool(result, key, True, obligation_id)
        if not exact_int(result.get("submit_attempts"), 1):
            fail(obligation_id, "each fixture platform must submit exactly once")
        require_nonempty_string(result.get("action_id"), "action_id", obligation_id)
        require_nonempty_string(
            result.get("parent_comment_id"), "parent_comment_id", obligation_id
        )
        require_hex(result.get("phase_sha256"), "phase_sha256", obligation_id)


def _validate_draft(receipt: dict[str, Any], obligation_id: str) -> None:
    if not exact_int(receipt.get("mutation_count"), 0):
        fail(obligation_id, "live draft batch must have integer mutation_count=0")
    keys = {
        "platform", "authenticated", "account_verified", "exact_post_verified",
        "terminal_expansion_verified", "scan_complete", "draft_queue_revision_bound",
        "mutation_count", "scanned_comment_count", "draft_count", "post_id_sha256",
        "draft_queue_sha256",
    }
    for result in _platform_results(receipt, obligation_id):
        require_exact_keys(result, keys, "draft result", obligation_id)
        for key in (
            "authenticated", "account_verified", "exact_post_verified",
            "terminal_expansion_verified", "scan_complete", "draft_queue_revision_bound",
        ):
            require_bool(result, key, True, obligation_id)
        if not exact_int(result.get("mutation_count"), 0):
            fail(obligation_id, "each live draft platform must have integer mutation_count=0")
        scanned = result.get("scanned_comment_count")
        drafted = result.get("draft_count")
        if not exact_int(scanned) or not exact_int(drafted) or scanned < 1 or not 1 <= drafted <= scanned:
            fail(obligation_id, "each live draft must bind non-empty scan and draft cardinality")
        require_hex(result.get("post_id_sha256"), "post_id_sha256", obligation_id)
        require_hex(result.get("draft_queue_sha256"), "draft_queue_sha256", obligation_id)


def _validate_batch(receipt: dict[str, Any], obligation_id: str) -> None:
    keys = {
        "platform", "approval_id", "permit_id", "claim_id", "comment_id",
        "parent_comment_id", "reply_text_sha256", "action_receipt_sha256",
        "exact_parent_verified", "own_exact_text_verified", "fresh_reconciliation",
        "submit_attempts", "outcome",
    }
    unique_values = {
        "permit_id": set(), "claim_id": set(), "action_receipt_sha256": set(),
    }
    parent_keys: set[tuple[str, str]] = set()
    for result in _platform_results(receipt, obligation_id):
        require_exact_keys(result, keys, "batch result", obligation_id)
        for key in ("approval_id", "permit_id", "claim_id", "comment_id", "parent_comment_id"):
            require_nonempty_string(result.get(key), key, obligation_id)
        for key in ("reply_text_sha256", "action_receipt_sha256"):
            require_hex(result.get(key), key, obligation_id)
        for key, seen in unique_values.items():
            if result[key] in seen:
                fail(obligation_id, f"batch {key} values must be unique")
            seen.add(result[key])
        parent_key = (result["platform"], result["parent_comment_id"])
        if parent_key in parent_keys:
            fail(obligation_id, "batch parent comments must be unique per platform")
        parent_keys.add(parent_key)
        for key in ("exact_parent_verified", "own_exact_text_verified", "fresh_reconciliation"):
            require_bool(result, key, True, obligation_id)
        if not exact_int(result.get("submit_attempts"), 1) or result.get("outcome") != "confirmed":
            fail(obligation_id, "each live batch platform must have one confirmed submit")
    if not exact_int(receipt.get("unknown_outcome_count"), 0):
        fail(obligation_id, "unknown outcomes cannot promote batch confirmation")


def _validate_bounded_counts(
    receipt: dict[str, Any], obligation_id: str,
) -> tuple[int, int]:
    for key in (
        "current_session_only", "dedupe_verified", "circuit_breaker_verified",
        "no_auto_resend", "no_background_polling", "stopped_on_unknown",
    ):
        require_bool(receipt, key, True, obligation_id)
    cap = receipt.get("cap")
    clicked = receipt.get("clicked_count")
    verified = receipt.get("verified_count")
    uncertain = receipt.get("uncertain_count")
    if not exact_int(cap) or not 1 <= cap <= 5:
        fail(obligation_id, "cap must be an integer from 1 through 5")
    if any(not exact_int(value) or value < 0 for value in (clicked, verified, uncertain)):
        fail(obligation_id, "bounded-auto counts must be non-negative integers")
    if clicked < 1 or verified != clicked or clicked > cap or uncertain != 0:
        fail(obligation_id, "bounded-auto promotion needs verified actions and no unknowns")
    return cap, clicked


def _validate_grant_window(
    receipt: dict[str, Any], obligation_id: str,
) -> tuple[datetime, datetime, datetime, datetime]:
    ttl = receipt.get("grant_ttl_seconds")
    if not exact_int(ttl) or not 1 <= ttl <= 3600:
        fail(obligation_id, "grant_ttl_seconds must fit the current session")
    require_nonempty_string(receipt.get("grant_id"), "grant_id", obligation_id)
    grant_issued = parse_utc(receipt.get("grant_issued_at"), "grant_issued_at", obligation_id)
    grant_expires = parse_utc(receipt.get("grant_expires_at"), "grant_expires_at", obligation_id)
    if grant_expires <= grant_issued or (grant_expires - grant_issued).total_seconds() != ttl:
        fail(obligation_id, "grant timestamps must exactly bind grant_ttl_seconds")
    observed = parse_utc(receipt.get("observed_at"), "observed_at", obligation_id)
    receipt_expires = parse_utc(receipt.get("expires_at"), "expires_at", obligation_id)
    if observed < grant_issued or receipt_expires > grant_expires:
        fail(obligation_id, "receipt window must be inside the grant window")
    return observed, receipt_expires, grant_issued, grant_expires


def _validate_grant_scope(
    receipt: dict[str, Any], cap: int, obligation_id: str,
) -> dict[str, Any]:
    if receipt.get("platform") not in PLATFORMS:
        fail(obligation_id, "bounded-auto platform is invalid")
    scope = require_exact_keys(
        receipt.get("grant_scope"),
        {"mode", "platforms", "post_ids_sha256", "risk_class", "max_replies"},
        "grant_scope", obligation_id,
    )
    if scope.get("mode") != "bounded_auto" or scope.get("platforms") != [receipt["platform"]]:
        fail(obligation_id, "grant_scope mode/platform does not bind the canary")
    if scope.get("risk_class") != "low" or not exact_int(scope.get("max_replies"), cap):
        fail(obligation_id, "grant_scope risk/cap does not bind the canary")
    require_hex(scope.get("post_ids_sha256"), "grant_scope.post_ids_sha256", obligation_id)
    return scope


def _validate_action_identity(
    action: dict[str, Any], receipt: dict[str, Any], scope: dict[str, Any],
    unique_fields: dict[str, set[Any]], parent_keys: set[tuple[str, str]],
    obligation_id: str,
) -> None:
    if action.get("platform") != receipt["platform"] or action.get("outcome") != "confirmed":
        fail(obligation_id, "bounded action platform/outcome is invalid")
    for key in ("action_id", "parent_comment_id", "permit_id", "claim_id", "grant_id"):
        require_nonempty_string(action.get(key), key, obligation_id)
    if (
        action["grant_id"] != receipt["grant_id"]
        or action.get("session_id_sha256") != receipt["session_id_sha256"]
        or action.get("post_ids_scope_sha256") != scope["post_ids_sha256"]
    ):
        fail(obligation_id, "bounded action is not bound to grant/session/post scope")
    for key, seen in unique_fields.items():
        if action[key] in seen:
            fail(obligation_id, f"bounded action {key} values must be unique")
        seen.add(action[key])
    parent_key = (action["platform"], action["parent_comment_id"])
    if parent_key in parent_keys:
        fail(obligation_id, "bounded parent comments must be unique per platform")
    parent_keys.add(parent_key)


def _validate_action_hashes_and_time(
    action: dict[str, Any], window: tuple[datetime, datetime, datetime, datetime],
    obligation_id: str,
) -> None:
    for key in (
        "post_id_sha256", "post_ids_scope_sha256", "reply_text_sha256",
        "execution_receipt_sha256", "session_id_sha256",
    ):
        require_hex(action.get(key), key, obligation_id)
    observed, receipt_expires, grant_issued, grant_expires = window
    executed = parse_utc(action.get("executed_at"), "executed_at", obligation_id)
    if executed < max(observed, grant_issued) or executed > min(receipt_expires, grant_expires):
        fail(obligation_id, "bounded action executed outside receipt/grant window")


def _validate_bounded_actions(
    receipt: dict[str, Any], clicked: int, scope: dict[str, Any],
    window: tuple[datetime, datetime, datetime, datetime], obligation_id: str,
) -> None:
    actions = receipt.get("actions")
    if not isinstance(actions, list) or len(actions) != clicked:
        fail(obligation_id, "actions must exactly match clicked_count")
    action_keys = {
        "platform", "action_id", "parent_comment_id", "post_id_sha256",
        "post_ids_scope_sha256", "reply_text_sha256", "permit_id", "claim_id",
        "execution_receipt_sha256", "grant_id", "session_id_sha256",
        "executed_at", "outcome",
    }
    unique_fields = {
        "action_id": set(), "permit_id": set(), "claim_id": set(),
        "execution_receipt_sha256": set(),
    }
    parent_keys: set[tuple[str, str]] = set()
    for raw_action in actions:
        action = require_exact_keys(raw_action, action_keys, "bounded action", obligation_id)
        _validate_action_identity(
            action, receipt, scope, unique_fields, parent_keys, obligation_id
        )
        _validate_action_hashes_and_time(action, window, obligation_id)


def _validate_bounded(receipt: dict[str, Any], obligation_id: str) -> None:
    cap, clicked = _validate_bounded_counts(receipt, obligation_id)
    window = _validate_grant_window(receipt, obligation_id)
    scope = _validate_grant_scope(receipt, cap, obligation_id)
    _validate_bounded_actions(receipt, clicked, scope, window, obligation_id)


SEMANTIC_VALIDATORS: dict[str, Callable[[dict[str, Any], str], None]] = {
    "TRUSTED_CHROME_HOST_RESOLVER": _validate_host,
    "STABLE_NODE_FRAME_MAPPING": _validate_mapping,
    "THREE_PLATFORM_BROWSER_FIXTURE": _validate_fixture,
    "THREE_PLATFORM_LIVE_DRAFT": _validate_draft,
    "LIVE_BATCH_CONFIRM": _validate_batch,
    "LIVE_BOUNDED_AUTO": _validate_bounded,
}

#!/usr/bin/env python3
"""Canonical receipt I/O, hashing, freshness, and common bindings."""

from __future__ import annotations

import hashlib
import json
import os
import stat
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from comment_capability_promotion_contract import (
    CANONICALIZATION,
    CANONICAL_HASH_GOLDEN_SHA256,
    CANONICAL_HASH_GOLDEN_VALUE,
    HASH_ALGORITHM,
    MAX_RECEIPT_BYTES,
    REQUIREMENTS,
    RFC3339_UTC,
    SOURCE_PATH,
    UUID_V4,
    exact_int,
    fail,
    require_bool,
    require_exact_keys,
    require_hex,
)


def canonical_json_bytes(value: Any) -> bytes:
    payload = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return (payload + "\n").encode("utf-8")


def json_hash(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)[:-1]).hexdigest()


def validate_hash_golden() -> None:
    if json_hash(CANONICAL_HASH_GOLDEN_VALUE) != CANONICAL_HASH_GOLDEN_SHA256:
        raise AssertionError("promotion canonical JSON golden vector drifted")


def _reject_reparse_chain(root: Path, candidate: Path, obligation_id: str) -> None:
    current = root.resolve()
    for part in candidate.relative_to(current).parts:
        current = current / part
        metadata = current.lstat()
        attributes = getattr(metadata, "st_file_attributes", 0)
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        if stat.S_ISLNK(metadata.st_mode) or attributes & reparse_flag:
            fail(obligation_id, "must not traverse a symlink or reparse point")


def safe_file(root: Path, relative: Any, obligation_id: str) -> Path:
    if (
        not isinstance(relative, str)
        or not SOURCE_PATH.fullmatch(relative)
        or "\\" in relative
    ):
        fail(obligation_id, "contains an invalid repo-relative source path")
    path = PurePosixPath(relative)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        fail(obligation_id, "contains a path outside the product root")
    resolved_root = root.resolve()
    lexical = resolved_root.joinpath(*path.parts)
    if lexical == resolved_root or resolved_root not in lexical.parents:
        fail(obligation_id, "contains a path outside the product root")
    if not lexical.exists():
        fail(obligation_id, f"references a missing file: {relative}")
    _reject_reparse_chain(resolved_root, lexical, obligation_id)
    candidate = lexical.resolve()
    if candidate == resolved_root or resolved_root not in candidate.parents:
        fail(obligation_id, "contains a path outside the product root")
    if not candidate.is_file():
        fail(obligation_id, f"references a non-file: {relative}")
    return candidate


def stable_read(path: Path, obligation_id: str) -> bytes:
    before = path.lstat()
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        fail(obligation_id, "evidence must be a regular file")
    with path.open("rb") as handle:
        opened = os.fstat(handle.fileno())
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            fail(obligation_id, "evidence identity changed before read")
        if opened.st_size > MAX_RECEIPT_BYTES:
            fail(obligation_id, "evidence exceeds the bounded size")
        payload = handle.read(MAX_RECEIPT_BYTES + 1)
        after = os.fstat(handle.fileno())
    if (
        (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
        != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
        or len(payload) != after.st_size
    ):
        fail(obligation_id, "evidence changed during read")
    return payload


def load_canonical_receipt(path: Path, obligation_id: str) -> dict[str, Any]:
    payload = stable_read(path, obligation_id)
    if len(payload) > MAX_RECEIPT_BYTES:
        fail(obligation_id, "receipt exceeds the bounded size")
    try:
        receipt = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(obligation_id, f"is not UTF-8 JSON: {exc}")
    if not isinstance(receipt, dict) or payload != canonical_json_bytes(receipt):
        fail(obligation_id, "must be one canonical UTF-8 JSON object")
    return receipt


def capability_contract_hash(root: Path, obligation_id: str) -> str:
    ledger_path = safe_file(root, ".rd/capability-ledger.json", obligation_id)
    try:
        ledger = json.loads(stable_read(ledger_path, obligation_id).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(obligation_id, f"cannot read the capability contract: {exc}")
    rows = ledger.get("obligations") if isinstance(ledger, dict) else None
    if not isinstance(rows, list):
        fail(obligation_id, "cannot derive the capability contract")
    stable = {
        "schemaVersion": ledger.get("schemaVersion"),
        "product": ledger.get("product"),
        "productVersion": ledger.get("productVersion"),
        "sourceRevisionBasis": ledger.get("sourceRevisionBasis"),
        "requiredObligationIds": ledger.get("requiredObligationIds"),
        "obligations": [
            {
                "id": row.get("id"),
                "title": row.get("title"),
                "requiredFor": row.get("requiredFor"),
            }
            for row in rows
            if isinstance(row, dict)
        ],
    }
    return json_hash(stable)


def source_rows(root: Path, obligation_id: str) -> list[dict[str, Any]]:
    rows = []
    for relative in REQUIREMENTS[obligation_id]["sources"]:
        path = safe_file(root, relative, obligation_id)
        payload = stable_read(path, obligation_id)
        rows.append({
            "path": relative,
            "exists": True,
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        })
    return rows


def _validate_source_row(
    source: Any, index: int, relative: str, root: Path, obligation_id: str,
) -> None:
    row = require_exact_keys(
        source,
        {"path", "exists", "size", "sha256"},
        f"source row {index}",
        obligation_id,
    )
    if row.get("path") != relative or row.get("exists") is not True:
        fail(obligation_id, "source inventory path/order or existence drifted")
    if not exact_int(row.get("size")) or row["size"] < 0:
        fail(obligation_id, "source size must be a non-negative integer")
    payload = stable_read(safe_file(root, relative, obligation_id), obligation_id)
    if row.get("sha256") != hashlib.sha256(payload).hexdigest() or row["size"] != len(payload):
        fail(obligation_id, f"source snapshot is stale: {relative}")


def _validate_source_freshness(
    receipt: dict[str, Any], root: Path, obligation_id: str,
) -> None:
    expected = REQUIREMENTS[obligation_id]["sources"]
    sources = receipt.get("source_files")
    if not isinstance(sources, list) or len(sources) != len(expected):
        fail(obligation_id, "requires the exact closed source inventory")
    for index, relative in enumerate(expected):
        _validate_source_row(sources[index], index, relative, root, obligation_id)
    if receipt.get("source_snapshot_sha256") != json_hash(sources):
        fail(obligation_id, "source_snapshot_sha256 does not bind the exact source rows")


def parse_utc(value: Any, label: str, obligation_id: str) -> datetime:
    if not isinstance(value, str) or not RFC3339_UTC.fullmatch(value):
        fail(obligation_id, f"{label} must be RFC3339 UTC")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        fail(obligation_id, f"{label} must be RFC3339 UTC")
    if parsed.tzinfo != timezone.utc:
        fail(obligation_id, f"{label} must be UTC")
    return parsed


def _validate_common_identity(
    receipt: dict[str, Any], obligation_id: str, version: str, revision: str,
) -> None:
    requirement = REQUIREMENTS[obligation_id]
    if not exact_int(receipt.get("schema_version"), 1):
        fail(obligation_id, "must use integer schema_version=1")
    if receipt.get("gate") != requirement["gate"] or receipt.get("status") != "PASS":
        fail(obligation_id, "gate or PASS status is invalid")
    if receipt.get("evidence_scope") != requirement["scope"]:
        fail(obligation_id, "uses the wrong evidence scope")
    require_bool(
        receipt, "capability_promotion_eligible", requirement["promotion"], obligation_id
    )
    require_bool(receipt, "live_browser_actuation_enabled", False, obligation_id)
    if receipt.get("hash_algorithm") != HASH_ALGORITHM or receipt.get("canonicalization") != CANONICALIZATION:
        fail(obligation_id, "hash algorithm or canonicalization contract drifted")
    if not isinstance(receipt.get("run_id"), str) or not UUID_V4.fullmatch(receipt["run_id"]):
        fail(obligation_id, "run_id must be a UUIDv4")
    require_hex(receipt.get("session_id_sha256"), "session_id_sha256", obligation_id)
    if receipt.get("product_version") != version or receipt.get("source_revision_basis") != revision:
        fail(obligation_id, "version or source revision is stale")


def _validate_common_hashes(
    receipt: dict[str, Any], obligation_id: str, root: Path,
) -> None:
    if receipt.get("capability_contract_sha256") != capability_contract_hash(root, obligation_id):
        fail(obligation_id, "capability contract snapshot is stale")
    policy = stable_read(
        safe_file(root, "references/comment-policy.json", obligation_id), obligation_id
    )
    if receipt.get("policy_sha256") != hashlib.sha256(policy).hexdigest():
        fail(obligation_id, "comment policy snapshot is stale")


def validate_common_receipt(
    receipt: dict[str, Any], obligation_id: str, version: str, revision: str,
    root: Path, now: datetime,
) -> None:
    _validate_common_identity(receipt, obligation_id, version, revision)
    _validate_common_hashes(receipt, obligation_id, root)
    observed = parse_utc(receipt.get("observed_at"), "observed_at", obligation_id)
    expires = parse_utc(receipt.get("expires_at"), "expires_at", obligation_id)
    if now.tzinfo != timezone.utc:
        fail(obligation_id, "verifier clock must be UTC")
    max_age = REQUIREMENTS[obligation_id]["max_age_seconds"]
    if expires <= observed or (expires - observed).total_seconds() > max_age:
        fail(obligation_id, "receipt lifetime exceeds the obligation bound")
    if now < observed or now > expires:
        fail(obligation_id, "receipt is not current for this verification session")
    _validate_source_freshness(receipt, root, obligation_id)

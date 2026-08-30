#!/usr/bin/env python3
"""Bridge rich localhost Browser evidence into one canonical test-only envelope.

The raw receipt remains the detailed Browser artifact.  The envelope is only a
fresh, source-bound input for ``THREE_PLATFORM_BROWSER_FIXTURE``; it can never
claim authenticated Meta authority, stable live node/frame mapping, or live
browser actuation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from comment_capability_promotion_contract import (
    CANONICALIZATION,
    HASH_ALGORITHM,
    PLATFORMS,
    REQUIREMENTS,
    fail,
)
from comment_capability_receipt_support import (
    canonical_json_bytes,
    capability_contract_hash,
    json_hash,
    safe_file,
    source_rows,
    stable_read,
)


OBLIGATION_ID = "THREE_PLATFORM_BROWSER_FIXTURE"
RAW_RECEIPT_RELATIVE = ".rd/receipts/three-platform-browser-fixture.json"
RAW_SIDECAR_RELATIVE = f"{RAW_RECEIPT_RELATIVE}.sha256"
RAW_PARSER_RELATIVE = "scripts/comment_chrome_fixture_receipt_testonly.mjs"
ARCHITECTURE_RECEIPT_RELATIVE = ".rd/receipts/js-architecture-gate.json"
ARCHITECTURE_SIDECAR_RELATIVE = f"{ARCHITECTURE_RECEIPT_RELATIVE}.sha256"
EXPECTED_DOES_NOT_PROVE = [
    "authenticated Meta host authority",
    "live Meta draft or send",
    "stable tab/frame/document mapping",
    "automatic reply eligibility",
]
NODE_PARSE_PROGRAM = """
import { pathToFileURL } from "node:url";
const [parserPath] = process.argv.slice(1);
let serialized = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) serialized += chunk;
const { parseCanonicalThreePlatformFixtureReceipt } = await import(pathToFileURL(parserPath).href);
parseCanonicalThreePlatformFixtureReceipt(serialized);
process.stdout.write("PASS\\n");
""".strip()


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _parse_raw_time(value: Any) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        fail(OBLIGATION_ID, "raw fixture observed_at must be canonical UTC")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        fail(OBLIGATION_ID, "raw fixture observed_at is invalid")
    if parsed.tzinfo != timezone.utc:
        fail(OBLIGATION_ID, "raw fixture observed_at must be UTC")
    return parsed


def _utc_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _require_sidecar(
    root: Path, receipt_relative: str, sidecar_relative: str, payload: bytes,
) -> None:
    sidecar = stable_read(safe_file(root, sidecar_relative, OBLIGATION_ID), OBLIGATION_ID)
    expected = f"{_sha256(payload)}  {Path(receipt_relative).name}\n".encode("ascii")
    if sidecar != expected:
        fail(OBLIGATION_ID, f"detached SHA-256 sidecar mismatch: {receipt_relative}")


def _run_authoritative_raw_parser(root: Path, payload: bytes) -> None:
    node = shutil.which("node")
    if node is None:
        fail(OBLIGATION_ID, "Node is required to verify the authoritative raw fixture schema")
    parser = safe_file(root, RAW_PARSER_RELATIVE, OBLIGATION_ID)
    try:
        completed = subprocess.run(
            [node, "--input-type=module", "-e", NODE_PARSE_PROGRAM, str(parser)],
            cwd=root,
            check=False,
            capture_output=True,
            input=payload,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError(
            f"obligation {OBLIGATION_ID} promotion evidence raw parser unavailable"
        ) from exc
    if completed.returncode != 0 or completed.stdout != b"PASS\n":
        fail(OBLIGATION_ID, "raw fixture failed the authoritative JavaScript receipt parser")


def _require_current_raw_sources(root: Path, receipt: dict[str, Any]) -> None:
    sources = receipt.get("sources")
    if not isinstance(sources, list) or not sources:
        fail(OBLIGATION_ID, "raw fixture source inventory is missing")
    for row in sources:
        if not isinstance(row, dict) or set(row) != {"path", "exists", "size", "sha256"}:
            fail(OBLIGATION_ID, "raw fixture source row schema drifted")
        if row.get("exists") is not True or not isinstance(row.get("path"), str):
            fail(OBLIGATION_ID, "raw fixture source row is not a present reviewed file")
        payload = stable_read(safe_file(root, row["path"], OBLIGATION_ID), OBLIGATION_ID)
        if row.get("size") != len(payload) or row.get("sha256") != _sha256(payload):
            fail(OBLIGATION_ID, f"raw fixture source snapshot is stale: {row['path']}")
    if receipt.get("source_snapshot_sha256") != json_hash(sources):
        fail(OBLIGATION_ID, "raw fixture source snapshot digest mismatch")


def _require_current_architecture_receipt(root: Path, receipt: dict[str, Any]) -> None:
    path = safe_file(root, ARCHITECTURE_RECEIPT_RELATIVE, OBLIGATION_ID)
    payload = stable_read(path, OBLIGATION_ID)
    _require_sidecar(
        root, ARCHITECTURE_RECEIPT_RELATIVE, ARCHITECTURE_SIDECAR_RELATIVE, payload
    )
    evidence = receipt.get("architecture_gate")
    if not isinstance(evidence, dict) or evidence.get("receipt_sha256") != _sha256(payload):
        fail(OBLIGATION_ID, "raw fixture no longer binds the current architecture receipt")


def _require_test_only_raw_claims(
    root: Path, receipt: dict[str, Any], now: datetime,
) -> None:
    expected = {
        "evidence_scope": "localhost_test_only_candidate",
        "capability_promotion_eligible": False,
        "live_browser_actuation_enabled": False,
        "claim_authority": "in_memory_test_only",
        "trusted_host_verified": False,
        "stable_node_frame_mapping_verified": False,
        "owned_ephemeral_loopback_server": True,
        "active_state_unchanged": True,
    }
    if any(receipt.get(key) != value for key, value in expected.items()):
        fail(OBLIGATION_ID, "raw fixture attempted to exceed localhost test-only authority")
    if receipt.get("does_not_prove") != EXPECTED_DOES_NOT_PROVE:
        fail(OBLIGATION_ID, "raw fixture does_not_prove boundary drifted")
    if receipt.get("platform_order") != PLATFORMS:
        fail(OBLIGATION_ID, "raw fixture platform order drifted")
    if receipt.get("browser_surface") != {"goto": True, "playwright": True, "dom_cua": True}:
        fail(OBLIGATION_ID, "raw fixture did not use the complete controlled Browser surface")
    observed = _parse_raw_time(receipt.get("observed_at"))
    max_age = REQUIREMENTS[OBLIGATION_ID]["max_age_seconds"]
    if observed > now or now - observed > timedelta(seconds=max_age):
        fail(OBLIGATION_ID, "raw fixture evidence is outside its bounded freshness window")
    policy = stable_read(
        safe_file(root, "references/comment-policy.json", OBLIGATION_ID), OBLIGATION_ID
    )
    if receipt.get("policy_sha256") != _sha256(policy):
        fail(OBLIGATION_ID, "raw fixture policy snapshot is stale")


def load_verified_raw_fixture(
    root: Path, now: datetime,
) -> tuple[dict[str, Any], str]:
    """Load one fresh raw Browser receipt without reading any account/session files."""
    receipt_path = safe_file(root, RAW_RECEIPT_RELATIVE, OBLIGATION_ID)
    payload = stable_read(receipt_path, OBLIGATION_ID)
    _require_sidecar(root, RAW_RECEIPT_RELATIVE, RAW_SIDECAR_RELATIVE, payload)
    _run_authoritative_raw_parser(root, payload)
    try:
        receipt = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(
            f"obligation {OBLIGATION_ID} promotion evidence raw fixture is invalid JSON"
        ) from exc
    if not isinstance(receipt, dict):
        fail(OBLIGATION_ID, "raw fixture must be one JSON object")
    _require_test_only_raw_claims(root, receipt, now)
    _require_current_raw_sources(root, receipt)
    _require_current_architecture_receipt(root, receipt)
    return receipt, _sha256(payload)


def derive_envelope_results(raw_receipt: dict[str, Any]) -> list[dict[str, Any]]:
    rows = raw_receipt.get("results")
    if not isinstance(rows, list) or len(rows) != len(PLATFORMS):
        fail(OBLIGATION_ID, "raw fixture must contain exactly three results")
    result = []
    for index, platform in enumerate(PLATFORMS):
        row = rows[index]
        if not isinstance(row, dict) or row.get("platform") != platform:
            fail(OBLIGATION_ID, "raw fixture result platform order drifted")
        result.append({
            "platform": platform,
            "exact_reply_visible": row.get("exact_reply_visible"),
            "own_author_verified": row.get("own_author_verified"),
            "parent_verified": row.get("parent_verified"),
            "test_only": row.get("test_only"),
            "submit_attempts": row.get("submit_attempts"),
            "action_id": row.get("action_id"),
            "parent_comment_id": row.get("parent_comment_id"),
            "phase_sha256": json_hash(row.get("phase_sha256")),
        })
    return result


def build_fixture_promotion_envelope(
    root: Path, raw_receipt: dict[str, Any], raw_sha256: str,
    version: str, revision: str,
) -> dict[str, Any]:
    requirement = REQUIREMENTS[OBLIGATION_ID]
    observed = _parse_raw_time(raw_receipt.get("observed_at"))
    sources = source_rows(root, OBLIGATION_ID)
    policy = stable_read(
        safe_file(root, "references/comment-policy.json", OBLIGATION_ID), OBLIGATION_ID
    )
    return {
        "schema_version": 1,
        "gate": requirement["gate"],
        "status": "PASS",
        "evidence_scope": requirement["scope"],
        "capability_promotion_eligible": False,
        "live_browser_actuation_enabled": False,
        "hash_algorithm": HASH_ALGORITHM,
        "canonicalization": CANONICALIZATION,
        "run_id": raw_receipt["run_id"],
        "session_id_sha256": _sha256(
            f"localhost-test-only:{raw_receipt['run_id']}".encode("utf-8")
        ),
        "observed_at": _utc_text(observed),
        "expires_at": _utc_text(
            observed + timedelta(seconds=requirement["max_age_seconds"])
        ),
        "product_version": version,
        "source_revision_basis": revision,
        "capability_contract_sha256": capability_contract_hash(root, OBLIGATION_ID),
        "policy_sha256": _sha256(policy),
        "source_files": sources,
        "source_snapshot_sha256": json_hash(sources),
        "trusted_host_verified": False,
        "stable_node_frame_mapping_verified": False,
        "claim_authority": "in_memory_test_only",
        "platform_order": list(PLATFORMS),
        "raw_fixture_receipt_path": RAW_RECEIPT_RELATIVE,
        "raw_fixture_receipt_sha256": raw_sha256,
        "results": derive_envelope_results(raw_receipt),
    }


def validate_envelope_binding(
    receipt: dict[str, Any], raw_receipt: dict[str, Any], raw_sha256: str,
) -> None:
    if receipt.get("raw_fixture_receipt_path") != RAW_RECEIPT_RELATIVE:
        fail(OBLIGATION_ID, "envelope points at an unsupported raw receipt path")
    if receipt.get("raw_fixture_receipt_sha256") != raw_sha256:
        fail(OBLIGATION_ID, "envelope does not bind the exact raw receipt bytes")
    expected = {
        "run_id": raw_receipt.get("run_id"),
        "observed_at": _utc_text(_parse_raw_time(raw_receipt.get("observed_at"))),
        "trusted_host_verified": False,
        "stable_node_frame_mapping_verified": False,
        "claim_authority": "in_memory_test_only",
        "platform_order": list(PLATFORMS),
        "results": derive_envelope_results(raw_receipt),
    }
    if any(receipt.get(key) != value for key, value in expected.items()):
        fail(OBLIGATION_ID, "envelope drifted from its raw localhost Browser evidence")


def verify_three_platform_fixture_envelope(
    receipt: dict[str, Any], _version: str, _revision: str,
    root: Path, now: datetime,
) -> None:
    """Trusted test-only verifier; never resolves or claims live host authority."""
    raw_receipt, raw_sha256 = load_verified_raw_fixture(root, now)
    validate_envelope_binding(receipt, raw_receipt, raw_sha256)


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def write_fixture_promotion_envelope(root: Path, now: datetime) -> Path:
    package = json.loads(stable_read(
        safe_file(root, ".rd/package.json", OBLIGATION_ID), OBLIGATION_ID
    ).decode("utf-8"))
    ledger = json.loads(stable_read(
        safe_file(root, ".rd/capability-ledger.json", OBLIGATION_ID), OBLIGATION_ID
    ).decode("utf-8"))
    version = package.get("version")
    revision = ledger.get("sourceRevisionBasis")
    if not isinstance(version, str) or not version or not isinstance(revision, str) or not revision:
        fail(OBLIGATION_ID, "package version or source revision basis is unavailable")
    raw_receipt, raw_sha256 = load_verified_raw_fixture(root, now)
    envelope = build_fixture_promotion_envelope(
        root, raw_receipt, raw_sha256, version, revision
    )
    target = root / REQUIREMENTS[OBLIGATION_ID]["path"]
    _atomic_write(target, canonical_json_bytes(envelope))
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write", action="store_true",
        help="write the canonical test-only promotion envelope after verification",
    )
    args = parser.parse_args()
    if not args.write:
        parser.error("--write is required; this command never runs the Browser fixture itself")
    root = Path(__file__).resolve().parent.parent
    target = write_fixture_promotion_envelope(root, datetime.now(timezone.utc))
    print(target.relative_to(root).as_posix())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "RAW_RECEIPT_RELATIVE",
    "build_fixture_promotion_envelope",
    "derive_envelope_results",
    "load_verified_raw_fixture",
    "validate_envelope_binding",
    "verify_three_platform_fixture_envelope",
    "write_fixture_promotion_envelope",
]

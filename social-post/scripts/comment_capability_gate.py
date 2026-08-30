#!/usr/bin/env python3
"""Validate the canonical capability ledger and its generated public comment view."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path, PurePosixPath
from typing import Any

from comment_capability_promotion import (
    PROMOTION_DEPENDENCIES,
    REQUIREMENTS as PROMOTION_REQUIREMENTS,
    validate_promotion_dependency_graph,
    validate_promotion_evidence,
)


ROOT = Path(__file__).resolve().parents[1]
CANONICAL = ROOT / ".rd" / "capability-ledger.json"
PACKAGE = ROOT / ".rd" / "package.json"
PROJECTION = ROOT / "comment-capabilities.json"
ALLOWED_STATUS = {"verified", "blocked_external", "planned", "unmeasured"}
ALLOWED_LEVEL = {"native_verified", "contract_enforced", "orchestrator_handoff", "unmeasured"}
ALLOWED_SCOPE = {"internal", "public", "parity"}
HEX_256 = re.compile(r"^[0-9a-f]{64}$")
REPLAY_COMMAND = re.compile(r"^(python|node) (scripts/[A-Za-z0-9_.-]+)$")
PRIVATE_PATTERNS = (
    re.compile(r"[A-Za-z]:[/\\]Users[/\\]", re.IGNORECASE),
    re.compile(r"(?:/Users/|/home/|\\\\)", re.IGNORECASE),
    re.compile(r"\.(?:codex|claude)[/\\]skills", re.IGNORECASE),
    re.compile(r"(?:api[_-]?key|token|secret|password|authorization)\s*[:=]", re.IGNORECASE),
)
PUBLIC_SUMMARY_PATH = re.compile(r"^references/promotion-summaries/[a-z0-9-]+\.json$")


def required_string(value: dict[str, Any], key: str, label: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result or result != result.strip():
        raise ValueError(f"{label}.{key} must be a non-empty string")
    return result


def json_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def file_hash(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def reject_private(value: Any, label: str) -> None:
    serialized = json.dumps(value, ensure_ascii=False)
    if any(pattern.search(serialized) for pattern in PRIVATE_PATTERNS):
        raise ValueError(f"{label} contains a private path or credential-shaped value")


def validate_string_list(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or not value or any(not isinstance(item, str) or not item for item in value):
        raise ValueError(f"{label} must be a non-empty string list")
    if len(value) != len(set(value)):
        raise ValueError(f"{label} contains duplicates")
    return value


def resolve_evidence_file(relative: Any, label: str) -> Path:
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise ValueError(f"{label} must be a repo-relative POSIX path")
    path = PurePosixPath(relative)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"{label} escapes the product root")
    candidate = ROOT.joinpath(*path.parts).resolve()
    if candidate != ROOT and ROOT not in candidate.parents:
        raise ValueError(f"{label} escapes the product root")
    if not candidate.is_file():
        raise ValueError(f"{label} does not exist: {relative}")
    return candidate


def validate_replay_commands(row: dict[str, Any], label: str) -> list[str]:
    commands = row.get("replayCommands", [])
    if not isinstance(commands, list) or any(not isinstance(command, str) for command in commands):
        raise ValueError(f"{label}.replayCommands must be a string list")
    for command in commands:
        match = REPLAY_COMMAND.fullmatch(command)
        if not match:
            raise ValueError(f"{label} has an unsupported replay command: {command}")
        resolve_evidence_file(match.group(2), f"{label}.replayCommands")
    return commands


def validate_public_promotion_evidence(
    row: dict[str, Any], label: str, version: str, revision: str,
) -> list[dict[str, str]]:
    evidence = row.get("publicEvidence")
    if not isinstance(evidence, list) or not evidence:
        raise ValueError(f"{label} requires a privacy-safe publicEvidence summary")
    for entry in evidence:
        if (
            not isinstance(entry, dict)
            or set(entry) != {"kind", "value"}
            or entry.get("kind") != "promotion_summary"
        ):
            raise ValueError(f"{label}.publicEvidence must use promotion_summary files")
        relative = entry.get("value")
        if not isinstance(relative, str) or not PUBLIC_SUMMARY_PATH.fullmatch(relative):
            raise ValueError(f"{label}.publicEvidence cannot expose private .rd evidence")
        path = resolve_evidence_file(relative, f"{label}.publicEvidence")
        try:
            summary = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"{label}.publicEvidence summary is not UTF-8 JSON") from exc
        keys = {
            "schema_version", "document_role", "obligation_id", "product_version",
            "source_revision_basis", "evidence_scope", "source_snapshot_sha256",
            "producer_attestation_sha256", "summary_sha256",
        }
        if not isinstance(summary, dict) or set(summary) != keys:
            raise ValueError(f"{label}.publicEvidence summary schema is invalid")
        expected = {
            "schema_version": 1,
            "document_role": "public_capability_promotion_summary",
            "obligation_id": row.get("id"),
            "product_version": version,
            "source_revision_basis": revision,
            "evidence_scope": PROMOTION_REQUIREMENTS[row["id"]]["scope"],
        }
        if any(summary.get(key) != value for key, value in expected.items()):
            raise ValueError(f"{label}.publicEvidence summary binding drifted")
        for key in ("source_snapshot_sha256", "producer_attestation_sha256"):
            if not HEX_256.fullmatch(str(summary.get(key, ""))):
                raise ValueError(f"{label}.publicEvidence {key} is invalid")
        payload = {key: value for key, value in summary.items() if key != "summary_sha256"}
        if summary.get("summary_sha256") != json_hash(payload):
            raise ValueError(f"{label}.publicEvidence summary hash is invalid")
    return evidence


def validate_verified(
    row: dict[str, Any], label: str, version: str, revision: str,
) -> None:
    if required_string(row, "verifiedVersion", label) != version:
        raise ValueError(f"{label} verification version drift")
    evidence = row.get("evidence")
    if not isinstance(evidence, list) or not evidence:
        raise ValueError(f"{label} requires replayable evidence")
    guarded = row.get("id") in PROMOTION_REQUIREMENTS
    for entry in evidence:
        if not isinstance(entry, dict) or entry.get("kind") not in {"file", "promotion_receipt"}:
            raise ValueError(f"{label} evidence must use file or promotion_receipt inputs")
        if entry.get("kind") == "promotion_receipt" and not guarded:
            raise ValueError(f"{label} is not eligible to use promotion_receipt evidence")
        resolve_evidence_file(entry.get("value"), f"{label}.evidence")
    if guarded:
        commands = validate_replay_commands(row, label)
        if not commands:
            raise ValueError(f"{label} requires at least one executable replay command")
        validate_public_promotion_evidence(row, label, version, revision)
        validate_promotion_evidence(row, version, revision, ROOT)
    else:
        validate_replay_commands(row, label)


def validate_promotion_dependencies(rows: list[dict[str, Any]]) -> None:
    by_id = {
        row.get("id"): row
        for row in rows
        if isinstance(row, dict) and isinstance(row.get("id"), str)
    }
    if any(obligation_id not in by_id for obligation_id in PROMOTION_DEPENDENCIES):
        raise ValueError("promotion dependency graph is missing a guarded obligation")
    for obligation_id, prerequisites in PROMOTION_DEPENDENCIES.items():
        if by_id[obligation_id].get("status") != "verified":
            continue
        unverified = [
            predecessor
            for predecessor in prerequisites
            if by_id[predecessor].get("status") != "verified"
        ]
        if unverified:
            raise ValueError(
                f"obligation {obligation_id} cannot be verified before: "
                + ", ".join(unverified)
            )


def validate_obligation(row: Any, version: str, revision: str) -> str:
    if not isinstance(row, dict):
        raise ValueError("obligation must be an object")
    obligation_id = required_string(row, "id", "obligation")
    label = f"obligation {obligation_id}"
    required_string(row, "title", label)
    status = required_string(row, "status", label)
    level = required_string(row, "integrationLevel", label)
    if status not in ALLOWED_STATUS or level not in ALLOWED_LEVEL:
        raise ValueError(f"{label} has an unsupported status or integration level")
    scopes = row.get("requiredFor")
    if not isinstance(scopes, list) or not scopes or any(scope not in ALLOWED_SCOPE for scope in scopes):
        raise ValueError(f"{label}.requiredFor is invalid")
    if status == "verified":
        validate_verified(row, label, version, revision)
    elif status == "blocked_external":
        blocker = row.get("blocker")
        if not isinstance(blocker, dict):
            raise ValueError(f"{label}.blocker must be an object")
        for key in ("owner", "condition", "action"):
            required_string(blocker, key, f"{label}.blocker")
    else:
        required_string(row, "nextExperiment", label)
    return obligation_id


def validate_canonical(value: Any, package: dict[str, Any]) -> dict[str, Any]:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("schemaVersion"), int)
        or isinstance(value.get("schemaVersion"), bool)
        or value.get("schemaVersion") != 1
    ):
        raise ValueError("canonical capability ledger schemaVersion must be integer 1")
    if value.get("documentRole") != "canonical_capability_ledger":
        raise ValueError("canonical capability ledger has the wrong documentRole")
    if value.get("product") != package.get("productName"):
        raise ValueError("canonical capability ledger product drift")
    version = required_string(value, "productVersion", "canonical")
    if version != package.get("version"):
        raise ValueError("canonical capability ledger product/version drift")
    release_state = required_string(value, "releaseState", "canonical")
    revision = required_string(value, "sourceRevisionBasis", "canonical")
    if release_state == "released" and revision != f"release-tag:v{version}":
        raise ValueError("released canonical ledger must bind its exact release tag")
    if release_state not in {"released", "unreleased_candidate"}:
        raise ValueError("canonical releaseState is unsupported")
    required = validate_string_list(value.get("requiredObligationIds"), "requiredObligationIds")
    rows = value.get("obligations")
    if not isinstance(rows, list):
        raise ValueError("canonical obligations must be a list")
    ids = [
        required_string(row, "id", "obligation")
        if isinstance(row, dict)
        else ""
        for row in rows
    ]
    if len(ids) != len(set(ids)):
        raise ValueError("canonical obligations contain duplicate IDs")
    if ids != required:
        raise ValueError("canonical obligations must exactly match requiredObligationIds in order")
    validate_promotion_dependency_graph(PROMOTION_DEPENDENCIES)
    validate_promotion_dependencies(rows)
    validated_ids = [validate_obligation(row, version, revision) for row in rows]
    if validated_ids != ids:
        raise AssertionError("validated obligation identity drifted")
    projection = value.get("publicProjection")
    if not isinstance(projection, dict) or projection.get("path") != "comment-capabilities.json":
        raise ValueError("canonical publicProjection path is invalid")
    if (
        not isinstance(projection.get("schemaVersion"), int)
        or isinstance(projection.get("schemaVersion"), bool)
        or projection.get("schemaVersion") != 2
    ):
        raise ValueError("canonical publicProjection schemaVersion must be 2")
    selected = validate_string_list(projection.get("obligationIds"), "publicProjection.obligationIds")
    if any(obligation_id not in required for obligation_id in selected):
        raise ValueError("publicProjection selects an unknown obligation")
    reject_private(value, "canonical capability ledger")
    return {"version": version, "required": required, "selected": selected, "rows": rows}


def projection_payload_hash(value: dict[str, Any]) -> str:
    payload = {key: item for key, item in value.items() if key != "projection_payload_sha256"}
    return json_hash(payload)


def open_obligations(rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    return [
        {"id": row["id"], "status": row["status"]}
        for row in rows if row["status"] != "verified"
    ]


def build_report(
    projection: dict[str, Any], *, mode: str, parity: str,
    canonical_count: int | None, canonical_rows: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    authoritative = mode == "private_canonical" and parity == "verified"
    return {
        "valid": authoritative,
        "structurally_valid": True,
        "authoritative": authoritative,
        "mode": mode,
        "version": projection["release_version"],
        "canonical_obligations": canonical_count,
        "projection_obligations": len(projection["obligations"]),
        "canonical_parity": parity,
        "canonical_open": None if canonical_rows is None else open_obligations(canonical_rows),
        "projection_open": open_obligations(projection["obligations"]),
    }


def public_row(row: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": row["id"],
        "name": row["title"],
        "status": row["status"],
        "integration_level": row["integrationLevel"],
        "scope": row["requiredFor"],
    }
    if row["status"] == "verified":
        evidence = [*row.get("replayCommands", [])]
        if row["id"] in PROMOTION_REQUIREMENTS:
            evidence.extend(entry["value"] for entry in row["publicEvidence"])
        else:
            evidence.extend(
                entry["value"]
                for entry in row["evidence"]
                if not entry["value"].startswith(".rd/")
            )
        result.update({"verified_version": row["verifiedVersion"], "evidence": evidence})
    elif row["status"] == "blocked_external":
        blocker = row["blocker"]
        result.update({"owner": blocker["owner"], "condition": blocker["condition"], "next_action": blocker["action"]})
    else:
        result["next_experiment"] = row["nextExperiment"]
    if "liveBrowserActuationEnabledByDefault" in row:
        result["live_browser_actuation_enabled_by_default"] = row["liveBrowserActuationEnabledByDefault"]
    if "limitation" in row:
        result["limitation"] = row["limitation"]
    return result


def build_projection(canonical: dict[str, Any], raw: bytes) -> dict[str, Any]:
    selected = canonical["publicProjection"]["obligationIds"]
    by_id = {row["id"]: row for row in canonical["obligations"]}
    value: dict[str, Any] = {
        "schema_version": 2,
        "document_role": "generated_public_projection",
        "canonical_source": ".rd/capability-ledger.json",
        "canonical_schema_version": canonical["schemaVersion"],
        "canonical_sha256": file_hash(raw),
        "release_version": canonical["productVersion"],
        "release_state": canonical["releaseState"],
        "source_revision_basis": canonical["sourceRevisionBasis"],
        "required_obligation_ids": selected,
        "obligations": [public_row(by_id[obligation_id]) for obligation_id in selected],
    }
    value["projection_payload_sha256"] = projection_payload_hash(value)
    return value


def validate_projection(value: Any) -> dict[str, Any]:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("schema_version"), int)
        or isinstance(value.get("schema_version"), bool)
        or value.get("schema_version") != 2
    ):
        raise ValueError("public projection schema_version must be integer 2")
    if value.get("document_role") != "generated_public_projection":
        raise ValueError("comment capability document is not a generated public projection")
    if (
        value.get("canonical_source") != ".rd/capability-ledger.json"
        or not isinstance(value.get("canonical_schema_version"), int)
        or isinstance(value.get("canonical_schema_version"), bool)
        or value.get("canonical_schema_version") != 1
    ):
        raise ValueError("public projection canonical source metadata is invalid")
    if not HEX_256.fullmatch(str(value.get("canonical_sha256", ""))):
        raise ValueError("public projection canonical_sha256 is invalid")
    if projection_payload_hash(value) != value.get("projection_payload_sha256"):
        raise ValueError("public projection payload hash mismatch")
    version = required_string(value, "release_version", "projection")
    if value.get("release_state") not in {"released", "unreleased_candidate"}:
        raise ValueError("public projection release_state is unsupported")
    if value.get("release_state") == "released" and value.get("source_revision_basis") != f"release-tag:v{version}":
        raise ValueError("released public projection must bind its exact release tag")
    required = validate_string_list(value.get("required_obligation_ids"), "projection.required_obligation_ids")
    rows = value.get("obligations")
    if not isinstance(rows, list):
        raise ValueError("projection obligations must be a list")
    ids = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("projected obligation must be an object")
        obligation_id = required_string(row, "id", "projected obligation")
        ids.append(obligation_id)
        label = f"projected obligation {obligation_id}"
        required_string(row, "name", label)
        status = required_string(row, "status", label)
        if status not in ALLOWED_STATUS or row.get("integration_level") not in ALLOWED_LEVEL:
            raise ValueError(f"{label} has invalid status or integration level")
        scopes = row.get("scope")
        if not isinstance(scopes, list) or not scopes or any(scope not in ALLOWED_SCOPE for scope in scopes):
            raise ValueError(f"{label}.scope is invalid")
        if status == "verified":
            if row.get("verified_version") != version:
                raise ValueError(f"{label} verification version drift")
            evidence = row.get("evidence")
            if not isinstance(evidence, list) or not evidence or any(not isinstance(item, str) or not item for item in evidence):
                raise ValueError(f"{label} has no evidence")
        elif status == "blocked_external":
            for key in ("owner", "condition", "next_action"):
                required_string(row, key, label)
        else:
            required_string(row, "next_experiment", label)
    if ids != required or len(ids) != len(set(ids)):
        raise ValueError("projected obligations must exactly match required_obligation_ids in order")
    reject_private(value, "public projection")
    return {"version": version, "obligations": len(rows)}


def validate_parity(canonical: dict[str, Any], raw: bytes, projection: dict[str, Any]) -> None:
    if projection != build_projection(canonical, raw):
        raise ValueError("public comment capability projection drifted from the canonical ledger")


def write_projection(value: dict[str, Any]) -> None:
    temporary = PROJECTION.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(PROJECTION)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-projection", action="store_true")
    parser.add_argument("--projection-only", action="store_true", help="Validate the exported view without private canonical access.")
    args = parser.parse_args()
    projection: dict[str, Any]
    if args.write_projection and args.projection_only:
        raise ValueError("--write-projection and --projection-only are mutually exclusive")
    if CANONICAL.is_file() and not args.projection_only:
        raw = CANONICAL.read_bytes()
        canonical = json.loads(raw.decode("utf-8"))
        package = json.loads(PACKAGE.read_text(encoding="utf-8"))
        summary = validate_canonical(canonical, package)
        expected = build_projection(canonical, raw)
        if args.write_projection:
            write_projection(expected)
        projection = json.loads(PROJECTION.read_text(encoding="utf-8"))
        validate_projection(projection)
        validate_parity(canonical, raw, projection)
        mode = "private_canonical"
        parity = "verified"
        canonical_count = len(summary["required"])
        canonical_rows = summary["rows"]
    else:
        if args.write_projection:
            raise ValueError("cannot generate projection without the private canonical ledger")
        projection = json.loads(PROJECTION.read_text(encoding="utf-8"))
        validate_projection(projection)
        mode = "public_projection"
        parity = "not_available_public_projection"
        canonical_count = None
        canonical_rows = None
    result = build_report(
        projection, mode=mode, parity=parity,
        canonical_count=canonical_count, canonical_rows=canonical_rows,
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

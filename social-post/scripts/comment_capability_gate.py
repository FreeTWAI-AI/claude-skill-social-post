#!/usr/bin/env python3
"""Validate the closed-world comment automation capability ledger."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "comment-capabilities.json"
ALLOWED_STATUS = {"verified", "blocked_external", "planned", "unmeasured"}
ALLOWED_LEVEL = {"native_verified", "contract_enforced", "orchestrator_handoff", "unmeasured"}
PRIVATE_PATTERNS = (
    re.compile(r"C:[/\\]Users[/\\]", re.IGNORECASE),
    re.compile(r"\.codex[/\\]codex-remote-attachments", re.IGNORECASE),
    re.compile(r"(?:cookie|token|password|authorization)\s*[:=]", re.IGNORECASE),
)


def required_string(value: dict[str, Any], key: str, label: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result.strip():
        raise ValueError(f"{label}.{key} must be a non-empty string")
    return result.strip()


def validate_ledger(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema_version") != 1:
        raise ValueError("capability ledger schema_version must be integer 1")
    version = required_string(value, "release_version", "ledger")
    revision = required_string(value, "source_revision_basis", "ledger")
    if revision != f"release-tag:v{version}":
        raise ValueError("source_revision_basis must bind the declared release tag")
    required = value.get("required_obligation_ids")
    rows = value.get("obligations")
    if not isinstance(required, list) or not required or any(not isinstance(item, str) for item in required):
        raise ValueError("required_obligation_ids must be a non-empty string list")
    if len(required) != len(set(required)):
        raise ValueError("required_obligation_ids contains duplicates")
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError("obligations must be a list of objects")
    ids = [required_string(row, "id", "obligation") for row in rows]
    if len(ids) != len(set(ids)):
        raise ValueError("obligations contains duplicate IDs")
    if set(ids) != set(required) or len(ids) != len(required):
        raise ValueError("obligations must exactly match required_obligation_ids")
    for row in rows:
        label = f"obligation {row['id']}"
        required_string(row, "name", label)
        status = required_string(row, "status", label)
        level = required_string(row, "integration_level", label)
        if status not in ALLOWED_STATUS or level not in ALLOWED_LEVEL:
            raise ValueError(f"{label} has an unsupported status or integration level")
        scope = row.get("scope")
        if not isinstance(scope, list) or not scope or any(item not in {"internal", "public", "parity"} for item in scope):
            raise ValueError(f"{label}.scope is invalid")
        if status == "verified":
            if required_string(row, "verified_version", label) != version:
                raise ValueError(f"{label} verification version drift")
            evidence = row.get("evidence")
            if not isinstance(evidence, list) or not evidence or any(not isinstance(item, str) or not item.strip() for item in evidence):
                raise ValueError(f"{label} requires replayable evidence")
        elif status == "blocked_external":
            for key in ("owner", "condition", "next_action"):
                required_string(row, key, label)
        elif not row.get("next_experiment"):
            raise ValueError(f"{label} requires next_experiment")
    serialized = json.dumps(value, ensure_ascii=False)
    if any(pattern.search(serialized) for pattern in PRIVATE_PATTERNS):
        raise ValueError("capability ledger contains a private path or credential-shaped value")
    return {"valid": True, "version": version, "obligations": len(rows)}


def negative_tests(value: dict[str, Any]) -> None:
    cases: list[dict[str, Any]] = []
    missing = copy.deepcopy(value)
    missing["obligations"].pop()
    cases.append(missing)
    duplicate = copy.deepcopy(value)
    duplicate["obligations"].append(copy.deepcopy(duplicate["obligations"][0]))
    cases.append(duplicate)
    drift = copy.deepcopy(value)
    drift["obligations"][0]["verified_version"] = "0.0.0"
    cases.append(drift)
    no_evidence = copy.deepcopy(value)
    no_evidence["obligations"][0]["evidence"] = []
    cases.append(no_evidence)
    weak_blocker = copy.deepcopy(value)
    weak_blocker["obligations"][3].pop("next_action")
    cases.append(weak_blocker)
    private = copy.deepcopy(value)
    private["obligations"][3]["condition"] = "C:" + "/Users/private/profile"
    cases.append(private)
    for index, candidate in enumerate(cases, 1):
        try:
            validate_ledger(candidate)
        except ValueError:
            continue
        raise AssertionError(f"negative capability fixture {index} was accepted")


def main() -> int:
    value = json.loads(LEDGER.read_text(encoding="utf-8"))
    result = validate_ledger(value)
    negative_tests(value)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

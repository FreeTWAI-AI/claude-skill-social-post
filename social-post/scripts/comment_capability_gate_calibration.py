#!/usr/bin/env python3
"""Golden, negative, parity, and reporting calibration for capability gate."""

from __future__ import annotations

import copy
import json
from typing import Callable

from comment_capability_gate import (
    CANONICAL,
    PACKAGE,
    PROJECTION,
    build_report,
    projection_payload_hash,
    validate_canonical,
    validate_parity,
    validate_projection,
    validate_promotion_dependencies,
    validate_public_promotion_evidence,
)
from comment_capability_promotion import PROMOTION_DEPENDENCIES


def expect_rejected(check: Callable[[], None], label: str) -> None:
    try:
        check()
    except (AssertionError, ValueError):
        return
    raise AssertionError(f"negative capability fixture was accepted: {label}")


def rehash_projection(value: dict) -> None:
    value["projection_payload_sha256"] = projection_payload_hash(value)


def promotion_dependency_tests(rows: list[dict]) -> None:
    guarded = copy.deepcopy(rows)
    by_id = {row["id"]: row for row in guarded if row["id"] in PROMOTION_DEPENDENCIES}
    for row in by_id.values():
        row["status"] = "verified"
    validate_promotion_dependencies(guarded)
    for obligation_id, prerequisites in PROMOTION_DEPENDENCIES.items():
        for prerequisite in prerequisites:
            skipped = copy.deepcopy(guarded)
            skipped_by_id = {row["id"]: row for row in skipped}
            skipped_by_id[prerequisite]["status"] = "planned"
            expect_rejected(
                lambda candidate=skipped: validate_promotion_dependencies(candidate),
                f"{obligation_id} skipped predecessor {prerequisite}",
            )
    expect_rejected(
        lambda: validate_public_promotion_evidence(
            {"id": "LIVE_BATCH_CONFIRM"},
            "guarded fixture",
            "fixture",
            "fixture-revision",
        ),
        "missing privacy-safe public promotion evidence",
    )


def canonical_negative_tests(value: dict, package: dict) -> None:
    cases: list[tuple[str, dict]] = []
    bool_schema = copy.deepcopy(value)
    bool_schema["schemaVersion"] = True
    cases.append(("boolean canonical schema version", bool_schema))
    missing = copy.deepcopy(value)
    missing["obligations"].pop()
    cases.append(("missing obligation", missing))
    duplicate = copy.deepcopy(value)
    duplicate["obligations"].append(copy.deepcopy(duplicate["obligations"][0]))
    cases.append(("duplicate obligation", duplicate))
    drift = copy.deepcopy(value)
    drift["productVersion"] = "0.0.0"
    cases.append(("product/version drift", drift))
    stale = copy.deepcopy(value)
    stale["obligations"][0]["verifiedVersion"] = "0.0.0"
    cases.append(("stale verified evidence", stale))
    missing_file = copy.deepcopy(value)
    missing_file["obligations"][0]["evidence"][0]["value"] = "scripts/missing-proof.json"
    cases.append(("missing evidence file", missing_file))
    missing_command = copy.deepcopy(value)
    missing_command["obligations"][0]["replayCommands"] = ["python scripts/missing_test.py"]
    cases.append(("missing replay command", missing_command))
    private = copy.deepcopy(value)
    private["candidatePolicy"] = "C:" + "/Users/private/profile"
    cases.append(("private absolute path", private))
    for label, candidate in cases:
        expect_rejected(lambda item=candidate: validate_canonical(item, package), label)
    weak_blocker = copy.deepcopy(value)
    blocker = next(row for row in weak_blocker["obligations"] if row["status"] != "verified")
    blocker.update({
        "status": "blocked_external",
        "integrationLevel": "unmeasured",
        "blocker": {
            "owner": "external fixture owner",
            "condition": "a controlled external fixture is unavailable",
        },
    })
    blocker.pop("nextExperiment", None)
    expect_rejected(lambda: validate_canonical(weak_blocker, package), "incomplete external blocker")
    promotion_dependency_tests(value["obligations"])


def projection_negative_tests(value: dict) -> None:
    bool_schema = copy.deepcopy(value)
    bool_schema["schema_version"] = True
    rehash_projection(bool_schema)
    expect_rejected(lambda: validate_projection(bool_schema), "boolean projection schema version")
    bool_canonical = copy.deepcopy(value)
    bool_canonical["canonical_schema_version"] = True
    rehash_projection(bool_canonical)
    expect_rejected(
        lambda: validate_projection(bool_canonical),
        "boolean canonical schema version in projection",
    )
    arbitrary = copy.deepcopy(value)
    arbitrary["release_state"] = "arbitrary"
    rehash_projection(arbitrary)
    expect_rejected(lambda: validate_projection(arbitrary), "arbitrary release state")
    tampered = copy.deepcopy(value)
    tampered["obligations"][0]["name"] = "tampered"
    expect_rejected(lambda: validate_projection(tampered), "tampered projection payload")
    missing = copy.deepcopy(value)
    missing["obligations"].pop()
    rehash_projection(missing)
    expect_rejected(lambda: validate_projection(missing), "projection missing obligation")


def parity_negative_tests(canonical: dict, raw: bytes, value: dict) -> None:
    status_drift = copy.deepcopy(value)
    row = status_drift["obligations"][0]
    row.update({
        "status": "unmeasured",
        "integration_level": "unmeasured",
        "next_experiment": "negative fixture",
    })
    row.pop("verified_version", None)
    row.pop("evidence", None)
    rehash_projection(status_drift)
    validate_projection(status_drift)
    expect_rejected(
        lambda: validate_parity(canonical, raw, status_drift), "projection status drift"
    )
    extra = copy.deepcopy(value)
    row = copy.deepcopy(extra["obligations"][0])
    row["id"] = "EXTRA_COMMENT_CAPABILITY"
    extra["required_obligation_ids"].append(row["id"])
    extra["obligations"].append(row)
    rehash_projection(extra)
    validate_projection(extra)
    expect_rejected(lambda: validate_parity(canonical, raw, extra), "projection extra obligation")
    wrong_source = copy.deepcopy(value)
    wrong_source["canonical_sha256"] = "0" * 64
    rehash_projection(wrong_source)
    validate_projection(wrong_source)
    expect_rejected(
        lambda: validate_parity(canonical, raw, wrong_source),
        "projection source hash drift",
    )


def reporting_tests() -> None:
    canonical_rows = [
        {"id": "TRUSTED_CHROME_HOST_RESOLVER", "status": "planned"},
        {"id": "STABLE_NODE_FRAME_MAPPING", "status": "planned"},
        {"id": "THREE_PLATFORM_BROWSER_FIXTURE", "status": "unmeasured"},
    ]
    projection_rows = [canonical_rows[-1]]
    report = build_report(
        {"release_version": "fixture", "obligations": projection_rows},
        mode="private_canonical",
        parity="verified",
        canonical_count=len(canonical_rows),
        canonical_rows=canonical_rows,
    )
    canonical_open = report["canonical_open"]
    projection_open = report["projection_open"]
    hidden = {row["id"] for row in canonical_open} - {row["id"] for row in projection_open}
    required_hidden = {"TRUSTED_CHROME_HOST_RESOLVER", "STABLE_NODE_FRAME_MAPPING"}
    if not required_hidden.issubset(hidden) or canonical_open == projection_open:
        raise AssertionError("canonical-only open capability reporting collapsed")
    if "open" in report or report["valid"] is not True or report["authoritative"] is not True:
        raise AssertionError("private canonical report lost its authoritative contract")
    public_report = build_report(
        {"release_version": "fixture", "obligations": projection_rows},
        mode="public_projection",
        parity="not_available_public_projection",
        canonical_count=None,
        canonical_rows=None,
    )
    if public_report["valid"] is not False or public_report["authoritative"] is not False:
        raise AssertionError("projection-only report became self-authoritative")


def run_capability_gate_calibration() -> None:
    projection = json.loads(PROJECTION.read_text(encoding="utf-8"))
    validate_projection(projection)
    projection_negative_tests(projection)
    if CANONICAL.is_file() and PACKAGE.is_file():
        raw = CANONICAL.read_bytes()
        canonical = json.loads(raw.decode("utf-8"))
        package = json.loads(PACKAGE.read_text(encoding="utf-8"))
        validate_canonical(canonical, package)
        validate_parity(canonical, raw, projection)
        canonical_negative_tests(canonical, package)
        parity_negative_tests(canonical, raw, projection)
    reporting_tests()


def main() -> int:
    run_capability_gate_calibration()
    print("comment capability gate calibration passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

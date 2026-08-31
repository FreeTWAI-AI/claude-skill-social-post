#!/usr/bin/env python3
"""Focused contracts for Browser fixture execution and test-only envelopes."""

from __future__ import annotations

import copy
import shutil
import subprocess
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from comment_capability_promotion import validate_promotion_receipt
from comment_capability_promotion_contract import PLATFORMS, REQUIREMENTS
from comment_capability_promotion_fixtures import FIXED_NOW, digest
from comment_fixture_promotion_envelope import (
    RAW_RECEIPT_RELATIVE,
    _run_authoritative_raw_parser,
    build_fixture_promotion_envelope,
    validate_envelope_binding,
)


OBLIGATION_ID = "THREE_PLATFORM_BROWSER_FIXTURE"


def _expect_rejected(callback, label: str) -> None:
    try:
        callback()
    except (ValueError, AssertionError):
        return
    raise AssertionError(f"fixture envelope negative accepted: {label}")


def _raw_fixture() -> dict:
    run_id = str(uuid.uuid4())
    return {
        "run_id": run_id,
        "observed_at": FIXED_NOW.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "results": [
            {
                "platform": platform,
                "exact_reply_visible": True,
                "own_author_verified": True,
                "parent_verified": True,
                "test_only": True,
                "submit_attempts": 1,
                "action_id": f"fixture-action-{run_id}-{platform}",
                "parent_comment_id": f"fixture-parent-{platform}",
                "phase_sha256": {
                    phase: digest(f"{platform}:{phase}")
                    for phase in ("scan", "preflight", "attempt", "result")
                },
            }
            for platform in PLATFORMS
        ],
    }


def _direct_node_must_fail(root: Path) -> None:
    node = shutil.which("node")
    if node is None:
        raise AssertionError("direct fixture execution guard requires Node")
    runner = root / "scripts" / "comment_fixture_browser_e2e.mjs"
    completed = subprocess.run(
        [node, str(runner)],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    combined = f"{completed.stdout}\n{completed.stderr}"
    if completed.returncode == 0 or "NOT_RUN" not in combined:
        raise AssertionError("direct Node fixture execution must fail loudly as NOT_RUN")


def _authoritative_parser_must_consume_stable_bytes(root: Path) -> None:
    payload = b'{"stable":"payload-a"}\n'
    with patch(
        "comment_fixture_promotion_envelope.shutil.which", return_value="node",
    ), patch(
        "comment_fixture_promotion_envelope.subprocess.run",
        return_value=SimpleNamespace(returncode=0, stdout=b"PASS\n", stderr=b""),
    ) as run:
        _run_authoritative_raw_parser(root, payload)
    args, kwargs = run.call_args
    command = args[0]
    if command[-1].endswith("three-platform-browser-fixture.json"):
        raise AssertionError("authoritative parser reopened the raw receipt pathname")
    if kwargs.get("input") != payload or kwargs.get("text") is True:
        raise AssertionError("authoritative parser did not consume the exact stable-read bytes")


def run_fixture_promotion_envelope_tests(
    root: Path, version: str, revision: str,
) -> None:
    requirement = REQUIREMENTS[OBLIGATION_ID]
    if requirement["promotion"] is not False:
        raise AssertionError("Browser fixture must remain promotion=false")
    if requirement["path"] == RAW_RECEIPT_RELATIVE:
        raise AssertionError("raw Browser evidence must not double as its promotion envelope")

    _direct_node_must_fail(root)
    _authoritative_parser_must_consume_stable_bytes(root)
    raw = _raw_fixture()
    raw_sha256 = digest("raw-browser-fixture-receipt")
    envelope = build_fixture_promotion_envelope(
        root, raw, raw_sha256, version, revision
    )
    validate_promotion_receipt(
        OBLIGATION_ID, envelope, version, revision, root,
        calibration_only=True, now=FIXED_NOW,
    )
    _expect_rejected(
        lambda: validate_promotion_receipt(
            OBLIGATION_ID, envelope, version, revision, root, now=FIXED_NOW,
        ),
        "promotion=false fixture accepted as production capability",
    )
    validate_envelope_binding(envelope, raw, raw_sha256)

    wrong_raw_hash = copy.deepcopy(envelope)
    wrong_raw_hash["raw_fixture_receipt_sha256"] = digest("wrong-raw")
    _expect_rejected(
        lambda: validate_envelope_binding(wrong_raw_hash, raw, raw_sha256),
        "wrong raw receipt hash",
    )
    live_claim = copy.deepcopy(envelope)
    live_claim["live_browser_actuation_enabled"] = True
    _expect_rejected(
        lambda: validate_promotion_receipt(
            OBLIGATION_ID, live_claim, version, revision, root,
            calibration_only=True, now=FIXED_NOW,
        ),
        "live authority claim",
    )
    trusted_host_claim = copy.deepcopy(envelope)
    trusted_host_claim["trusted_host_verified"] = True
    _expect_rejected(
        lambda: validate_promotion_receipt(
            OBLIGATION_ID, trusted_host_claim, version, revision, root,
            calibration_only=True, now=FIXED_NOW,
        ),
        "trusted host claim",
    )
    raw_phase_drift = copy.deepcopy(raw)
    raw_phase_drift["results"][0]["phase_sha256"]["result"] = digest("changed")
    _expect_rejected(
        lambda: validate_envelope_binding(envelope, raw_phase_drift, raw_sha256),
        "raw phase drift",
    )
    print("comment fixture promotion envelope test passed")


__all__ = ["run_fixture_promotion_envelope_tests"]

#!/usr/bin/env python3
"""Public entry point for modular comment-operation behavioral tests."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from comment_test_authorization import run_authorization_tests
from comment_capability_gate import main as run_capability_gate
from comment_test_browser_adapter import run_browser_adapter_tests
from comment_test_browser_contract import run_browser_contract_tests
from comment_test_cli import run_cli_tests
from comment_test_state import run_state_tests


def run_chrome_actuator_tests() -> None:
    """Run JavaScript actuator and durable-claim contracts when Node is available."""
    node = shutil.which("node")
    if not node:
        print("comment Chrome actuator test skipped: node is unavailable")
        return
    for name in (
        "comment_chrome_claim_bridge_test.mjs",
        "comment_chrome_claim_integration_test.mjs",
        "comment_chrome_actuator_test.mjs",
    ):
        subprocess.run([node, str(Path(__file__).with_name(name))], check=True)


def run_comment_self_tests() -> None:
    """Run the complete comment-operation test suite."""
    run_state_tests()
    run_authorization_tests()
    run_cli_tests()
    run_browser_adapter_tests()
    run_browser_contract_tests()
    run_chrome_actuator_tests()
    if run_capability_gate() != 0:
        raise AssertionError("comment capability gate failed")


def main() -> int:
    run_comment_self_tests()
    print("comment self-test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Compatibility entrypoint for modular browser contract tests."""

from __future__ import annotations

from comment_test_browser_contract_scan import run_browser_scan_contract_tests
from comment_test_browser_contract_send import run_browser_send_contract_tests
from comment_test_browser_policy_gate import run_browser_policy_gate_tests
from comment_test_browser_regressions import run_browser_regression_tests


def run_browser_contract_tests() -> None:
    run_browser_scan_contract_tests()
    run_browser_send_contract_tests()
    run_browser_policy_gate_tests()
    run_browser_regression_tests()


if __name__ == "__main__":
    run_browser_contract_tests()
    print("comment browser contract tests passed")

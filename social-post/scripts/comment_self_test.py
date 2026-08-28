#!/usr/bin/env python3
"""Public entry point for modular comment-operation behavioral tests."""

from __future__ import annotations

from comment_test_authorization import run_authorization_tests
from comment_test_cli import run_cli_tests
from comment_test_state import run_state_tests


def run_comment_self_tests() -> None:
    """Run the complete comment-operation test suite."""
    run_state_tests()
    run_authorization_tests()
    run_cli_tests()


def main() -> int:
    run_comment_self_tests()
    print("comment self-test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

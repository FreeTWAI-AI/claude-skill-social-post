#!/usr/bin/env python3
"""Offline calibration for the trusted existing-Chrome-session verifier."""

from __future__ import annotations

import ast
import copy
from pathlib import Path
from typing import Any, Callable

from comment_capability_promotion import (
    TRUSTED_PRODUCER_VERIFIERS,
    validate_promotion_receipt,
)
from comment_capability_promotion_fixtures import FIXED_NOW, digest, positive_receipt
from comment_capability_trusted_host_verifier import (
    AUTHORITY_SCHEMA_VERSION,
    AUTHORITY_TRUST_DOMAIN,
    EXISTING_SESSION_KIND,
    OBLIGATION_ID,
    VERIFY_OPERATION,
    build_trusted_host_verifier,
    verify_trusted_chrome_host_receipt,
)


Mutator = Callable[[dict[str, Any]], None]


def _expect_rejected(check: Callable[[], None], label: str) -> None:
    try:
        check()
    except (AssertionError, OSError, TypeError, ValueError):
        return
    raise AssertionError(f"trusted host verifier negative was accepted: {label}")


class FakeExistingSessionAuthority:
    """Isolated challenge responder; it has no browser or network dependency."""

    def __init__(
        self, receipt: dict[str, Any], *, descriptor_updates: dict[str, Any] | None = None,
        response_mutator: Mutator | None = None, replay_first: bool = False,
        descriptor_error: bool = False, verification_error: bool = False,
    ) -> None:
        self.descriptor = {
            "schema_version": AUTHORITY_SCHEMA_VERSION,
            "trust_domain": AUTHORITY_TRUST_DOMAIN,
            "session_kind": EXISTING_SESSION_KIND,
            "authority_id_sha256": digest("offline-test-authority"),
            "session_id_sha256": receipt["session_id_sha256"],
            "connected": True,
            "read_only": True,
            "can_launch_browser": False,
            "can_mutate_browser": False,
            "test_only": True,
        }
        self.descriptor.update(descriptor_updates or {})
        self.response_mutator = response_mutator
        self.replay_first = replay_first
        self.descriptor_error = descriptor_error
        self.verification_error = verification_error
        self.requests: list[dict[str, Any]] = []
        self.first_response: dict[str, Any] | None = None

    def describe_existing_session(self) -> dict[str, Any]:
        if self.descriptor_error:
            raise RuntimeError("isolated descriptor failure")
        return copy.deepcopy(self.descriptor)

    def verify_existing_session(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.verification_error:
            raise RuntimeError("isolated verification failure")
        self.requests.append(copy.deepcopy(request))
        if self.replay_first and self.first_response is not None:
            return copy.deepcopy(self.first_response)
        response = {
            "schema_version": AUTHORITY_SCHEMA_VERSION,
            "operation": VERIFY_OPERATION,
            "challenge_nonce": request["challenge_nonce"],
            "authority_id_sha256": self.descriptor["authority_id_sha256"],
            "session_id_sha256": request["session_id_sha256"],
            "run_id": request["run_id"],
            "source_snapshot_sha256": request["source_snapshot_sha256"],
            "verified_at": "2030-01-02T12:04:30Z",
            "existing_session": True,
            "read_only": True,
            "browser_launch_count": 0,
            "mutation_count": 0,
            "platform_results": copy.deepcopy(request["platform_bindings"]),
        }
        if self.response_mutator:
            self.response_mutator(response)
        self.first_response = copy.deepcopy(response)
        return response


def _local_verifier(authority: Any, *, allow_test: bool = True) -> Callable:
    return build_trusted_host_verifier(lambda: authority, allow_test_authority=allow_test)


def _verify_local(
    authority: Any, receipt: dict[str, Any], version: str, revision: str,
    *, allow_test: bool = True,
) -> None:
    _local_verifier(authority, allow_test=allow_test)(
        receipt, version, revision, Path("."), FIXED_NOW
    )


def _positive_boundary(
    receipt: dict[str, Any], version: str, revision: str, root: Path,
) -> None:
    authority = FakeExistingSessionAuthority(receipt)
    _verify_local(authority, receipt, version, revision)
    if len(authority.requests) != 1:
        raise AssertionError("trusted authority was not challenged exactly once")
    request = authority.requests[0]
    if len(request.get("challenge_nonce", "")) != 64:
        raise AssertionError("trusted authority challenge nonce is not 256-bit hex")
    if request["session_id_sha256"] != receipt["session_id_sha256"]:
        raise AssertionError("trusted authority request lost its session binding")
    if TRUSTED_PRODUCER_VERIFIERS.get(OBLIGATION_ID) is not verify_trusted_chrome_host_receipt:
        raise AssertionError("production facade did not install the callable boundary")
    _expect_rejected(
        lambda: validate_promotion_receipt(
            OBLIGATION_ID, receipt, version, revision, root, now=FIXED_NOW
        ),
        "production resolver without a source-wired existing session",
    )


def _descriptor_negatives(
    receipt: dict[str, Any], version: str, revision: str,
) -> None:
    _expect_rejected(
        lambda: build_trusted_host_verifier(lambda: None)(
            receipt, version, revision, Path("."), FIXED_NOW
        ),
        "missing authority",
    )
    _expect_rejected(
        lambda: build_trusted_host_verifier(
            lambda: (_ for _ in ()).throw(RuntimeError("resolver failed"))
        )(receipt, version, revision, Path("."), FIXED_NOW),
        "authority resolver exception",
    )
    _expect_rejected(
        lambda: _verify_local(object(), receipt, version, revision),
        "duck-typed object without authority methods",
    )
    cases = {
        "float descriptor schema": {"schema_version": 1.0},
        "wrong trust domain": {"trust_domain": "untrusted.example"},
        "not an existing session": {"session_kind": "launchable_session"},
        "disconnected session": {"connected": False},
        "non-read-only session": {"read_only": False},
        "browser launch capability": {"can_launch_browser": True},
        "browser mutation capability": {"can_mutate_browser": True},
        "different session": {"session_id_sha256": digest("another-session")},
    }
    for label, updates in cases.items():
        authority = FakeExistingSessionAuthority(receipt, descriptor_updates=updates)
        _expect_rejected(
            lambda item=authority: _verify_local(item, receipt, version, revision), label
        )
    authority = FakeExistingSessionAuthority(receipt)
    _expect_rejected(
        lambda: _verify_local(authority, receipt, version, revision, allow_test=False),
        "test authority presented to production-mode builder",
    )
    authority = FakeExistingSessionAuthority(receipt, descriptor_error=True)
    _expect_rejected(
        lambda: _verify_local(authority, receipt, version, revision),
        "authority descriptor exception",
    )


def _set_response(key: str, value: Any) -> Mutator:
    def mutate(response: dict[str, Any]) -> None:
        response[key] = value
    return mutate


def _identity_and_time_negatives(
    receipt: dict[str, Any], version: str, revision: str,
) -> None:
    cases: list[tuple[str, Mutator]] = [
        ("boolean response schema", _set_response("schema_version", True)),
        ("float response schema", _set_response("schema_version", 1.0)),
        ("challenge mismatch", _set_response("challenge_nonce", "0" * 64)),
        ("authority mismatch", _set_response("authority_id_sha256", digest("other"))),
        ("session mismatch", _set_response("session_id_sha256", digest("other"))),
        ("run mismatch", _set_response("run_id", "00000000-0000-4000-8000-999999999999")),
        ("source mismatch", _set_response("source_snapshot_sha256", digest("other"))),
        ("not existing", _set_response("existing_session", False)),
        ("not read-only", _set_response("read_only", False)),
        ("browser launched", _set_response("browser_launch_count", 1)),
        ("boolean launch count", _set_response("browser_launch_count", False)),
        ("float launch count", _set_response("browser_launch_count", 0.0)),
        ("browser mutated", _set_response("mutation_count", 1)),
        ("boolean mutation count", _set_response("mutation_count", False)),
        ("float mutation count", _set_response("mutation_count", 0.0)),
        ("before receipt", _set_response("verified_at", "2030-01-02T12:02:59Z")),
        ("after verifier clock", _set_response("verified_at", "2030-01-02T12:05:01Z")),
    ]
    for label, mutator in cases:
        authority = FakeExistingSessionAuthority(receipt, response_mutator=mutator)
        _expect_rejected(
            lambda item=authority: _verify_local(item, receipt, version, revision), label
        )
    authority = FakeExistingSessionAuthority(receipt, verification_error=True)
    _expect_rejected(
        lambda: _verify_local(authority, receipt, version, revision),
        "authority challenge exception",
    )


def _platform_negatives(
    receipt: dict[str, Any], version: str, revision: str,
) -> None:
    def reorder(response: dict[str, Any]) -> None:
        response["platform_results"].reverse()

    def unauthenticated(response: dict[str, Any]) -> None:
        response["platform_results"][0]["authenticated"] = False

    def platform_mutation(response: dict[str, Any]) -> None:
        response["platform_results"][0]["mutation_count"] = 1

    def platform_float_mutation(response: dict[str, Any]) -> None:
        response["platform_results"][0]["mutation_count"] = 0.0

    for label, mutator in (
        ("platform reorder", reorder),
        ("unauthenticated platform", unauthenticated),
        ("platform mutation", platform_mutation),
        ("platform float mutation", platform_float_mutation),
    ):
        authority = FakeExistingSessionAuthority(receipt, response_mutator=mutator)
        _expect_rejected(
            lambda item=authority: _verify_local(item, receipt, version, revision), label
        )


def _replay_negative(
    receipt: dict[str, Any], version: str, revision: str,
) -> None:
    authority = FakeExistingSessionAuthority(receipt, replay_first=True)
    verifier = _local_verifier(authority)
    verifier(receipt, version, revision, Path("."), FIXED_NOW)
    _expect_rejected(
        lambda: verifier(receipt, version, revision, Path("."), FIXED_NOW),
        "replayed authority response",
    )
    if len(authority.requests) != 2:
        raise AssertionError("replay test did not issue a fresh second challenge")
    if authority.requests[0]["challenge_nonce"] == authority.requests[1]["challenge_nonce"]:
        raise AssertionError("authority challenges were reused")


def _source_has_no_browser_side_effects() -> None:
    path = Path(__file__).with_name("comment_capability_trusted_host_verifier.py")
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source)
    forbidden = {"subprocess", "webbrowser", "selenium", "playwright", "pyppeteer"}
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    if imported & forbidden:
        raise AssertionError("trusted host verifier imports a browser-launch dependency")
    for marker in ("Popen(", "subprocess.run(", "os.system(", "Start-Process"):
        if marker in source:
            raise AssertionError(f"trusted host verifier contains side-effect marker {marker}")


def run_trusted_host_verifier_tests(
    root: Path, version: str, revision: str,
) -> None:
    """Prove offline binding and production fail-closed behavior."""
    receipt = positive_receipt(root, OBLIGATION_ID, version, revision)
    _positive_boundary(receipt, version, revision, root)
    _descriptor_negatives(receipt, version, revision)
    _identity_and_time_negatives(receipt, version, revision)
    _platform_negatives(receipt, version, revision)
    _replay_negative(receipt, version, revision)
    _source_has_no_browser_side_effects()


__all__ = ["run_trusted_host_verifier_tests"]

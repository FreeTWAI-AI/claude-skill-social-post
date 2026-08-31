#!/usr/bin/env python3
"""Offline regressions for read-only reconstruction of uncertain browser actions."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest

from comment_browser_common import _json_digest
from comment_browser_send_contract import build_browser_recovery_action
from comment_cli_support import load_state
from comment_test_browser_adapter import LocalFixtureCommentAdapter
from comment_test_browser_contract_support import (
    SESSION_ID, approved_browser_send, finish_browser_send,
    ingest_browser_scan, intent_state, scan_envelope,
)
from comment_test_cli import draft_cli_fixture, prepare_cli_fixture, run_cli


RECOVERY_SESSION = "session-read-only-recovery"


def _snapshot(root: Path) -> dict[str, bytes]:
    """Include every fixture artifact so even a new authority file is detected."""
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in root.rglob("*") if path.is_file()
    }


def _fixture_inputs(root: Path) -> tuple[dict, dict, list[dict]]:
    records, _policy, replay = load_state(root)
    if not replay["valid"]:
        raise AssertionError(replay["errors"])
    return deepcopy((
        replay["latest_comments"], replay["reply_states"], records["replies"],
    ))


class BrowserRecoveryActionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = tempfile.TemporaryDirectory(prefix="social-recovery-action-")
        cls.addClassCleanup(cls.fixture.cleanup)
        cls.root = Path(cls.fixture.name)
        # LocalFixtureCommentAdapter is an in-memory fixture, never a browser.
        cls.script, _adapter, cls.action, cls.claim = approved_browser_send(
            cls.root, "threads",
        )
        cls.intent_id = cls.action["intent_id"]
        cls.inputs = _fixture_inputs(cls.root)
        cls.comment_key = next(
            key for key, state in cls.inputs[1].items()
            if state.get("intent_id") == cls.intent_id
        )

    def build(self, inputs: tuple, session: str = RECOVERY_SESSION) -> dict:
        comments, states, reply_rows = inputs
        return build_browser_recovery_action(
            comments, states, self.intent_id, session, reply_rows=reply_rows,
        )

    def assert_build_rejected(self, inputs: tuple, session: str = RECOVERY_SESSION) -> None:
        before = deepcopy(inputs)
        with self.assertRaises(ValueError):
            self.build(inputs, session)
        self.assertEqual(inputs, before, "rejected reconstruction mutated its inputs")

    def assert_envelope(
        self, envelope: dict, action: dict, attempt: dict,
        session: str = RECOVERY_SESSION,
    ) -> None:
        self.assertEqual(set(envelope), {
            "schema_version", "decision", "operation", "recovery_session_id",
            "action", "preparation", "attempt",
        })
        self.assertIs(type(envelope["schema_version"]), int)
        self.assertEqual(envelope["schema_version"], 1)
        self.assertEqual(envelope["decision"], "RECONCILE_ONLY")
        self.assertEqual(envelope["operation"], "browser-reconcile")
        self.assertEqual(envelope["recovery_session_id"], session)
        self.assertEqual(envelope["action"], action)
        self.assertEqual(_json_digest(envelope["action"]), attempt["browser_action_digest"])
        self.assertEqual(envelope["action"]["session_id"], attempt["session_id"])
        self.assertNotEqual(envelope["action"]["session_id"], session)
        self.assertEqual(envelope["preparation"], {
            "test_only": False,
            "action_id": action["action_id"],
            "permit_id": action["permit_id"],
            "reply_hash": action["reply_hash"],
            "scope": action["scope"],
            "action_digest": attempt["browser_action_digest"],
            "plan_digest": attempt["browser_plan_digest"],
            "preparation_id": attempt["browser_preparation_id"],
            "baseline_total_reply_count": attempt["browser_baseline_total_reply_count"],
        })
        self.assertEqual(envelope["attempt"], {
            "action_id": action["action_id"],
            "claim_id": attempt["browser_submit_claim_id"],
            "preflight_id": attempt["browser_preflight_id"],
            "preparation_id": attempt["browser_preparation_id"],
            "attempt_session_id": attempt["session_id"],
        })

        def check_no_authority(value: object) -> None:
            if isinstance(value, dict):
                for key, item in value.items():
                    self.assertNotIn("capability", key.lower())
                    self.assertNotIn("nonce", key.lower())
                    check_no_authority(item)
            elif isinstance(value, list):
                for item in value:
                    check_no_authority(item)
            elif isinstance(value, str):
                self.assertNotIn("SUBMIT_CLAIM", value)
                self.assertNotEqual(value, "WRITE_OK")

        check_no_authority(envelope)

    def assert_cli_read_only(
        self, script: Path, root: Path, action: dict,
        session: str = RECOVERY_SESSION,
    ) -> dict:
        before = _snapshot(root)
        state_before = intent_state(root, action["intent_id"])
        completed = run_cli(
            script, root, "browser-recovery-action", "--intent-id", action["intent_id"],
            "--session-id", session,
        )
        envelope = json.loads(completed.stdout)
        self.assertEqual(completed.stderr, "")
        self.assert_envelope(envelope, action, state_before["attempt"], session)
        self.assertEqual(_snapshot(root), before, "read-only command changed fixture files")
        self.assertEqual(intent_state(root, action["intent_id"]), state_before)
        self.assertIsNone(state_before["permit"], "fixture accidentally retained a live permit")
        return envelope

    def assert_cli_rejected(
        self, script: Path, root: Path, intent_id: str,
        session: str = RECOVERY_SESSION, *extra: str,
    ) -> None:
        before = _snapshot(root)
        completed = run_cli(
            script, root, "browser-recovery-action", "--intent-id", intent_id,
            "--session-id", session, *extra, expected=2,
        )
        self.assertEqual(completed.stdout, "")
        self.assertEqual(_snapshot(root), before, "rejected command changed fixture files")

    def test_cli_reconstructs_exact_original_action_for_all_platforms(self) -> None:
        first = self.assert_cli_read_only(self.script, self.root, self.action)
        # Read-only inspection is repeatable: it must not consume a nonce or claim.
        self.assertEqual(first, self.assert_cli_read_only(self.script, self.root, self.action))
        for platform in ("facebook", "instagram"):
            with self.subTest(platform=platform), tempfile.TemporaryDirectory(
                prefix=f"social-recovery-action-{platform}-",
            ) as raw:
                root = Path(raw)
                script, _adapter, action, _claim = approved_browser_send(root, platform)
                self.assert_cli_read_only(script, root, action)

    def test_cli_is_available_with_live_mutation_disabled(self) -> None:
        with tempfile.TemporaryDirectory(prefix="social-recovery-action-disabled-") as raw:
            root = Path(raw)
            script, _adapter, action, _claim = approved_browser_send(root, "threads")
            policy_path = root / "references" / "comment-policy.json"
            policy = json.loads(policy_path.read_text(encoding="utf-8"))
            policy["live_browser_actuation_enabled"] = False
            policy_path.write_text(json.dumps(policy), encoding="utf-8")
            self.assert_cli_read_only(script, root, action)

    def test_cli_rejects_original_session_write_option_and_unknown_intent(self) -> None:
        self.assert_cli_rejected(self.script, self.root, self.intent_id, SESSION_ID)
        self.assert_cli_rejected(self.script, self.root, self.intent_id, "")
        self.assert_cli_rejected(
            self.script, self.root, self.intent_id, RECOVERY_SESSION, "--write",
        )
        self.assert_cli_rejected(self.script, self.root, "unknown-recovery-intent")

    def test_cli_recovery_does_not_reopen_submit_paths(self) -> None:
        self.assert_cli_read_only(self.script, self.root, self.action)
        before = _snapshot(self.root)
        for session in (SESSION_ID, RECOVERY_SESSION):
            for command, extra in (
                ("browser-action", ()),
                ("browser-begin", (str(self.root / "browser-preflight.json"), "--write")),
                ("begin-send", ("--write",)),
            ):
                with self.subTest(command=command, session=session):
                    run_cli(
                        self.script, self.root, command, *extra,
                        "--intent-id", self.intent_id, "--session-id", session, expected=2,
                    )
                    self.assertEqual(_snapshot(self.root), before)

    def test_cli_needs_reconcile_preserves_attempt_and_rejects_current_session(self) -> None:
        with tempfile.TemporaryDirectory(prefix="social-recovery-action-uncertain-") as raw:
            root = Path(raw)
            script, adapter, action, _claim = approved_browser_send(root, "threads")
            original_attempt = intent_state(root, action["intent_id"])["attempt"]
            adapter.click_submit("ambiguous")
            finish_browser_send(script, root, action, adapter)
            self.assertEqual(intent_state(root, action["intent_id"])["status"], "needs_reconcile")
            self.assert_cli_read_only(script, root, action)
            issuer_session = "session-fixture-current-reconcile"
            # Prepare a genuine current recovery issuer only in this isolated ledger.
            run_cli(
                script, root, "browser-recover-reconcile", "--intent-id", action["intent_id"],
                "--session-id", issuer_session, "--reason", "browser_process_restarted", "--write",
            )
            self.assert_cli_rejected(script, root, action["intent_id"], issuer_session)
            self.assert_cli_read_only(script, root, action, "session-after-current-reconcile")
            self.assertEqual(intent_state(root, action["intent_id"])["attempt"], original_attempt)

    def test_cli_rejects_approved_and_terminal_states(self) -> None:
        with tempfile.TemporaryDirectory(prefix="social-recovery-action-approved-") as raw:
            root = Path(raw)
            script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
            comment = ingest_browser_scan(script, root, scan_envelope(LocalFixtureCommentAdapter("threads")))
            _reply_path, intent_id = draft_cli_fixture(script, root, comment)
            run_cli(
                script, root, "approve", "--intent-id", intent_id,
                "--approval-mode", "batch_confirm", "--session-id", SESSION_ID, "--write",
            )
            self.assert_cli_rejected(script, root, intent_id)
        with tempfile.TemporaryDirectory(prefix="social-recovery-action-terminal-") as raw:
            root = Path(raw)
            script, adapter, action, _claim = approved_browser_send(root, "instagram")
            adapter.click_submit("verified")
            finish_browser_send(script, root, action, adapter)
            self.assertEqual(intent_state(root, action["intent_id"])["status"], "sent_verified")
            self.assert_cli_rejected(script, root, action["intent_id"])

    def test_direct_builder_never_installs_approval_or_changes_inputs(self) -> None:
        for status in ("send_started", "needs_reconcile"):
            with self.subTest(status=status):
                inputs = deepcopy(self.inputs)
                state = inputs[1][self.comment_key]
                state["status"] = status
                before = deepcopy(inputs)
                envelope = self.build(inputs)
                self.assert_envelope(envelope, self.action, state["attempt"])
                self.assertEqual(inputs, before)
                self.assertIsNone(state["permit"])

    def test_direct_builder_preserves_expired_original_action(self) -> None:
        inputs = deepcopy(self.inputs)
        state = inputs[1][self.comment_key]
        expected_action = deepcopy(self.action)
        expired = "2000-01-01T00:00:00+00:00"
        expected_action["expires_at"] = expired
        approval = next(row for row in inputs[2] if row["event_type"] == "approved")
        approval["expires_at"] = expired
        # Model an original historical send, not a refreshed approval. expires_at
        # is outside action-provenance core but remains bound by the full action SHA.
        state["attempt"]["browser_action_digest"] = _json_digest(expected_action)
        self.assertLess(datetime.fromisoformat(expired), datetime.now(timezone.utc))
        before = deepcopy(inputs)
        envelope = self.build(inputs)
        self.assert_envelope(envelope, expected_action, state["attempt"])
        self.assertEqual(envelope["action"]["expires_at"], expired)
        self.assertEqual(inputs, before)

    def test_direct_builder_preserves_nonzero_preparation_baseline(self) -> None:
        inputs = deepcopy(self.inputs)
        state = inputs[1][self.comment_key]
        state["attempt"]["browser_baseline_total_reply_count"] = 3
        before = deepcopy(inputs)
        envelope = self.build(inputs)
        self.assert_envelope(envelope, self.action, state["attempt"])
        self.assertEqual(inputs, before)

    def test_direct_builder_rejects_stale_or_empty_sessions_and_nonuncertain_states(self) -> None:
        for session in (SESSION_ID, "", "   "):
            with self.subTest(session=session):
                self.assert_build_rejected(deepcopy(self.inputs), session)
        for status in (
            "drafted", "approved", "sent_verified", "failed", "reconciled_sent",
            "reconciled_not_sent", "revoked", "deferred",
        ):
            with self.subTest(status=status):
                inputs = deepcopy(self.inputs)
                inputs[1][self.comment_key]["status"] = status
                self.assert_build_rejected(inputs)
        for issuer_field in ("reconcile_capability", "last_event"):
            with self.subTest(issuer_field=issuer_field):
                inputs = deepcopy(self.inputs)
                state = inputs[1][self.comment_key]
                state["status"] = "needs_reconcile"
                state[issuer_field] = {"browser_reconcile_authorized_session_id": RECOVERY_SESSION}
                self.assert_build_rejected(inputs)

    def test_direct_builder_rejects_changed_comment_scope_fingerprint_or_anchor(self) -> None:
        for key, value in (
            ("raw_fingerprint", "f" * 64),
            ("post_key", "changed-post"),
            ("post_permalink", "https://www.threads.com/@test/post/changed-post"),
            ("observed_parent_post_permalink", "https://www.threads.com/@test/post/wrong-parent"),
            ("comment_permalink", "https://www.threads.com/@other/post/changed-comment"),
            ("platform_comment_id", "changed-comment"),
            ("account_key", "changed-account"),
            ("comment_key", "changed-comment-key"),
            ("platform", "instagram"),
            ("body", "changed original comment"),
        ):
            with self.subTest(field=key):
                inputs = deepcopy(self.inputs)
                inputs[0][self.comment_key][key] = value
                self.assert_build_rejected(inputs)

    def test_direct_builder_rejects_changed_attempt_bindings_and_digests(self) -> None:
        for key, value in (
            ("browser_action_digest", "0" * 64),
            ("browser_action_digest", "not-a-digest"),
            ("browser_action_id", "changed-action"),
            ("permit_id", "changed-permit"),
            ("reply_hash", "1" * 64),
            ("comment_fingerprint", "2" * 64),
            ("scope", {**self.action["scope"], "post_key": "changed-post"}),
            ("browser_preparation_id", "not-a-digest"),
            ("browser_plan_digest", "not-a-digest"),
            ("browser_submit_claim_id", ""),
            ("browser_preflight_id", ""),
            ("browser_baseline_total_reply_count", True),
            ("browser_baseline_total_reply_count", -1),
        ):
            with self.subTest(field=key, value=value):
                inputs = deepcopy(self.inputs)
                inputs[1][self.comment_key]["attempt"][key] = value
                self.assert_build_rejected(inputs)

    def test_direct_builder_rejects_missing_duplicate_or_mismatched_historical_approval(self) -> None:
        inputs = deepcopy(self.inputs)
        inputs[2][:] = [row for row in inputs[2] if row["event_type"] != "approved"]
        self.assert_build_rejected(inputs)
        inputs = deepcopy(self.inputs)
        approval = next(row for row in inputs[2] if row["event_type"] == "approved")
        inputs[2].append(deepcopy(approval))
        self.assert_build_rejected(inputs)
        for key, value in (
            ("intent_id", "other-intent"), ("permit_id", "other-permit"),
            ("session_id", "other-original-session"),
            ("scope", {**self.action["scope"], "comment_key": "other-comment"}),
            ("expires_at", "2000-01-01T00:00:00+00:00"),
        ):
            with self.subTest(field=key):
                inputs = deepcopy(self.inputs)
                approval = next(row for row in inputs[2] if row["event_type"] == "approved")
                approval[key] = value
                self.assert_build_rejected(inputs)


def run_browser_recovery_action_tests() -> None:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(BrowserRecoveryActionTests)
    result = unittest.TestResult()
    suite.run(result)
    if not result.wasSuccessful():
        raise AssertionError("\n".join(detail for _test, detail in result.errors + result.failures))


if __name__ == "__main__":
    unittest.main(verbosity=2)

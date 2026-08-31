#!/usr/bin/env python3
"""Fail-closed recovery tests for lost or expired browser receipt authority."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from comment_test_browser_contract_support import (
    SESSION_ID, approved_browser_send, capture_receipt_commit, intent_state,
    preflight_for, reinspection_for, result_for, write_json,
)
from comment_test_cli import run_cli
from comment_test_browser_recovery_action import run_browser_recovery_action_tests


LEDGERS = (
    "data/comment_events.jsonl",
    "data/reply_events.jsonl",
    "data/browser_scan_requests.jsonl",
)


def _snapshot(root: Path) -> dict[str, bytes]:
    return {relative: (root / relative).read_bytes() for relative in LEDGERS}


def _reject_unchanged(
    script: Path, root: Path, *args: str, message: str,
) -> None:
    before = _snapshot(root)
    run_cli(script, root, *args, expected=2)
    if _snapshot(root) != before:
        raise AssertionError(message)


def _recover(
    script: Path, root: Path, intent_id: str, session_id: str, reason: str,
) -> dict:
    completed = run_cli(
        script, root, "browser-recover-reconcile", "--intent-id", intent_id,
        "--session-id", session_id, "--reason", reason, "--write",
    )
    if "SUBMIT_CLAIM " in completed.stdout:
        raise AssertionError("recovery emitted a second submit claim")
    lines = [
        line.removeprefix("INTERNAL_RECOVERY_CAPABILITY ")
        for line in completed.stdout.splitlines()
        if line.startswith("INTERNAL_RECOVERY_CAPABILITY ")
    ]
    if len(lines) != 1:
        raise AssertionError("recovery emitted no unique reconcile capability")
    payload = json.loads(lines[0])
    if (
        payload.get("operation") != "browser-reconcile"
        or payload.get("decision") != "RECONCILE_ONLY"
    ):
        raise AssertionError("recovery issued a non-reconcile operation")
    return payload


def _reinspection(
    action: dict, attempt: dict, session_id: str, *, found: bool,
) -> dict:
    receipt = reinspection_for(action, attempt, found=found)
    receipt["session_id"] = session_id
    return receipt


def _run_reconcile(
    script: Path, root: Path, action: dict, session_id: str,
    capability: dict, receipt: dict,
) -> dict:
    source = root / "recovery-reinspection.json"
    write_json(source, {"provenance": capability, "receipt": receipt})
    completed = run_cli(
        script, root, "browser-reconcile", str(source),
        "--intent-id", action["intent_id"], "--session-id", session_id, "--write",
    )
    return capture_receipt_commit(root, action["intent_id"], completed.stdout)


def _expire_current_reconcile_capability(root: Path) -> None:
    path = root / "data" / "reply_events.jsonl"
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    if not rows or rows[-1].get("event_type") != "needs_reconcile":
        raise AssertionError("fixture has no active reconcile capability to expire")
    rows[-1]["browser_reconcile_capability_expires_at"] = (
        "2000-01-01T00:00:00+00:00"
    )
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


class _IsolatedFusedRecoveryHarness:
    """Keep recovery bearer authority inside one isolated test closure."""

    def __init__(self, script: Path, root: Path, action: dict) -> None:
        self._script = script
        self._root = root
        self._action = action
        self._session_id: str | None = None
        self._capability: dict | None = None

    @property
    def reconcile_required(self) -> bool:
        return self._capability is not None

    def recover_and_reconcile(
        self, session_id: str, reason: str, *, found: bool,
        receipt_overrides: dict | None = None,
    ) -> dict:
        recovery = _recover(
            self._script, self._root, self._action["intent_id"],
            session_id, reason,
        )
        self._session_id = session_id
        self._capability = recovery["receipt_capability"]
        return self.reinspect_and_reconcile(
            found=found, receipt_overrides=receipt_overrides,
        )

    def reinspect_and_reconcile(
        self, *, found: bool, receipt_overrides: dict | None = None,
    ) -> dict:
        if self._session_id is None or self._capability is None:
            raise AssertionError("fused recovery has no private reconcile authority")
        state = intent_state(self._root, self._action["intent_id"])
        receipt = _reinspection(
            self._action, state["attempt"], self._session_id, found=found,
        )
        receipt.update(receipt_overrides or {})
        committed = _run_reconcile(
            self._script, self._root, self._action, self._session_id,
            self._capability, receipt,
        )
        self._capability = committed.get("next_capability")
        # Mirror the production fused facade: callers receive only a disposition
        # summary. The one-time bearer never crosses this harness boundary.
        return {
            "schema_version": committed["schema_version"],
            "operation": committed["operation"],
            "outcome": committed["outcome"],
            "receipt_digest": committed["receipt_digest"],
            "reconcile_required": self._capability is not None,
        }

    def simulate_process_crash(self) -> None:
        self._session_id = None
        self._capability = None


def check_isolated_fused_recovery_harness() -> None:
    with tempfile.TemporaryDirectory(prefix="social-recovery-fused-not-sent-") as raw:
        root = Path(raw)
        script, _adapter, action, _claim = approved_browser_send(root, "instagram")
        harness = _IsolatedFusedRecoveryHarness(script, root, action)
        summary = harness.recover_and_reconcile(
            "session-fused-not-sent", "browser_process_restarted", found=False,
        )
        if summary["outcome"] != "not-sent" or summary["reconcile_required"]:
            raise AssertionError("fused recovery did not close a proven absence")
        if any(key in summary for key in ("receipt_capability", "next_capability", "nonce")):
            raise AssertionError("fused recovery summary exposed private authority")
        if intent_state(root, action["intent_id"])["status"] != "reconciled_not_sent":
            raise AssertionError("fused not-sent recovery did not close the attempt")

    with tempfile.TemporaryDirectory(prefix="social-recovery-fused-rotation-") as raw:
        root = Path(raw)
        script, adapter, action, claim = approved_browser_send(root, "threads")
        adapter.click_submit("ambiguous")
        state = intent_state(root, action["intent_id"])
        finish_receipt = result_for(
            action, adapter, state["attempt"]["browser_preflight_id"],
        )
        finish_source = root / "fused-uncertain-finish.json"
        write_json(finish_source, {
            "provenance": claim["receipt_capability"], "receipt": finish_receipt,
        })
        completed = run_cli(
            script, root, "browser-finish", str(finish_source),
            "--intent-id", action["intent_id"], "--session-id", SESSION_ID, "--write",
        )
        capture_receipt_commit(root, action["intent_id"], completed.stdout)
        _expire_current_reconcile_capability(root)

        first_process = _IsolatedFusedRecoveryHarness(script, root, action)
        unknown = first_process.recover_and_reconcile(
            "session-fused-unknown", "receipt_capability_expired", found=False,
            receipt_overrides={
                "absence_verified": False,
                "own_author_reply_count": 1,
                "reinspection_total_reply_count": 1,
            },
        )
        if unknown["outcome"] != "unknown" or not unknown["reconcile_required"]:
            raise AssertionError("fused recovery did not privately rotate unknown authority")
        if any(key in unknown for key in ("receipt_capability", "next_capability", "nonce")):
            raise AssertionError("unknown fused summary exposed rotated authority")
        if intent_state(root, action["intent_id"])["status"] != "needs_reconcile":
            raise AssertionError("unknown fused recovery changed send disposition")

        # A second crash loses the rotated in-memory bearer. A new process and a
        # genuinely fresh session must recover from the ledger, never reclaim or
        # resend the original submit attempt.
        first_process.simulate_process_crash()
        second_process = _IsolatedFusedRecoveryHarness(script, root, action)
        closed = second_process.recover_and_reconcile(
            "session-fused-after-second-crash",
            "browser_process_restarted", found=True,
        )
        if closed["outcome"] != "sent" or closed["reconcile_required"]:
            raise AssertionError("fresh-session recovery after a second crash did not close")
        if intent_state(root, action["intent_id"])["status"] != "reconciled_sent":
            raise AssertionError("second-crash recovery did not preserve and close the attempt")


def check_restart_recovery_is_reconcile_only() -> None:
    with tempfile.TemporaryDirectory(prefix="social-recovery-restart-") as raw:
        root = Path(raw)
        script, adapter, action, _claim = approved_browser_send(root, "instagram")
        attempt_before = intent_state(root, action["intent_id"])["attempt"]
        recovery_session = "session-after-browser-restart"
        recovery = _recover(
            script, root, action["intent_id"], recovery_session,
            "browser_process_restarted",
        )
        state = intent_state(root, action["intent_id"])
        if state["status"] != "needs_reconcile" or state["attempt"] != attempt_before:
            raise AssertionError("restart recovery changed the authoritative send attempt")

        # The old action/preflight and the legacy claim path cannot reclaim or click.
        preflight_source = root / "replayed-preflight.json"
        write_json(preflight_source, preflight_for(action, adapter))
        _reject_unchanged(
            script, root, "browser-begin", str(preflight_source),
            "--intent-id", action["intent_id"], "--session-id", SESSION_ID, "--write",
            message="browser-begin reclaimed a recovered send",
        )
        _reject_unchanged(
            script, root, "begin-send", "--intent-id", action["intent_id"],
            "--session-id", recovery_session, "--write",
            message="legacy begin-send reclaimed a recovered send",
        )
        _reject_unchanged(
            script, root, "browser-action", "--intent-id", action["intent_id"],
            "--session-id", recovery_session,
            message="browser-action rebuilt a recovered send action",
        )
        _reject_unchanged(
            script, root, "browser-recover-reconcile", "--intent-id", action["intent_id"],
            "--session-id", recovery_session, "--reason", "browser_process_restarted",
            "--write", message="replayed recovery session rotated authority",
        )

        capability = recovery["receipt_capability"]
        receipt = _reinspection(
            action, state["attempt"], recovery_session, found=False,
        )
        source = root / "forged-recovery-reinspection.json"
        write_json(source, {"provenance": capability, "receipt": receipt})
        _reject_unchanged(
            script, root, "browser-reconcile", str(source),
            "--intent-id", action["intent_id"], "--session-id", "wrong-session",
            "--write", message="wrong recovery session mutated a ledger",
        )
        forged = dict(receipt, scope={**receipt["scope"], "post_key": "wrong-post"})
        write_json(source, {"provenance": capability, "receipt": forged})
        _reject_unchanged(
            script, root, "browser-reconcile", str(source),
            "--intent-id", action["intent_id"], "--session-id", recovery_session,
            "--write", message="wrong recovery binding mutated a ledger",
        )

        write_json(source, {"provenance": capability, "receipt": receipt})
        before_close = _snapshot(root)
        commit = _run_reconcile(
            script, root, action, recovery_session, capability, receipt,
        )
        if commit["outcome"] != "not-sent":
            raise AssertionError("fresh recovery inspection did not close as not-sent")
        if intent_state(root, action["intent_id"])["status"] != "reconciled_not_sent":
            raise AssertionError("restart recovery did not close the uncertain attempt")
        if _snapshot(root)["data/reply_events.jsonl"] == before_close["data/reply_events.jsonl"]:
            raise AssertionError("valid recovery inspection appended no audit event")
        _reject_unchanged(
            script, root, "browser-reconcile", str(source),
            "--intent-id", action["intent_id"], "--session-id", recovery_session,
            "--write", message="replayed recovery receipt mutated a ledger",
        )


def check_expired_capability_recovers_and_can_remain_unknown() -> None:
    with tempfile.TemporaryDirectory(prefix="social-recovery-expiry-") as raw:
        root = Path(raw)
        script, adapter, action, claim = approved_browser_send(root, "threads")
        adapter.click_submit("ambiguous")
        state = intent_state(root, action["intent_id"])
        finish_receipt = result_for(
            action, adapter, state["attempt"]["browser_preflight_id"],
        )
        finish_source = root / "uncertain-finish.json"
        write_json(finish_source, {
            "provenance": claim["receipt_capability"], "receipt": finish_receipt,
        })
        completed = run_cli(
            script, root, "browser-finish", str(finish_source),
            "--intent-id", action["intent_id"], "--session-id", SESSION_ID, "--write",
        )
        old_capability = capture_receipt_commit(
            root, action["intent_id"], completed.stdout,
        )["next_capability"]
        _expire_current_reconcile_capability(root)
        state = intent_state(root, action["intent_id"])
        old_receipt = _reinspection(action, state["attempt"], SESSION_ID, found=False)
        old_source = root / "expired-reinspection.json"
        write_json(old_source, {
            "provenance": old_capability, "receipt": old_receipt,
        })
        _reject_unchanged(
            script, root, "browser-reconcile", str(old_source),
            "--intent-id", action["intent_id"], "--session-id", SESSION_ID, "--write",
            message="expired reconcile capability mutated a ledger",
        )

        recovery_session = "session-after-capability-expiry"
        recovery = _recover(
            script, root, action["intent_id"], recovery_session,
            "receipt_capability_expired",
        )
        state = intent_state(root, action["intent_id"])
        uncertain = _reinspection(
            action, state["attempt"], recovery_session, found=False,
        )
        uncertain.update({
            "absence_verified": False,
            "own_author_reply_count": 1,
            "reinspection_total_reply_count": 1,
        })
        recovery_capability = recovery["receipt_capability"]
        commit = _run_reconcile(
            script, root, action, recovery_session, recovery_capability, uncertain,
        )
        if commit["outcome"] != "unknown" or not commit["next_capability"]:
            raise AssertionError("fresh recovery inspection could not remain unknown")
        if intent_state(root, action["intent_id"])["status"] != "needs_reconcile":
            raise AssertionError("unknown recovery inspection changed send disposition")

        replay_source = root / "replayed-recovery-capability.json"
        write_json(replay_source, {
            "provenance": recovery_capability, "receipt": uncertain,
        })
        _reject_unchanged(
            script, root, "browser-reconcile", str(replay_source),
            "--intent-id", action["intent_id"], "--session-id", recovery_session,
            "--write", message="rotated recovery capability replay mutated a ledger",
        )
        final_state = intent_state(root, action["intent_id"])
        found = _reinspection(
            action, final_state["attempt"], recovery_session, found=True,
        )
        final_commit = _run_reconcile(
            script, root, action, recovery_session, commit["next_capability"], found,
        )
        if final_commit["outcome"] != "sent":
            raise AssertionError("rotated recovery inspection did not close as sent")
        if intent_state(root, action["intent_id"])["status"] != "reconciled_sent":
            raise AssertionError("expiry recovery did not close the uncertain attempt")


def check_recovery_respects_live_kill_switch() -> None:
    with tempfile.TemporaryDirectory(prefix="social-recovery-disabled-") as raw:
        root = Path(raw)
        script, _adapter, action, _claim = approved_browser_send(root, "facebook")
        policy_path = root / "references" / "comment-policy.json"
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        policy["live_browser_actuation_enabled"] = False
        policy_path.write_text(json.dumps(policy), encoding="utf-8")
        _reject_unchanged(
            script, root, "browser-recover-reconcile",
            "--intent-id", action["intent_id"],
            "--session-id", "session-disabled-recovery",
            "--reason", "browser_process_restarted", "--write",
            message="disabled recovery mutated a canonical ledger",
        )


def run_browser_recovery_tests() -> None:
    run_browser_recovery_action_tests()
    check_isolated_fused_recovery_harness()
    check_restart_recovery_is_reconcile_only()
    check_expired_capability_recovers_and_can_remain_unknown()
    check_recovery_respects_live_kill_switch()


if __name__ == "__main__":
    run_browser_recovery_tests()
    print("comment browser recovery test passed")

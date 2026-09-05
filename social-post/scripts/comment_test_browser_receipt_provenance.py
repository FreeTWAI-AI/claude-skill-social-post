#!/usr/bin/env python3
"""Attack-focused tests for one-shot browser finish/reconcile provenance."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

from comment_browser_provenance import build_receipt_binding, consume_receipt_envelope
from comment_test_browser_contract_support import (
    SESSION_ID, approved_browser_send, capture_receipt_commit, intent_state,
    provenance_envelope, reinspection_for, result_for, write_json,
)
from comment_test_cli import run_cli


LEDGERS = (
    "data/comment_events.jsonl",
    "data/reply_events.jsonl",
    "data/browser_scan_requests.jsonl",
)


def _snapshot(root: Path) -> dict[str, bytes]:
    return {relative: (root / relative).read_bytes() for relative in LEDGERS}


def _assert_rejected_unchanged(
    script: Path, root: Path, command: str, source: Path,
    intent_id: str, message: str, *, session_id: str = SESSION_ID,
) -> None:
    before = _snapshot(root)
    run_cli(
        script, root, command, str(source), "--intent-id", intent_id,
        "--session-id", session_id, "--write", expected=2,
    )
    if _snapshot(root) != before:
        raise AssertionError(message)


def _assert_bearer_not_persisted(root: Path, *capabilities: dict) -> None:
    ledger = b"\n".join(_snapshot(root).values()).decode("utf-8")
    for capability in capabilities:
        nonce = str(capability.get("nonce") or "")
        if nonce and nonce in ledger:
            raise AssertionError("receipt capability nonce leaked into a canonical ledger")


def _race_receipt_commit(
    script: Path, root: Path, command: str, source: Path, intent_id: str,
) -> list[subprocess.CompletedProcess[str]]:
    """Release two CLI writers together so one-shot receipt locking is exercised."""
    gate = root / f"{command}-race.start"
    wrapper = (
        "import os,subprocess,sys,time\n"
        "gate,ready,*command=sys.argv[1:]\n"
        "open(ready,'w',encoding='utf-8').write('ready')\n"
        "deadline=time.monotonic()+10\n"
        "while not os.path.exists(gate):\n"
        "  if time.monotonic()>=deadline: sys.exit(97)\n"
        "  time.sleep(0.005)\n"
        "completed=subprocess.run(command,check=False)\n"
        "sys.exit(completed.returncode)\n"
    )
    clean_env = os.environ.copy()
    for name in ("PYTHONIOENCODING", "PYTHONUTF8", "PYTHONLEGACYWINDOWSSTDIO"):
        clean_env.pop(name, None)
    processes: list[subprocess.Popen[str]] = []
    ready_paths: list[Path] = []
    cli = [
        sys.executable, str(script), command, str(source),
        "--intent-id", intent_id, "--session-id", SESSION_ID,
        "--write", "--root", str(root),
    ]
    for index in range(2):
        ready = root / f"{command}-race-{index}.ready"
        ready_paths.append(ready)
        processes.append(subprocess.Popen(
            [sys.executable, "-c", wrapper, str(gate), str(ready), *cli],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            encoding="utf-8", env=clean_env,
        ))
    deadline = time.monotonic() + 10
    while not all(path.exists() for path in ready_paths):
        if time.monotonic() >= deadline:
            for process in processes:
                process.kill()
            raise AssertionError("concurrent receipt writers did not reach the start barrier")
        time.sleep(0.005)
    gate.write_text("go", encoding="utf-8")
    results = []
    for process in processes:
        stdout, stderr = process.communicate(timeout=20)
        results.append(subprocess.CompletedProcess(
            process.args, process.returncode, stdout, stderr,
        ))
    return results


def _assert_exactly_one_race_commit(
    results: list[subprocess.CompletedProcess[str]], label: str,
) -> subprocess.CompletedProcess[str]:
    successes = [result for result in results if result.returncode == 0]
    rejects = [result for result in results if result.returncode == 2]
    if len(successes) != 1 or len(rejects) != 1:
        details = [(result.returncode, result.stdout, result.stderr) for result in results]
        raise AssertionError(f"{label} race was not exactly-once: {details}")
    return successes[0]


def _commit_while_other_writer_validates(
    script: Path, root: Path, command: str, source: Path, intent_id: str,
) -> list[subprocess.CompletedProcess[str]]:
    """Pause one real CLI after reading rows; another commits before it resumes."""
    ready = root / f"{command}-snapshot.ready"
    release = root / f"{command}-snapshot.release"
    wrapper = (
        "import pathlib,runpy,sys,time\n"
        "script,ready,release,*args=sys.argv[1:]\n"
        "sys.path.insert(0,str(pathlib.Path(script).parent))\n"
        "import comment_cli_support as support\n"
        "original=support.validate_comment_store\n"
        "paused=False\n"
        "def pause_once(*args,**kwargs):\n"
        "  global paused\n"
        "  if not paused:\n"
        "    paused=True\n"
        "    pathlib.Path(ready).write_text('rows-loaded',encoding='utf-8')\n"
        "    deadline=time.monotonic()+15\n"
        "    while not pathlib.Path(release).exists():\n"
        "      if time.monotonic()>=deadline: raise TimeoutError('snapshot race release expired')\n"
        "      time.sleep(0.005)\n"
        "  return original(*args,**kwargs)\n"
        "support.validate_comment_store=pause_once\n"
        "sys.argv=[script,*args]\n"
        "runpy.run_path(script,run_name='__main__')\n"
    )
    cli = [command, str(source), "--intent-id", intent_id, "--session-id", SESSION_ID,
           "--write", "--root", str(root)]
    delayed = subprocess.Popen(
        [sys.executable, "-c", wrapper, str(script), str(ready), str(release), *cli],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
    )
    try:
        deadline = time.monotonic() + 10
        while not ready.exists():
            if delayed.poll() is not None or time.monotonic() >= deadline:
                raise AssertionError("receipt writer did not reach its loaded-snapshot barrier")
            time.sleep(0.005)
        winner = run_cli(
            script, root, command, str(source), "--intent-id", intent_id,
            "--session-id", SESSION_ID, "--write",
        )
        release.write_text("committed", encoding="utf-8")
        stdout, stderr = delayed.communicate(timeout=20)
        loser = subprocess.CompletedProcess(delayed.args, delayed.returncode, stdout, stderr)
        return [winner, loser]
    finally:
        if delayed.poll() is None:
            delayed.kill()
            delayed.communicate(timeout=5)


def check_receipt_snapshot_revision_race() -> None:
    """A stale capability snapshot must not adopt another writer's fresh revision."""
    with tempfile.TemporaryDirectory(prefix="social-receipt-snapshot-race-") as raw:
        root = Path(raw)
        script, adapter, action, claim = approved_browser_send(root, "facebook")
        adapter.click_submit("verified")
        state = intent_state(root, action["intent_id"])
        source = root / "finish-snapshot.json"
        write_json(source, {
            "provenance": claim["receipt_capability"],
            "receipt": result_for(action, adapter, state["attempt"]["browser_preflight_id"]),
        })
        before = _snapshot(root)
        results = _commit_while_other_writer_validates(
            script, root, "browser-finish", source, action["intent_id"],
        )
        _assert_exactly_one_race_commit(results, "finish snapshot/revision")
        if "comment store changed after validation" not in results[1].stderr:
            raise AssertionError("stale capability view did not retain its original store revision")
        after = _snapshot(root)
        if len(after["data/reply_events.jsonl"].splitlines()) != len(before["data/reply_events.jsonl"].splitlines()) + 1:
            raise AssertionError("ordered receipt race must append exactly one finish event")
        for name in ("data/comment_events.jsonl", "data/browser_scan_requests.jsonl"):
            if after[name] != before[name]:
                raise AssertionError("ordered receipt race changed an unrelated ledger")

    with tempfile.TemporaryDirectory(prefix="social-reconcile-snapshot-race-") as raw:
        root = Path(raw)
        script, action, _finish_capability, capability, base, source = _begin_reconcile_case(root)
        write_json(source, {"provenance": capability, "receipt": base})
        before = _snapshot(root)
        results = _commit_while_other_writer_validates(
            script, root, "browser-reconcile", source, action["intent_id"],
        )
        _assert_exactly_one_race_commit(results, "reconcile snapshot/revision")
        if "comment store changed after validation" not in results[1].stderr:
            raise AssertionError("stale reconcile capability adopted another writer's revision")
        after = _snapshot(root)
        if len(after["data/reply_events.jsonl"].splitlines()) != len(before["data/reply_events.jsonl"].splitlines()) + 1:
            raise AssertionError("ordered reconcile race must append exactly one terminal event")
        if intent_state(root, action["intent_id"])["status"] != "reconciled_not_sent":
            raise AssertionError("ordered reconcile winner did not close its original attempt")
        for name in ("data/comment_events.jsonl", "data/browser_scan_requests.jsonl"):
            if after[name] != before[name]:
                raise AssertionError("ordered reconcile race changed an unrelated ledger")


def _assert_finish_expiry_boundary(
    envelope: dict, state: dict,
) -> None:
    attempt = state["attempt"]
    exact_expiry = datetime.fromisoformat(
        attempt["browser_finish_capability_expires_at"]
    )
    try:
        consume_receipt_envelope(
            envelope,
            "browser-finish",
            build_receipt_binding("browser-finish", attempt),
            attempt,
            now=exact_expiry,
        )
    except ValueError as exc:
        if "receipt capability expired" not in str(exc):
            raise AssertionError(
                f"exact-expiry finish gave the wrong error: {exc}"
            ) from exc
    else:
        raise AssertionError("finish capability was accepted at exact expiry")


def check_finish_provenance_and_replay() -> None:
    with tempfile.TemporaryDirectory(prefix="social-finish-provenance-") as raw:
        root = Path(raw)
        script, adapter, action, claim = approved_browser_send(root, "instagram")
        capability = claim["receipt_capability"]
        adapter.click_submit("verified")
        state = intent_state(root, action["intent_id"])
        receipt = result_for(
            action, adapter, state["attempt"]["browser_preflight_id"],
        )
        source = root / "finish-provenance.json"

        # A structurally valid browser receipt is still forged without the bearer boundary.
        write_json(source, receipt)
        _assert_rejected_unchanged(
            script, root, "browser-finish", source, action["intent_id"],
            "raw forged finish JSON mutated a ledger",
        )

        forged_capability = dict(capability, nonce="z" * 43)
        write_json(source, provenance_envelope(
            root, action["intent_id"], "browser-finish", receipt,
            capability=forged_capability,
        ))
        _assert_rejected_unchanged(
            script, root, "browser-finish", source, action["intent_id"],
            "forged finish nonce mutated a ledger",
        )

        for label, changed in (
            ("action", dict(receipt, action_id="wrong-action")),
            ("session", dict(receipt, session_id="wrong-session")),
            ("scope", dict(receipt, scope={**receipt["scope"], "post_key": "wrong-post"})),
        ):
            write_json(source, provenance_envelope(
                root, action["intent_id"], "browser-finish", changed,
                capability=capability,
            ))
            _assert_rejected_unchanged(
                script, root, "browser-finish", source, action["intent_id"],
                f"wrong finish {label} mutated a ledger",
            )

        envelope = provenance_envelope(
            root, action["intent_id"], "browser-finish", receipt,
            capability=capability,
        )
        _assert_finish_expiry_boundary(envelope, state)
        write_json(source, envelope)
        completed = run_cli(
            script, root, "browser-finish", str(source),
            "--intent-id", action["intent_id"], "--session-id", SESSION_ID, "--write",
        )
        committed = capture_receipt_commit(root, action["intent_id"], completed.stdout)
        if committed["outcome"] != "sent":
            raise AssertionError("valid finish capability did not commit sent evidence")
        if intent_state(root, action["intent_id"])["status"] != "sent_verified":
            raise AssertionError("positive finish provenance did not reach sent_verified")
        _assert_bearer_not_persisted(root, capability)

        # The exact accepted envelope is a replay after the atomic state transition.
        before_replay = _snapshot(root)
        run_cli(
            script, root, "browser-finish", str(source),
            "--intent-id", action["intent_id"], "--session-id", SESSION_ID,
            "--write", expected=2,
        )
        if _snapshot(root) != before_replay:
            raise AssertionError("finish capability replay mutated a ledger")


def _begin_reconcile_case(
    root: Path,
) -> tuple[Path, dict, dict, dict, dict, Path]:
    script, adapter, action, claim = approved_browser_send(root, "threads")
    finish_capability = claim["receipt_capability"]
    adapter.click_submit("ambiguous")
    state = intent_state(root, action["intent_id"])
    finish_receipt = result_for(
        action, adapter, state["attempt"]["browser_preflight_id"],
    )
    finish_source = root / "uncertain-finish.json"
    write_json(finish_source, {
        "provenance": finish_capability,
        "receipt": finish_receipt,
    })
    finished = run_cli(
        script, root, "browser-finish", str(finish_source),
        "--intent-id", action["intent_id"], "--session-id", SESSION_ID, "--write",
    )
    finish_commit = capture_receipt_commit(
        root, action["intent_id"], finished.stdout,
    )
    reconcile_capability = finish_commit["next_capability"]
    if finish_commit["outcome"] != "unknown" or not reconcile_capability:
        raise AssertionError("uncertain finish did not issue a reconcile capability")
    state = intent_state(root, action["intent_id"])
    base = reinspection_for(action, state["attempt"], found=False)
    return (
        script, action, finish_capability, reconcile_capability,
        base, root / "reconcile-provenance.json",
    )


def _rotate_reconcile_capability(
    script: Path, root: Path, source: Path, action: dict,
    reconcile_capability: dict, base: dict,
) -> dict:
    uncertain = dict(
        base, absence_verified=False, own_author_reply_count=1,
        reinspection_total_reply_count=1,
    )
    write_json(source, {
        "provenance": reconcile_capability,
        "receipt": uncertain,
    })
    accepted = run_cli(
        script, root, "browser-reconcile", str(source),
        "--intent-id", action["intent_id"], "--session-id", SESSION_ID, "--write",
    )
    commit = capture_receipt_commit(root, action["intent_id"], accepted.stdout)
    rotated = commit["next_capability"]
    if commit["outcome"] != "unknown" or not rotated:
        raise AssertionError("uncertain reinspection did not rotate its capability")
    current = intent_state(root, action["intent_id"])
    if current["status"] != "needs_reconcile":
        raise AssertionError("uncertain reinspection changed the send disposition")
    if current["last_event"]["event_type"] != "browser_reinspection_observed":
        raise AssertionError("uncertain reinspection was not retained as an audit event")
    before_replay = _snapshot(root)
    run_cli(
        script, root, "browser-reconcile", str(source),
        "--intent-id", action["intent_id"], "--session-id", SESSION_ID,
        "--write", expected=2,
    )
    if _snapshot(root) != before_replay:
        raise AssertionError("reconcile capability replay mutated a ledger")
    return rotated


def check_reconcile_rotation_and_replay() -> None:
    with tempfile.TemporaryDirectory(prefix="social-reconcile-provenance-") as raw:
        root = Path(raw)
        (
            script, action, finish_capability, reconcile_capability, base, source,
        ) = _begin_reconcile_case(root)
        write_json(source, base)
        _assert_rejected_unchanged(
            script, root, "browser-reconcile", source, action["intent_id"],
            "raw forged reinspection JSON mutated a ledger",
        )
        rotated = _rotate_reconcile_capability(
            script, root, source, action, reconcile_capability, base,
        )
        write_json(source, {"provenance": rotated, "receipt": base})
        reconciled = run_cli(
            script, root, "browser-reconcile", str(source),
            "--intent-id", action["intent_id"], "--session-id", SESSION_ID, "--write",
        )
        final_commit = capture_receipt_commit(
            root, action["intent_id"], reconciled.stdout,
        )
        if final_commit["outcome"] != "not-sent":
            raise AssertionError("rotated reconcile capability did not commit absence")
        if intent_state(root, action["intent_id"])["status"] != "reconciled_not_sent":
            raise AssertionError("positive reconcile provenance did not close the attempt")
        _assert_bearer_not_persisted(
            root, finish_capability, reconcile_capability, rotated,
        )


def check_concurrent_receipt_replay_is_exactly_once() -> None:
    with tempfile.TemporaryDirectory(prefix="social-finish-race-") as raw:
        root = Path(raw)
        script, adapter, action, claim = approved_browser_send(root, "facebook")
        adapter.click_submit("verified")
        state = intent_state(root, action["intent_id"])
        receipt = result_for(
            action, adapter, state["attempt"]["browser_preflight_id"],
        )
        source = root / "finish-race.json"
        write_json(source, {
            "provenance": claim["receipt_capability"], "receipt": receipt,
        })
        before = _snapshot(root)
        before_reply_rows = before["data/reply_events.jsonl"].splitlines()
        winner = _assert_exactly_one_race_commit(
            _race_receipt_commit(
                script, root, "browser-finish", source, action["intent_id"],
            ),
            "finish capability",
        )
        commit = capture_receipt_commit(root, action["intent_id"], winner.stdout)
        if commit["outcome"] != "sent":
            raise AssertionError("concurrent finish winner did not record sent evidence")
        after = _snapshot(root)
        if after["data/comment_events.jsonl"] != before["data/comment_events.jsonl"]:
            raise AssertionError("concurrent finish race changed the comment ledger")
        if after["data/browser_scan_requests.jsonl"] != before["data/browser_scan_requests.jsonl"]:
            raise AssertionError("concurrent finish race changed the scan ledger")
        if len(after["data/reply_events.jsonl"].splitlines()) != len(before_reply_rows) + 1:
            raise AssertionError("concurrent finish race appended other than one reply event")
        if intent_state(root, action["intent_id"])["status"] != "sent_verified":
            raise AssertionError("concurrent finish race did not close as sent_verified")

    with tempfile.TemporaryDirectory(prefix="social-reconcile-race-") as raw:
        root = Path(raw)
        (
            script, action, _finish_capability, reconcile_capability, base, source,
        ) = _begin_reconcile_case(root)
        write_json(source, {"provenance": reconcile_capability, "receipt": base})
        before = _snapshot(root)
        before_reply_rows = before["data/reply_events.jsonl"].splitlines()
        winner = _assert_exactly_one_race_commit(
            _race_receipt_commit(
                script, root, "browser-reconcile", source, action["intent_id"],
            ),
            "reconcile capability",
        )
        commit = capture_receipt_commit(root, action["intent_id"], winner.stdout)
        if commit["outcome"] != "not-sent":
            raise AssertionError("concurrent reconcile winner did not record absence")
        after = _snapshot(root)
        if after["data/comment_events.jsonl"] != before["data/comment_events.jsonl"]:
            raise AssertionError("concurrent reconcile race changed the comment ledger")
        if after["data/browser_scan_requests.jsonl"] != before["data/browser_scan_requests.jsonl"]:
            raise AssertionError("concurrent reconcile race changed the scan ledger")
        if len(after["data/reply_events.jsonl"].splitlines()) != len(before_reply_rows) + 1:
            raise AssertionError("concurrent reconcile race appended other than one reply event")
        if intent_state(root, action["intent_id"])["status"] != "reconciled_not_sent":
            raise AssertionError("concurrent reconcile race did not close as reconciled_not_sent")


def run_browser_receipt_provenance_tests() -> None:
    check_finish_provenance_and_replay()
    check_reconcile_rotation_and_replay()
    check_concurrent_receipt_replay_is_exactly_once()
    check_receipt_snapshot_revision_race()


if __name__ == "__main__":
    run_browser_receipt_provenance_tests()
    print("comment browser receipt provenance test passed")

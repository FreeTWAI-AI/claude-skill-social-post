#!/usr/bin/env python3
"""Dry-run, write-gate, authorization, and Unicode CLI tests."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from comment_test_support import POLICY, ROOT, sample_comment


def run_cli(
    script: Path, root: Path, *args: str, expected: int = 0,
) -> subprocess.CompletedProcess[str]:
    clean_env = os.environ.copy()
    for name in ("PYTHONIOENCODING", "PYTHONUTF8", "PYTHONLEGACYWINDOWSSTDIO"):
        clean_env.pop(name, None)
    completed = subprocess.run(
        [sys.executable, str(script), *args, "--root", str(root)],
        capture_output=True, text=True, encoding="utf-8", check=False, env=clean_env,
    )
    if completed.returncode != expected:
        raise AssertionError(
            f"comment CLI returned {completed.returncode}, expected {expected}: "
            f"{completed.stdout} {completed.stderr}"
        )
    return completed


def prepare_cli_fixture(
    root: Path, *, live_browser_actuation_enabled: bool = False,
) -> tuple[Path, Path]:
    (root / "data").mkdir()
    (root / "references").mkdir()
    (root / "data" / "comment_events.jsonl").write_text("", encoding="utf-8")
    (root / "data" / "reply_events.jsonl").write_text("", encoding="utf-8")
    fixture_policy = dict(POLICY)
    fixture_policy["live_browser_actuation_enabled"] = live_browser_actuation_enabled
    (root / "references" / "comment-policy.json").write_text(
        json.dumps(fixture_policy), encoding="utf-8",
    )
    source = root / "comment.json"
    source.write_text(
        json.dumps(sample_comment("cli", observed_at="2026-01-01T00:00:00+08:00")),
        encoding="utf-8",
    )
    return ROOT / "scripts" / "comment_assistant.py", source


def ingest_cli_fixture(script: Path, root: Path, source: Path) -> dict:
    dry = run_cli(script, root, "ingest", str(source))
    comment_path = root / "data" / "comment_events.jsonl"
    if "DRY_RUN valid" not in dry.stdout or comment_path.read_text(encoding="utf-8"):
        raise AssertionError("ingest dry-run failed or mutated the ledger")
    written = run_cli(script, root, "ingest", str(source), "--write")
    rows = comment_path.read_text(encoding="utf-8").splitlines()
    if "WRITE_OK" not in written.stdout or len(rows) != 1:
        raise AssertionError("ingest did not append exactly one observation")
    return json.loads(rows[0])


def draft_cli_fixture(script: Path, root: Path, comment: dict) -> tuple[Path, str]:
    args = (
        "draft", "--comment-key", comment["comment_key"], "--session-id", "session-cli",
        "--text", "謝謝你喜歡這支影片！", "--classification", "positive_reaction",
        "--risk", "low", "--confidence", "0.99", "--language", "zh-Hant",
    )
    reply_path = root / "data" / "reply_events.jsonl"
    dry = run_cli(script, root, *args)
    if "DRY_RUN valid" not in dry.stdout or reply_path.read_text(encoding="utf-8"):
        raise AssertionError("draft dry-run failed or mutated the ledger")
    run_cli(script, root, *args, "--write")
    row = json.loads(reply_path.read_text(encoding="utf-8").splitlines()[0])
    return reply_path, row["intent_id"]


def assert_cli_rejected_without_mutation(
    script: Path, root: Path, reply_path: Path, *args: str,
) -> None:
    before = reply_path.read_text(encoding="utf-8")
    run_cli(script, root, *args, expected=2)
    if reply_path.read_text(encoding="utf-8") != before:
        raise AssertionError(f"rejected CLI command mutated the ledger: {args}")


def check_cli_dry_run_and_write_gate() -> None:
    with tempfile.TemporaryDirectory(prefix="social-comment-cli-") as raw:
        root = Path(raw)
        script, source = prepare_cli_fixture(root)
        comment = ingest_cli_fixture(script, root, source)
        reply_path, intent_id = draft_cli_fixture(script, root, comment)
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "batch_confirm", "--session-id", "session-cli", "--write",
        )
        assert_cli_rejected_without_mutation(
            script, root, reply_path, "begin-send", "--intent-id", intent_id,
            "--session-id", "wrong-session", "--write",
        )
        run_cli(
            script, root, "begin-send", "--intent-id", intent_id,
            "--session-id", "session-cli", "--write",
        )
        assert_cli_rejected_without_mutation(
            script, root, reply_path, "begin-send", "--intent-id", intent_id,
            "--session-id", "session-cli", "--write",
        )
        assert_cli_rejected_without_mutation(
            script, root, reply_path, "finish-send", "--intent-id", intent_id,
            "--result", "sent", "--session-id", "session-cli", "--write",
        )
        run_cli(
            script, root, "finish-send", "--intent-id", intent_id, "--result", "sent",
            "--evidence", "exact reply visible under target comment",
            "--session-id", "session-cli", "--write",
        )
        assert_cli_rejected_without_mutation(
            script, root, reply_path, "finish-send", "--intent-id", intent_id,
            "--result", "sent", "--evidence", "duplicate attempt",
            "--session-id", "session-cli", "--write",
        )
        event_types = [
            json.loads(row)["event_type"]
            for row in reply_path.read_text(encoding="utf-8").splitlines()
        ]
        if event_types != ["drafted", "approved", "send_started", "sent_verified"]:
            raise AssertionError(f"unexpected CLI lifecycle: {event_types}")
        if json.loads(run_cli(script, root, "queue", "--format", "json").stdout)["items"]:
            raise AssertionError("verified CLI reply remained in the pending queue")
        if not json.loads(run_cli(script, root, "validate").stdout)["valid"]:
            raise AssertionError("CLI lifecycle ended with an invalid store")


def check_cli_bounded_auto_requires_grant() -> None:
    with tempfile.TemporaryDirectory(prefix="social-comment-cli-grant-") as raw:
        root = Path(raw)
        script, source = prepare_cli_fixture(root)
        comment = ingest_cli_fixture(script, root, source)
        reply_path, intent_id = draft_cli_fixture(script, root, comment)
        assert_cli_rejected_without_mutation(
            script, root, reply_path, "approve", "--intent-id", intent_id,
            "--approval-mode", "bounded_auto", "--session-id", "session-cli", "--write",
        )
        run_cli(
            script, root, "grant-auto", "--session-id", "session-cli",
            "--platform", comment["platform"], "--account-key", comment["account_key"],
            "--post-key", comment["post_key"], "--maximum-actions", "1", "--write",
        )
        events = [json.loads(row) for row in reply_path.read_text(encoding="utf-8").splitlines()]
        grants = [event for event in events if event["event_type"] == "session_granted"]
        if len(grants) != 1:
            raise AssertionError(f"grant-auto did not append one session grant: {events}")
        run_cli(
            script, root, "approve", "--intent-id", intent_id,
            "--approval-mode", "bounded_auto", "--grant-id", grants[0]["grant_id"],
            "--session-id", "session-cli", "--write",
        )
        final_events = [
            json.loads(row) for row in reply_path.read_text(encoding="utf-8").splitlines()
        ]
        if [event["event_type"] for event in final_events] != [
            "drafted", "session_granted", "approved",
        ]:
            raise AssertionError(f"unexpected bounded-auto authorization lifecycle: {final_events}")
        approval = final_events[-1]
        if approval.get("authorization_basis") != "current_session_user_instruction":
            raise AssertionError("bounded-auto approval lost its current-session authorization basis")
        if approval.get("grant_id") != grants[0]["grant_id"]:
            raise AssertionError("bounded-auto approval was not bound to its grant")


def check_cli_emoji_without_encoding_environment() -> None:
    with tempfile.TemporaryDirectory(prefix="social-comment-cli-emoji-") as raw:
        root = Path(raw)
        script, source = prepare_cli_fixture(root)
        emoji_comment = sample_comment(
            "emoji-cli", body="太棒了🔥", observed_at="2026-01-01T00:00:00+08:00",
        )
        source.write_text(json.dumps(emoji_comment, ensure_ascii=False), encoding="utf-8")
        completed = run_cli(script, root, "ingest", str(source))
        if "🔥" not in completed.stdout or "DRY_RUN valid" not in completed.stdout:
            raise AssertionError("emoji-safe CLI output depends on external encoding environment")


def run_cli_tests() -> None:
    check_cli_dry_run_and_write_gate()
    check_cli_bounded_auto_requires_grant()
    check_cli_emoji_without_encoding_environment()

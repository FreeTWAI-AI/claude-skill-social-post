#!/usr/bin/env python3
"""Shared I/O, validation, and console helpers for the comment CLI."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from comment_state import validate_comment_store
from comment_store import comment_store_revision, commit_comment_records, load_comment_records


SKILL_ROOT = Path(__file__).resolve().parents[1]
POLICY_FILE = SKILL_ROOT / "references" / "comment-policy.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def configure_utf8_streams() -> None:
    """Keep emoji-safe CLI output on Windows consoles that default to CP950."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def load_policy(root: Path = SKILL_ROOT) -> dict[str, Any]:
    path = root / "references" / POLICY_FILE.name
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("comment policy must be a JSON object")
    return value


def load_state(
    root: Path = SKILL_ROOT,
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any], dict[str, Any]]:
    records = load_comment_records(root / "data")
    policy = load_policy(root)
    result = validate_comment_store(records["comments"], records["replies"], policy)
    result["revision"] = comment_store_revision(root / "data")
    result["counts"] = {
        "comment_events": len(records["comments"]),
        "reply_events": len(records["replies"]),
        "comments": len(result["latest_comments"]),
        "active_intents": len(result["reply_states"]),
        "authorization_grants": len(result.get("authorization_grants", {})),
    }
    return records, policy, result


def require_valid(result: dict[str, Any]) -> None:
    if not result["valid"]:
        raise ValueError("comment store is invalid: " + "; ".join(result["errors"]))


def validate_staged(
    records: dict[str, list[dict[str, Any]]], policy: dict[str, Any],
) -> dict[str, Any]:
    result = validate_comment_store(records["comments"], records["replies"], policy)
    require_valid(result)
    return result


def commit_or_preview(
    records: dict[str, list[dict[str, Any]]], policy: dict[str, Any], base_revision: str,
    payload: Any, *, root: Path, write: bool,
) -> None:
    validate_staged(records, policy)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    if not write:
        print("DRY_RUN valid; add --write to commit")
        return
    new_revision = commit_comment_records(
        records, data_dir=root / "data", expected_revision=base_revision,
    )
    _records, _policy, result = load_state(root)
    require_valid(result)
    print(f"WRITE_OK revision={new_revision}")


def read_json_source(value: str) -> Any:
    if value == "-":
        return json.load(sys.stdin)
    return json.loads(Path(value).read_text(encoding="utf-8-sig"))


def intent_state(
    states: dict[str, dict[str, Any]], intent_id: str,
) -> tuple[str, dict[str, Any]]:
    found = [(key, state) for key, state in states.items() if state.get("intent_id") == intent_id]
    if len(found) != 1:
        raise ValueError(f"expected one active intent_id {intent_id}, found {len(found)}")
    return found[0]

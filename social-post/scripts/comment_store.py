#!/usr/bin/env python3
"""Append-only, optimistic comment ledger storage independent from outcome data."""

from __future__ import annotations

import hashlib
import shutil
import tempfile
from pathlib import Path
from typing import Any

from social_store import exclusive_store_lock, load_jsonl, write_jsonl


COMMENT_FILENAMES = ("comment_events.jsonl", "reply_events.jsonl")


def comment_store_revision(data_dir: Path) -> str:
    digest = hashlib.sha256()
    for name in COMMENT_FILENAMES:
        path = data_dir / name
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        if path.exists():
            digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def load_comment_records(data_dir: Path) -> dict[str, list[dict[str, Any]]]:
    return {
        "comments": load_jsonl(data_dir / COMMENT_FILENAMES[0]),
        "replies": load_jsonl(data_dir / COMMENT_FILENAMES[1]),
    }


def commit_comment_records(
    records: dict[str, list[dict[str, Any]]], *, data_dir: Path, expected_revision: str,
) -> str:
    destinations = {
        "comments": data_dir / COMMENT_FILENAMES[0],
        "replies": data_dir / COMMENT_FILENAMES[1],
    }
    with exclusive_store_lock(data_dir):
        current = comment_store_revision(data_dir)
        if current != expected_revision:
            raise RuntimeError(
                "comment store changed after validation; rescan before retrying "
                f"(expected {expected_revision[:12]}, found {current[:12]})"
            )
        originals = {
            destination: destination.read_bytes() if destination.exists() else None
            for destination in destinations.values()
        }
        data_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="social-comment-commit-", dir=data_dir.parent) as raw:
            staging = Path(raw)
            staged = {}
            for name, destination in destinations.items():
                path = staging / destination.name
                write_jsonl(path, records[name])
                staged[destination] = path
            try:
                for destination, source in staged.items():
                    temporary = destination.with_suffix(destination.suffix + ".tmp")
                    shutil.copyfile(source, temporary)
                    temporary.replace(destination)
            except OSError:
                for destination, original in originals.items():
                    if original is None:
                        destination.unlink(missing_ok=True)
                    else:
                        destination.write_bytes(original)
                raise
    return comment_store_revision(data_dir)

#!/usr/bin/env python3
"""Copy the configured public allowlist without deleting public-only examples."""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "audit.config.json"
MANIFEST_NAME = ".social-post-managed.json"


def public_root(config: dict) -> Path:
    value = config.get("sync", {}).get("public_root")
    if not value:
        raise ValueError("sync.public_root is not configured")
    result = Path(value).expanduser()
    return result if result.is_absolute() else (ROOT / result).resolve()


def ignored(relative: str, patterns: list[str]) -> bool:
    normalized = relative.replace("\\", "/")
    return any(fnmatch.fnmatch(normalized, pattern) for pattern in patterns)


def candidates(config: dict, root: Path = ROOT) -> list[tuple[Path, str]]:
    included = config.get("sync", {}).get("include")
    if not isinstance(included, list) or not included or any(not isinstance(item, str) for item in included):
        raise ValueError("sync.include must be a non-empty list of path patterns")
    excluded = config.get("exclude", [])
    sync_ignored = config.get("sync", {}).get("ignore", [])
    rows = []
    unclassified = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        if ignored(relative, excluded) or ignored(relative, sync_ignored):
            continue
        if ignored(relative, included):
            rows.append((path, relative))
        else:
            unclassified.append(relative)
    if unclassified:
        preview = ", ".join(sorted(unclassified)[:10])
        suffix = " ..." if len(unclassified) > 10 else ""
        raise ValueError(
            "sync source files must be explicitly included or ignored: " + preview + suffix
        )
    return sorted(rows, key=lambda row: row[1])


def privacy_violations(rows: list[tuple[Path, str]], config: dict) -> list[str]:
    privacy = config.get("sync", {}).get("privacy", config.get("privacy", {}))
    tokens = [str(value) for value in privacy.get("tokens", []) if str(value)]
    patterns = []
    for value in privacy.get("patterns", []):
        try:
            patterns.append(re.compile(str(value), re.IGNORECASE))
        except re.error as exc:
            return [f"invalid privacy regex {value!r}: {exc}"]
    failures = []
    for source, relative in rows:
        try:
            text = source.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            continue
        lowered = text.casefold()
        for token in tokens:
            if token.casefold() in lowered:
                failures.append(f"{relative}: privacy token {token!r}")
        for pattern in patterns:
            if pattern.search(text):
                failures.append(f"{relative}: privacy pattern {pattern.pattern!r}")
    return failures


def managed_paths(destination_root: Path) -> set[str]:
    manifest = destination_root / MANIFEST_NAME
    if not manifest.exists():
        return set()
    value = json.loads(manifest.read_text(encoding="utf-8-sig"))
    paths = value.get("managed_paths") if isinstance(value, dict) else None
    if not isinstance(paths, list) or any(not isinstance(item, str) for item in paths):
        raise ValueError(f"invalid sync manifest: {manifest}")
    return set(paths)


def safe_destination(destination_root: Path, relative: str) -> Path:
    destination = (destination_root / relative).resolve()
    root = destination_root.resolve()
    if destination != root and root not in destination.parents:
        raise ValueError(f"sync path escapes public root: {relative}")
    return destination


def write_manifest(destination_root: Path, paths: list[str]) -> None:
    manifest = destination_root / MANIFEST_NAME
    temporary = manifest.with_suffix(".tmp")
    temporary.write_text(
        json.dumps({"schema_version": 1, "managed_paths": paths}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(manifest)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="Copy files. Default is dry-run.")
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
    destination_root = public_root(config)
    rows = candidates(config)
    violations = privacy_violations(rows, config)
    if violations:
        print(f"BLOCK public_root={destination_root} privacy_violations={len(violations)}")
        for violation in violations:
            print(violation)
        return 2
    current = [relative for _source, relative in rows]
    stale = sorted(managed_paths(destination_root) - set(current))
    changed = []
    for source, relative in rows:
        destination = safe_destination(destination_root, relative)
        if destination.exists() and destination.read_bytes() == source.read_bytes():
            continue
        changed.append(relative)
        if args.write:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    if args.write:
        for relative in stale:
            safe_destination(destination_root, relative).unlink(missing_ok=True)
        write_manifest(destination_root, current)
    mode = "WRITE" if args.write else "DRY_RUN"
    print(f"{mode} public_root={destination_root} changed={len(changed)} stale={len(stale)}")
    for relative in changed:
        print(relative)
    for relative in stale:
        print(f"STALE {relative}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

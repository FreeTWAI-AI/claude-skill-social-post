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
        raw = source.read_bytes()
        decoded_views = [raw.decode("utf-8-sig", errors="ignore"), raw.decode("latin-1")]
        for encoding in ("utf-16-le", "utf-16-be"):
            # Scan both alignments so a binary prefix cannot hide UTF-16 text.
            decoded_views.extend(raw[offset:].decode(encoding, errors="ignore") for offset in (0, 1))
        lowered_views = [value.casefold() for value in decoded_views]
        raw_lower = raw.lower()
        for token in tokens:
            exact_variants = [token.encode(name) for name in ("utf-8", "utf-16-le", "utf-16-be")]
            folded_variants = [token.casefold().encode(name) for name in ("utf-8", "utf-16-le", "utf-16-be")]
            byte_match = any(value in raw for value in exact_variants) or any(
                value in raw_lower for value in folded_variants
            )
            if any(token.casefold() in value for value in lowered_views) or byte_match:
                failures.append(f"{relative}: privacy token {token!r}")
        for pattern in patterns:
            if any(pattern.search(value) for value in decoded_views):
                failures.append(f"{relative}: privacy pattern {pattern.pattern!r}")
    return failures


def public_tree_rows(destination_root: Path) -> tuple[list[tuple[Path, str]], list[str]]:
    """Inventory the whole public mirror without following links outside it."""
    if not destination_root.exists():
        return [], []
    rows: list[tuple[Path, str]] = []
    failures: list[str] = []
    for path in destination_root.rglob("*"):
        relative = path.relative_to(destination_root).as_posix()
        if relative == ".git" or relative.startswith(".git/"):
            continue
        is_junction = bool(getattr(path, "is_junction", lambda: False)())
        if path.is_symlink() or is_junction:
            failures.append(f"public/{relative}: linked public path is not allowed")
            continue
        if path.is_file():
            rows.append((path, f"public/{relative}"))
    return sorted(rows, key=lambda row: row[1]), sorted(failures)


def managed_paths(destination_root: Path) -> set[str]:
    manifest = destination_root / MANIFEST_NAME
    if not manifest.exists():
        return set()
    value = json.loads(manifest.read_text(encoding="utf-8-sig"))
    paths = value.get("managed_paths") if isinstance(value, dict) else None
    if not isinstance(paths, list) or any(not isinstance(item, str) for item in paths):
        raise ValueError(f"invalid sync manifest: {manifest}")
    return set(paths)


def forbidden_public_paths(config: dict) -> set[str]:
    """Return exact private-only paths that must not survive in the public mirror."""
    values = config.get("sync", {}).get("forbid_public", [])
    if not isinstance(values, list) or any(not isinstance(item, str) for item in values):
        raise ValueError("sync.forbid_public must be a list of exact relative paths")
    result: set[str] = set()
    for raw in values:
        relative = raw.replace("\\", "/").strip("/")
        if not relative or relative == MANIFEST_NAME or any(char in relative for char in "*?["):
            raise ValueError(f"invalid exact sync.forbid_public path: {raw!r}")
        if relative == ".git" or relative.startswith(".git/"):
            raise ValueError("sync.forbid_public cannot target .git")
        result.add(relative)
    return result


def public_generated_cache_paths(config: dict) -> set[str]:
    """Return exact, explicitly configured generated-cache directories."""
    values = config.get("sync", {}).get("purge_public_generated", [])
    if not isinstance(values, list) or any(not isinstance(item, str) for item in values):
        raise ValueError("sync.purge_public_generated must be a list of exact relative paths")
    result: set[str] = set()
    for raw in values:
        relative = raw.replace("\\", "/").strip("/")
        if (
            not relative
            or relative == MANIFEST_NAME
            or any(char in relative for char in "*?[")
            or Path(relative).name != "__pycache__"
        ):
            raise ValueError(f"invalid exact sync.purge_public_generated path: {raw!r}")
        if relative == ".git" or relative.startswith(".git/"):
            raise ValueError("sync.purge_public_generated cannot target .git")
        result.add(relative)
    return result


def safe_destination(destination_root: Path, relative: str) -> Path:
    destination = (destination_root / relative).resolve()
    root = destination_root.resolve()
    if destination != root and root not in destination.parents:
        raise ValueError(f"sync path escapes public root: {relative}")
    return destination


def purge_public_generated(destination_root: Path, config: dict) -> list[str]:
    """Remove only configured, in-root Python cache directories."""
    removed: list[str] = []
    for relative in sorted(public_generated_cache_paths(config)):
        destination = safe_destination(destination_root, relative)
        if not destination.exists():
            continue
        is_junction = bool(getattr(destination, "is_junction", lambda: False)())
        if destination.is_symlink() or is_junction or not destination.is_dir():
            raise ValueError(f"invalid generated-cache target: {relative}")
        shutil.rmtree(destination)
        removed.append(relative)
    return removed


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
    removed_generated: list[str] = []
    if args.write:
        try:
            removed_generated = purge_public_generated(destination_root, config)
        except ValueError as exc:
            print(f"BLOCK public_root={destination_root} generated_cache_error={exc}")
            return 2
    public_rows, public_tree_failures = public_tree_rows(destination_root)
    violations.extend(public_tree_failures)
    violations.extend(privacy_violations(public_rows, config))
    if violations:
        print(f"BLOCK public_root={destination_root} privacy_violations={len(violations)}")
        for violation in violations:
            print(violation)
        return 2
    current = [relative for _source, relative in rows]
    forbidden = forbidden_public_paths(config)
    forbidden_existing = set()
    for relative in forbidden:
        destination = safe_destination(destination_root, relative)
        if destination.exists():
            if not destination.is_file() or destination.is_symlink():
                print(f"BLOCK public_root={destination_root} invalid_forbidden_target={relative}")
                return 2
            forbidden_existing.add(relative)
    stale = sorted((managed_paths(destination_root) - set(current)) | forbidden_existing)
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
    for relative in removed_generated:
        print(f"REMOVED_GENERATED {relative}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

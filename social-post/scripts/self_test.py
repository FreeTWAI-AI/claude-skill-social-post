#!/usr/bin/env python3
"""Smoke-test structured outcomes and generated archives."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from build_rule_registry import build
from comment_self_test import run_comment_self_tests
from log_outcome import prepare_records, validate_staged
from social_data import SKILL_ROOT, series_summary, validate_store
from social_store import commit_records
from sync_public import candidates, managed_paths, privacy_violations, safe_destination, write_manifest


def check_private_baseline(result: dict) -> None:
    if not result["counts"]["posts"]:
        return
    minimum_counts = {"posts": 4, "snapshots": 6, "experiments": 3}
    if any(result["counts"].get(key, 0) < value for key, value in minimum_counts.items()):
        raise AssertionError(f"outcome store lost records: {result['counts']}")
    rows = series_summary(SKILL_ROOT, "reborn-married-driver")
    by_episode = {row["episode"]: row for row in rows if row["platform"] == "combined"}
    if not {1, 2, 3}.issubset(by_episode):
        raise AssertionError("baseline episodes disappeared")
    expected_watch = {1: 61.1, 2: 38.9, 3: 41.1}
    observed = {episode: by_episode[episode]["watch_percent"] for episode in expected_watch}
    if observed != expected_watch:
        raise AssertionError("baseline derived watch percentages changed")
    beyblade_rows = series_summary(SKILL_ROOT, "beyblade-battles")
    if {row["platform"] for row in beyblade_rows} != {"facebook", "instagram", "youtube"}:
        raise AssertionError("cross-platform snapshots were collapsed")
    youtube = next(row for row in beyblade_rows if row["platform"] == "youtube")
    if youtube["watch_seconds"] is not None or youtube["watch_percent"] is not None:
        raise AssertionError("missing YouTube retention was converted to zero")
    if result["counts"].get("account_snapshots", 0) < 1:
        raise AssertionError("account-level Instagram history disappeared")


def check_registry_backlinks(result: dict) -> None:
    registry = build()
    rule_files = list((SKILL_ROOT / "references" / "rules").glob("R*.md"))
    if len(registry["rules"]) != len(rule_files):
        raise AssertionError("rule registry count differs from rule files")
    registry_by_id = {row["id"]: row for row in registry["rules"]}
    latest_experiments = result["latest_experiments"]
    if (SKILL_ROOT / "data" / "experiments.jsonl").exists():
        for rule_id, rule in registry_by_id.items():
            for experiment_id in rule.get("experiment_ids", []):
                experiment = latest_experiments.get(experiment_id)
                if experiment is None or rule_id not in experiment.get("rule_ids", []):
                    raise AssertionError(f"broken rule/experiment backlink: {rule_id} <-> {experiment_id}")
    for experiment_id, experiment in latest_experiments.items():
        for rule_id in experiment.get("rule_ids", []):
            if experiment_id not in registry_by_id[rule_id].get("experiment_ids", []):
                raise AssertionError(f"broken experiment/rule backlink: {experiment_id} <-> {rule_id}")


def check_archive_manifests() -> None:
    pairs = (("references/cases/manifest.json", "case-*.md"), ("references/rules/manifest.json", "R*.md"))
    for relative, pattern in pairs:
        manifest_path = SKILL_ROOT / relative
        if not manifest_path.exists():
            continue
        value = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        key = "cases" if "cases" in value else "rules"
        expected = len(list((SKILL_ROOT / Path(relative).parent).glob(pattern)))
        if len(value[key]) != expected:
            raise AssertionError(f"{relative} expected {expected}, found {len(value[key])}")
        for record in value[key]:
            if not (SKILL_ROOT / Path(relative).parent / record["path"]).exists():
                raise AssertionError(f"missing archived file: {record['path']}")


def sample_bundle(suffix: str) -> dict:
    post_id = f"post-{suffix}"
    return {
        "post": {"post_id": post_id, "published_at": "2026-08-13T10:00:00+08:00",
                 "platforms": ["facebook"], "caption": suffix},
        "snapshot": {"snapshot_id": f"snapshot-{suffix}", "post_id": post_id,
                     "captured_at": "2026-08-13T11:00:00+08:00", "metrics": {}},
    }


def check_concurrent_writer() -> None:
    with tempfile.TemporaryDirectory(prefix="social-post-concurrency-") as raw:
        data_dir = Path(raw) / "data"
        first, _, first_revision = prepare_records(sample_bundle("first"), data_dir)
        second, _, second_revision = prepare_records(sample_bundle("second"), data_dir)
        validate_staged(first)
        validate_staged(second)
        commit_records(first, data_dir=data_dir, expected_revision=first_revision)
        try:
            commit_records(second, data_dir=data_dir, expected_revision=second_revision)
        except RuntimeError:
            return
        raise AssertionError("stale concurrent writer was not rejected")


def check_account_snapshot() -> None:
    with tempfile.TemporaryDirectory(prefix="social-post-account-") as raw:
        data_dir = Path(raw) / "data"
        bundle = {"account_snapshot": {
            "account_snapshot_id": "ig-account-30d-test", "platform": "instagram",
            "captured_at": "2026-08-13T17:03:00+08:00", "window_days": 30,
            "metrics": {"reel_views": 100, "net_followers": 2},
        }}
        staged, _, revision = prepare_records(bundle, data_dir)
        validate_staged(staged)
        commit_records(staged, data_dir=data_dir, expected_revision=revision)


def check_append_only_corrections() -> None:
    with tempfile.TemporaryDirectory(prefix="social-post-correction-") as raw:
        root = Path(raw)
        data_dir = root / "data"
        bundle = sample_bundle("corrected")
        bundle["post"]["content_type"] = "short_video"
        bundle["snapshot"]["metrics"] = {"plays": 1200}
        bundle["correction"] = {
            "correction_id": "correction-duration-and-precision",
            "target_type": "post",
            "target_id": "post-corrected",
            "recorded_at": "2026-08-13T12:00:00+08:00",
            "changes": {"duration_seconds": 30},
            "reason": "duration confirmed from source media",
        }
        staged, _, revision = prepare_records(bundle, data_dir)
        validate_staged(staged)
        commit_records(staged, data_dir=data_dir, expected_revision=revision)
        result = validate_store(root)
        if result["posts"][0].get("duration_seconds") != 30:
            raise AssertionError("post correction was not materialized")
        raw_post = json.loads((data_dir / "posts.jsonl").read_text(encoding="utf-8"))
        if "duration_seconds" in raw_post:
            raise AssertionError("correction mutated the original post event")

        invalid = {"correction": {
            "correction_id": "correction-illegal-identity",
            "target_type": "post",
            "target_id": "post-corrected",
            "recorded_at": "2026-08-13T13:00:00+08:00",
            "changes": {"post_id": "different"},
            "reason": "negative control",
        }}
        rejected, _, _ = prepare_records(invalid, data_dir)
        try:
            validate_staged(rejected)
        except ValueError:
            pass
        else:
            raise AssertionError("identity-changing correction was accepted")


def check_metric_qualifiers() -> None:
    with tempfile.TemporaryDirectory(prefix="social-post-qualifier-") as raw:
        root = Path(raw)
        data_dir = root / "data"
        bundle = sample_bundle("rounded")
        bundle["snapshot"]["metrics"] = {"plays": 86000}
        bundle["snapshot"]["metric_qualifiers"] = {"plays": "rounded"}
        staged, _, revision = prepare_records(bundle, data_dir)
        validate_staged(staged)
        commit_records(staged, data_dir=data_dir, expected_revision=revision)
        rows = series_summary(root)
        if rows[0].get("plays_qualifier") != "rounded":
            raise AssertionError("metric precision qualifier disappeared from summary")


def check_public_sync_guard() -> None:
    with tempfile.TemporaryDirectory(prefix="social-post-public-guard-") as raw:
        root = Path(raw)
        candidate = root / "candidate.md"
        candidate.write_text("contains private-account marker", encoding="utf-8")
        config = {"sync": {"privacy": {"tokens": ["private-account"], "patterns": []}}}
        if not privacy_violations([(candidate, "candidate.md")], config):
            raise AssertionError("public sync privacy token was not blocked")
        secret_fixture = "Authorization: " + "Bearer " + "private-" + "secret-value"
        candidate.write_text(secret_fixture, encoding="utf-8")
        pattern_config = {
            "sync": {"privacy": {"tokens": [], "patterns": [
                r"(?i)Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~-]{8,}",
            ]}},
        }
        if not privacy_violations([(candidate, "candidate.md")], pattern_config):
            raise AssertionError("public sync credential-shaped pattern was not blocked")
        try:
            safe_destination(root, "../escape.txt")
        except ValueError:
            pass
        else:
            raise AssertionError("public sync accepted a path outside its root")
        write_manifest(root, ["safe.md"])
        if managed_paths(root) != {"safe.md"}:
            raise AssertionError("public sync managed manifest did not round-trip")
        (root / "safe.md").write_text("public", encoding="utf-8")
        (root / "private.jsonl").write_text('{"author":"private"}\n', encoding="utf-8")
        fixture_ignore = ["candidate.md", ".social-post-managed.json"]
        allowlist = {
            "sync": {"include": ["safe.md"], "ignore": [*fixture_ignore, "private.jsonl"]},
            "exclude": [],
        }
        if [relative for _path, relative in candidates(allowlist, root)] != ["safe.md"]:
            raise AssertionError("public sync copied a file outside the closed-world allowlist")
        try:
            candidates({
                "sync": {"include": ["safe.md"], "ignore": fixture_ignore}, "exclude": [],
            }, root)
        except ValueError:
            pass
        else:
            raise AssertionError("public sync silently accepted an unclassified private file")
        try:
            candidates({"sync": {"ignore": []}}, root)
        except ValueError:
            pass
        else:
            raise AssertionError("public sync accepted a missing include allowlist")


def main() -> int:
    result = validate_store()
    if not result["valid"]:
        raise AssertionError(result["errors"])
    check_private_baseline(result)
    check_registry_backlinks(result)
    check_archive_manifests()
    check_concurrent_writer()
    check_account_snapshot()
    check_append_only_corrections()
    check_metric_qualifiers()
    check_public_sync_guard()
    run_comment_self_tests()
    print("self-test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Isolated contract tests for target-only intake; never browser/live evidence."""

from __future__ import annotations

import argparse
from contextlib import redirect_stdout
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import tempfile
from unittest.mock import patch

from comment_browser_common import _json_digest
from comment_browser_scan_contract import (
    build_browser_scan_request, build_browser_target_completion,
    normalize_browser_scan, normalize_browser_scan_request,
    normalize_browser_target_completion, normalize_browser_target_observation,
    replay_browser_scan_requests,
)
from comment_browser_send_contract import build_browser_action
from comment_browser_target_cli import (
    command_browser_target_observation, command_browser_target_observation_request,
)
from comment_cli_support import load_state
from comment_domain import normalize_reply_event
from comment_scan_provenance import (
    consume_scan_receipt_envelope, issue_scan_receipt_capability,
    validate_scan_provenance,
)
from comment_state import validate_comment_store
from comment_store import comment_store_revision
from comment_test_support import POLICY


def _reject(call, label: str) -> None:
    try:
        call()
    except (ValueError, KeyError):
        return
    raise AssertionError(f"target observation accepted {label}")


def _fixture() -> tuple[dict, dict, dict]:
    now = datetime.now(timezone.utc)
    request = build_browser_scan_request(
        platform="instagram", account_key="creator-test", post_key="ExampleShortcode",
        post_permalink="https://www.instagram.com/reels/ExampleShortcode/",
        session_id="session-target-test", requested_at=(now - timedelta(seconds=10)).isoformat(),
        expires_at=(now + timedelta(minutes=5)).isoformat(),
        observation_scope="target_comment", target={
            "platform_comment_id": "123456789",
            "comment_permalink": "https://www.instagram.com/p/ExampleShortcode/c/123456789/",
        },
    )
    bearer, metadata = issue_scan_receipt_capability(request)
    request.update(metadata)
    return request, bearer, _receipt(request, now.isoformat())


def _receipt(request: dict, observed_at: str) -> dict:
    comment = {
        **request["target"], "observed_parent_post_permalink": request["post_permalink"],
        "author_key": "viewer-test", "author_display": "Viewer Test",
        "body": "Thank you for this episode!", "body_complete": True,
        "is_own": False, "has_own_reply": False, "language": "en",
    }
    digest = _json_digest(comment)
    return {
        "schema_version": 1, "test_only": False, "observation_scope": "target_comment",
        **{key: request[key] for key in ("scan_request_id", "session_id", "platform", "account_key", "post_key", "post_permalink")},
        "observed_url": request["target"]["comment_permalink"], "observed_at": observed_at,
        "authentication_state": "authenticated", "account_verified": True,
        "post_verified": True, "target_verified": True, "comment": comment,
        "observation_evidence": {
            "schema_version": 1, "adapter_id": "test-contract-only",
            "adapter_version": "test-only-1", "document_binding": {
                "schema_version": 1, "kind": "source_owned_ui_continuity",
                "tab_id": "isolated-test-tab", "observed_url": request["target"]["comment_permalink"],
                "target_digest": _json_digest({
                    "account_key": request["account_key"].removeprefix("@"),
                    "comment_permalink": request["target"]["comment_permalink"],
                    "author_key": comment["author_key"], "body": comment["body"],
                }),
            },
            "stable_read_count": 2, "first_read_digest": digest, "second_read_digest": digest,
        },
    }


def _contract_tests() -> None:
    request, bearer, receipt = _fixture()
    raw, consumption = consume_scan_receipt_envelope({"provenance": bearer, "receipt": receipt}, request)
    observation = normalize_browser_target_observation(raw, POLICY, request)
    completion = build_browser_target_completion(observation, request, consumption)
    replayed, errors = replay_browser_scan_requests([request, completion])
    assert not errors, errors
    assert replayed[request["scan_request_id"]]["execution_status"] == "completed"
    assert "zero_result" not in completion and "thread_expansion_evidence" not in completion
    provenance = observation["comment"]["scan_provenance"]
    assert provenance["evidence_scope"] == "target_comment_receipt_continuity_only"
    assert all(provenance[key] is False for key in (
        "whole_post_complete", "reply_thread_complete", "own_reply_absence_proven",
        "capability_promotion_eligible", "full_lifecycle_bound",
    ))
    _, replay_errors = replay_browser_scan_requests([request, completion, completion])
    assert replay_errors, "completion replay must fail"
    _reject(lambda: normalize_browser_scan(receipt, POLICY, request), "target as whole-post scan")
    for key, value in (
        ("test_only", True), ("observation_scope", "whole_post"),
        ("account_verified", False), ("post_verified", False), ("target_verified", "true"),
        ("observed_url", "https://www.instagram.com/p/ExampleShortcode/c/987654321"),
        ("session_id", "other-session"), ("whole_post_complete", True),
    ):
        bad = deepcopy(receipt); bad[key] = value
        _reject(lambda: normalize_browser_target_observation(bad, POLICY, request), key)
    for key, value in (
        ("body_complete", False), ("platform_comment_id", "987654321"),
        ("author_key", ""), ("body", "only a fragment"),
        ("comment_permalink", request["target"]["comment_permalink"] + "/r/987654321"),
    ):
        bad = deepcopy(receipt); bad["comment"][key] = value
        _reject(lambda: normalize_browser_target_observation(bad, POLICY, request), "comment " + key)
    for key, value in (("stable_read_count", True), ("second_read_digest", "0" * 64), ("document_binding", None)):
        bad = deepcopy(receipt); bad["observation_evidence"][key] = value
        _reject(lambda: normalize_browser_target_observation(bad, POLICY, request), "evidence " + key)
    for key, value in (("schema_version", True), ("kind", "physical_document_epoch"), ("tab_id", ""),
                       ("observed_url", "https://www.instagram.com/p/Other/c/123456789"),
                       ("target_digest", "0" * 64)):
        bad = deepcopy(receipt); bad["observation_evidence"]["document_binding"][key] = value
        _reject(lambda: normalize_browser_target_observation(bad, POLICY, request), "document binding " + key)
    bad = deepcopy(receipt)
    bad["observation_evidence"]["document_epoch"] = 1234567
    _reject(lambda: normalize_browser_target_observation(bad, POLICY, request), "invented document epoch")
    for key, value in (("whole_post_complete", True), ("reply_thread_complete", True), ("zero_result", False)):
        bad = deepcopy(completion); bad[key] = value
        _reject(lambda: normalize_browser_target_completion(bad, request), "completion " + key)
    for key, value in (("whole_post_complete", True), ("reply_thread_complete", True), ("exhaustion_digest", "a" * 64)):
        bad = deepcopy(provenance); bad[key] = value
        bad["provenance_digest"] = _json_digest({k: v for k, v in bad.items() if k != "provenance_digest"})
        _reject(lambda: validate_scan_provenance(bad), "rehash promotion " + key)
    bad_request = deepcopy(request); bad_request["target"]["platform_comment_id"] = "999"
    _reject(lambda: normalize_browser_scan_request(bad_request), "request target mutation")
    bad_bearer = deepcopy(bearer); bad_bearer["nonce"] = "a" * 43
    _reject(lambda: consume_scan_receipt_envelope({"provenance": bad_bearer, "receipt": receipt}, request), "forged bearer")
    expired_now = datetime.fromisoformat(request["expires_at"]) + timedelta(seconds=1)
    _reject(lambda: consume_scan_receipt_envelope({"provenance": bearer, "receipt": receipt}, request, now=expired_now), "expired bearer")
    # Drafts retain the target-only source digest and can reach an approved action;
    # this does not create a live submit permit or prove reply-thread completeness.
    comment = observation["comment"]
    now = datetime.now(timezone.utc).isoformat()
    draft = normalize_reply_event({
        "event_type": "drafted", "comment_key": comment["comment_key"],
        "occurred_at": now, "session_id": request["session_id"],
        "reply_text": "Thank you!", "classification": "gratitude", "risk": "low",
        "confidence": 0.99, "language": "en", "policy_version": POLICY["policy_version"],
    }, {comment["comment_key"]: comment})
    approval = normalize_reply_event({
        "event_type": "approved", "comment_key": comment["comment_key"],
        "intent_id": draft["intent_id"], "occurred_at": now,
        "session_id": request["session_id"], "approval_mode": "batch_confirm",
        "authorization_basis": "batch_confirm_user_confirmation", "permit_id": "test-permit",
        "expires_at": request["expires_at"], "one_shot": True, "reply_hash": draft["reply_hash"],
        "scope": {key: comment[key] for key in ("platform", "account_key", "post_key", "comment_key")},
    }, {comment["comment_key"]: comment})
    state = validate_comment_store([comment], [draft, approval], POLICY)
    assert state["valid"], state["errors"]
    action = build_browser_action(state["latest_comments"], state["reply_states"], draft["intent_id"], request["session_id"])
    assert action["scan_provenance_digest"] == provenance["provenance_digest"]
    assert action["observation_scope"] == "target_comment"
    assert action["observation_target"] == request["target"]


def _isolated_cli_tests() -> None:
    with tempfile.TemporaryDirectory(prefix="social-target-contract-") as raw_root:
        root = Path(raw_root)
        (root / "references").mkdir()
        policy = {**POLICY, "live_browser_scan_enabled": True, "live_browser_actuation_enabled": False}
        (root / "references" / "comment-policy.json").write_text(json.dumps(policy), encoding="utf-8")
        args = argparse.Namespace(
            root=root, write=True, internal_fused=True, ttl_minutes=5,
            platform="instagram", account_key="creator-test", post_key="ExampleShortcode",
            post_permalink="https://www.instagram.com/reels/ExampleShortcode",
            platform_comment_id="123456789", comment_permalink="https://www.instagram.com/p/ExampleShortcode/c/123456789",
            session_id="session-isolated-target",
        )
        out = io.StringIO()
        with redirect_stdout(out):
            command_browser_target_observation_request(args)
        issued = json.loads(next(line.split(" ", 1)[1] for line in out.getvalue().splitlines() if line.startswith("INTERNAL_SCAN_CAPABILITY ")))
        request = issued["scan_request"]
        receipt = _receipt(request, datetime.now(timezone.utc).isoformat())
        envelope = {"provenance": issued["receipt_capability"], "receipt": receipt}
        commit_args = argparse.Namespace(root=root, write=True, source="-", scan_request_id=request["scan_request_id"], session_id=args.session_id)
        with patch("comment_browser_target_cli.read_json_source", return_value=envelope), redirect_stdout(io.StringIO()):
            command_browser_target_observation(commit_args)
        records, _, result = load_state(root)
        assert result["valid"], result["errors"]
        assert len(records["comments"]) == 1 and len(records["replies"]) == 0
        assert len(records["scan_requests"]) == 2
        revision = comment_store_revision(root / "data")
        with patch("comment_browser_target_cli.read_json_source", return_value=envelope):
            _reject(lambda: command_browser_target_observation(commit_args), "CLI replay")
        assert comment_store_revision(root / "data") == revision


def run_browser_target_tests() -> None:
    _contract_tests()
    _isolated_cli_tests()
    print("comment target-only observation tests passed")


if __name__ == "__main__":
    run_browser_target_tests()

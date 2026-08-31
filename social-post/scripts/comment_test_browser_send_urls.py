#!/usr/bin/env python3
"""Offline regressions for exact ledger-bound Threads reply-page send evidence."""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

from comment_browser_common import _json_digest
from comment_browser_send_contract import (
    _require_send_observed_url,
    classify_browser_reinspection,
    classify_browser_result,
    validate_browser_preflight,
)
from comment_test_browser_adapter import LocalFixtureCommentAdapter
from comment_test_browser_contract_support import (
    PLATFORM_URLS, SESSION_ID, begin_browser_send, bound_preflight_for,
    ingest_browser_scan, intent_state, prepare_action, rebind_preparation,
    reinspection_for, result_for, scan_envelope,
)
from comment_test_cli import draft_cli_fixture, prepare_cli_fixture, run_cli
from comment_test_support import POLICY


class ThreadsSendObservedUrlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # This adapter operates only on local fixture DOM, never Chrome.
        with tempfile.TemporaryDirectory(prefix="social-send-url-contract-") as raw:
            root = Path(raw)
            script, _unused = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
            adapter = LocalFixtureCommentAdapter("threads")
            cls.comment = ingest_browser_scan(script, root, scan_envelope(adapter))
            _reply_path, cls.intent_id = draft_cli_fixture(script, root, cls.comment)
            run_cli(
                script, root, "approve", "--intent-id", cls.intent_id,
                "--approval-mode", "batch_confirm", "--session-id", SESSION_ID, "--write",
            )
            cls.action = prepare_action(script, root, cls.intent_id)
            approved = intent_state(root, cls.intent_id)
            preflight = bound_preflight_for(cls.action)
            adapter.fill_composer(cls.action["reply_text"])
            begin_browser_send(script, root, cls.action, adapter)
            started = intent_state(root, cls.intent_id)
            adapter.click_submit("verified")
            result = result_for(
                cls.action, adapter, started["attempt"]["browser_preflight_id"],
            )
            reconcile = dict(started, status="needs_reconcile")
            reinspection = reinspection_for(cls.action, started["attempt"], found=True)
            cls.stages = (
                ("preflight", validate_browser_preflight, approved, preflight),
                ("result", classify_browser_result, started, result),
                ("reinspection", classify_browser_reinspection, reconcile, reinspection),
            )

    def validate(self, stage: tuple, url: str, *, comment: dict | None = None,
                 changes: dict | None = None) -> dict:
        label, validator, state, base = stage
        receipt = deepcopy(base)
        receipt["observed_url"] = url
        receipt.update(changes or {})
        if label == "preflight":
            rebind_preparation(receipt)
        return validator(
            receipt, {self.comment["comment_key"]: comment or self.comment},
            {self.comment["comment_key"]: state}, POLICY, self.intent_id, SESSION_ID,
        )

    def test_all_stages_accept_original_post_and_exact_stored_reply(self) -> None:
        for stage in self.stages:
            for url in (self.comment["post_permalink"], self.comment["comment_permalink"]):
                with self.subTest(stage=stage[0], url=url):
                    outcome = self.validate(stage, url)
                    if stage[0] == "preflight":
                        self.assertEqual(outcome["action_id"], self.action["action_id"])
                    else:
                        self.assertEqual(outcome["result"], "sent")

    def test_all_stages_reject_unstored_reply_wrong_parent_host_and_query(self) -> None:
        anchor = self.comment["comment_permalink"]
        cases = (
            "https://www.threads.com/@other/post/arbitrary-reply",
            "https://www.threads.com/@test/post/other-parent",
            anchor.replace("www.threads.com", "www.threads.net"),
            anchor.replace("www.threads.com", "evil.example"),
            anchor.replace("https://", "http://"),
            anchor.replace("https://", "https://user@"),
            anchor.replace("www.threads.com", "www.threads.com:444"),
            anchor + "?reply_id=injected",
            anchor + "?redirect=https%3A%2F%2Fevil.example",
        )
        for stage in self.stages:
            for url in cases:
                with self.subTest(stage=stage[0], url=url), self.assertRaises(ValueError):
                    self.validate(stage, url)

    def test_exact_reply_requires_stored_original_parent(self) -> None:
        for stage in self.stages:
            for parent in (None, "https://www.threads.com/@other/post/wrong-parent"):
                comment = dict(self.comment, observed_parent_post_permalink=parent)
                with self.subTest(stage=stage[0], parent=parent), self.assertRaises(ValueError):
                    self.validate(stage, self.comment["comment_permalink"], comment=comment)

    def test_receipt_cannot_supply_a_new_reply_anchor(self) -> None:
        forged = "https://www.threads.com/@external/post/not-in-ledger"
        for stage in self.stages:
            with self.subTest(stage=stage[0]), self.assertRaises(ValueError):
                self.validate(stage, forged, changes={
                    "comment_permalink": forged, "comment_anchor": {"comment_permalink": forged},
                    "post_permalink": forged,
                })

    def test_stored_anchor_cannot_change_host_or_add_query(self) -> None:
        anchor = self.comment["comment_permalink"]
        for forged in (
            anchor + "?reply_id=injected",
            anchor.replace("www.threads.com", "www.threads.net"),
        ):
            for stage in self.stages:
                with self.subTest(stage=stage[0], anchor=forged), self.assertRaises(ValueError):
                    self.validate(stage, forged, comment=dict(self.comment, comment_permalink=forged))

    def test_original_action_bindings_remain_required_at_reply_url(self) -> None:
        for stage in self.stages:
            for key, value in (
                ("action_id", "unapproved-action"),
                ("scope", {**self.action["scope"], "post_key": "wrong-post"}),
                ("comment_fingerprint", "wrong-fingerprint"),
                ("reply_hash", "0" * 64),
            ):
                with self.subTest(stage=stage[0], key=key), self.assertRaises(ValueError):
                    self.validate(stage, self.comment["comment_permalink"], changes={key: value})
        redirected_action = dict(self.action, post_permalink=self.comment["comment_permalink"])
        with self.assertRaisesRegex(ValueError, "action_digest differs from approved action"):
            self.validate(self.stages[0], self.comment["comment_permalink"], changes={
                "action_digest": _json_digest(redirected_action),
            })

    def test_reply_url_does_not_replace_parent_verification(self) -> None:
        outcome = self.validate(
            self.stages[1], self.comment["comment_permalink"], changes={"parent_verified": False},
        )
        self.assertEqual(outcome["result"], "unknown")
        with self.assertRaisesRegex(ValueError, "parent_verified was not verified"):
            self.validate(
                self.stages[2], self.comment["comment_permalink"],
                changes={"parent_verified": False},
            )

    def test_missing_anchor_and_other_platforms_keep_post_only_rule(self) -> None:
        no_anchor = dict(self.comment, comment_permalink=None)
        self.assertEqual(
            _require_send_observed_url(no_anchor, no_anchor["post_permalink"]),
            no_anchor["post_permalink"],
        )
        with self.assertRaises(ValueError):
            _require_send_observed_url(no_anchor, self.comment["comment_permalink"])
        for platform in ("facebook", "instagram"):
            post = PLATFORM_URLS[platform]
            comment = {"platform": platform, "post_permalink": post, "comment_permalink": post + "/comment/id"}
            with self.subTest(platform=platform):
                self.assertEqual(_require_send_observed_url(comment, post), post)
                with self.assertRaises(ValueError):
                    _require_send_observed_url(comment, comment["comment_permalink"])


def run_browser_send_url_tests() -> None:
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ThreadsSendObservedUrlTests)
    result = unittest.TestResult()
    suite.run(result)
    if not result.wasSuccessful():
        raise AssertionError("\n".join(detail for _test, detail in result.errors + result.failures))


if __name__ == "__main__":
    unittest.main(verbosity=2)

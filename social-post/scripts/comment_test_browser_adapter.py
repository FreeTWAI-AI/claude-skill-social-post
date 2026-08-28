#!/usr/bin/env python3
"""Local-only end-to-end fixtures for Facebook, Instagram, and Threads adapters."""

from __future__ import annotations

import json
import tempfile
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterator
from urllib.parse import urlparse

from comment_browser_common import _json_digest
from comment_domain import stable_id
from comment_state import validate_comment_store
from comment_store import load_comment_records
from comment_test_cli import (
    assert_cli_rejected_without_mutation,
    draft_cli_fixture,
    ingest_cli_fixture,
    prepare_cli_fixture,
    run_cli,
)
from comment_test_support import POLICY


FIXTURE_ROOT = Path(__file__).with_name("comment_adapter_fixtures").resolve()
REPLY_TEXT = "謝謝你喜歡這支影片！"
EXPECTED_BODIES = {
    "facebook": "這個測試太精彩了🔥",
    "instagram": "女主角下一集會反擊嗎？",
    "threads": "有下一集記得通知我！",
}
EXPECTED_COMMENT_IDS = {
    "facebook": "fb-comment-001",
    "instagram": "ig-comment-001",
    "threads": "threads-reply-001",
}


@dataclass
class HtmlNode:
    tag: str
    attrs: dict[str, str]
    children: list["HtmlNode"] = field(default_factory=list)
    text_parts: list[str] = field(default_factory=list)

    def text(self) -> str:
        nested = "".join(child.text() for child in self.children)
        return " ".join(("".join(self.text_parts) + nested).split())


class FixtureHtmlParser(HTMLParser):
    """Tiny DOM reader sufficient for deterministic, local fixture snapshots."""

    VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.roots: list[HtmlNode] = []
        self.stack: list[HtmlNode] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = HtmlNode(tag, {key: value or "" for key, value in attrs})
        (self.stack[-1].children if self.stack else self.roots).append(node)
        if tag not in self.VOID_TAGS:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if self.stack and self.stack[-1].tag == tag:
            self.stack.pop()

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data: str) -> None:
        if self.stack:
            self.stack[-1].text_parts.append(data)


@dataclass(frozen=True)
class AdapterSpec:
    platform: str
    comment_id_attr: str
    permalink_attr: str
    author_attr: str
    body_attr: str
    composer_attr: str
    submit_attr: str
    own_replies_attr: str


ADAPTER_SPECS = {
    "facebook": AdapterSpec(
        "facebook", "data-fb-comment-id", "data-fb-comment-permalink",
        "data-fb-author", "data-fb-body", "data-fb-composer", "data-fb-submit",
        "data-fb-own-replies",
    ),
    "instagram": AdapterSpec(
        "instagram", "data-ig-comment-id", "data-ig-comment-permalink",
        "data-ig-author", "data-ig-body", "data-ig-composer", "data-ig-submit",
        "data-ig-own-replies",
    ),
    "threads": AdapterSpec(
        "threads", "data-threads-reply-id", "data-threads-comment-permalink",
        "data-threads-author", "data-threads-body", "data-threads-composer",
        "data-threads-submit", "data-threads-own-replies",
    ),
}


def walk(nodes: list[HtmlNode]) -> Iterator[HtmlNode]:
    for node in nodes:
        yield node
        yield from walk(node.children)


def require_fixture_url(value: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.hostname != "fixture.invalid":
        raise ValueError("local adapter fixture refuses non-fixture network origins")


class LocalFixtureCommentAdapter:
    """Stateful browser stand-in; it never opens Chrome or performs network I/O."""

    def __init__(self, platform: str) -> None:
        self.spec = ADAPTER_SPECS[platform]
        fixture_path = (FIXTURE_ROOT / f"{platform}.html").resolve()
        if FIXTURE_ROOT not in fixture_path.parents:
            raise ValueError("fixture path escaped the local fixture root")
        parser = FixtureHtmlParser()
        parser.feed(fixture_path.read_text(encoding="utf-8"))
        self.nodes = parser.roots
        self.composer_text = ""
        self.composer_was_empty_before_fill: bool | None = None
        self.submit_clicks = 0
        self.visible_own_replies: list[str] = []
        self.last_preparation_id: str | None = None

    def global_one(self, attribute: str) -> HtmlNode:
        matches = [node for node in walk(self.nodes) if attribute in node.attrs]
        if len(matches) != 1:
            raise AssertionError(f"fixture expected one {attribute}, found {len(matches)}")
        return matches[0]

    def target(self) -> HtmlNode:
        expected_id = EXPECTED_COMMENT_IDS[self.spec.platform]
        matches = [
            node for node in walk(self.nodes)
            if node.attrs.get(self.spec.comment_id_attr) == expected_id
        ]
        if len(matches) != 1:
            raise AssertionError(
                f"fixture expected one target {expected_id}, found {len(matches)}"
            )
        return matches[0]

    def one(self, attribute: str) -> HtmlNode:
        target = self.target()
        matches = [
            node for node in (target, *walk(target.children))
            if attribute in node.attrs
        ]
        if len(matches) != 1:
            raise AssertionError(
                f"fixture target expected one {attribute}, found {len(matches)}"
            )
        return matches[0]

    def has(self, attribute: str) -> bool:
        target = self.target()
        return any(attribute in node.attrs for node in (target, *walk(target.children)))

    def scan(self) -> dict:
        root = self.global_one("data-fixture-origin")
        if root.attrs["data-fixture-origin"] != "local-only":
            raise ValueError("adapter fixture is not marked local-only")
        if root.attrs.get("data-platform") != self.spec.platform:
            raise ValueError("adapter fixture platform does not match adapter")
        comment = self.one(self.spec.comment_id_attr)
        permalink = self.one(self.spec.permalink_attr).attrs["href"]
        post_permalink = root.attrs["data-post-permalink"]
        require_fixture_url(post_permalink)
        require_fixture_url(permalink)
        body = self.one(self.spec.body_attr).text()
        return {
            "platform": self.spec.platform,
            "account_key": root.attrs["data-account-key"],
            "post_key": root.attrs["data-post-key"],
            "post_permalink": post_permalink,
            "platform_comment_id": comment.attrs[self.spec.comment_id_attr],
            "comment_permalink": permalink,
            "author_key": comment.attrs["data-author-key"],
            "author_display": self.one(self.spec.author_attr).text(),
            "body": body,
            "body_complete": bool(body),
            "is_own": comment.attrs.get("data-is-own") == "true",
            "has_own_reply": bool(self.visible_own_replies or self.one(self.spec.own_replies_attr).text()),
            "observed_at": root.attrs["data-observed-at"],
            "language": root.attrs.get("lang", "und"),
        }

    def fill_composer(self, text: str) -> None:
        self.one(self.spec.composer_attr)
        if self.submit_clicks:
            raise RuntimeError("cannot edit composer after one-shot submission")
        if not text.strip():
            raise ValueError("reply text must not be empty")
        was_empty = not self.composer_text
        if self.composer_was_empty_before_fill is None:
            self.composer_was_empty_before_fill = was_empty
        else:
            self.composer_was_empty_before_fill &= was_empty
        self.composer_text = text.strip()

    def click_submit(self, outcome: str) -> None:
        self.one(self.spec.submit_attr)
        if self.submit_clicks:
            raise RuntimeError("one-shot browser adapter blocked a duplicate submit")
        if outcome not in {"verified", "ambiguous"}:
            raise ValueError("fixture outcome must be verified or ambiguous")
        if not self.composer_text:
            raise RuntimeError("composer must be filled before submit")
        self.submit_clicks = 1
        if outcome == "verified":
            self.visible_own_replies.append(self.composer_text)

    def inspect_send_result(self) -> dict[str, str]:
        if self.submit_clicks != 1:
            raise RuntimeError("send result cannot be inspected before one submit")
        if self.composer_text in self.visible_own_replies:
            return {
                "result": "sent",
                "evidence": f"local {self.spec.platform} fixture shows exact reply under target comment",
            }
        return {
            "result": "unknown",
            "reason": "local_fixture_visibility_ambiguous_after_submit",
        }

    def hide_submit_control(self) -> None:
        self.one(self.spec.submit_attr).attrs.pop(self.spec.submit_attr)

    def show_own_reply(self, text: str) -> None:
        self.visible_own_replies.append(text)

    def _scope_flags(self, action: dict) -> tuple[dict, bool, bool]:
        scanned = self.scan()
        scope = action["scope"]
        account_ok = scanned["account_key"] == scope["account_key"]
        post_ok = all(
            scanned[key] == scope[key] for key in ("platform", "post_key")
        )
        return scanned, account_ok, post_ok

    def _target_verified(self, action: dict, scanned: dict) -> bool:
        anchor = action.get("comment_anchor") or {}
        return all((
            anchor.get("platform_comment_id") == scanned["platform_comment_id"],
            action.get("expected_body") == scanned["body"],
            action.get("author_key") == scanned["author_key"],
        ))

    def preflight_receipt(
        self, action: dict, observed_at: str, *, observed_url: str | None = None,
    ) -> dict:
        scanned, account_ok, post_ok = self._scope_flags(action)
        target_ok = self._target_verified(action, scanned)
        receipt = {
            "schema_version": 1,
            "test_only": False,
            "action_id": action["action_id"],
            "intent_id": action["intent_id"],
            "session_id": action["session_id"],
            "permit_id": action["permit_id"],
            "scope": action["scope"],
            "comment_fingerprint": action["comment_fingerprint"],
            "reply_hash": action["reply_hash"],
            "action_digest": _json_digest(action),
            "plan_digest": _json_digest({"local_fixture_plan": self.spec.platform}),
            "observed_url": observed_url or action["post_permalink"],
            "observed_at": observed_at,
            "baseline_exact_reply_count": sum(
                1 for item in self.visible_own_replies if item == action["reply_text"]
            ),
            "baseline_total_reply_count": len(self.visible_own_replies),
            "account_verified": account_ok,
            "post_verified": post_ok,
            "target_verified": target_ok,
            "body_complete": scanned["body_complete"],
            "composer_empty_before_fill": self.composer_was_empty_before_fill is True,
            "composer_matches_reply": self.composer_text == action["reply_text"],
            "reply_control_verified": self.has(self.spec.submit_attr),
            "evidence": f"local {self.spec.platform} fixture preflight derived from DOM state",
        }
        receipt["preparation_id"] = _json_digest({
            key: receipt[key] for key in (
                "action_digest", "plan_digest", "observed_url", "observed_at",
                "baseline_exact_reply_count", "baseline_total_reply_count", "test_only",
            )
        })
        self.last_preparation_id = receipt["preparation_id"]
        return receipt

    def result_receipt(
        self, action: dict, preflight_id: str, observed_at: str,
    ) -> dict:
        scanned, account_ok, post_ok = self._scope_flags(action)
        target_ok = self._target_verified(action, scanned)
        exact = self.composer_text in self.visible_own_replies
        preparation_id = self.last_preparation_id
        if not preparation_id:
            raise AssertionError("result receipt requires a prior preflight receipt")
        return {
            "schema_version": 1,
            "test_only": False,
            "action_id": action["action_id"],
            "preflight_id": preflight_id,
            "preparation_id": preparation_id,
            "claim_id": stable_id(
                "browser-submit-claim", action["action_id"], preflight_id, preparation_id,
            ),
            "intent_id": action["intent_id"],
            "session_id": action["session_id"],
            "scope": action["scope"],
            "comment_fingerprint": action["comment_fingerprint"],
            "reply_hash": action["reply_hash"],
            "observed_url": action["post_permalink"],
            "observed_at": observed_at,
            "submission_attempted": self.submit_clicks == 1,
            "submission_possible": self.has(self.spec.submit_attr),
            "account_verified": account_ok,
            "post_verified": post_ok,
            "target_verified": target_ok,
            "parent_verified": post_ok and target_ok,
            "exact_reply_visible": exact,
            "own_author_verified": exact,
            "post_submit_total_reply_count": len(self.visible_own_replies),
            "evidence": f"local {self.spec.platform} fixture result derived from click state",
        }


def stage_cli_send(adapter: LocalFixtureCommentAdapter, root: Path) -> tuple[Path, str, dict]:
    script, source = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
    scanned = adapter.scan()
    if scanned["body"] != EXPECTED_BODIES[adapter.spec.platform]:
        raise AssertionError(f"{adapter.spec.platform} adapter extracted the wrong body")
    source.write_text(json.dumps(scanned, ensure_ascii=False), encoding="utf-8")
    comment = ingest_cli_fixture(script, root, source)
    reply_path, intent_id = draft_cli_fixture(script, root, comment)
    run_cli(
        script, root, "approve", "--intent-id", intent_id,
        "--approval-mode", "batch_confirm", "--session-id", "session-cli", "--write",
    )
    adapter.fill_composer(REPLY_TEXT)
    run_cli(
        script, root, "begin-send", "--intent-id", intent_id,
        "--session-id", "session-cli", "--write",
    )
    return reply_path, intent_id, comment


def record_fixture_result(
    adapter: LocalFixtureCommentAdapter, root: Path, intent_id: str, outcome: str,
) -> None:
    script = Path(__file__).with_name("comment_assistant.py")
    adapter.click_submit(outcome)
    try:
        adapter.click_submit(outcome)
    except RuntimeError:
        pass
    else:
        raise AssertionError("browser adapter allowed a duplicate one-shot submit")
    result = adapter.inspect_send_result()
    args = [
        "finish-send", "--intent-id", intent_id, "--result", result["result"],
        "--session-id", "session-cli", "--write",
    ]
    if result["result"] == "sent":
        args.extend(("--evidence", result["evidence"]))
    else:
        args.extend(("--reason", result["reason"]))
    run_cli(script, root, *args)


def assert_lifecycle_state(
    adapter: LocalFixtureCommentAdapter, root: Path, reply_path: Path,
    intent_id: str, expected_status: str,
) -> None:
    records = load_comment_records(root / "data")
    result = validate_comment_store(records["comments"], records["replies"], POLICY)
    if not result["valid"]:
        raise AssertionError(result["errors"])
    state = next(
        state for state in result["reply_states"].values()
        if state.get("intent_id") == intent_id
    )
    if state["status"] != expected_status:
        raise AssertionError(f"expected {expected_status}, found {state['status']}")
    event_types = [
        json.loads(row)["event_type"]
        for row in reply_path.read_text(encoding="utf-8").splitlines()
    ]
    expected_tail = "sent_verified" if expected_status == "sent_verified" else "needs_reconcile"
    if event_types != ["drafted", "approved", "send_started", expected_tail]:
        raise AssertionError(f"unexpected adapter lifecycle: {event_types}")
    if expected_status == "sent_verified" and not adapter.scan()["has_own_reply"]:
        raise AssertionError("post-send scan did not observe the exact own-account reply")


def check_adapter_lifecycle(platform: str, outcome: str) -> None:
    adapter = LocalFixtureCommentAdapter(platform)
    with tempfile.TemporaryDirectory(prefix=f"social-{platform}-adapter-") as raw:
        root = Path(raw)
        reply_path, intent_id, _comment = stage_cli_send(adapter, root)
        record_fixture_result(adapter, root, intent_id, outcome)
        expected_status = "sent_verified" if outcome == "verified" else "needs_reconcile"
        assert_lifecycle_state(adapter, root, reply_path, intent_id, expected_status)
        if expected_status == "needs_reconcile":
            assert_cli_rejected_without_mutation(
                Path(__file__).with_name("comment_assistant.py"), root, reply_path,
                "begin-send", "--intent-id", intent_id,
                "--session-id", "session-cli", "--write",
            )


def check_live_origin_is_rejected() -> None:
    try:
        require_fixture_url("https://www.facebook.com/real-account/posts/1")
    except ValueError:
        pass
    else:
        raise AssertionError("local adapter accepted a live platform origin")


def fixture_action(adapter: LocalFixtureCommentAdapter) -> dict:
    scanned = adapter.scan()
    return {
        "action_id": f"fixture-action-{adapter.spec.platform}",
        "intent_id": f"fixture-intent-{adapter.spec.platform}",
        "session_id": "fixture-session",
        "permit_id": f"fixture-permit-{adapter.spec.platform}",
        "scope": {
            key: scanned[key] for key in ("platform", "account_key", "post_key")
        },
        "post_permalink": scanned["post_permalink"],
        "comment_anchor": {
            "platform_comment_id": scanned["platform_comment_id"],
            "comment_permalink": scanned["comment_permalink"],
        },
        "author_key": scanned["author_key"],
        "expected_body": scanned["body"],
        "reply_text": REPLY_TEXT,
        "comment_fingerprint": "fixture-fingerprint",
        "reply_hash": "fixture-reply-hash",
    }


def check_receipts_are_state_derived() -> None:
    for platform in ("facebook", "instagram", "threads"):
        adapter = LocalFixtureCommentAdapter(platform)
        action = fixture_action(adapter)
        before_fill = adapter.preflight_receipt(action, "2026-08-28T00:00:00Z")
        if before_fill["composer_empty_before_fill"] or before_fill["composer_matches_reply"]:
            raise AssertionError(f"{platform} preflight ignored an unfilled composer")
        adapter.fill_composer(REPLY_TEXT)
        after_fill = adapter.preflight_receipt(action, "2026-08-28T00:00:01Z")
        if not after_fill["composer_empty_before_fill"] or not after_fill["composer_matches_reply"]:
            raise AssertionError(f"{platform} preflight did not derive the fill state")
        before_click = adapter.result_receipt(action, "fixture-preflight", "2026-08-28T00:00:02Z")
        if before_click["submission_attempted"] or before_click["exact_reply_visible"]:
            raise AssertionError(f"{platform} result invented a submit before click")
        adapter.click_submit("verified")
        after_click = adapter.result_receipt(action, "fixture-preflight", "2026-08-28T00:00:03Z")
        if not after_click["submission_attempted"] or not after_click["exact_reply_visible"]:
            raise AssertionError(f"{platform} result did not derive verified click state")


def run_browser_adapter_tests() -> None:
    check_live_origin_is_rejected()
    check_receipts_are_state_derived()
    for platform in ("facebook", "instagram", "threads"):
        check_adapter_lifecycle(platform, "verified")
        check_adapter_lifecycle(platform, "ambiguous")

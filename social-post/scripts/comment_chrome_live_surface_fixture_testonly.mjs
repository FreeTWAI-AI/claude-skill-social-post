/** Synthetic DOM and shared assertions for live-surface tests; no browser or submission authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import {
  inspectLiveReplySurface, liveReplyUrl, prepareLiveReplyThread,
} from "./comment_chrome_live_surface.mjs";

export function action(platform, post, comment, id) {
  const reply = "Thanks!";
  return {
    action_id: "test", intent_id: "test", session_id: "test", permit_id: "test",
    comment_fingerprint: "test", expected_body: "Useful update", reply_text: reply,
    reply_hash: createHash("sha256").update(reply).digest("hex"),
    scope: { platform, account_key: "example", post_key: "abc", comment_key: "c1" },
    post_permalink: post, comment_anchor: { comment_permalink: comment, platform_comment_id: id },
  };
}
export const instagram = action("instagram", "https://www.instagram.com/p/abc",
  "https://www.instagram.com/p/abc/c/123", "123");

// The following fixture executes the real evaluate callbacks against a minimal
// DOM. It cannot inject a production count latch or return a canned evidence row.
function matchesSimple(node, selector) {
  const tag = selector.match(/^[A-Za-z][A-Za-z0-9-]*/u)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const match of selector.matchAll(/\[([^\]=\s$^]+)(?:([$^]?=)"([^"]*)")?\]/gu)) {
    const value = node.getAttribute(match[1]);
    if (value === null) return false;
    if (match[2] === "=" && value !== match[3]) return false;
    if (match[2] === "$=" && !value.endsWith(match[3])) return false;
    if (match[2] === "^=" && !value.startsWith(match[3])) return false;
  }
  return true;
}

function matchesSelector(node, selector) {
  return selector.split(",").some((part) => {
    const chain = part.trim().split(/\s+/u);
    if (!matchesSimple(node, chain.pop())) return false;
    let ancestor = node.parentElement;
    while (chain.length) {
      const wanted = chain.pop();
      while (ancestor && !matchesSimple(ancestor, wanted)) ancestor = ancestor.parentElement;
      if (!ancestor) return false;
      ancestor = ancestor.parentElement;
    }
    return true;
  });
}

class NativeFixtureNode {
  constructor(tag, attrs = {}, text = "", children = []) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.text = text;
    this.parentElement = null;
    this.children = [];
    for (const child of children) this.append(child);
  }
  append(node) { node.parentElement = this; this.children.push(node); return node; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  get innerText() { return [this.text, ...this.children.map((child) => child.innerText)].filter(Boolean).join(" "); }
  get ownerDocument() {
    let root = this;
    while (root.parentElement) root = root.parentElement;
    return root.tagName === "DOCUMENT" ? root : null;
  }
  get nextElementSibling() {
    return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null;
  }
  getClientRects() {
    for (let node = this; node; node = node.parentElement) if (node.attrs.hidden === "true") return [];
    return [{}];
  }
  contains(node) {
    for (let current = node; current; current = current.parentElement) if (current === this) return true;
    return false;
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (matchesSelector(node, selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(matchesSelector(child, selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

export const nativeNode = (tag, attrs = {}, text = "", children = []) => new NativeFixtureNode(tag, attrs, text, children);

class NativeFixtureLocator {
  constructor(fixture, resolve) { this.fixture = fixture; this.resolve = resolve; }
  locator(selector) {
    return new NativeFixtureLocator(this.fixture, () => selector === "xpath=ancestor::ul[1]"
      ? this.resolve().map((node) => node.closest("ul")).filter(Boolean)
      : this.resolve().flatMap((node) => node.querySelectorAll(selector)));
  }
  filter({ has }) {
    return new NativeFixtureLocator(this.fixture, () => this.resolve().filter((node) =>
      has.resolve().some((child) => node !== child && node.contains(child))));
  }
  nth(index) {
    return new NativeFixtureLocator(this.fixture, () => {
      const node = this.resolve()[index];
      return node ? [node] : [];
    });
  }
  getByRole(role, { name, exact = false } = {}) {
    const selector = role === "button" ? 'button,[role="button"]' : 'textarea,[role="textbox"]';
    return new NativeFixtureLocator(this.fixture, () => this.resolve().flatMap((node) => node.querySelectorAll(selector))
      .filter((node) => {
        const label = node.getAttribute("aria-label") || node.innerText;
        return name === undefined || (exact ? label === name : label.includes(name));
      }));
  }
  async count() { return this.resolve().length; }
  async isVisible() { return this.resolve().length === 1 && this.resolve()[0].getClientRects().length > 0; }
  async isEnabled() { return true; }
  async waitFor(options) {
    this.fixture.counters.readinessWait += 1;
    assert.deepEqual(options, { state: "visible", timeoutMs: 10000 });
    this.fixture.beforeReadinessWait?.(this.fixture);
    const nodes = this.resolve();
    if (nodes.length !== 1 || !nodes[0].getClientRects().length) {
      throw new Error("fixture Instagram native reply readiness timeout");
    }
    assert.equal(nodes[0].tagName, "A");
    assert.ok(nodes[0].querySelector("time"));
  }
  async evaluate(callback, argument) {
    const nativeRead = this.resolve()[0]?.tagName === "LI";
    if (nativeRead) {
      this.fixture.nativeReads += 1;
      this.fixture.beforeNativeRead?.(this.fixture.nativeReads, this.fixture);
    }
    const result = this.fixture.evaluate(callback, this.resolve()[0], argument);
    if (nativeRead) this.fixture.afterNativeRead?.(this.fixture.nativeReads, this.fixture);
    return result;
  }
  async click() {
    const node = this.resolve()[0];
    if (node?.getAttribute("data-test-operation") === "expand") {
      this.fixture.counters.expand += 1;
      if (this.fixture.clickFailure === "before") throw new Error("fixture ambiguous expansion before outcome");
      this.fixture.expanded = true;
      this.fixture.render();
      if (this.fixture.clickFailure === "after") throw new Error("fixture ambiguous expansion after outcome");
      return;
    }
    const counter = node?.innerText === "發佈" ? "submit" : "otherClick";
    this.fixture.counters[counter] += 1;
    throw new Error(`fixture forbids ${counter}`);
  }
  async fill() { this.fixture.counters.fill += 1; throw new Error("fixture forbids fill"); }
}

function nativeComment(path, author, body, options = {}) {
  const heading = nativeNode("h3", {}, "", [nativeNode("a", { href: `/${author}/` }, author)]);
  const bodyNode = nativeNode("div", {}, body);
  const controls = nativeNode("div", {}, "", [
    nativeNode("a", { href: path }, "", [nativeNode("time", {}, "1m")]),
    nativeNode("button", {}, "回覆"),
  ]);
  return nativeNode("li", options, "", [heading, bodyNode, controls]);
}

export const nativeFixtures = [];
export function nativeInstagramFixture(options = {}) {
  const approved = { ...structuredClone(instagram), author_key: "reader" };
  const fixture = {
    action: approved, url: liveReplyUrl(approved), nativeReads: 0, crossRealmNativeReads: 0,
    declaredCount: 1, expanded: false, expandControls: 1, hideControls: 1,
    keepExpand: false, loading: false, busy: false, hiddenHide: false,
    counters: { expand: 0, readinessWait: 0, submit: 0, fill: 0, otherClick: 0 },
    rows: [{ id: "501", author: "example", body: "Thanks!" }],
    ...options,
    evaluate(callback, ...args) {
      const value = runInNewContext(`(${callback.toString()})(...args)`, {
        args, document: this.document,
        location: { origin: "https://www.instagram.com" },
      });
      // Keep browser-like cross-realm objects intact: JSON round-tripping here
      // would conceal the production row-rehydration regression.
      if (args[0]?.tagName === "LI" && value?.valid === true) {
        assert.notEqual(Object.getPrototypeOf(value), Object.prototype);
        assert.notEqual(Object.getPrototypeOf(value.parent), Object.prototype);
        assert.notEqual(Object.getPrototypeOf(value.rows), Array.prototype);
        for (const row of value.rows) assert.notEqual(Object.getPrototypeOf(row), Object.prototype);
        this.crossRealmNativeReads += 1;
        // Negative tests may corrupt a real callback result, never seed valid evidence.
        this.corruptNativeResult?.(value);
      }
      return value;
    },
    render() {
      const profile = nativeNode("a", { href: "/example/" }, "", [
        nativeNode("img", { alt: "example的大頭貼照" }),
      ]);
      const nav = nativeNode("nav", {}, "", [profile, ...["首頁", "搜尋", "新貼文"]
        .map((label) => nativeNode("svg", { "aria-label": label }))]);
      const parentPath = "/p/abc/c/123/";
      const parent = nativeComment(parentPath, "reader", "Useful update");
      const thread = nativeNode("ul", this.busy ? { "aria-busy": "true" } : {}, "", [parent]);
      const outsideDisclosures = [];
      let replyContainer = thread;
      let controlContainer = thread;
      if (this.disclosureDepth !== undefined) {
        let wrapper = nativeNode("li", { "data-fixture-disclosure": "true" });
        if (this.disclosureOutside) outsideDisclosures.push(wrapper);
        else thread.append(wrapper);
        for (let depth = 0; depth < this.disclosureDepth; depth += 1) {
          wrapper = wrapper.append(nativeNode("ul")).append(nativeNode("li"));
        }
        if (this.disclosureOwnHeading) wrapper.append(nativeNode("h3", {}, "Malformed wrapper author"));
        if (this.disclosureChildOwned) wrapper = wrapper.append(nativeComment(
          `${parentPath}r/599/`, "other_reader", "A real child owns this control",
        ));
        controlContainer = wrapper.append(nativeNode("div", { "data-fixture-control-group": "true" }));
        replyContainer = wrapper;
      }
      if (this.expanded) {
        for (const row of this.rows) replyContainer.append(nativeComment(
          row.path ?? `${parentPath}r/${row.id}/`, row.author, row.body,
        ));
        for (let index = 0; index < this.hideControls; index += 1) controlContainer.append(
          nativeNode("button", this.hiddenHide ? { hidden: "true" } : {}, "隱藏回覆"),
        );
      }
      if (!this.expanded || this.keepExpand) {
        for (let index = 0; index < this.expandControls; index += 1) controlContainer.append(nativeNode(
          "button", { "data-test-operation": "expand" }, this.expandLabel ?? `查看回覆（${this.declaredCount}）`,
        ));
      }
      if (this.loading) thread.append(nativeNode("div", { role: "progressbar" }, "載入中"));
      if (this.statusLoading) thread.append(nativeNode("div", { role: "status" }, "載入中"));
      const form = nativeNode("form", {}, "", [
        nativeNode("textarea", { "aria-label": "留言⋯⋯" }), nativeNode("button", {}, "發佈"),
      ]);
      this.document = nativeNode("document", {}, "", [nativeNode("html", {}, "", [
        nativeNode("body", {}, "", [nav, nativeNode("main", {}, "", [
          nativeNode("article", {}, "", [thread, ...outsideDisclosures, form]),
        ])]),
      ])]);
    },
  };
  fixture.render();
  const root = new NativeFixtureLocator(fixture, () => [fixture.document]);
  fixture.tab = {
    id: "generic-native-tab",
    url: async () => fixture.url,
    playwright: {
      locator: (selector) => root.locator(selector),
      getByRole: (role, query) => root.getByRole(role, query),
      evaluate: async (callback, arg) => fixture.evaluate(callback, arg),
    },
  };
  nativeFixtures.push(fixture);
  return fixture;
}

export function assertCandidateOnly(result, exhaustive) {
  assert.equal(result.complete, false);
  assert.equal(result.exhaustiveThread, exhaustive);
  assert.equal(result.replyExhaustionCandidate.candidate_only, true);
  assert.equal(result.replyExhaustionCandidate.exhaustiveThread, exhaustive);
  assert.match(result.blockedReason, /selected_parent_not_verified/u);
  assert.equal(Object.isFrozen(result.replyExhaustionCandidate), true);
  assert.equal(result.replyExhaustionCandidate.document_binding.kind, "source_owned_ui_continuity");
  assert.equal("document_epoch" in result.replyExhaustionCandidate, false);
}

export function expectedUiBinding(fixture, author = "reader", body = fixture.action.expected_body) {
  const target = {
    account_key: fixture.action.scope.account_key,
    comment_permalink: fixture.action.comment_anchor.comment_permalink, author_key: author, body,
  };
  const payload = Object.fromEntries(Object.keys(target).sort().map((key) => [key, target[key]]));
  return {
    schema_version: 1, kind: "source_owned_ui_continuity", tab_id: fixture.tab.id,
    observed_url: fixture.url, target_digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}

export async function inspectNative(fixture, approved = fixture.action) {
  const result = await inspectLiveReplySurface(fixture.tab, approved, "after");
  assert.equal(result.complete, false);
  assert.equal(result.replyExhaustionCandidate.candidate_only, true);
  return result;
}

export function nativeTarget(fixture) {
  return {
    platform: "instagram", account_key: fixture.action.scope.account_key,
    post_key: fixture.action.scope.post_key, post_permalink: fixture.action.post_permalink,
    comment_permalink: fixture.action.comment_anchor.comment_permalink,
    platform_comment_id: fixture.action.comment_anchor.platform_comment_id,
  };
}

export async function privateCanaryFixture() {
  const fixture = nativeInstagramFixture({ rows: [{ id: "501", author: "other_reader", body: "Existing native reply" }] });
  const preflight = await prepareLiveReplyThread(fixture.tab, fixture.action);
  assertCandidateOnly(preflight, true);
  assert.equal(preflight.ownReplyCount, 0);
  return fixture;
}

export function appendNativeOwnReply(fixture, changes = {}) {
  fixture.rows.push({ id: "502", author: "example", body: "Thanks!", ...changes });
  fixture.render();
}

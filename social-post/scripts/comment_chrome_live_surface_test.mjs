/** Pure URL and synthetic-DOM guards; never claims a permit or opens a browser. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import {
  inspectLiveCanaryResult, inspectLiveReplySurface, liveReplyUrl,
  prepareLiveReplyThread, readLiveTargetComment,
} from "./comment_chrome_live_surface.mjs";

function action(platform, post, comment, id) {
  const reply = "Thanks!";
  return {
    action_id: "test", intent_id: "test", session_id: "test", permit_id: "test",
    comment_fingerprint: "test", expected_body: "Useful update", reply_text: reply,
    reply_hash: createHash("sha256").update(reply).digest("hex"),
    scope: { platform, account_key: "example", post_key: "abc", comment_key: "c1" },
    post_permalink: post, comment_anchor: { comment_permalink: comment, platform_comment_id: id },
  };
}
const threads = action("threads", "https://www.threads.com/@example/post/abc",
  "https://www.threads.com/@reader/post/c1", "c1");
const facebook = action("facebook", "https://www.facebook.com/example/posts/abc",
  "https://www.facebook.com/example/posts/abc?comment_id=123", "123");
const instagram = action("instagram", "https://www.instagram.com/p/abc",
  "https://www.instagram.com/p/abc/c/123", "123");
assert.equal(liveReplyUrl(threads), threads.comment_anchor.comment_permalink);
assert.equal(liveReplyUrl(facebook), facebook.comment_anchor.comment_permalink);
assert.equal(liveReplyUrl(instagram), instagram.comment_anchor.comment_permalink);
for (const kind of ["p", "reel", "reels", "tv"]) {
  const aliased = { ...instagram, post_permalink: `https://www.instagram.com/${kind}/abc/` };
  assert.equal(liveReplyUrl(aliased), instagram.comment_anchor.comment_permalink);
}
for (const url of [
  "https://www.instagram.com/p/wrong/c/123", "https://www.instagram.com/p/abc/c/other",
  "https://www.instagram.com/p/abc/c/123/c/other", "https://www.instagram.com/p/abc/c/123%2Fother",
  "https://www.instagram.com/p/abc/c/123?comment_id=other", "https://www.instagram.com/p/abc/c/123?x=1&x=1",
  "https://www.instagram.com/p/abc/c/123?x=1", "https://instagram.com/p/abc/c/123",
  "https://user@www.instagram.com/p/abc/c/123", "https://www.instagram.com:444/p/abc/c/123",
  "https://www.instagram.com/p/abc/c/other/../123", "https://www.instagram.com/p/abc",
]) {
  assert.throws(() => liveReplyUrl({ ...instagram, comment_anchor: {
    ...instagram.comment_anchor, comment_permalink: url,
  } }));
}
assert.equal(liveReplyUrl({ ...facebook, comment_anchor: { platform_comment_id: "123" } }), facebook.comment_anchor.comment_permalink);
for (const url of [
  "https://evil.example/@reader/post/c1", "http://www.threads.com/@reader/post/c1",
  "https://www.threads.com:444/@reader/post/c1", "https://user@www.threads.com/@reader/post/c1",
  "https://www.threads.com/@reader/post/other", "https://www.threads.com/@reader/post/c1?fake=1",
  "https://www.threads.com/@reader", "https://threads.net/@reader/post/c1",
]) {
  assert.throws(() => liveReplyUrl({ ...threads, comment_anchor: { ...threads.comment_anchor, comment_permalink: url } }));
}
for (const original of [facebook, instagram]) {
  assert.throws(() => liveReplyUrl({ ...original, comment_anchor: {
    ...original.comment_anchor, comment_permalink: original.comment_anchor.comment_permalink.replace("/abc", "/wrong"),
  } }));
}
assert.throws(() => liveReplyUrl({ ...facebook, comment_anchor: { ...facebook.comment_anchor, platform_comment_id: "wrong" } }));
assert.throws(() => liveReplyUrl({ ...threads, reply_text: "Changed approval" }));
await assert.rejects(inspectLiveReplySurface(null, threads, "invented-phase"), /unknown live reply inspection phase/u);

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

const nativeNode = (tag, attrs = {}, text = "", children = []) => new NativeFixtureNode(tag, attrs, text, children);

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

const nativeFixtures = [];
function nativeInstagramFixture(options = {}) {
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

function assertCandidateOnly(result, exhaustive) {
  assert.equal(result.complete, false);
  assert.equal(result.exhaustiveThread, exhaustive);
  assert.equal(result.replyExhaustionCandidate.candidate_only, true);
  assert.equal(result.replyExhaustionCandidate.exhaustiveThread, exhaustive);
  assert.match(result.blockedReason, /selected_parent_not_verified/u);
  assert.equal(Object.isFrozen(result.replyExhaustionCandidate), true);
  assert.equal(result.replyExhaustionCandidate.document_binding.kind, "source_owned_ui_continuity");
  assert.equal("document_epoch" in result.replyExhaustionCandidate, false);
}

function expectedUiBinding(fixture, author = "reader", body = fixture.action.expected_body) {
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

async function inspectNative(fixture, approved = fixture.action) {
  const result = await inspectLiveReplySurface(fixture.tab, approved, "after");
  assert.equal(result.complete, false);
  assert.equal(result.replyExhaustionCandidate.candidate_only, true);
  return result;
}

async function nativeInstagramCandidateTests() {
  for (const count of [1, 2]) {
    const fixture = nativeInstagramFixture({ declaredCount: count, rows: Array.from({ length: count }, (_, index) => ({
      id: String(501 + index), author: index ? "other_reader" : "example", body: index ? "Other reply" : "Thanks!",
    })) });
    const result = await prepareLiveReplyThread(fixture.tab, fixture.action);
    assertCandidateOnly(result, true);
    assert.equal(result.totalReplies, count);
    assert.equal(result.ownReplyCount, 1);
    assert.equal(result.exactOwnCount, 1);
    assert.equal(result.replyExhaustionCandidate.declared_count, count);
    assert.equal(result.replyExhaustionCandidate.stable_reads, 2);
    assert.equal(fixture.nativeReads, 3);
    assert.equal(fixture.crossRealmNativeReads, 3);
    assert.equal(fixture.counters.expand, 1);
    assert.equal(fixture.counters.readinessWait, 1);
    assertCandidateOnly(await prepareLiveReplyThread(fixture.tab, fixture.action), true);
    assert.equal(fixture.counters.expand, 1, "a completed candidate must not click again");
    assert.equal(fixture.counters.readinessWait, 1, "readiness is awaited only after the first expansion");
    const before = await inspectLiveReplySurface(fixture.tab, fixture.action, "before");
    assertCandidateOnly(before, true);
    assert.ok(before.composer && before.submit);
  }

  // Observed native disclosure layouts: target LI followed by a heading-free
  // sibling LI, optionally nesting another UL > LI around its DIV > button.
  for (const disclosureDepth of [0, 1, 2]) {
    const fixture = nativeInstagramFixture({ disclosureDepth });
    const thread = fixture.document.querySelector("ul");
    const wrapper = thread.children[1];
    assert.equal(wrapper.tagName, "LI");
    assert.equal(wrapper.parentElement, thread);
    assert.equal(wrapper.querySelectorAll("h3").length, 0);
    assert.equal(wrapper.querySelector('[data-test-operation="expand"]').parentElement.tagName, "DIV");
    const result = await prepareLiveReplyThread(fixture.tab, fixture.action);
    assertCandidateOnly(result, true);
    assert.equal(result.totalReplies, 1);
    assert.equal(result.replyExhaustionCandidate.declared_count, 1);
    assert.equal(result.replyExhaustionCandidate.stable_reads, 2);
    assert.equal(fixture.nativeReads, 3, "count seed plus two stable native reads");
    assert.equal(fixture.counters.expand, 1);
    const expandedWrapper = fixture.document.querySelector('[data-fixture-disclosure="true"]');
    const headings = expandedWrapper.querySelectorAll("h3");
    assert.equal(headings.length, 1, "the wrapper contains a native child heading after expansion");
    assert.notEqual(headings[0].closest("li"), expandedWrapper, "the wrapper does not own the child heading");
    assert.equal(expandedWrapper.querySelectorAll('a[href="/p/abc/c/123/r/501/"]').length, 1);
    assertCandidateOnly(await inspectNative(fixture), true);
    assert.equal(fixture.counters.expand, 1);
  }

  for (const options of [
    { disclosureDepth: 1, disclosureChildOwned: true },
    { disclosureDepth: 3 }, { disclosureDepth: 0, disclosureOutside: true },
  ]) {
    const fixture = nativeInstagramFixture(options);
    const result = await inspectNative(fixture);
    assertCandidateOnly(result, false);
    assert.equal(result.replyExhaustionCandidate.declared_count, null);
    await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /positive observed pre-expansion reply count/u);
    assert.equal(fixture.counters.expand, 0, "an unbound wrapper cannot seed a count or receive a click");
  }

  for (const disclosureDepth of [0, 1]) {
    const fixture = nativeInstagramFixture({ disclosureDepth, disclosureOwnHeading: true });
    await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /Instagram native parent/u);
    assert.equal(fixture.counters.expand, 0, "a malformed wrapper-owned heading must fail closed");
  }

  for (const options of [
    { expanded: true }, { declaredCount: 0 }, { expandControls: 0 }, { expandControls: 2 },
    { declaredCount: 101 }, { expandLabel: "查看回覆（1.5）" },
    { expandLabel: "查看回覆（1+）" }, { expandLabel: "查看回覆" },
    { loading: true }, { busy: true },
  ]) {
    const fixture = nativeInstagramFixture(options);
    assertCandidateOnly(await inspectNative(fixture), false);
    await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /Instagram/u);
    assert.equal(fixture.counters.expand, 0);
  }

  for (const rows of [
    [{ id: "501", author: "example", body: "Thanks!" }, { id: "501", author: "example", body: "Thanks!" }],
    [{ path: "/p/abc/c/999/r/501/", author: "example", body: "Thanks!" }],
    [{ path: "/p/other/c/123/r/501/", author: "example", body: "Thanks!" }],
    [{ path: "/p/abc/c/123/r/501/?fake=1", author: "example", body: "Thanks!" }],
  ]) {
    const fixture = nativeInstagramFixture({ rows });
    await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /Instagram native parent|readiness timeout/u);
    assert.equal(fixture.counters.expand, 1);
    await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /Instagram/u);
    assert.equal(fixture.counters.expand, 1);
  }

  for (const options of [
    { rows: [] }, { declaredCount: 2 }, { hideControls: 0 }, { hideControls: 2 },
    { hiddenHide: true }, { keepExpand: true },
    { beforeNativeRead: (read, fixture) => { if (read === 2) { fixture.loading = true; fixture.render(); } } },
    { beforeNativeRead: (read, fixture) => { if (read === 2) { fixture.statusLoading = true; fixture.render(); } } },
  ]) {
    const fixture = nativeInstagramFixture(options);
    await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /not stably exhausted|readiness timeout/u);
    assertCandidateOnly(await inspectNative(fixture), false);
    assert.equal(fixture.counters.expand, 1);
  }

  const timedOut = nativeInstagramFixture({ rows: [] });
  await assert.rejects(prepareLiveReplyThread(timedOut.tab, timedOut.action), /readiness timeout/u);
  assert.equal(timedOut.nativeReads, 1, "a readiness timeout is not terminal evidence");
  await assert.rejects(prepareLiveReplyThread(timedOut.tab, timedOut.action), /not stably exhausted/u);
  assert.equal(timedOut.counters.expand, 1, "readiness timeout must not cause a second click");
  assert.equal(timedOut.counters.readinessWait, 1, "readiness timeout must not cause a second wait");
  timedOut.rows.push({ id: "501", author: "example", body: "Thanks!" });
  timedOut.render();
  assertCandidateOnly(await prepareLiveReplyThread(timedOut.tab, timedOut.action), true);
  assert.equal(timedOut.counters.expand, 1);
  assert.equal(timedOut.counters.readinessWait, 1);

  const lateRows = nativeInstagramFixture({ rows: [], beforeReadinessWait: (fixture) => {
    fixture.rows.push({ id: "501", author: "example", body: "Thanks!" });
    fixture.render();
  } });
  assertCandidateOnly(await prepareLiveReplyThread(lateRows.tab, lateRows.action), true);
  assert.equal(lateRows.nativeReads, 3, "readiness never replaces either stable native read");
  assert.equal(lateRows.counters.readinessWait, 1);

  for (const key of ["id", "author", "body"]) {
    const fixture = nativeInstagramFixture({ beforeNativeRead: (read, current) => {
      if (read === 3) {
        current.rows[0][key] = { id: "502", author: "other_reader", body: "Changed reply" }[key];
        current.render();
      }
    } });
    await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /not stably exhausted/u);
    const result = await inspectNative(fixture);
    assertCandidateOnly(result, false);
    assert.equal(result.replyExhaustionCandidate.reason, "reply_evidence_changed");
    assert.equal(fixture.counters.expand, 1);
  }

  for (const reset of ["action", "tab-id"]) {
    const fixture = nativeInstagramFixture();
    assertCandidateOnly(await prepareLiveReplyThread(fixture.tab, fixture.action), true);
    const changed = reset === "action" ? { ...fixture.action, intent_id: "another_intent" } : fixture.action;
    if (reset === "tab-id") {
      fixture.tab.id = "changed-native-tab";
      await assert.rejects(inspectNative(fixture), /Instagram/u);
      await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /Instagram/u);
      assert.equal(fixture.counters.expand, 1);
      continue;
    }
    const result = await inspectNative(fixture, changed);
    assertCandidateOnly(result, false);
    assert.equal(result.replyExhaustionCandidate.declared_count, null);
    await assert.rejects(prepareLiveReplyThread(fixture.tab, changed), /pre-expansion reply count/u);
    assert.equal(fixture.counters.expand, 1);
  }

  for (const failure of ["before", "after"]) {
    const fixture = nativeInstagramFixture({ clickFailure: failure });
    await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /fixture ambiguous expansion/u);
    assert.equal(fixture.counters.expand, 1);
    if (failure === "before") {
      await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /Instagram/u);
    } else assertCandidateOnly(await prepareLiveReplyThread(fixture.tab, fixture.action), true);
    assert.equal(fixture.counters.expand, 1, "ambiguous click must never be repeated");
    fixture.render();
    if (failure === "before") await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /Instagram/u);
    else assertCandidateOnly(await prepareLiveReplyThread(fixture.tab, fixture.action), true);
    assert.equal(fixture.counters.expand, 1, "identical UI replacement must not repeat an ambiguous click");
  }

  const changingTabId = nativeInstagramFixture({ beforeNativeRead: (read, fixture) => {
    if (read === 3) fixture.tab.id = "changed-during-read";
  } });
  await assert.rejects(prepareLiveReplyThread(changingTabId.tab, changingTabId.action), /Instagram/u);
  await assert.rejects(inspectNative(changingTabId), /Instagram/u);
  const changingUrl = nativeInstagramFixture({ afterNativeRead: (read, fixture) => {
    if (read === 3) fixture.url = "https://www.instagram.com/p/abc/c/999";
  } });
  await assert.rejects(prepareLiveReplyThread(changingUrl.tab, changingUrl.action), /Instagram|approved comment URL/u);

  // Replacing all DOM objects with identical visible UI is deliberately NOT a
  // detected reload: this diagnostic proves UI continuity, never document epoch.
  const sameUiReload = nativeInstagramFixture();
  const beforeReload = await prepareLiveReplyThread(sameUiReload.tab, sameUiReload.action);
  const oldDocument = sameUiReload.document;
  sameUiReload.render();
  assert.notEqual(sameUiReload.document, oldDocument);
  assert.equal(sameUiReload.document.defaultView, undefined);
  const afterReload = await prepareLiveReplyThread(sameUiReload.tab, sameUiReload.action);
  assertCandidateOnly(afterReload, true);
  assert.deepEqual(afterReload.replyExhaustionCandidate.document_binding,
    beforeReload.replyExhaustionCandidate.document_binding);
  assert.equal(sameUiReload.counters.expand, 1);

  for (const operation of ["inspect", "prepare"]) {
    const fixture = nativeInstagramFixture();
    let release;
    let entered;
    const held = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const evaluate = fixture.tab.playwright.evaluate;
    let accountReads = 0;
    fixture.tab.playwright.evaluate = async (...args) => {
      accountReads += 1;
      if (accountReads === 1) { entered(); await held; }
      return evaluate(...args);
    };
    if (operation === "inspect") {
      const first = inspectNative(fixture);
      await started;
      assertCandidateOnly(await inspectNative(fixture), false);
      release();
      await assert.rejects(first, /inspections overlapped/u);
      assert.equal(fixture.counters.expand, 0);
    } else {
      const first = prepareLiveReplyThread(fixture.tab, fixture.action);
      await started;
      await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /already running/u);
      release();
      assertCandidateOnly(await first, true);
      assert.equal(fixture.counters.expand, 1);
    }
  }
  for (const fixture of nativeFixtures) {
    assert.equal(fixture.counters.submit, 0);
    assert.equal(fixture.counters.fill, 0);
    assert.equal(fixture.counters.otherClick, 0);
    assert.ok(fixture.counters.expand <= 1);
    assert.ok(fixture.counters.readinessWait <= 1);
  }
}

function nativeTarget(fixture) {
  return {
    platform: "instagram", account_key: fixture.action.scope.account_key,
    post_key: fixture.action.scope.post_key, post_permalink: fixture.action.post_permalink,
    comment_permalink: fixture.action.comment_anchor.comment_permalink,
    platform_comment_id: fixture.action.comment_anchor.platform_comment_id,
  };
}

async function nativeInstagramTargetTests() {
  const fixture = nativeInstagramFixture();
  fixture.document.querySelector("li h3 a").text = "Actual Reader Display";
  fixture.document.querySelector("li").children[1].text = "Actual whole native comment";
  const observed = await readLiveTargetComment(fixture.tab, {
    ...nativeTarget(fixture), author_key: "caller_forged", body: "caller supplied fragment",
  });
  assert.deepEqual(observed, {
    comment: {
      platform_comment_id: "123", comment_permalink: "https://www.instagram.com/p/abc/c/123",
      observed_parent_post_permalink: "https://www.instagram.com/p/abc",
      author_key: "reader", author_display: "Actual Reader Display", body: "Actual whole native comment",
      body_complete: true, is_own: false, has_own_reply: false, language: null,
    },
    documentBinding: expectedUiBinding(fixture, "reader", "Actual whole native comment"), observedUrl: fixture.url,
  });
  assert.equal(Object.isFrozen(observed.comment), true);
  assert.equal(fixture.crossRealmNativeReads, 1);
  assert.equal(fixture.counters.expand, 0);
  const aliasedParent = nativeInstagramFixture();
  const fromAlias = await readLiveTargetComment(aliasedParent.tab, {
    ...nativeTarget(aliasedParent), post_permalink: "https://www.instagram.com/reels/abc/",
  });
  assert.equal(fromAlias.comment.observed_parent_post_permalink, "https://www.instagram.com/p/abc");
  assert.deepEqual(fromAlias.documentBinding, expectedUiBinding(aliasedParent));
  assert.equal("documentEpoch" in fromAlias, false);
  const ownReply = nativeInstagramFixture({ expanded: true });
  const withOwn = await readLiveTargetComment(ownReply.tab, nativeTarget(ownReply));
  assert.equal(withOwn.comment.has_own_reply, true);
  assert.equal(withOwn.absence_proven, undefined);
  assert.equal(withOwn.complete, undefined);
  assert.equal(ownReply.counters.expand, 0);
  const ownParent = nativeInstagramFixture();
  const ownAuthor = ownParent.document.querySelector("li h3 a");
  ownAuthor.attrs.href = "/example/";
  ownAuthor.text = "example";
  assert.equal((await readLiveTargetComment(ownParent.tab, nativeTarget(ownParent))).comment.is_own, true);

  for (const changes of [
    { platform: "facebook" }, { account_key: "another_account" }, { account_key: "invalid/account" },
    { post_key: "other" }, { platform_comment_id: "999" },
    { post_permalink: "https://www.instagram.com/p/other" },
    { comment_permalink: "https://www.instagram.com/p/abc/c/999" },
    { comment_permalink: "https://instagram.com/p/abc/c/123" },
    { comment_permalink: "https://www.instagram.com/p/abc/c/123?extra=1" },
  ]) {
    const current = nativeInstagramFixture();
    await assert.rejects(readLiveTargetComment(current.tab, { ...nativeTarget(current), ...changes }));
    assert.equal(current.counters.expand, 0);
  }
  for (const change of ["empty-body", "duplicate-author", "changed-tab-id", "changed-url"]) {
    const current = nativeInstagramFixture();
    if (change === "empty-body") current.document.querySelector("li").children[1].text = "";
    if (change === "duplicate-author") current.document.querySelector("li").append(
      nativeNode("h3", {}, "", [nativeNode("a", { href: "/other/" }, "Other")]),
    );
    if (change === "changed-tab-id") current.afterNativeRead = () => { current.tab.id = "changed-native-tab"; };
    if (change === "changed-url") current.afterNativeRead = () => { current.url += "?changed=1"; };
    await assert.rejects(readLiveTargetComment(current.tab, nativeTarget(current)), /Instagram/u);
    assert.equal(current.counters.expand, 0);
  }
}

async function privateCanaryFixture() {
  const fixture = nativeInstagramFixture({ rows: [{ id: "501", author: "other_reader", body: "Existing native reply" }] });
  const preflight = await prepareLiveReplyThread(fixture.tab, fixture.action);
  assertCandidateOnly(preflight, true);
  assert.equal(preflight.ownReplyCount, 0);
  return fixture;
}

function appendNativeOwnReply(fixture, changes = {}) {
  fixture.rows.push({ id: "502", author: "example", body: "Thanks!", ...changes });
  fixture.render();
}

async function nativeInstagramCanaryTests() {
  const fixture = await privateCanaryFixture();
  appendNativeOwnReply(fixture);
  const readsBefore = fixture.nativeReads;
  const positive = await inspectLiveCanaryResult(fixture.tab, fixture.action);
  assert.equal(fixture.nativeReads - readsBefore, 2);
  assert.equal(fixture.crossRealmNativeReads, 5, "three private preflight reads and two positive reads stay cross-realm");
  assert.equal(positive.verifiedNewReply, true);
  assert.equal(positive.replyPermalink, "https://www.instagram.com/p/abc/c/123/r/502/");
  assert.equal(positive.positive_only, true);
  assert.equal(positive.absence_proven, false);
  assert.equal(positive.complete, false);
  assert.equal(positive.exhaustiveThread, false);
  assert.equal(positive.totalReplies, 2);
  assert.equal(positive.ownReplyCount, 1);
  assert.equal(positive.exactOwnCount, 1);
  assert.equal(positive.stable_reads, 2);
  assert.deepEqual(positive.documentBinding, expectedUiBinding(fixture));
  assert.equal("documentEpoch" in positive, false);
  for (const key of ["action_digest", "binding_digest", "baseline_rows_digest", "rows_digest"]) {
    assert.match(positive[key], /^[0-9a-f]{64}$/u);
  }
  assert.equal(Object.isFrozen(positive), true);
  assert.equal(fixture.counters.expand, 1);

  for (const seededOwn of [false, true]) {
    const current = nativeInstagramFixture({ expanded: !seededOwn });
    if (seededOwn) await prepareLiveReplyThread(current.tab, current.action);
    else await readLiveTargetComment(current.tab, nativeTarget(current));
    await assert.rejects(inspectLiveCanaryResult(current.tab, current.action, {
      binding: "caller-forged", documentBinding: { kind: "caller-forged" }, rows: [], verifiedNewReply: true,
    }), /private zero-own preflight baseline/u);
  }
  for (const kind of [
    "no-new-reply", "foreign-author", "nonexact-body", "two-own", "changed-original", "missing-original",
    "wrong-parent", "duplicate-id", "loading", "missing-hide", "pending-expand", "changed-action", "changed-tab-id",
    "changed-parent", "changed-account",
  ]) {
    const current = await privateCanaryFixture();
    if (kind !== "no-new-reply") appendNativeOwnReply(current);
    if (kind === "foreign-author") current.rows[1].author = "foreign_reader";
    if (kind === "nonexact-body") current.rows[1].body = "Thanks! plus unapproved words";
    if (kind === "two-own") current.rows.push({ id: "503", author: "example", body: "Thanks!" });
    if (kind === "changed-original") current.rows[0].body = "Original reply was edited";
    if (kind === "missing-original") current.rows.shift();
    if (kind === "wrong-parent") current.rows[1].path = "/p/abc/c/999/r/502/";
    if (kind === "duplicate-id") current.rows[1].id = "501";
    if (kind === "loading") current.loading = true;
    if (kind === "missing-hide") current.hideControls = 0;
    if (kind === "pending-expand") current.keepExpand = true;
    if (kind === "changed-tab-id") current.tab.id = "changed-canary-tab";
    current.render();
    if (kind === "changed-parent") current.document.querySelector("li").children[1].text = "Changed parent body";
    if (kind === "changed-account") current.document.querySelector("nav a").attrs.href = "/another_account/";
    const approved = kind === "changed-action" ? { ...current.action, intent_id: "changed_intent" } : current.action;
    await assert.rejects(inspectLiveCanaryResult(current.tab, approved), /Instagram/u, kind);
    assert.equal(current.counters.expand, 1);
  }
  const drift = await privateCanaryFixture();
  appendNativeOwnReply(drift);
  const firstCanaryRead = drift.nativeReads + 1;
  drift.beforeNativeRead = (read, current) => {
    if (read === firstCanaryRead + 1) { current.rows[1].id = "503"; current.render(); }
  };
  await assert.rejects(inspectLiveCanaryResult(drift.tab, drift.action), /positive canary rows are not stable/u);
}

async function nativeInstagramCrossRealmSchemaTests() {
  const corruptions = [
    ["extra-field", (row) => { row.unexpected = "not part of the native row schema"; }],
    ["missing-field", (row) => { delete row.authorDisplay; }],
    ["empty-field", (row) => { row.body = ""; }],
    ...["author", "authorDisplay", "body", "path"].map((key) => [
      `nonstring-${key}`, (row) => { row[key] = 42; },
    ]),
  ];
  for (const [label, corrupt] of corruptions) {
    for (const surface of ["prepare", "target", "canary"]) {
      const fixture = surface === "canary" ? await privateCanaryFixture()
        : nativeInstagramFixture({ expanded: surface === "target" });
      if (surface === "canary") appendNativeOwnReply(fixture);
      fixture.corruptNativeResult = (value) => {
        // Prepare must first obtain its real count and make its single expansion.
        if (value.rows.length) corrupt(surface === "target" ? value.parent : value.rows[0]);
      };
      const operation = surface === "prepare" ? prepareLiveReplyThread(fixture.tab, fixture.action)
        : surface === "target" ? readLiveTargetComment(fixture.tab, nativeTarget(fixture))
          : inspectLiveCanaryResult(fixture.tab, fixture.action);
      await assert.rejects(operation, /native reply row has an unexpected string schema/u, `${surface}: ${label}`);
      assert.equal(fixture.counters.expand, surface === "target" ? 0 : 1);
    }
  }
  for (const corruptNativeResult of [
    (value) => { value.rows = {}; },
    (value) => { value.rows[0] = null; },
    (value) => { value.rows[0] = []; },
    (value) => { value.parent = null; },
  ]) {
    const fixture = nativeInstagramFixture({ expanded: true, corruptNativeResult });
    await assert.rejects(readLiveTargetComment(fixture.tab, nativeTarget(fixture)), /native reply (?:row has|rows are)/u);
    assert.equal(fixture.counters.expand, 0);
  }
}

await nativeInstagramCandidateTests();
await nativeInstagramTargetTests();
await nativeInstagramCanaryTests();
await nativeInstagramCrossRealmSchemaTests();
for (const fixture of nativeFixtures) {
  assert.equal(fixture.counters.submit, 0);
  assert.equal(fixture.counters.fill, 0);
  assert.equal(fixture.counters.otherClick, 0);
  assert.ok(fixture.counters.expand <= 1);
  assert.ok(fixture.counters.readinessWait <= 1);
}
console.log("PASS live surface URL guards (pure tests; no browser submission)");

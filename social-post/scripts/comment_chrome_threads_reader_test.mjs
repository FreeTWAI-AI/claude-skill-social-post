/** Anonymous Threads native DOM reader tests; no browser, network or submission. */
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import {
  threadsNativeTarget, readThreadsNativeColumn, readThreadsNativeComment, readThreadsTargetComment,
} from "./comment_chrome_threads_reader.mjs";

const target = Object.freeze({
  platform: "threads", account_key: "example.owner", post_key: "Root123",
  post_permalink: "https://www.threads.com/@example.owner/post/Root123",
  platform_comment_id: "Comment456",
  comment_permalink: "https://www.threads.com/@example.reader/post/Comment456",
});
const native = threadsNativeTarget(target);
let parserCalls = 0;

function matches(node, selector) {
  return selector.split(",").some((part) => {
    let simple = part.trim();
    const exclusions = [...simple.matchAll(/:not\(([^()]+)\)/gu)].map((match) => match[1]);
    simple = simple.replace(/:not\([^()]+\)/gu, "");
    if (exclusions.some((excluded) => matches(node, excluded))) return false;
    const tag = simple.match(/^[A-Za-z][A-Za-z0-9-]*/u)?.[0];
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    for (const match of simple.matchAll(/\[([^\]=\s*^$]+)(?:([*^$]?=)"([^"]*)")?\]/gu)) {
      const value = node.getAttribute(match[1]);
      if (value === null) return false;
      if (match[2] === "=" && value !== match[3]) return false;
      if (match[2] === "*=" && !value.includes(match[3])) return false;
      if (match[2] === "^=" && !value.startsWith(match[3])) return false;
      if (match[2] === "$=" && !value.endsWith(match[3])) return false;
    }
    return true;
  });
}

class Node {
  constructor(tag, attrs = {}, children = []) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.childNodes = [];
    this.parentElement = null;
    for (const child of children) this.append(child);
  }
  append(child) {
    const node = typeof child === "string" ? { nodeType: 3, nodeValue: child } : child;
    node.parentElement = this;
    this.childNodes.push(node);
    return node;
  }
  get children() { return this.childNodes.filter((child) => child.nodeType === 1); }
  get parentNode() { return this.parentElement; }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get previousElementSibling() {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }
  get nextElementSibling() {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  getAttribute(key) { return this.attrs[key] ?? null; }
  hasAttribute(key) { return Object.hasOwn(this.attrs, key); }
  get innerText() {
    if (!this.getClientRects().length) return "";
    return this.childNodes.map((child) => child.nodeType === 3 ? child.nodeValue : child.innerText).join("");
  }
  get textContent() { return this.childNodes.map((child) => child.nodeType === 3 ? child.nodeValue : child.textContent).join(""); }
  getClientRects() {
    for (let node = this; node; node = node.parentElement) if (node.attrs.hidden === "true") return [];
    return [{}];
  }
  contains(node) {
    for (let current = node; current; current = current.parentElement) if (current === this) return true;
    return false;
  }
  matches(selector) { return matches(this, selector); }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (matches(node, selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
const el = (tag, attrs = {}, children = []) => new Node(tag, attrs, children);

function postRow({ path = native.targetPath, author = "example.reader", text = "Useful update", zero = true } = {}) {
  const profile = el("a", { role: "link", href: `/@${author}` }, [author]);
  const time = el("time", { datetime: "2026-08-31T00:00:00.000Z" }, ["1m"]);
  const anchor = el("a", { role: "link", href: path }, [time]);
  const header = el("div", {}, [profile, anchor]);
  const body = el("div", { dir: "auto" }, [text]);
  const replyIcon = el("svg", { "aria-label": "回覆" });
  const replyButton = el("div", { role: "button" }, [replyIcon]);
  const controls = el("div", {}, [replyButton]);
  const bodyControls = el("div", {}, [body, controls]);
  const zeroMarker = el("div", {}, zero ? ["尚無回覆"] : []);
  const ownComposer = el("div", {}, [
    el("a", { role: "link", href: "/@example.owner" }, ["example.owner"]),
    el("div", { role: "textbox", contenteditable: "true" }),
  ]);
  const content = el("div", {}, [el("div", {}, [el("img", { alt: `${author}的大頭貼照` })]),
    header, bodyControls, zeroMarker, ownComposer]);
  const scope = el("div", { "data-pressable-container": "true" }, [content]);
  return { scope, content, profile, header, time, anchor, body, bodyControls, controls, replyIcon, replyButton, zeroMarker, ownComposer };
}

function column() {
  const parent = postRow({ path: native.postPath, author: "example.owner", text: "Parent post", zero: false });
  const focus = postRow();
  const parentPagelet = el("div", { "data-pagelet": "threads_post_page_0" }, [parent.scope]);
  const targetPagelet = el("div", { "data-pagelet": "threads_post_page_1" }, [focus.scope]);
  const emptyPagelet = el("div", { "data-pagelet": "threads_post_page_2" });
  const stack = el("div", {}, [parentPagelet, targetPagelet, emptyPagelet]);
  const root = el("div", { role: "region", "aria-label": "直欄內文" }, [stack]);
  return { root, stack, parent, focus, parentPagelet, targetPagelet, emptyPagelet };
}

function parse(fixture, expected = native) {
  parserCalls += 1;
  return readThreadsNativeColumn(fixture.root, expected);
}

function testWholeBodyAndRichText() {
  const good = parse(column());
  assert.ok(good, "anonymous native parent/focus column must parse");
  assert.equal(good.author, "example.reader");
  assert.equal(good.authorDisplay, "example.reader");
  assert.equal(good.body, "Useful update");
  assert.equal(good.parentPath, native.postPath);
  assert.equal(good.targetPath, native.targetPath);
  assert.equal(good.replyCount, 0);
  assert.equal(good.zeroReplyCandidate, true);
  assert.ok(good.selector.includes("nth-of-type"));
  const whole = column();
  whole.focus.body.childNodes = [];
  whole.focus.body.append("Before ");
  whole.focus.body.append(el("span", {}, ["matching fragment"]));
  whole.focus.body.append(" after");
  assert.equal(parse(whole, { ...native, body: "matching fragment" }).body, "Before matching fragment after",
    "caller supplied expected text never replaces the complete source body");
  const rich = column();
  rich.focus.body.childNodes = [];
  rich.focus.body.append("Cafe\u0301 ");
  rich.focus.body.append(el("img", { alt: "🙂" }));
  rich.focus.body.append(el("br"));
  rich.focus.body.append(el("a", { href: "/@mentioned.reader" }, ["第二行"]));
  assert.equal(parse(rich).body, "Café 🙂 第二行");
  rich.focus.body.append(el("p", {}, ["Third paragraph"]));
  rich.focus.body.append(el("div", {}, ["Fourth block"]));
  assert.equal(parse(rich).body, "Café 🙂 第二行 Third paragraph Fourth block", "block boundaries must not join adjacent words");
  const crossRealm = runInNewContext(`(${readThreadsNativeColumn.toString()})(root, expected)`,
    { root: rich.root, expected: native, URL });
  parserCalls += 1;
  assert.notEqual(Object.getPrototypeOf(crossRealm), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(crossRealm)), parse(rich));
}

function testZeroCandidateCannotClaimCompleteness() {
  for (const mutate of [
    (f) => { f.focus.zeroMarker.childNodes = []; },
    (f) => { f.focus.zeroMarker.childNodes = []; f.focus.body.append(" 尚無回覆"); },
    (f) => { f.focus.zeroMarker.append(el("div", { role: "button" })); },
    (f) => { f.emptyPagelet.append("Another reply may follow"); },
    (f) => { f.emptyPagelet.append(postRow({ path: "/@another.reader/post/Child789", author: "another.reader" }).scope); },
    (f) => { f.focus.replyButton.append("3"); },
  ]) {
    const fixture = column(); mutate(fixture);
    const observed = parse(fixture);
    assert.ok(observed, "read-only parent intake remains independent from reply-thread completeness");
    assert.equal(observed.zeroReplyCandidate, false);
    assert.equal(Object.hasOwn(observed, "complete"), false);
  }
  const ambiguousCount = column();
  ambiguousCount.focus.replyButton.append("1.2K");
  assert.equal(parse(ambiguousCount), null, "abbreviated reply count is not an exact native count");
}

function testBodyAndPendingRejections() {
  for (const [name, mutate] of [
    ["empty body", (f) => { f.focus.body.childNodes = []; }],
    ["hidden body", (f) => { f.focus.body.attrs.hidden = "true"; }],
    ["collapsed body", (f) => { f.focus.body.attrs["aria-expanded"] = "false"; }],
    ["collapsed descendant", (f) => { f.focus.body.append(el("span", { "aria-expanded": "false" }, ["partial"])); }],
    ["body truncation button", (f) => { f.focus.body.append(el("button", {}, ["See more"])); }],
    ["body role button", (f) => { f.focus.body.append(el("div", { role: "button" }, ["查看更多"])); }],
    ["pending status", (f) => { f.root.append(el("div", { role: "status" }, ["載入中"])); }],
    ["busy descendant", (f) => { f.root.append(el("div", { "aria-busy": "true" })); }],
    ["progress indicator", (f) => { f.root.append(el("div", { role: "progressbar" })); }],
    ["loading text", (f) => { f.emptyPagelet.append("載入中"); }],
  ]) {
    const fixture = column(); mutate(fixture);
    assert.equal(parse(fixture), null, name);
  }
}

function testParentAuthorAndTimeAnchorRejections() {
  for (const [name, mutate] of [
    ["wrong parent", (f) => { f.parent.anchor.attrs.href = "/@example.owner/post/OtherRoot"; }],
    ["wrong target", (f) => { f.focus.anchor.attrs.href = "/@example.reader/post/OtherComment"; }],
    ["query on native target", (f) => { f.focus.anchor.attrs.href += "?tracking=1"; }],
    ["query on native parent", (f) => { f.parent.anchor.attrs.href += "?tracking=1"; }],
    ["external native target", (f) => { f.focus.anchor.attrs.href = `https://evil.example${native.targetPath}`; }],
    ["missing target time", (f) => { f.focus.anchor.childNodes = []; }],
    ["hidden target time", (f) => { f.focus.time.attrs.hidden = "true"; }],
    ["second target timeanchor", (f) => { f.focus.header.append(el("a", { href: native.targetPath }, [el("time", {}, ["2m"])])); }],
    ["another parent timeanchor", (f) => { f.parentPagelet.append(el("a", { href: "/@another.reader/post/OtherRoot" }, [el("time", {}, ["2m"])])); }],
    ["mismatched named author", (f) => { f.focus.profile.attrs.href = "/@another.reader"; }],
    ["hidden named author", (f) => { f.focus.profile.attrs.hidden = "true"; }],
    ["wrong parent pagelet", (f) => { f.parentPagelet.attrs["data-pagelet"] = "threads_post_page_9"; }],
    ["wrong focus pagelet", (f) => { f.targetPagelet.attrs["data-pagelet"] = "threads_post_page_9"; }],
    ["reversed parent ordering", (f) => { f.stack.childNodes = [f.targetPagelet, f.parentPagelet, f.emptyPagelet]; }],
    ["intervening pagelet", (f) => { const gap = el("div", { "data-pagelet": "threads_post_page_7" }); gap.parentElement = f.stack; f.stack.childNodes.splice(1, 0, gap); }],
    ["different parent", (f) => { const wrapper = el("div", {}, [f.targetPagelet]); wrapper.parentElement = f.stack; f.stack.childNodes[1] = wrapper; }],
  ]) {
    const fixture = column(); mutate(fixture);
    assert.equal(parse(fixture), null, name);
  }
}

function testTargetIdentityGuards() {
  assert.equal(native.commentId, "Comment456");
  assert.equal(native.postId, "Root123");
  assert.equal(native.author, "example.reader");
  for (const changed of [
    { platform: "instagram" }, { account_key: "bad/name" }, { platform_comment_id: "bad/id" },
    { post_key: "OtherPost" }, { platform_comment_id: "OtherComment" },
    { post_permalink: `${target.post_permalink}?extra=1` },
    { comment_permalink: `${target.comment_permalink}?extra=1` },
    { comment_permalink: target.post_permalink, platform_comment_id: "Root123" },
    { comment_permalink: `${target.comment_permalink}/child` },
    { comment_permalink: target.comment_permalink.replace("www.threads.com", "evil.example") },
    { comment_permalink: target.comment_permalink.replace("https:", "http:") },
    { comment_permalink: target.comment_permalink.replace("www.threads.com", "user@www.threads.com") },
    { comment_permalink: target.comment_permalink.replace("www.threads.com", "www.threads.com:8443") },
  ]) assert.throws(() => threadsNativeTarget({ ...target, ...changed }));
}

function testResultOnlyAncestorChainCannotUpgradeIntake() {
  const fixture = column();
  const childNative = threadsNativeTarget({ ...target,
    post_key: native.commentId, post_permalink: native.commentUrl,
    platform_comment_id: "OwnReply789",
    comment_permalink: "https://www.threads.com/@example.owner/post/OwnReply789",
  });
  const child = postRow({ path: childNative.targetPath, author: native.account, text: "Approved reply" });
  fixture.parentPagelet.childNodes = [];
  fixture.parentPagelet.append(el("div", {}, [fixture.parent.scope]));
  fixture.parentPagelet.append(el("div", {}, [fixture.focus.scope]));
  fixture.targetPagelet.childNodes = [];
  fixture.targetPagelet.append(child.scope);
  assert.equal(parse(fixture, childNative), null,
    "the default single-anchor target intake must still reject a nested ancestor chain");
  const expectedResult = { ...childNative, resultAncestorPaths: [native.postPath, native.targetPath] };
  const positive = parse(fixture, expectedResult);
  assert.ok(positive);
  assert.equal(positive.parentPath, native.targetPath);
  assert.deepEqual(positive.resultAncestorPaths, [native.postPath, native.targetPath]);
  assert.equal(positive.zeroReplyCandidate, false,
    "result-only context support cannot grant even a zero-reply candidate");
  for (const paths of [[], [native.targetPath], [native.targetPath, native.postPath],
    [native.postPath, native.postPath], [native.postPath, native.targetPath, childNative.targetPath]]) {
    assert.equal(parse(fixture, { ...childNative, resultAncestorPaths: paths }), null);
  }
}

class Locator {
  constructor(fixture, nodes) { this.fixture = fixture; this.nodes = nodes; }
  filter({ has }) { return new Locator(this.fixture, this.nodes.filter((node) => has.nodes.some((child) => node.contains(child)))); }
  nth(index) { return new Locator(this.fixture, this.nodes.slice(index, index + 1)); }
  async count() { return this.nodes.length; }
  async isVisible() { return this.nodes.length === 1 && this.nodes[0].getClientRects().length > 0; }
  async getAttribute(name) {
    assert.equal(this.nodes.length, 1, "attributes need a unique source node");
    if (this.nodes[0] === this.fixture.account) {
      this.fixture.accountChecks += 1;
      if (this.fixture.driftAfterAccountCheck === this.fixture.accountChecks) this.fixture.url = "https://www.threads.com/@another.reader/post/OtherComment";
    }
    return this.nodes[0].getAttribute(name);
  }
  async waitFor(options) {
    assert.deepEqual(options, { state: "visible", timeoutMs: 15000 });
    this.fixture.waits += 1;
    if (this.nodes.length !== 1 || !this.nodes[0].getClientRects().length) throw new Error("anonymous target wait requires exactly one visible node");
  }
  async evaluate(callback, argument) {
    assert.equal(this.nodes.length, 1, "DOM evaluation requires a unique source node");
    this.fixture.evaluations += 1;
    this.fixture.callbacks.push(callback.name);
    parserCalls += 1;
    const result = callback(this.nodes[0], argument);
    if (this.fixture.driftAfterRead) this.fixture.url = "https://www.threads.com/@another.reader/post/OtherComment";
    return result;
  }
}

function sourceFixture(options = {}) {
  const fixture = { ...column(), url: native.commentUrl, evaluations: 0, callbacks: [], waits: 0, accountChecks: 0, ...options };
  fixture.account = el("a", { role: "link", href: "/@example.owner" }, [el("svg", { "aria-label": "個人檔案" })]);
  fixture.title = el("a", { role: "link", href: native.targetPath }, [el("h1", {}, ["Thread"])]);
  fixture.document = el("div", {}, [fixture.account, fixture.title, fixture.root]);
  const tab = { id: "anonymous-threads-test-tab", url: async () => fixture.url, playwright: {
    locator: (selector) => new Locator(fixture, fixture.document.querySelectorAll(selector)),
    getByRole: (role, options = {}) => new Locator(fixture, fixture.document.querySelectorAll(`[role="${role}"]`)
      .filter((node) => !options.name || node.getAttribute("aria-label") === options.name)),
  } };
  return { fixture, tab };
}

async function testSourceReaderAndUrlDrift() {
  const good = sourceFixture();
  const result = await readThreadsTargetComment(good.tab, target);
  assert.equal(result.comment.body, "Useful update");
  assert.equal(result.comment.author_key, "example.reader");
  assert.equal(result.comment.platform_comment_id, "Comment456");
  assert.equal(result.comment.observed_parent_post_permalink, native.postUrl);
  assert.equal(result.comment.body_complete, true);
  assert.equal(result.comment.has_own_reply, false, "target observation does not claim an exhaustive reply scan");
  assert.equal(result.documentBinding.kind, "source_owned_ui_continuity");
  assert.equal(result.documentBinding.observed_url, native.commentUrl);
  assert.equal(good.fixture.evaluations, 1, "source reader executes the actual column callback");
  assert.deepEqual(good.fixture.callbacks, ["readThreadsNativeColumn"]);
  assert.equal(good.fixture.waits, 1);
  assert.equal(good.fixture.accountChecks, 2, "active account is checked before and after the DOM read");
  for (const options of [
    { url: "https://www.threads.com/@another.reader/post/OtherComment" },
    { driftAfterRead: true }, { driftAfterAccountCheck: 2 },
  ]) {
    const drift = sourceFixture(options);
    await assert.rejects(readThreadsTargetComment(drift.tab, target), /URL changed|tab or URL changed/u);
  }
  const rawFixture = sourceFixture();
  const raw = await readThreadsNativeComment(rawFixture.tab, native);
  assert.equal(raw.observedUrl, native.commentUrl);
  assert.equal(raw.evidence.body, "Useful update");
  assert.equal(raw.evidence.zeroReplyCandidate, true);
  assert.equal(Object.hasOwn(raw.evidence, "complete"), false, "zero marker is a candidate, never complete reply-thread evidence");
  assert.equal(typeof raw.region.evaluate, "function");
  assert.equal(raw.documentBinding.kind, "source_owned_ui_continuity");
  assert.equal(rawFixture.fixture.evaluations, 1);
}

async function testSourceRejectsAmbiguousOrMissingIdentity() {
  for (const mutate of [
    (f) => { f.document.childNodes = [f.account, f.title]; },
    (f) => { f.root.attrs.hidden = "true"; },
    (f) => { f.document.append(column().root); },
  ]) {
    const waiting = sourceFixture(); mutate(waiting.fixture);
    await assert.rejects(readThreadsTargetComment(waiting.tab, target), /exactly one visible node/u);
    assert.equal(waiting.fixture.waits, 1);
    assert.equal(waiting.fixture.evaluations, 0, "readiness failure must not run or fake the column callback");
  }
  for (const mutate of [
    (f) => { f.account.attrs.href = "/@another.owner"; },
    (f) => { f.account.attrs.hidden = "true"; },
    (f) => { f.account.childNodes = []; },
    (f) => { for (let index = 0; index < 4; index += 1) f.document.append(el("a", { role: "link", href: "/@example.owner" }, [el("svg", { "aria-label": "個人檔案" })])); },
  ]) {
    const invalid = sourceFixture(); mutate(invalid.fixture);
    await assert.rejects(readThreadsTargetComment(invalid.tab, target), /account/u);
    assert.equal(invalid.fixture.evaluations, 0, "account identity failure rejects before observation");
  }
  for (const mutate of [
    (f) => { f.title.attrs.href = "/@another.reader/post/OtherComment"; },
    (f) => { f.title.attrs.href += "?tracking=1"; },
    (f) => { f.title.childNodes = []; },
    (f) => { f.document.append(el("a", { role: "link", href: native.targetPath }, [el("h1", {}, ["Duplicate title"])])); },
  ]) {
    const invalid = sourceFixture(); mutate(invalid.fixture);
    await assert.rejects(readThreadsTargetComment(invalid.tab, target), /title/u);
    assert.equal(invalid.fixture.evaluations, 0, "column title identity failure rejects before observation");
  }
}

testWholeBodyAndRichText();
testZeroCandidateCannotClaimCompleteness();
testBodyAndPendingRejections();
testParentAuthorAndTimeAnchorRejections();
testTargetIdentityGuards();
testResultOnlyAncestorChainCannotUpgradeIntake();
await testSourceReaderAndUrlDrift();
await testSourceRejectsAmbiguousOrMissingIdentity();
assert.ok(parserCalls > 30, "actual native column callback runs across anonymous positive and negative cases");
console.log("PASS Threads native reader DOM, identity and URL drift tests (anonymous; no browser submission)");

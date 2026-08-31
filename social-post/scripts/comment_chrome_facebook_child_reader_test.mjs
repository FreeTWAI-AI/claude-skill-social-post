/** Anonymous Facebook native child reader tests; real DOM callbacks, no browser or submission. */
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { readFacebookNativeChildRow, collectFacebookNativeChildIds, readFacebookOwnReplyDetails } from "./comment_chrome_facebook_child_reader.mjs";

const expected = Object.freeze({
  origin: "https://www.facebook.com", host: "www.facebook.com",
  postPath: "/example.owner/posts/pfbidExample123", commentId: "123", replyId: "456",
  account: "example.owner", parentDisplay: "Example Reader",
});
const nativePath = `${expected.postPath}?comment_id=123&reply_comment_id=456`;
const replyUrl = `${expected.origin}${nativePath}`;
let parserCalls = 0;
let collectorCalls = 0;

function matches(node, selector) {
  return selector.split(",").some((part) => {
    const simple = part.trim();
    const tag = simple.match(/^[A-Za-z][A-Za-z0-9-]*/u)?.[0];
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    for (const match of simple.matchAll(/\[([^\]=\s*]+)(?:(\*?=)"([^"]*)")?\]/gu)) {
      const value = node.getAttribute(match[1]);
      if (value === null) return false;
      if (match[2] === "=" && value !== match[3]) return false;
      if (match[2] === "*=" && !value.includes(match[3])) return false;
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
    const node = typeof child === "string" ? {
      nodeType: 3, nodeValue: child, get textContent() { return this.nodeValue; },
    } : child;
    node.parentElement = this;
    this.childNodes.push(node);
    return node;
  }
  get children() { return this.childNodes.filter((child) => child.nodeType === 1); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  get innerText() {
    for (let node = this; node; node = node.parentElement) if (node.attrs.hidden === "true") return "";
    return this.childNodes.map((child) => child.nodeType === 3 ? child.nodeValue : child.innerText).join("");
  }
  get textContent() { return this.childNodes.map((child) => child.nodeType === 3 ? child.nodeValue : child.textContent).join(""); }
  getClientRects() {
    for (let node = this; node; node = node.parentElement) if (node.attrs.hidden === "true") return [];
    if (this.attrs.zeroRect === "true") return [];
    return [{}];
  }
  contains(node) {
    for (let current = node; current; current = current.parentElement) if (current === this) return true;
    return false;
  }
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

function row({ text = "Helpful reply", author = "Example Owner", authorHref = "/example.owner",
  href = nativePath, parentDisplay = "Example Reader", time = "1分鐘", labelTime = `${time}前` } = {}) {
  const profile = el("a", { href: authorHref }, [author]);
  const body = el("div", { dir: "auto", lang: "en" }, [text]);
  const anchor = el("a", { href }, [time]);
  const article = el("div", { role: "article", "aria-label": `${author}回覆${parentDisplay}的留言${labelTime}` },
    [profile, body, anchor]);
  const root = el("div", {}, [article]);
  return { root, article, profile, body, anchor };
}

function parse(fixture, input = expected) {
  parserCalls += 1;
  return readFacebookNativeChildRow(fixture.article, input);
}

function testPositiveWholeBodyAndRichText() {
  const good = parse(row());
  assert.deepEqual(good, { author: "example.owner", authorDisplay: "Example Owner",
    parentDisplay: "Example Reader", body: "Helpful reply", commentId: "123", replyId: "456",
    replyUrl, timeText: "1分鐘" });
  assert.equal(Object.hasOwn(good, "complete"), false);
  assert.equal(Object.hasOwn(good, "absence"), false);
  assert.equal(Object.keys(good).length, 8, "positive native child facts contain no completeness or absence flags");
  assert.equal(parse(row({ labelTime: "1分鐘" })).timeText, "1分鐘", "exact native time without 前 is also valid");

  const whole = row({ text: "Before " });
  whole.body.append(el("span", {}, ["matching fragment"]));
  whole.body.append(" after");
  whole.body.append(el("span", { dir: "auto", lang: "en" }, [" nested text"]));
  assert.equal(parse(whole, { ...expected, body: "matching fragment" }).body,
    "Before matching fragment after nested text", "matching child fragments never replace the source-owned complete body");
  const rich = row({ text: "Cafe\u0301 " });
  rich.body.append(el("img", { alt: "🙂" }));
  rich.body.append(el("img", { alt: "🐈" }));
  rich.body.append(el("br"));
  rich.body.append("第二行 ");
  rich.body.append(el("a", { href: "/another.reader" }, ["linked text"]));
  assert.equal(parse(rich).body, "Café 🙂🐈 第二行 linked text");
  const emoji = row({ text: "" });
  emoji.body.append(el("img", { alt: "🙂" }));
  assert.equal(parse(emoji).body, "🙂");
  const crossRealm = runInNewContext(`(${readFacebookNativeChildRow.toString()})(article, expected)`,
    { article: rich.article, expected, URL });
  parserCalls += 1;
  assert.notEqual(Object.getPrototypeOf(crossRealm), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(crossRealm)), parse(rich),
    "pure callback works in an isolated VM without module imports or browser globals");
}

function testAllowedTrackingAndExactTime() {
  const tracked = row({ href: `${nativePath}&__cft__[0]=anonymous-trace&__tn__=R` });
  tracked.profile.attrs.href = "/example.owner?comment_id=opaque-context&__cft__[0]=anonymous-profile&__tn__=R";
  assert.equal(parse(tracked).replyUrl, replyUrl, "tracking does not enter canonical native child identity");
  const reordered = row({ href: `${expected.postPath}?__tn__=R&reply_comment_id=456&__cft__%5B0%5D=anonymous&comment_id=123` });
  assert.equal(parse(reordered).replyUrl, replyUrl);
  const duplicateSameNative = row();
  duplicateSameNative.article.append(el("a", { href: `${nativePath}&__tn__=R` }, ["1分鐘"]));
  assert.equal(parse(duplicateSameNative).timeText, "1分鐘", "duplicate views of one native ID must agree on visible time");
  const online = row();
  const status = el("a", { href: "/example.owner" }, ["目前在線上"]);
  status.parentElement = online.article;
  online.article.childNodes.unshift(status);
  assert.equal(parse(online).authorDisplay, "Example Owner", "named profile link is selected by exact reply label");
  const numeric = row({ authorHref: "/profile.php?id=789" });
  assert.equal(parse(numeric, { ...expected, account: "789" }).author, "789");
}

function testNativeScopeAndQueryRejections() {
  for (const [name, href] of [
    ["wrong root", `/example.owner/posts/OtherRoot?comment_id=123&reply_comment_id=456`],
    ["wrong parent", `${expected.postPath}?comment_id=999&reply_comment_id=456`],
    ["wrong reply", `${expected.postPath}?comment_id=123&reply_comment_id=999`],
    ["missing reply", `${expected.postPath}?comment_id=123`],
    ["reply alias", `${expected.postPath}?comment_id=123&reply_id=456`],
    ["duplicate parent", `${nativePath}&comment_id=123`],
    ["conflicting parent", `${nativePath}&comment_id=999`],
    ["duplicate reply", `${nativePath}&reply_comment_id=456`],
    ["conflicting reply", `${nativePath}&reply_comment_id=999`],
    ["mixed reply alias", `${nativePath}&reply_id=456`],
    ["unknown query", `${nativePath}&other=anonymous`],
    ["unsupported tracking index", `${nativePath}&__cft__[1]=anonymous`],
    ["empty tracking", `${nativePath}&__tn__=`],
    ["duplicate tracking", `${nativePath}&__tn__=R&__tn__=R`],
    ["conflicting tracking", `${nativePath}&__cft__[0]=first&__cft__[0]=second`],
    ["HTTP", `http://www.facebook.com${nativePath}`],
    ["wrong host", `https://evil.example${nativePath}`],
    ["credentials", `https://user@www.facebook.com${nativePath}`],
    ["port", `https://www.facebook.com:8443${nativePath}`],
    ["hash", `${nativePath}#other`],
  ]) assert.equal(parse(row({ href })), null, name);
  for (const [name, mutate] of [
    ["hidden native time", (f) => { f.anchor.attrs.hidden = "true"; }],
    ["empty native time", (f) => { f.anchor.childNodes = []; }],
    ["different times for same ID", (f) => { f.article.append(el("a", { href: nativePath }, ["2分鐘"])); }],
    ["only body native anchor", (f) => { f.article.childNodes = [f.profile, f.body]; f.body.append(el("a", { href: nativePath }, ["1分鐘"])); }],
    ["only profile opaque comment ID", (f) => { f.article.childNodes = [f.profile, f.body]; f.profile.attrs.href += "?comment_id=123&__tn__=R"; }],
  ]) {
    const fixture = row(); mutate(fixture);
    assert.equal(parse(fixture), null, name);
  }
}

function testAuthorAndLabelRejections() {
  for (const [name, mutate] of [
    ["wrong account", (f) => { f.profile.attrs.href = "/another.owner"; }],
    ["ambiguous author", (f) => { f.article.append(el("a", { href: "/another.owner" }, ["Another Owner"])); }],
    ["hidden author", (f) => { f.profile.attrs.hidden = "true"; }],
    ["no named author", (f) => { f.profile.childNodes = []; }],
    ["wrong author label", (f) => { f.article.attrs["aria-label"] = "Another Owner回覆Example Reader的留言1分鐘前"; }],
    ["wrong parent label", (f) => { f.article.attrs["aria-label"] = "Example Owner回覆Another Reader的留言1分鐘前"; }],
    ["wrong label time", (f) => { f.article.attrs["aria-label"] = "Example Owner回覆Example Reader的留言2分鐘前"; }],
    ["repeated 前 suffix", (f) => { f.article.attrs["aria-label"] += "前"; }],
    ["additional label suffix", (f) => { f.article.attrs["aria-label"] += " another suffix"; }],
    ["wrong time suffix", (f) => { f.article.attrs["aria-label"] = "Example Owner回覆Example Reader的留言1分鐘後"; }],
    ["profile mixed reply ID", (f) => { f.profile.attrs.href += "?comment_id=opaque&reply_comment_id=456"; }],
    ["profile duplicate opaque ID", (f) => { f.profile.attrs.href += "?comment_id=first&comment_id=second"; }],
    ["profile unknown query", (f) => { f.profile.attrs.href += "?other=anonymous"; }],
    ["profile duplicate tracking", (f) => { f.profile.attrs.href += "?__tn__=R&__tn__=R"; }],
    ["profile empty opaque ID", (f) => { f.profile.attrs.href += "?comment_id="; }],
    ["body mention not author", (f) => { f.profile.attrs.href = "/another.owner"; f.body.append(el("a", { href: "/example.owner" }, ["Example Owner"])); }],
  ]) {
    const fixture = row(); mutate(fixture);
    assert.equal(parse(fixture), null, name);
  }
  for (const href of ["/profile.php?id=789&id=789", "/profile.php?id=789&id=999", "/profile.php?id=789&other=value"]) {
    assert.equal(parse(row({ authorHref: href }), { ...expected, account: "789" }), null);
  }
}

function testHiddenTruncatedAndAmbiguousBodies() {
  for (const [name, mutate] of [
    ["hidden article", (f) => { f.article.attrs.hidden = "true"; }],
    ["wrong article role", (f) => { f.article.attrs.role = "region"; }],
    ["hidden whole body", (f) => { f.body.attrs.hidden = "true"; }],
    ["empty body", (f) => { f.body.childNodes = []; }],
    ["collapsed whole body", (f) => { f.body.attrs["aria-expanded"] = "false"; }],
    ["collapsed body branch", (f) => { f.body.append(el("span", { "aria-expanded": "false" }, ["hidden remainder"])); }],
    ["hidden textual branch", (f) => { f.body.append(el("span", { hidden: "true" }, ["hidden remainder"])); }],
    ["aria-hidden textual branch", (f) => { f.body.append(el("span", { "aria-hidden": "true" }, ["hidden remainder"])); }],
    ["body button", (f) => { f.body.append(el("button", {}, ["See more"])); }],
    ["outside truncation control", (f) => { f.article.append(el("div", { role: "button" }, ["查看更多"])); }],
    ["ambiguous second body", (f) => { f.article.append(el("div", { dir: "auto", lang: "en" }, ["Another whole body"])); }],
  ]) {
    const fixture = row(); mutate(fixture);
    assert.equal(parse(fixture), null, name);
  }
}

function testNestedArticleIsolation() {
  const fixture = row();
  const nested = row({ author: "Nested Reader", authorHref: "/nested.reader", text: "Unrelated nested body",
    href: `${expected.postPath}?comment_id=456&reply_comment_id=999` });
  nested.article.append(el("div", { role: "button" }, ["查看更多"]));
  fixture.article.append(nested.article);
  assert.equal(parse(fixture).body, "Helpful reply", "nested article body, author, native ID and truncation control are excluded");
  fixture.article.childNodes = [fixture.profile, fixture.anchor, nested.article];
  assert.equal(parse(fixture), null, "nested language container cannot replace a missing owned body");
}

function transparentBody({ recursive = false } = {}) {
  const fixture = row({ text: "" });
  fixture.body.tagName = "SPAN";
  const leaf = el("span", {}, [expected.parentDisplay]);
  const inner = recursive ? el("span", { zeroRect: "true" }, [leaf]) : leaf;
  const wrapper = el("span", { zeroRect: "true" }, [inner]);
  fixture.body.append(wrapper);
  fixture.body.append(" Helpful reply");
  return { ...fixture, wrapper, leaf };
}

function testTransparentSpanVisibleCoverage() {
  for (const recursive of [false, true]) {
    const fixture = transparentBody({ recursive });
    assert.equal(fixture.body.getClientRects().length, 1);
    assert.equal(fixture.wrapper.getClientRects().length, 0);
    assert.equal(fixture.leaf.getClientRects().length, 1,
      "zero rect on a transparent wrapper must not hide its visible descendant");
    assert.equal(fixture.leaf.innerText, expected.parentDisplay);
    assert.equal(parse(fixture).body, "Example Reader Helpful reply");
  }
  for (const [name, mutate] of [
    ["transparent wrapper with hidden leaf", (f) => { f.leaf.attrs.hidden = "true"; }],
    ["transparent wrapper with only direct text", (f) => { f.wrapper.childNodes = []; f.wrapper.append(expected.parentDisplay); }],
    ["transparent wrapper with mixed direct text", (f) => { f.wrapper.append("direct text"); }],
    ["transparent wrapper with whitespace text node", (f) => { f.wrapper.append(" "); }],
    ["transparent wrapper with hidden sibling", (f) => { f.wrapper.append(el("span", { hidden: "true" }, ["hidden sibling"])); }],
    ["aria-hidden transparent wrapper", (f) => { f.wrapper.attrs["aria-hidden"] = "true"; }],
    ["explicit aria-hidden false wrapper", (f) => { f.wrapper.attrs["aria-hidden"] = "false"; }],
    ["styled transparent wrapper", (f) => { f.wrapper.attrs.style = ""; }],
    ["role-bearing transparent wrapper", (f) => { f.wrapper.attrs.role = "presentation"; }],
    ["hidden attribute on transparent wrapper", (f) => { f.wrapper.attrs.hidden = ""; }],
    ["non-SPAN transparent child", (f) => { f.leaf.tagName = "DIV"; }],
    ["visible leaf with hidden nested text", (f) => { f.leaf.append(el("span", { hidden: "true" }, ["hidden remainder"])); }],
  ]) {
    const fixture = transparentBody(); mutate(fixture);
    assert.equal(parse(fixture), null, name);
  }
}

function testPureInputGuards() {
  for (const input of [null, undefined, [], {},
    ...[
      { host: "evil.example" }, { host: "www.facebook.com:8443" },
      { origin: "http://www.facebook.com" }, { origin: "https://www.facebook.com/" },
      { origin: "https://facebook.com" }, { postPath: "/example.owner/posts/invalid/key" },
      { postPath: "/example.owner/posts/pfbidExample123?other=1" },
      { commentId: "abc" }, { commentId: 123 }, { replyId: "abc" }, { replyId: "123" },
      { account: "bad/name" }, { account: "@example.owner" },
      { parentDisplay: "" }, { parentDisplay: "   " }, { parentDisplay: [] },
    ].map((change) => ({ ...expected, ...change })),
  ]) {
    parserCalls += 1;
    assert.equal(readFacebookNativeChildRow(row().article, input), null, "invalid source scope must fail closed");
  }
  parserCalls += 1;
  assert.equal(readFacebookNativeChildRow(null, expected), null);
}

const parentNative = Object.freeze({ account: expected.account, commentId: expected.commentId,
  postUrl: `${expected.origin}${expected.postPath}`, commentUrl: `${expected.origin}${expected.postPath}?comment_id=123`,
  postPath: expected.postPath, host: expected.host });
class Locator {
  constructor(fixture, nodes) { this.fixture = fixture; this.nodes = nodes; }
  filter({ has }) { return new Locator(this.fixture, this.nodes.filter((node) => has.nodes.some((child) => node.contains(child)))); }
  async count() {
    this.fixture.countReads += 1;
    if (this.fixture.driftAtCount === this.fixture.countReads) this.fixture.url = `${expected.origin}/another.owner/posts/Other?comment_id=123`;
    return this.nodes.length;
  }
  async isVisible() { return this.nodes.length === 1 && this.nodes[0].getClientRects().length > 0; }
  async evaluate(callback, input) {
    this.fixture.callbacks.push(callback.name);
    if (callback === collectFacebookNativeChildIds) collectorCalls += 1;
    else if (callback === readFacebookNativeChildRow) parserCalls += 1;
    else assert.fail("helper must execute an actual reviewed child callback");
    const raw = runInNewContext(`(${callback.toString()})(element, input)`, { element: this.nodes[0], input, URL });
    if (raw !== null) assert.notEqual(Object.getPrototypeOf(raw), Array.isArray(raw) ? Array.prototype : Object.prototype);
    const number = this.fixture.callbacks.length;
    if (this.fixture.driftAfterEvaluation === number) this.fixture.url = `${expected.origin}/another.owner/posts/Other?comment_id=123`;
    if (this.fixture.tabDriftAfterEvaluation === number) this.fixture.tab.id = "changed-anonymous-tab";
    return raw;
  }
}
function sourceFixture(options = {}) {
  const parent = row({ text: "Parent comment", author: expected.parentDisplay, authorHref: "/example.reader",
    href: `${expected.postPath}?comment_id=123` });
  parent.article.attrs["aria-label"] = "Example Reader的留言1分鐘前";
  const child = row();
  parent.root.append(child.article);
  const fixture = { parent, child, root: parent.root, url: parentNative.commentUrl, callbacks: [], countReads: 0, ...options };
  const tab = { id: "anonymous-facebook-child-tab", url: async () => fixture.url, playwright: {
    locator: (selector) => new Locator(fixture, fixture.root.querySelectorAll(selector)),
    getByRole: (role) => new Locator(fixture, fixture.root.querySelectorAll(`[role="${role}"]`)),
  } };
  Object.assign(fixture, { tab, parentLocator: new Locator(fixture, [parent.article]) });
  fixture.read = (native = parentNative) => readFacebookOwnReplyDetails(tab, fixture.parentLocator, native, expected.parentDisplay);
  return fixture;
}

async function testSourceHelperPositiveAndIsolation() {
  const good = sourceFixture();
  const details = await good.read();
  assert.deepEqual(details, { replies: [{ author: "example.owner", authorDisplay: "Example Owner",
    parentDisplay: "Example Reader", body: "Helpful reply", commentId: "123", replyId: "456", replyUrl, timeText: "1分鐘" }],
  complete: false, absence_verified: false });
  assert.ok(Object.isFrozen(details) && Object.isFrozen(details.replies) && Object.isFrozen(details.replies[0]));
  assert.deepEqual(good.callbacks, ["collectFacebookNativeChildIds", "readFacebookNativeChildRow"]);
  for (const kind of ["foreign-author", "body-mention", "wrong-parent-label", "foreign-parent-id"]) {
    const isolated = sourceFixture();
    if (kind === "foreign-parent-id") isolated.child.anchor.attrs.href = `${expected.postPath}?comment_id=999&reply_comment_id=456`;
    else if (kind === "wrong-parent-label") isolated.child.article.attrs["aria-label"] = "Example Owner回覆Another Reader的留言1分鐘前";
    else {
      isolated.child.profile.attrs.href = "/another.owner";
      isolated.child.profile.childNodes[0].nodeValue = "Another Owner";
      isolated.child.article.attrs["aria-label"] = "Another Owner回覆Example Reader的留言1分鐘前";
      if (kind === "body-mention") isolated.child.body.append(el("a", { href: "/example.owner" }, ["Example Owner"]));
    }
    assert.deepEqual(await isolated.read(), { replies: [], complete: false, absence_verified: false }, kind);
    assert.deepEqual(isolated.callbacks, ["collectFacebookNativeChildIds"], "non-own candidates cannot become child evidence");
  }
  const multiple = sourceFixture();
  multiple.root.append(row({ href: `${expected.postPath}?comment_id=123&reply_comment_id=789` }).article);
  assert.deepEqual((await multiple.read()).replies.map((reply) => reply.replyId), ["456", "789"]);
  assert.deepEqual(multiple.callbacks, ["collectFacebookNativeChildIds", "readFacebookNativeChildRow", "readFacebookNativeChildRow"]);
}

async function testSourceHelperGuardsAndDrift() {
  for (const change of [
    { host: "evil.example" }, { commentId: "999" }, { postPath: "/example.owner/posts/Other" },
    { postUrl: `${parentNative.postUrl}?other=1` },
    { commentUrl: `${parentNative.commentUrl}&reply_comment_id=456` },
    { commentUrl: `${parentNative.commentUrl}&comment_id=123` },
  ]) {
    const invalid = sourceFixture();
    await assert.rejects(invalid.read({ ...parentNative, ...change }));
    assert.equal(invalid.callbacks.length, 0, "inconsistent native scope rejects before DOM evaluation");
    assert.equal(invalid.countReads, 0);
  }
  for (const options of [
    { url: `${expected.origin}/another.owner/posts/Other?comment_id=123` },
    { driftAfterEvaluation: 1 }, { driftAfterEvaluation: 2 },
    { tabDriftAfterEvaluation: 1 }, { tabDriftAfterEvaluation: 2 },
    { driftAtCount: 1 }, { driftAtCount: 2 },
  ]) await assert.rejects(sourceFixture(options).read(), /tab or URL changed/u);
  const duplicate = sourceFixture();
  duplicate.root.append(row().article);
  await assert.rejects(duplicate.read(), /ambiguous/u);
  assert.deepEqual(duplicate.callbacks, ["collectFacebookNativeChildIds"]);
  const prefix = sourceFixture();
  prefix.root.append(row({ author: "Another Owner", authorHref: "/another.owner",
    href: `${expected.postPath}?comment_id=123&reply_comment_id=4560` }).article);
  await assert.rejects(prefix.read(), /exactly one/u);
  const wrongParent = sourceFixture();
  wrongParent.parent.anchor.attrs.href = `${expected.postPath}?comment_id=999`;
  await assert.rejects(wrongParent.read(), /ambiguous/u);
  const hiddenChild = sourceFixture();
  hiddenChild.child.body.attrs.hidden = "true";
  await assert.rejects(hiddenChild.read(), /ambiguous/u);
}

testPositiveWholeBodyAndRichText();
testAllowedTrackingAndExactTime();
testNativeScopeAndQueryRejections();
testAuthorAndLabelRejections();
testHiddenTruncatedAndAmbiguousBodies();
testNestedArticleIsolation();
testTransparentSpanVisibleCoverage();
testPureInputGuards();
await testSourceHelperPositiveAndIsolation();
await testSourceHelperGuardsAndDrift();
assert.ok(parserCalls >= 80, "actual pure callback executes across all anonymous source-bound cases");
console.log(JSON.stringify({ parserCalls, collectorCalls, groups: 10, pureIsolatedVmCases: 1 }));
console.log("PASS Facebook native child reader DOM and source continuity tests (anonymous; no browser or submission)");

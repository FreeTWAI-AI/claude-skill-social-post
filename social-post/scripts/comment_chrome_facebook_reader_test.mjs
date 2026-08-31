/** Anonymous Facebook native DOM reader tests; no browser, network or submission. */
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import {
  facebookNativeTarget, readFacebookNativeRow, readFacebookTargetComment,
} from "./comment_chrome_facebook_reader.mjs";
import { bindLiveReplyBrowser } from "./comment_chrome_facebook_surface.mjs";

const target = Object.freeze({
  platform: "facebook", account_key: "example.owner", post_key: "pfbidExample123",
  post_permalink: "https://www.facebook.com/example.owner/posts/pfbidExample123",
  platform_comment_id: "123", comment_permalink:
    "https://www.facebook.com/example.owner/posts/pfbidExample123?comment_id=123",
});
const native = facebookNativeTarget(target);
const expected = { ...native, origin: native.commentUrl };
let parserCalls = 0;

function matches(node, selector) {
  return selector.split(",").some((part) => {
    let simple = part.trim();
    const exclusions = [...simple.matchAll(/:not\(([^()]+)\)/gu)].map((match) => match[1]);
    simple = simple.replace(/:not\([^()]+\)/gu, "");
    if (exclusions.some((excluded) => matches(node, excluded))) return false;
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
    const node = typeof child === "string" ? { nodeType: 3, nodeValue: child } : child;
    node.parentElement = this;
    this.childNodes.push(node);
    return node;
  }
  get children() { return this.childNodes.filter((child) => child.nodeType === 1); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  get innerText() {
    if (!this.getClientRects().length) return "";
    return this.childNodes.map((child) => child.nodeType === 3 ? child.nodeValue : child.innerText).join("");
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

function row({ text = "Useful update", authorHref = "/example.reader", author = "Example Reader",
  commentHref = `${native.postPath}?comment_id=123` } = {}) {
  const body = el("div", { dir: "auto", lang: "en" }, [text]);
  const profile = el("a", { href: authorHref }, [author]);
  const anchor = el("a", { href: commentHref }, ["1m"]);
  const article = el("div", { role: "article", "aria-label": `${author}的留言 1m` }, [profile, body, anchor]);
  const root = el("div", {}, [article]);
  return { root, article, body, profile, anchor };
}

function parse(fixture, input = expected) {
  parserCalls += 1;
  return readFacebookNativeRow(fixture.article, input);
}

function testWholeBodyAndRichText() {
  assert.deepEqual(parse(row()), { author: "example.reader", authorDisplay: "Example Reader", body: "Useful update" });
  const whole = row({ text: "Before " });
  whole.body.append(el("span", {}, ["matching fragment"]));
  whole.body.append(" after");
  assert.equal(parse(whole, { ...expected, body: "matching fragment" }).body, "Before matching fragment after");
  whole.body.append(el("span", { dir: "auto", lang: "en" }, [" nested text"]));
  assert.equal(parse(whole).body, "Before matching fragment after nested text");

  const rich = row({ text: "Cafe\u0301 " });
  rich.body.append(el("img", { alt: "🙂" }));
  rich.body.append(el("img", { alt: "🐈" }));
  rich.body.append(el("br"));
  rich.body.append("第二行");
  rich.body.append(el("a", { href: "/unrelated.mention" }, [" linked text"]));
  assert.equal(parse(rich).body, "Café 🙂🐈 第二行 linked text");

  const nested = row();
  nested.article.append(row({ author: "Another Reader", authorHref: "/another.reader", text: "Child body",
    commentHref: `${native.postPath}?comment_id=123&reply_comment_id=456` }).article);
  assert.equal(parse(nested).body, "Useful update", "child article never supplies parent body or author");
  const crossRealm = runInNewContext(`(${readFacebookNativeRow.toString()})(article, expected)`,
    { article: rich.article, expected, URL });
  parserCalls += 1;
  assert.notEqual(Object.getPrototypeOf(crossRealm), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(crossRealm)), parse(rich));
}

function testBodyAndTruncationRejections() {
  for (const mutate of [
    (f) => { f.body.attrs.hidden = "true"; },
    (f) => { f.body.childNodes = []; },
    (f) => { f.body.attrs["aria-expanded"] = "false"; },
    (f) => { f.body.append(el("span", { "aria-expanded": "false" }, ["partial"])); },
    (f) => { f.body.append(el("button", {}, ["more"])); },
    (f) => { f.article.append(el("div", { dir: "auto", lang: "en" }, ["ambiguous second body"])); },
    (f) => { f.article.append(el("button", {}, ["See more"])); },
    (f) => { f.article.append(el("div", { role: "button" }, ["查看更多"])); },
    (f) => { f.article.append(el("div", { role: "button" }, ["顯示更多"])); },
  ]) {
    const fixture = row(); mutate(fixture);
    assert.equal(parse(fixture), null);
  }
}

function testAuthorAndNativeAnchorRejections() {
  for (const mutate of [
    (f) => { f.profile.attrs.hidden = "true"; },
    (f) => { f.article.attrs["aria-label"] = "Different Reader的留言"; },
    (f) => { f.article.append(el("a", { href: "/another.reader" }, ["Another Reader"])); },
    (f) => { f.anchor.attrs.href = `${native.postPath}?comment_id=999`; },
    (f) => { f.anchor.attrs.href = `${native.postPath}?comment_id=123&comment_id=123`; },
    (f) => { f.anchor.attrs.href = `${native.postPath}?comment_id=123&comment_id=999`; },
    (f) => { f.anchor.attrs.href = `${native.postPath}?comment_id=123&reply_comment_id=456`; },
    (f) => { f.anchor.attrs.href = `${native.postPath}?comment_id=123&reply_id=456`; },
    (f) => { f.anchor.attrs.href = `${native.postPath}?unrelated=123`; },
    (f) => { f.anchor.attrs.href = `https://evil.example${native.postPath}?comment_id=123`; },
  ]) {
    const fixture = row(); mutate(fixture);
    assert.equal(parse(fixture), null);
  }
  assert.equal(parse(row({ authorHref: "/profile.php?id=456" })).author, "456");
  assert.equal(parse(row({ authorHref: "/profile.php?id=456&id=789" })), null,
    "conflicting numeric profile IDs must not collapse to the first author");
  const online = row();
  const statusLink = el("a", { href: "/example.reader" }, ["目前在線上"]);
  statusLink.parentElement = online.article;
  online.article.childNodes.unshift(statusLink);
  assert.deepEqual(parse(online), {
    author: "example.reader", authorDisplay: "Example Reader", body: "Useful update",
  }, "the named second profile link, not first online-status link, binds the article author");
}

function testTargetIdentityGuards() {
  assert.equal(native.commentId, "123");
  assert.equal(facebookNativeTarget({ ...target, post_permalink: `${target.post_permalink}/` }).postUrl, native.postUrl);
  for (const changed of [
    { platform: "instagram" }, { account_key: "bad/name" }, { platform_comment_id: "abc" },
    { post_key: "OtherPost" }, { post_permalink: `${target.post_permalink}?extra=1` },
    { post_permalink: "https://www.facebook.com/story.php?story_fbid=123&id=456" },
    { comment_permalink: `${target.comment_permalink}&comment_id=123` },
    { comment_permalink: `${target.comment_permalink}&reply_comment_id=456` },
    { comment_permalink: target.comment_permalink.replace("comment_id=123", "comment_id=999") },
    { comment_permalink: target.comment_permalink.replace("www.facebook.com", "evil.example") },
    { comment_permalink: target.comment_permalink.replace("https:", "http:") },
    { comment_permalink: target.comment_permalink.replace("www.facebook.com", "user@www.facebook.com") },
    { comment_permalink: target.comment_permalink.replace("www.facebook.com", "www.facebook.com:8443") },
  ]) assert.throws(() => facebookNativeTarget({ ...target, ...changed }));
}

class Locator {
  constructor(fixture, nodes) { this.fixture = fixture; this.nodes = nodes; }
  filter({ has }) { return new Locator(this.fixture, this.nodes.filter((node) => has.nodes.some((child) => node.contains(child)))); }
  async count() { return this.nodes.length; }
  async isVisible() { return this.nodes.length === 1 && this.nodes[0].getClientRects().length > 0; }
  async waitFor(options) {
    assert.deepEqual(options, { state: "visible", timeoutMs: 15000 });
    this.fixture.waits += 1;
    if (this.nodes.length !== 1 || !this.nodes[0].getClientRects().length) {
      throw new Error("anonymous target wait requires exactly one visible node");
    }
  }
  async evaluate(callback, argument) {
    this.fixture.evaluations += 1;
    this.fixture.callbacks.push(callback.name);
    parserCalls += 1;
    const result = callback(this.nodes[0], argument);
    if (this.fixture.driftAfterRead) this.fixture.url = "https://www.facebook.com/other.owner/posts/other?comment_id=123";
    return result;
  }
}

function sourceFixture(options = {}) {
  const fixture = { ...row(), url: native.commentUrl, evaluations: 0, callbacks: [], waits: 0,
    probes: 0, closed: 0, ...options };
  const tab = { id: "anonymous-facebook-test-tab", url: async () => fixture.url, playwright: {
    locator: (selector) => new Locator(fixture, fixture.root.querySelectorAll(selector)),
    getByRole: (role) => new Locator(fixture, fixture.root.querySelectorAll(`[role="${role}"]`)),
  } };
  bindLiveReplyBrowser(tab, { tabs: { new: async () => {
    fixture.probes += 1;
    return {
      goto: async (url) => { assert.equal(url, "https://www.facebook.com/me/"); },
      url: async () => {
        if (fixture.driftAfterProbe === fixture.probes) fixture.url = "https://www.facebook.com/other.owner/posts/other?comment_id=123";
        return "https://www.facebook.com/example.owner";
      },
      close: async () => { fixture.closed += 1; },
    };
  } } });
  return { fixture, tab };
}

async function testSourceReaderAndUrlDrift() {
  const good = sourceFixture();
  const result = await readFacebookTargetComment(good.tab, target);
  assert.equal(result.comment.body, "Useful update");
  assert.equal(result.comment.author_key, "example.reader");
  assert.equal(result.comment.body_complete, true);
  assert.equal(result.documentBinding.kind, "source_owned_ui_continuity");
  assert.equal(result.documentBinding.observed_url, native.commentUrl);
  assert.equal(good.fixture.evaluations, 2, "source reader executes both actual DOM callbacks");
  assert.deepEqual(good.fixture.callbacks, ["readFacebookNativeRow", "readFacebookOwnReplyPresence"]);
  assert.equal(good.fixture.waits, 1);
  assert.equal(good.fixture.probes, 2);
  assert.equal(good.fixture.closed, 2);
  for (const options of [
    { url: "https://www.facebook.com/other.owner/posts/other?comment_id=123" },
    { driftAfterRead: true }, { driftAfterProbe: 2 },
  ]) {
    const drift = sourceFixture(options);
    await assert.rejects(readFacebookTargetComment(drift.tab, target), /URL changed|tab or URL changed/u);
    assert.equal(drift.fixture.closed, drift.fixture.probes);
  }
}

async function testSourceWaitRejectsMissingHiddenAndAmbiguousTargets() {
  for (const mutate of [
    (fixture) => { fixture.root.childNodes = []; },
    (fixture) => { fixture.article.attrs.hidden = "true"; },
    (fixture) => { fixture.root.append(row().article); },
  ]) {
    const waiting = sourceFixture();
    mutate(waiting.fixture);
    await assert.rejects(readFacebookTargetComment(waiting.tab, target), /exactly one visible node/u);
    assert.equal(waiting.fixture.waits, 1);
    assert.equal(waiting.fixture.evaluations, 0, "readiness failure cannot run or fake either DOM callback");
    assert.equal(waiting.fixture.closed, waiting.fixture.probes);
  }
}

async function testSourcePositiveOwnChildAndBodyMention() {
  for (const own of [true, false]) {
    const current = sourceFixture();
    const child = row({ authorHref: own ? "/example.owner" : "/another.reader",
      author: own ? "Example Owner" : "Another Reader", text: "A prior native child reply",
      commentHref: `${native.postPath}?comment_id=123&reply_comment_id=456` });
    if (!own) child.body.append(el("a", { href: "/example.owner" }, [" mentioning the account"]));
    current.fixture.root.append(child.article);
    const result = await readFacebookTargetComment(current.tab, target);
    assert.equal(result.comment.has_own_reply, own,
      "native child author proves positive presence; an account mention in another author's body does not");
    assert.equal(result.comment.body, "Useful update");
    assert.equal(current.fixture.evaluations, 2);
    assert.deepEqual(current.fixture.callbacks, ["readFacebookNativeRow", "readFacebookOwnReplyPresence"]);
    assert.equal(current.fixture.waits, 1);
  }
}

testWholeBodyAndRichText();
testBodyAndTruncationRejections();
testAuthorAndNativeAnchorRejections();
testTargetIdentityGuards();
await testSourceReaderAndUrlDrift();
await testSourceWaitRejectsMissingHiddenAndAmbiguousTargets();
await testSourcePositiveOwnChildAndBodyMention();
assert.ok(parserCalls > 30, "real DOM parser callback must execute across positive and negative cases");
console.log("PASS Facebook native reader DOM, identity and URL drift tests (anonymous; no browser submission)");

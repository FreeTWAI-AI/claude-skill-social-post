/** Anonymous Threads preparation fixtures; no browser, network or submission. */
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import {
  readThreadsZeroTerminal, readThreadsSelectedDialog as reexportedSelectedDialog,
  inspectThreadsCanarySurface, prepareThreadsCanaryReply, revalidateThreadsSelection, inspectThreadsCanaryResult,
} from "./comment_chrome_threads_canary_surface.mjs";
import { readThreadsSelectedDialog } from "./comment_chrome_threads_modal_reader.mjs";
import { getCommentCuaBrowser, installCommentCuaRuntime } from "./comment_cua_runtime.mjs";

assert.equal(reexportedSelectedDialog, readThreadsSelectedDialog, "production surface preserves the independently importable pure callback");

const expected = Object.freeze({
  account: "example.owner", author: "example.reader", host: "www.threads.com",
  postId: "Root123", commentId: "Comment456",
  postUrl: "https://www.threads.com/@example.owner/post/Root123",
  commentUrl: "https://www.threads.com/@example.reader/post/Comment456",
  postPath: "/@example.owner/post/Root123", targetPath: "/@example.reader/post/Comment456",
  selector: ":scope > div:nth-of-type(1) > div:nth-of-type(2) > div:nth-of-type(1)",
  body: "Useful complete update", displayedAt: "1m", targetDatetime: "2026-08-31T00:00:00.000Z",
});
const calls = { zero: 0, modal: 0, clicks: 0, fills: 0 };

function matches(node, selector) {
  return selector.split(",").some((part) => {
    let simple = part.trim();
    const exclusions = [...simple.matchAll(/:not\(([^()]+)\)/gu)].map((match) => match[1]);
    simple = simple.replace(/:not\([^()]+\)/gu, "");
    if (exclusions.some((excluded) => matches(node, excluded))) return false;
    const tag = simple.match(/^[A-Za-z][A-Za-z0-9-]*/u)?.[0];
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    const nth = simple.match(/:nth-of-type\((\d+)\)/u)?.[1];
    if (nth && node.parentElement?.children.filter((child) => child.tagName === node.tagName).indexOf(node) + 1 !== Number(nth)) return false;
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
  replaceChildren(...children) {
    for (const child of this.childNodes) child.parentElement = null;
    this.childNodes = [];
    for (const child of children) this.append(child);
  }
  get children() { return this.childNodes.filter((child) => child.nodeType === 1); }
  get parentNode() { return this.parentElement; }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  get nextElementSibling() {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
  get innerText() {
    if (!this.getClientRects().length) return "";
    return this.childNodes.map((child) => child.nodeType === 3 ? child.nodeValue : child.innerText).join("");
  }
  get textContent() { return this.childNodes.map((child) => child.nodeType === 3 ? child.nodeValue : child.textContent).join(""); }
  getClientRects() {
    if (this.tagName === "TITLE") return [];
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
    if (selector.startsWith(":scope > ")) {
      return selector.slice(9).split(" > ").reduce((nodes, part) => nodes.flatMap((node) => node.children.filter((child) => matches(child, part))), [this]);
    }
    return this.children.flatMap((child) => [
      ...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  click() { calls.clicks += 1; throw new Error("pure candidate callbacks cannot click"); }
  fill() { calls.fills += 1; throw new Error("pure candidate callbacks cannot fill"); }
}
const el = (tag, attrs = {}, children = []) => new Node(tag, attrs, children);

function postRow({ path = expected.targetPath, author = expected.author, body = expected.body, zero = true } = {}) {
  const profile = el("a", { role: "link", href: `/@${author}` }, [author]);
  const time = el("time", { datetime: expected.targetDatetime }, [expected.displayedAt]);
  const anchor = el("a", { role: "link", href: path }, [time]);
  const header = el("div", {}, [profile, anchor]);
  const content = el("div", { dir: "auto" }, [body]);
  const replyIcon = el("svg", { role: "img", "aria-label": "回覆" }, [el("title", {}, ["回覆"]), el("path")]);
  const reply = el("div", { role: "button" }, [el("span", {}, [replyIcon]), el("span")]);
  const controls = el("div", {}, [reply]);
  const bodyControls = el("div", {}, [content, controls]);
  const marker = el("div", {}, zero ? ["尚無回覆"] : []);
  const ownComposer = el("div", {}, [
    el("a", { role: "link", href: `/@${expected.account}` }, [expected.account]),
    el("div", { role: "textbox", contenteditable: "true", "aria-placeholder": `回覆${expected.author}……` }),
  ]);
  const shell = el("div", {}, [el("div", {}, [el("img", { alt: `${author}的大頭貼照` })]), header, bodyControls, marker, ownComposer]);
  const owner = el("div", { "data-pressable-container": "true" }, [shell]);
  return { owner, shell, header, profile, time, anchor, content, controls, bodyControls, marker, ownComposer, reply };
}

function zeroFixture() {
  const original = postRow({ path: expected.postPath, author: expected.account, body: "Root post", zero: false });
  const focus = postRow();
  const originalPagelet = el("div", { "data-pagelet": "threads_post_page_0" }, [original.owner]);
  const focusPagelet = el("div", { "data-pagelet": "threads_post_page_1" }, [focus.owner]);
  const tailPagelet = el("div", { "data-pagelet": "threads_post_page_{n}" });
  const emptyTail = el("div");
  const context = el("div", {}, [originalPagelet, focusPagelet, tailPagelet, emptyTail]);
  const root = el("div", { role: "region", "aria-label": "直欄內文" }, [context]);
  return { root, context, originalPagelet, focusPagelet, tailPagelet, emptyTail, original, focus };
}

function modalFixture() {
  const heading = el("h2", {}, ["回覆"]);
  const avatarImage = el("img", { alt: `${expected.author}的大頭貼照` });
  const avatarLink = el("a", { href: `/@${expected.author}` }, [avatarImage]);
  const avatar = el("div", {}, [avatarLink]);
  const profile = el("a", { href: `/@${expected.author}` }, [expected.author]);
  const time = el("time", { datetime: expected.targetDatetime }, [expected.displayedAt]);
  const header = el("div", {}, [profile, time]);
  const connector = el("div");
  const context = el("div", {}, [`正在回覆@${expected.account}`]);
  const content = el("div", { dir: "auto" }, [expected.body]);
  const bodyShell = el("div", {}, [context, content]);
  const bodyBranch = el("div", {}, [bodyShell]);
  const card = el("div", {}, [avatar, header, connector, bodyBranch]);
  const ownAvatar = el("img", { alt: `${expected.account}的大頭貼照` });
  const ownLabel = el("span", {}, [expected.account]);
  const textbox = el("div", { role: "textbox", contenteditable: "true", "data-lexical-editor": "true",
    "aria-placeholder": `回覆 ${expected.author}……` });
  const composer = el("div", {}, [ownAvatar, ownLabel, textbox]);
  const addThreadAvatar = el("img", { alt: `${expected.account}的大頭貼照` });
  const addThreadBranch = el("div", {}, [addThreadAvatar]);
  const submit = el("button", {}, ["發佈"]);
  const root = el("div", { role: "dialog", "aria-modal": "true" }, [heading, card, composer, addThreadBranch, submit]);
  return { root, heading, card, avatar, avatarLink, avatarImage, profile, time, header, connector, context,
    content, bodyShell, bodyBranch, ownAvatar, ownLabel, textbox, composer, addThreadAvatar, addThreadBranch, submit };
}

function evaluate(callback, fixture, input = expected) {
  if (callback === readThreadsZeroTerminal) calls.zero += 1;
  if (callback === readThreadsSelectedDialog) calls.modal += 1;
  return runInNewContext(`(${callback.toString()})(root, expected)`, { root: fixture.root, expected: input, URL });
}
const localJson = (value) => JSON.parse(JSON.stringify(value));

function assertCandidateOnly(result) {
  for (const field of ["complete", "exhaustiveThread", "absence_proven", "selectedParentCandidate", "selection", "verifiedNewReply", "replyPermalink"]) {
    assert.equal(Object.hasOwn(result, field), false, `${field} cannot be granted by a pure DOM callback`);
  }
}

function testObservedZeroTerminal() {
  const fixture = zeroFixture();
  assert.equal(fixture.root.querySelector(expected.selector), fixture.focus.owner, "test selector resolves the actual source owner");
  const observed = evaluate(readThreadsZeroTerminal, fixture);
  assert.ok(observed, "exact observed root/focus/empty-native-tail/empty-DIV shape must parse");
  assert.notEqual(Object.getPrototypeOf(observed), Object.prototype, "the actual callback result stays cross-realm");
  assert.deepEqual(localJson(observed), {
    terminal: true, targetDatetime: expected.targetDatetime, marker: "尚無回覆",
    parentPath: expected.postPath, targetPath: expected.targetPath,
    pageletNames: ["threads_post_page_0", "threads_post_page_1", "threads_post_page_{n}"], unlabelledTailEmpty: true, observedChildCount: 0,
  });
  assertCandidateOnly(observed);
  fixture.focus.ownComposer.querySelector('[role="textbox"]').append(el("br"));
  assert.ok(evaluate(readThreadsZeroTerminal, fixture), "an empty inline lexical line remains empty");
}

function testZeroLayoutAndChildrenRejections() {
  const child = () => postRow({ path: "/@another.reader/post/Child789", author: "another.reader", body: "Existing child", zero: false }).owner;
  for (const [name, change] of [
    ["missing explicit native tail", (f) => f.context.replaceChildren(f.originalPagelet, f.focusPagelet, f.emptyTail)],
    ["missing explicit unlabelled tail", (f) => f.context.replaceChildren(f.originalPagelet, f.focusPagelet, f.tailPagelet)],
    ["unknown pagelet", (f) => { f.tailPagelet.attrs["data-pagelet"] = "threads_unknown_page_7"; }],
    ["numeric substitute for observed literal tail", (f) => { f.tailPagelet.attrs["data-pagelet"] = "threads_post_page_7"; }],
    ["wrong literal native tail", (f) => { f.tailPagelet.attrs["data-pagelet"] = "threads_post_page_{m}"; }],
    ["unbraced native tail", (f) => { f.tailPagelet.attrs["data-pagelet"] = "threads_post_page_n"; }],
    ["duplicate root pagelet", (f) => { f.tailPagelet.attrs["data-pagelet"] = "threads_post_page_0"; }],
    ["duplicate focus pagelet", (f) => { f.tailPagelet.attrs["data-pagelet"] = "threads_post_page_1"; }],
    ["labelled final DIV", (f) => { f.emptyTail.attrs["data-pagelet"] = "threads_post_page_8"; }],
    ["extra nonpagelet context child", (f) => f.context.append(el("div"))],
    ["extra unknown context child", (f) => f.context.append(el("div", { "data-pagelet": "unknown" }))],
    ["context sibling", (f) => f.root.append(el("div"))],
    ["native tail contains text", (f) => f.tailPagelet.append("Unmapped reply")],
    ["unlabelled tail contains text", (f) => f.emptyTail.append("Unmapped reply")],
    ["native tail contains child", (f) => f.tailPagelet.append(child())],
    ["unlabelled tail contains child", (f) => f.emptyTail.append(child())],
    ["inline composer contains child", (f) => f.focus.ownComposer.append(child())],
    ["root pagelet contains child", (f) => f.originalPagelet.append(child())],
    ["empty tail has hidden interactive child", (f) => f.emptyTail.append(el("button", { hidden: "true" }))],
    ["root and focus reversed", (f) => f.context.replaceChildren(f.focusPagelet, f.originalPagelet, f.tailPagelet, f.emptyTail)],
    ["focus nested under different parent", (f) => f.context.replaceChildren(f.originalPagelet, el("div", {}, [f.focusPagelet]), f.tailPagelet, f.emptyTail)],
    ["missing inline editor shell branch", (f) => f.focus.shell.replaceChildren(...f.focus.shell.children.slice(0, 4))],
    ["duplicate inline editor", (f) => f.focus.ownComposer.append(el("div", { role: "textbox", contenteditable: "true", "aria-placeholder": `回覆${expected.author}……` }))],
    ["inline editor already filled", (f) => f.focus.ownComposer.querySelector('[role="textbox"]').append("Existing draft")],
    ["inline editor hidden draft", (f) => f.focus.ownComposer.querySelector('[role="textbox"]').append(el("span", { hidden: "true" }, ["Existing draft"]))],
    ["hidden inline editor", (f) => { f.focus.ownComposer.querySelector('[role="textbox"]').attrs.hidden = "true"; }],
    ["inline editor wrong target", (f) => { f.focus.ownComposer.querySelector('[role="textbox"]').attrs["aria-placeholder"] = "回覆another.reader……"; }],
    ["inline editor not editable", (f) => { f.focus.ownComposer.querySelector('[role="textbox"]').attrs.contenteditable = "false"; }],
  ]) {
    const fixture = zeroFixture(); change(fixture);
    assert.equal(evaluate(readThreadsZeroTerminal, fixture), null, name);
  }
}

function testZeroMarkerPendingAndIdentityRejections() {
  const cases = [
    ["missing target marker", (f) => f.focus.marker.replaceChildren()],
    ["partial marker", (f) => f.focus.marker.replaceChildren("尚無回")],
    ["marker with extra text", (f) => f.focus.marker.append(" except hidden replies")],
    ["hidden marker", (f) => { f.focus.marker.attrs.hidden = "true"; }],
    ["marker has control", (f) => f.focus.marker.append(el("button"))],
    ["duplicate marker", (f) => f.original.marker.append("尚無回覆")],
    ["misplaced marker", (f) => { f.focus.marker.replaceChildren(); f.focus.content.append("尚無回覆"); }],
    ["root busy", (f) => { f.root.attrs["aria-busy"] = "true"; }],
    ["pending status", (f) => f.focus.controls.append(el("div", { role: "status" }))],
    ["pending progress", (f) => f.focus.controls.append(el("div", { role: "progressbar" }))],
    ["busy descendant", (f) => f.focus.controls.append(el("div", { "aria-busy": "true" }))],
    ["wrong root", (f) => { f.original.anchor.attrs.href = "/@example.owner/post/OtherRoot"; }],
    ["wrong target", (f) => { f.focus.anchor.attrs.href = "/@example.reader/post/OtherComment"; }],
    ["native target query", (f) => { f.focus.anchor.attrs.href += "?tracking=1"; }],
    ["foreign target host", (f) => { f.focus.anchor.attrs.href = `https://foreign.example${expected.targetPath}`; }],
    ["hidden target anchor", (f) => { f.focus.anchor.attrs.hidden = "true"; }],
    ["duplicate target time", (f) => f.focus.anchor.append(el("time", { datetime: expected.targetDatetime }, [expected.displayedAt]))],
    ["missing native datetime", (f) => { delete f.focus.time.attrs.datetime; }],
    ["partial native datetime", (f) => { f.focus.time.attrs.datetime = "2026-08-31"; }],
    ["different displayed timestamp", (f) => f.focus.time.replaceChildren("2m")],
  ];
  for (const label of ["載入中", "Loading…", "顯示更多回覆", "查看更多回覆", "載入更多", "更多回覆", "See more replies", "View more replies", "Load more"]) {
    cases.push([`pending/expander ${label}`, (f) => f.focus.controls.append(el("div", { role: "button" }, [label]))]);
  }
  for (const [name, change] of cases) {
    const fixture = zeroFixture(); change(fixture);
    assert.equal(evaluate(readThreadsZeroTerminal, fixture), null, name);
  }
}

function testObservedDialogAndRichBody() {
  const fixture = modalFixture();
  assert.equal(fixture.time.closest("a"), null, "the observed modal TIME has no permalink anchor");
  assert.equal(fixture.card.children[0], fixture.avatar);
  assert.equal(fixture.avatar.tagName, "DIV", "the native avatar branch is a DIV, not the profile link itself");
  assert.equal(fixture.avatar.firstElementChild, fixture.avatarLink);
  assert.equal(fixture.avatarLink.firstElementChild, fixture.avatarImage);
  assert.equal(fixture.root.querySelectorAll(`img[alt="${expected.account}的大頭貼照"]`).length, 2,
    "native own-account avatars occur separately in composer and add-thread branches");
  assert.equal(fixture.composer.contains(fixture.addThreadAvatar), false);
  assert.equal(fixture.time.getAttribute("datetime"), zeroFixture().focus.time.getAttribute("datetime"));
  assert.deepEqual(fixture.bodyBranch.children, [fixture.bodyShell], "the fourth card branch has one native DIV shell");
  assert.equal(fixture.bodyShell.tagName, "DIV");
  assert.deepEqual(fixture.bodyShell.children, [fixture.context, fixture.content]);
  assert.equal(fixture.context.innerText, `正在回覆@${expected.account}`, "observed ancestor context has no inserted space");
  const observed = evaluate(readThreadsSelectedDialog, fixture);
  assert.ok(observed, "observed four-child parent card, nested author avatar and two own-avatar branches must parse");
  assert.notEqual(Object.getPrototypeOf(observed), Object.prototype);
  assert.deepEqual(localJson(observed), {
    author: expected.author, body: expected.body, displayedAt: expected.displayedAt,
    targetDatetime: expected.targetDatetime, ancestorAuthor: expected.account, account: expected.account,
    composerText: "", composerEmpty: true, placeholder: `回覆 ${expected.author}……`, terminal: false,
  });
  assertCandidateOnly(observed);
  const spacedContext = modalFixture();
  spacedContext.context.replaceChildren(` 正在回覆 \n\t@${expected.account} `);
  assert.ok(evaluate(readThreadsSelectedDialog, spacedContext), "normalized whitespace before the exact complete handle is equivalent");
  fixture.textbox.append("Existing unapproved draft");
  const draft = evaluate(readThreadsSelectedDialog, fixture, { ...expected, reply_text: "Caller proposed replacement" });
  assert.equal(draft.composerText, "Existing unapproved draft", "pure observation reports actual text; caller reply cannot replace it");
  assert.equal(draft.composerEmpty, false);
  assertCandidateOnly(draft);
  const rich = modalFixture();
  rich.content.replaceChildren("Cafe\u0301 ", el("img", { alt: "🙂" }), el("br"), el("p", {}, ["第二行"]), el("div", {}, ["Last block"]));
  assert.equal(evaluate(readThreadsSelectedDialog, rich, { ...expected, body: "Café 🙂 第二行 Last block" }).body, "Café 🙂 第二行 Last block");
  rich.textbox.attrs["aria-placeholder"] = `回覆${expected.author}⋯⋯`;
  assert.ok(evaluate(readThreadsSelectedDialog, rich, { ...expected, body: "Café 🙂 第二行 Last block" }), "both supported Chinese ellipsis spellings preserve exact author binding");
  const nestedTime = modalFixture();
  nestedTime.header.replaceChildren(nestedTime.profile);
  nestedTime.header.append(el("div", {}, [el("span", {}, [nestedTime.time])]));
  assert.ok(evaluate(readThreadsSelectedDialog, nestedTime), "native TIME may be nested within the same header without a permalink");
  for (const child of [el("br"), el("img", { alt: "🙂" }), el("span", { hidden: "true" }, ["Hidden draft"])]) {
    const empty = modalFixture(); empty.textbox.append(child);
    assert.equal(evaluate(readThreadsSelectedDialog, empty).composerEmpty, child.tagName === "BR",
      "a blank lexical line is empty; image-only and hidden drafts are not");
  }
}

function testDialogParentAndBodyRejections() {
  for (const [name, change] of [
    ["wrong author avatar href", (f) => { f.avatarLink.attrs.href = "/@another.reader"; }],
    ["wrong author avatar alt", (f) => { f.avatarImage.attrs.alt = "another.reader的大頭貼照"; }],
    ["profile anchor substituted for native avatar DIV", (f) => f.card.replaceChildren(f.avatarLink, f.header, f.connector, f.bodyBranch)],
    ["duplicate nested author profile", (f) => f.avatarLink.append(el("a", { href: `/@${expected.author}` }))],
    ["ambiguous sibling author profile", (f) => f.avatar.append(el("a", { href: "/@another.reader" }))],
    ["duplicate nested author avatar", (f) => f.avatarLink.append(el("div", {}, [el("img", { alt: `${expected.author}的大頭貼照` })]))],
    ["author avatar outside profile anchor", (f) => { f.avatarLink.replaceChildren(); f.avatar.append(f.avatarImage); }],
    ["wrong header author href", (f) => { f.profile.attrs.href = "/@another.reader"; }],
    ["partial author label", (f) => f.profile.replaceChildren("example.read")],
    ["duplicate header profile", (f) => f.header.append(el("a", { href: `/@${expected.author}` }, [expected.author]))],
    ["wrong native datetime", (f) => { f.time.attrs.datetime = "2026-08-31T00:00:01.000Z"; }],
    ["wrong displayed timestamp", (f) => f.time.replaceChildren("2m")],
    ["time inside anchor", (f) => f.header.replaceChildren(f.profile, el("a", { href: expected.targetPath }, [f.time]))],
    ["duplicate time", (f) => f.header.append(el("time", { datetime: expected.targetDatetime }, [expected.displayedAt]))],
    ["hidden time", (f) => { f.time.attrs.hidden = "true"; }],
    ["wrong ancestor", (f) => f.context.replaceChildren("正在回覆 @another.owner")],
    ["ancestor label partial", (f) => f.context.replaceChildren("正在回覆 @example.own")],
    ["ancestor label extra content", (f) => f.context.append(" and another parent")],
    ["ancestor label has extra prefix", (f) => f.context.replaceChildren(`Other text 正在回覆@${expected.account}`)],
    ["ancestor handle contains whitespace", (f) => f.context.replaceChildren("正在回覆@example. owner")],
    ["ancestor context missing at sign", (f) => f.context.replaceChildren(`正在回覆${expected.account}`)],
    ["hidden ancestor suffix", (f) => f.context.append(el("span", { hidden: "true" }, ["Another parent"]))],
    ["aria-hidden ancestor suffix", (f) => f.context.append(el("span", { "aria-hidden": "true" }, ["Another parent"]))],
    ["body is a matching fragment", (f) => f.content.replaceChildren("complete")],
    ["body edited", (f) => f.content.replaceChildren("Useful edited update")],
    ["body has extra text", (f) => f.content.append(" Another sentence")],
    ["body has extra descendant", (f) => f.content.append(el("span", {}, [" Another sentence"]))],
    ["extra body branch", (f) => f.bodyBranch.append(el("div", {}, ["Unobserved body fragment"]))],
    ["extra direct body text", (f) => f.bodyBranch.append("Unobserved body fragment")],
    ["previous direct-two-child body shape", (f) => f.bodyBranch.replaceChildren(f.context, f.content)],
    ["missing body shell", (f) => f.bodyBranch.replaceChildren()],
    ["multiple body shells", (f) => f.bodyBranch.append(el("div"))],
    ["non-DIV body shell", (f) => { f.bodyShell.tagName = "SPAN"; }],
    ["extra wrapping shell", (f) => f.bodyBranch.replaceChildren(el("div", {}, [f.bodyShell]))],
    ["missing shell context", (f) => f.bodyShell.replaceChildren(f.content)],
    ["missing shell body", (f) => f.bodyShell.replaceChildren(f.context)],
    ["extra shell child", (f) => f.bodyShell.append(el("div"))],
    ["extra direct shell text", (f) => f.bodyShell.append("Unobserved body fragment")],
    ["hidden body branch", (f) => { f.bodyBranch.attrs.hidden = "true"; }],
    ["aria-hidden body branch", (f) => { f.bodyBranch.attrs["aria-hidden"] = "true"; }],
    ["hidden body shell", (f) => { f.bodyShell.attrs.hidden = "true"; }],
    ["aria-hidden body shell", (f) => { f.bodyShell.attrs["aria-hidden"] = "true"; }],
    ["hidden ancestor context", (f) => { f.context.attrs.hidden = "true"; }],
    ["aria-hidden ancestor context", (f) => { f.context.attrs["aria-hidden"] = "true"; }],
    ["aria-hidden body node", (f) => { f.content.attrs["aria-hidden"] = "true"; }],
    ["extra direct card text", (f) => f.card.append("Unobserved parent fragment")],
    ["hidden body", (f) => { f.content.attrs.hidden = "true"; }],
    ["hidden body suffix", (f) => f.content.append(el("span", { hidden: "true" }, ["Unobserved suffix"]))],
    ["aria-hidden substantive body", (f) => f.content.replaceChildren(el("span", { "aria-hidden": "true" }, [expected.body]))],
    ["collapsed body", (f) => { f.content.attrs["aria-expanded"] = "false"; }],
    ["collapsed descendant", (f) => f.content.append(el("span", { "aria-expanded": "false" }))],
    ["truncation button", (f) => f.content.append(el("button", {}, ["查看更多"]))],
    ["truncation role button", (f) => f.content.append(el("div", { role: "button" }, ["See more"]))],
    ["connector text", (f) => f.connector.append("Another parent")],
    ["connector interactive node", (f) => f.connector.append(el("div", { role: "button" }))],
    ["extra parent card child", (f) => f.card.append(el("div"))],
    ["duplicate parent card", (f) => f.root.append(modalFixture().card)],
  ]) {
    const fixture = modalFixture(); change(fixture);
    assert.equal(evaluate(readThreadsSelectedDialog, fixture), null, name);
  }
}

function testDialogComposerAndStructureRejections() {
  for (const [name, change] of [
    ["wrong dialog role", (f) => { f.root.attrs.role = "region"; }],
    ["nonmodal dialog", (f) => { f.root.attrs["aria-modal"] = "false"; }],
    ["hidden modal", (f) => { f.root.attrs.hidden = "true"; }],
    ["nested duplicate dialog", (f) => f.root.append(el("div", { role: "dialog" }))],
    ["wrong heading", (f) => f.heading.replaceChildren("New post")],
    ["duplicate heading", (f) => f.root.append(el("h2", {}, ["回覆"]))],
    ["pending status", (f) => f.root.append(el("div", { role: "status" }))],
    ["pending progress", (f) => f.root.append(el("div", { role: "progressbar" }))],
    ["busy descendant", (f) => f.root.append(el("div", { "aria-busy": "true" }))],
    ["busy dialog", (f) => { f.root.attrs["aria-busy"] = "true"; }],
    ["duplicate textbox", (f) => f.composer.append(el("div", { ...f.textbox.attrs }))],
    ["textbox is not a DIV", (f) => { f.textbox.tagName = "TEXTAREA"; }],
    ["noneditable textbox", (f) => { f.textbox.attrs.contenteditable = "false"; }],
    ["nonlexical textbox", (f) => { delete f.textbox.attrs["data-lexical-editor"]; }],
    ["textbox within parent card", (f) => { f.composer.replaceChildren(f.ownAvatar, f.ownLabel); f.connector.append(f.textbox); }],
    ["wrong placeholder author", (f) => { f.textbox.attrs["aria-placeholder"] = "回覆 another.reader……"; }],
    ["partial placeholder author", (f) => { f.textbox.attrs["aria-placeholder"] = "回覆 example.read……"; }],
    ["missing placeholder", (f) => { delete f.textbox.attrs["aria-placeholder"]; }],
    ["partial ellipsis", (f) => { f.textbox.attrs["aria-placeholder"] = `回覆 ${expected.author}…`; }],
    ["composer avatar account mismatch", (f) => { f.ownAvatar.attrs.alt = "another.owner的大頭貼照"; }],
    ["add-thread avatar account mismatch", (f) => { f.addThreadAvatar.attrs.alt = "another.owner的大頭貼照"; }],
    ["malformed third own avatar in composer", (f) => f.composer.append(el("img", { alt: `${expected.account}的大頭貼照` }))],
    ["malformed nested extra own avatar", (f) => f.addThreadBranch.append(el("div", {}, [el("img", { alt: `${expected.account}的大頭貼照` })]))],
    ["missing composer avatar", (f) => f.composer.replaceChildren(f.ownLabel, f.textbox)],
    ["missing add-thread avatar", (f) => f.addThreadBranch.replaceChildren()],
    ["both own avatars in composer branch", (f) => { f.addThreadBranch.replaceChildren(); f.composer.append(f.addThreadAvatar); }],
    ["partial own account text", (f) => f.ownLabel.replaceChildren("example.own")],
    ["own account is only a prefix", (f) => f.ownLabel.replaceChildren("example.owner.other")],
    ["duplicate own account label", (f) => f.composer.append(el("span", {}, [expected.account]))],
    ["wrong own account text", (f) => f.ownLabel.replaceChildren("another.owner")],
    ["foreign own-composer profile", (f) => f.composer.append(el("a", { href: "/@another.owner" }))],
    ["own composer context includes parent card", (f) => { f.root.replaceChildren(f.heading, f.composer, f.submit); f.composer.append(f.card); }],
    ["missing submit", (f) => f.submit.replaceChildren("Other action")],
    ["duplicate submit", (f) => f.root.append(el("button", {}, ["發佈"]))],
    ["submit inside parent card", (f) => { f.root.replaceChildren(f.heading, f.card, f.composer); f.connector.append(f.submit); }],
  ]) {
    const fixture = modalFixture(); change(fixture);
    assert.equal(evaluate(readThreadsSelectedDialog, fixture), null, name);
  }
}

const action = Object.freeze({
  action_id: "anonymous-action", intent_id: "anonymous-intent", session_id: "anonymous-session",
  permit_id: "anonymous-permit", comment_fingerprint: "anonymous-fingerprint",
  reply_text: "hello", reply_hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  expected_body: expected.body, author_key: expected.author, post_permalink: expected.postUrl,
  scope: { platform: "threads", account_key: expected.account, post_key: expected.postId, comment_key: expected.commentId },
  comment_anchor: { platform_comment_id: expected.commentId, comment_permalink: expected.commentUrl },
});

class Locator {
  constructor(fixture, nodes) { this.fixture = fixture; this.nodes = nodes; }
  locator(selector) { return new Locator(this.fixture, this.nodes.flatMap((node) => node.querySelectorAll(selector))); }
  filter({ has }) { return new Locator(this.fixture, this.nodes.filter((node) => has.nodes.some((child) => node.contains(child)))); }
  getByRole(role, options = {}) {
    const selector = role === "button" ? 'button,[role="button"]' : `[role="${role}"]`;
    const located = new Locator(this.fixture, this.nodes.flatMap((node) => node.querySelectorAll(selector))
      .filter((node) => !options.name || (node.getAttribute("aria-label") || node.innerText) === options.name));
    if (role === "button" && options.name === "發佈" && this.fixture.dialogOpen) {
      this.fixture.submitLookups += 1;
      this.fixture.afterSubmitLookup?.(this.fixture);
    }
    return located;
  }
  nth(index) { return new Locator(this.fixture, this.nodes.slice(index, index + 1)); }
  async count() { return this.nodes.length; }
  async isVisible() { return this.nodes.length === 1 && this.nodes[0].getClientRects().length > 0; }
  async isEnabled() { return this.nodes.length === 1 && !this.nodes[0].hasAttribute("disabled"); }
  async getAttribute(name) { assert.equal(this.nodes.length, 1); return this.nodes[0].getAttribute(name); }
  async waitFor(options) {
    assert.equal(options.state, "visible");
    assert.ok([10000, 15000].includes(options.timeoutMs));
    this.fixture.waits.push(options.timeoutMs);
    await this.fixture.beforeWait?.(this, options);
    if (!(await this.isVisible())) throw new Error("anonymous native readiness requires exactly one visible node");
  }
  async click() {
    assert.equal(this.nodes.length, 1);
    assert.equal(this.nodes[0], this.fixture.zero.focus.reply, "only the exact native reply opener can be clicked");
    this.fixture.clicks += 1;
    assert.ok(this.fixture.clicks <= 1, "source selection never retries an uncertain click");
    if (this.fixture.ambiguousClick) throw new Error("ambiguous anonymous reply-opening click");
    this.fixture.openDialog();
  }
  async evaluate(callback, input) {
    assert.equal(this.nodes.length, 1, "real callback evaluation requires exactly one native node");
    this.fixture.callbacks.push(callback.name);
    const result = evaluate(callback, { root: this.nodes[0] }, input);
    this.fixture.onEvaluate?.(callback.name, this.fixture);
    return result;
  }
}

function sourceFixture(options = {}) {
  const fixture = { zero: zeroFixture(), modal: modalFixture(), url: expected.commentUrl,
    submitLookups: 0, clicks: 0,
    dialogOpen: false, waits: [], callbacks: [], ...options };
  fixture.zero.original.reply.append("3");
  fixture.account = el("a", { role: "link", href: `/@${expected.account}` }, [el("svg", { "aria-label": "個人檔案" })]);
  const title = el("a", { href: expected.targetPath }, [el("h1", {}, ["Thread"])]);
  fixture.document = el("div", {}, [fixture.account, title, fixture.zero.root]);
  fixture.openDialog = () => { fixture.dialogOpen = true; fixture.document.append(fixture.modal.root); };
  if (fixture.preexistingDialog) fixture.openDialog();
  fixture.tab = { id: "anonymous-canary-tab", url: async () => fixture.url,
    playwright: new Locator(fixture, [fixture.document]) };
  return fixture;
}

function assertIncompleteCandidate(result) {
  assert.equal(result.complete, false);
  assert.equal(result.exhaustiveThread, result.zeroThreadTerminalCandidate);
  assert.equal(result.absence_proven, false);
  assert.equal(Object.hasOwn(result, "verifiedNewReply"), false);
  assert.equal(Object.hasOwn(result, "replyPermalink"), false);
}

async function testSourceOwnedPreparationCandidates() {
  const readOnly = sourceFixture();
  const first = await inspectThreadsCanarySurface(readOnly.tab, action);
  const second = await inspectThreadsCanarySurface(readOnly.tab, action);
  assertIncompleteCandidate(first); assertIncompleteCandidate(second);
  assert.equal(first.zeroThreadTerminalCandidate, false);
  assert.equal(second.zeroThreadTerminalCandidate, true);
  assert.equal(readOnly.clicks, 0);
  assert.equal(second.replyExhaustionCandidate.kind, "threads_explicit_zero");
  assert.equal(second.replyExhaustionCandidate.observed_count, 0);
  const fixture = sourceFixture();
  assert.equal(fixture.tab.playwright.fill, undefined);
  assert.equal(fixture.tab.dom_cua, undefined);
  const selected = await prepareThreadsCanaryReply(fixture.tab, action);
  assertIncompleteCandidate(selected);
  assert.equal(selected.selectedParentCandidate, true);
  assert.equal(selected.selection.candidate_only, true);
  assert.equal(selected.selection.trigger_binding.comment_permalink, expected.commentUrl);
  assert.equal(Object.hasOwn(selected.selection, "composer_node_id"), false);
  assert.equal(selected.composerEmpty, true);
  assert.equal(fixture.clicks, 1);
  assert.ok(fixture.callbacks.includes("readThreadsNativeColumn") && fixture.callbacks.includes("readThreadsSelectedDialog"),
    "wrapper executes the real source reader and modal callbacks, never canned valid evidence");
  assert.ok(fixture.waits.includes(10000));
  await assert.rejects(prepareThreadsCanaryReply(fixture.tab, action), /already attempted|invalidated|changed/u);
  assert.equal(fixture.clicks, 1);
}

async function testSourceOwnedPreparationRejections() {
  const preexisting = sourceFixture({ preexistingDialog: true });
  await assert.rejects(prepareThreadsCanaryReply(preexisting.tab, action), /pre-existing.*no source selection/u);
  assert.equal(preexisting.clicks, 0);
  const drift = sourceFixture({ onEvaluate: (name, fixture) => {
    if (name === "readThreadsNativeColumn") fixture.url = "https://www.threads.com/@another.reader/post/OtherComment";
  } });
  await assert.rejects(prepareThreadsCanaryReply(drift.tab, action), /URL changed/u);
  assert.equal(drift.clicks, 0);
  const ambiguous = sourceFixture({ ambiguousClick: true });
  await assert.rejects(prepareThreadsCanaryReply(ambiguous.tab, action), /ambiguous anonymous/u);
  await assert.rejects(prepareThreadsCanaryReply(ambiguous.tab, action), /changed|invalidated|already attempted/u);
  assert.equal(ambiguous.clicks, 1);
  const wrongDialog = sourceFixture();
  wrongDialog.modal.content.replaceChildren("Another comment's body");
  await assert.rejects(prepareThreadsCanaryReply(wrongDialog.tab, action), /selected dialog differs/u);
  assert.equal(wrongDialog.clicks, 1);
  const draft = sourceFixture();
  draft.modal.textbox.append("Existing unapproved text");
  await assert.rejects(prepareThreadsCanaryReply(draft.tab, action), /composer differs|composer is not empty/u);
  assert.equal(draft.clicks, 1);
  const changedAction = sourceFixture();
  await inspectThreadsCanarySurface(changedAction.tab, action);
  await assert.rejects(prepareThreadsCanaryReply(changedAction.tab, { ...action, action_id: "another-action" }), /UI binding.*changed/u);
  assert.equal(changedAction.clicks, 0);
  const changedDuringTerminal = sourceFixture({ onEvaluate: (name, fixture) => {
    if (name === "readThreadsZeroTerminal") fixture.zero.focus.content.replaceChildren("Edited native body");
  } });
  await assert.rejects(prepareThreadsCanaryReply(changedDuringTerminal.tab, action), /changed during zero-thread/u);
  assert.equal(changedDuringTerminal.clicks, 0);
  const disabled = sourceFixture();
  disabled.zero.focus.reply.attrs.disabled = "true";
  await assert.rejects(prepareThreadsCanaryReply(disabled.tab, action), /trigger is not enabled/u);
  assert.equal(disabled.clicks, 0);
}

async function testFinalBoundSurfaceDriftRejections() {
  for (const [name, change, message] of [
    ["URL drift", (f) => { f.url = "https://www.threads.com/@another.reader/post/OtherComment"; }, /target URL changed/u],
    ["account drift", (f) => { f.account.attrs.href = "/@another.owner"; }, /active account changed/u],
    ["native whole-body drift", (f) => f.zero.focus.content.replaceChildren("Edited native body"), /exact native parent|native target changed/u],
    ["selected modal body drift", (f) => f.modal.content.replaceChildren("Edited modal body"), /selected dialog.*changed/u],
  ]) {
    const fixture = sourceFixture();
    const prepared = await prepareThreadsCanaryReply(fixture.tab, action);
    assert.equal(prepared.selectedParentCandidate, true);
    const before = { submitLookups: fixture.submitLookups };
    let changed = false;
    fixture.afterSubmitLookup = (f) => {
      assert.equal(changed, false, `${name}: one final lookup boundary, not a repeated retry`);
      changed = true;
      change(f);
    };
    // Inspect directly: a later prepare() stabilization pass must not hide a
    // missing final read in the single inspection returned to the caller.
    await assert.rejects(inspectThreadsCanarySurface(fixture.tab, action), message, name);
    assert.equal(changed, true, `${name}: regression reached the post-bind lookup boundary`);
    assert.equal(fixture.submitLookups, before.submitLookups + 1);
    assert.equal(fixture.clicks, 1, `${name}: drift never reopens or submits the dialog`);
  }
}

function resultFixture({ delayedRegion = false } = {}) {
  const fixture = sourceFixture();
  const childPath = `/@${expected.account}/post/OwnReply789`;
  const childUrl = `https://${expected.host}${childPath}`;
  fixture.zero.focus.reply.append("1");
  fixture.zero.focus.marker.replaceChildren();
  const observedChild = postRow({ path: childPath, author: expected.account, body: action.reply_text });
  fixture.zero.tailPagelet.append(observedChild.owner);
  const parentDocument = fixture.document;
  const childRoot = postRow({ path: expected.postPath, author: expected.account, body: "Root post", zero: false });
  const childOriginal = postRow({ path: expected.targetPath, author: expected.author, body: expected.body, zero: false });
  const childFocus = postRow({ path: childPath, author: expected.account, body: action.reply_text });
  const childRootRow = el("div", {}, [childRoot.owner]);
  const childParentRow = el("div", {}, [childOriginal.owner]);
  const childContext = el("div", { "data-pagelet": "threads_post_page_0" }, [childRootRow, childParentRow]);
  const childRegion = el("div", { role: "region", "aria-label": "直欄內文" }, [el("div", {}, [
    childContext,
    el("div", { "data-pagelet": "threads_post_page_1" }, [childFocus.owner]),
  ])]);
  const childDocument = el("div", {}, [
    el("a", { role: "link", href: `/@${expected.account}` }, [el("svg", { "aria-label": "個人檔案" })]),
    el("a", { href: childPath }, [el("h1", {}, ["Thread"])]), childRegion,
  ]);
  Object.assign(fixture, { childPath, childUrl, childRoot, childOriginal, childFocus, childDocument,
    childRootRow, childParentRow, childContext,
    parentDocument, observedChild, scene: "parent", navigations: [], discoveryReads: 0,
    regionReadiness: [] });
  fixture.beforeWait = async (locator) => {
    const region = fixture.document.querySelector('[role="region"]');
    if (delayedRegion && region?.attrs.hidden === "true" && locator.nodes.includes(region)) {
      await Promise.resolve();
      delete region.attrs.hidden;
      fixture.regionReadiness.push(fixture.url);
    }
  };
  fixture.tab.goto = async (url) => {
    assert.ok([expected.commentUrl, childUrl].includes(url), "navigation uses only the exact observed native child and original parent");
    fixture.navigations.push(url);
    fixture.scene = url === childUrl ? "child" : "parent";
    fixture.url = url;
    fixture.document = fixture.scene === "child" ? childDocument : parentDocument;
    if (delayedRegion) fixture.document.querySelector('[role="region"]').attrs.hidden = "true";
    fixture.tab.playwright = new Locator(fixture, [fixture.document]);
  };
  return fixture;
}

async function testPositiveChildReadback() {
  const fixture = resultFixture();
  const confirmed = await inspectThreadsCanaryResult(fixture.tab, action);
  assert.equal(confirmed.verifiedNewReply, true);
  assert.equal(confirmed.replyPermalink, fixture.childUrl);
  assert.equal(confirmed.observedUrl, expected.commentUrl);
  assert.equal(confirmed.absence_verified, false);
  assert.equal(confirmed.complete, false);
  assert.deepEqual(fixture.navigations, [fixture.childUrl, expected.commentUrl]);
  assert.equal(fixture.clicks, 0);

  const delayed = resultFixture({ delayedRegion: true });
  const delayedResult = await inspectThreadsCanaryResult(delayed.tab, action);
  assert.equal(delayedResult.verifiedNewReply, true);
  assert.equal(delayedResult.replyPermalink, delayed.childUrl);
  assert.deepEqual(delayed.regionReadiness, [delayed.childUrl, expected.commentUrl],
    "both child navigation and parent restoration await delayed visible regions before uniqueness checks");
  assert.equal(delayed.clicks, 0);
  const delayedWrongParent = resultFixture({ delayedRegion: true });
  delayedWrongParent.childOriginal.anchor.attrs.href = "/@other.reader/post/WrongParent";
  await assert.rejects(inspectThreadsCanaryResult(delayedWrongParent.tab, action), /native parent context/u,
    "waiting for region visibility never relaxes the immediate-parent check");
  assert.equal(delayedWrongParent.url, expected.commentUrl);
  assert.equal(delayedWrongParent.clicks, 0);

  for (const [name, change, error] of [
    ["wrong immediate parent", (f) => { f.childOriginal.anchor.attrs.href = "/@other.reader/post/WrongParent"; }, /native parent context/u],
    ["wrong original ancestor", (f) => { f.childRoot.anchor.attrs.href = "/@example.owner/post/WrongRoot"; }, /native parent context/u],
    ["reversed context rows", (f) => f.childContext.replaceChildren(f.childParentRow, f.childRootRow), /native parent context/u],
    ["missing original row", (f) => f.childContext.replaceChildren(f.childParentRow), /native parent context/u],
    ["extra context row", (f) => f.childContext.append(el("div")), /native parent context/u],
    ["hidden original row", (f) => { f.childRootRow.attrs.hidden = "true"; }, /native parent context/u],
    ["hidden immediate parent time", (f) => { f.childOriginal.time.attrs.hidden = "true"; }, /native parent context/u],
    ["nested parent decoy", (f) => f.childParentRow.replaceChildren(el("div", {}, [f.childOriginal.owner])), /native parent context/u],
    ["nested extra owner", (f) => f.childOriginal.owner.append(el("div", { "data-pressable-container": "true" })), /native parent context/u],
    ["extra native time", (f) => f.childOriginal.header.append(el("time", {}, ["2m"])), /native parent context/u],
    ["wrong child author", (f) => { f.childFocus.profile.attrs.href = "/@another.owner"; }, /native parent context/u],
    ["wrong whole reply body", (f) => f.childFocus.content.replaceChildren("Unapproved reply text"), /approved text and immediate parent/u],
    ["child URL drift", (f) => { f.onEvaluate = (callback, state) => {
      if (state.scene === "child" && callback === "readThreadsNativeColumn") state.url = "https://www.threads.com/@another.owner/post/WrongURL";
    }; }, /URL changed/u],
  ]) {
    const changed = resultFixture();
    change(changed);
    await assert.rejects(inspectThreadsCanaryResult(changed.tab, action), error, name);
    assert.equal(changed.url, expected.commentUrl, `${name}: restore original parent after unknown result`);
    assert.equal(changed.clicks, 0, `${name}: result inspection never submits`);
  }

  const zero = sourceFixture();
  await assert.rejects(inspectThreadsCanaryResult(zero.tab, action), /no verified parent with a positive native reply count/u);
  assert.equal(zero.clicks, 0);
  const absent = resultFixture();
  absent.zero.tailPagelet.replaceChildren();
  await assert.rejects(inspectThreadsCanaryResult(absent.tab, action), /no unique own child candidate/u);
  assert.deepEqual(absent.navigations, [], "no candidate does not navigate or imply absence");

  const finalDrift = resultFixture();
  finalDrift.onEvaluate = (callback, state) => {
    if (callback === "discoverThreadsOwnChildLinks" && ++state.discoveryReads === 2) {
      state.url = "https://www.threads.com/@another.owner/post/WrongURL";
    }
  };
  await assert.rejects(inspectThreadsCanaryResult(finalDrift.tab, action), /URL changed|context changed/u,
    "URL drift during the final candidate read must not return success");
}

async function testCuaChildUsesNewOwnedTabWithoutParentNavigation() {
  let active;
  let sequence = 0;
  const browserId = "anonymous-cua-browser";
  const cua = {
    async getState() {
      active.stateReads += 1;
      return { browsers: [{ id: browserId, family: "chrome", type: "extension",
        metadata: { extensionInstanceId: active.extension ?? "anonymous-cua-extension" },
        tabs: [
          { id: active.parent.tab.id, url: active.parent.url },
          { id: `existing-child-${sequence}`, url: active.parent.childUrl },
          ...(active.child && !active.child.closed ? [{ id: active.child.tab.id, url: active.child.url }] : []),
        ],
      }] };
    },
    async getTab(id, options) {
      active.gets.push(id);
      assert.equal(options.browser, browserId);
      assert.equal(id, active.parent.tab.id, "result inspection cannot borrow an already listed child");
      return active.parent.tab;
    },
    async createBrowserTab(browser, url, options) {
      active.creates.push(url);
      assert.equal(browser, "chrome");
      assert.equal(url, active.parent.childUrl, "only the exact own-child link discovered in native DOM may be opened");
      assert.equal(options.sessionName, "💬 Social Post");
      if (active.creationError) throw active.creationError;
      const parent = active.parent;
      const child = { ...parent, url, scene: "child", document: parent.childDocument,
        waits: [], callbacks: [], closed: false, closes: 0,
        onEvaluate: (name, state) => active.onChildEvaluate?.(name, state) };
      child.tab = { id: `created-child-${sequence}`, url: async () => child.url,
        playwright: new Locator(child, [child.document]),
        goto: async () => { active.forbidden.push("child goto"); throw new Error("CUA result never navigates child"); },
        close: async () => { child.closes += 1; child.closed = true; },
      };
      active.child = child;
      return child.tab;
    },
  };
  function nextCase() {
    sequence += 1;
    const parent = resultFixture();
    parent.tab.id = `cua-parent-${sequence}`;
    const test = { parent, child: null, gets: [], creates: [], stateReads: 0, forbidden: [] };
    parent.tab.goto = async () => { test.forbidden.push("parent goto"); throw new Error("CUA result must preserve parent navigation"); };
    parent.tab.close = async () => { test.forbidden.push("parent close"); throw new Error("CUA result cannot close parent"); };
    active = test;
    return test;
  }
  async function inspect(test) {
    active = test;
    const parent = await getCommentCuaBrowser().tabs.get(test.parent.tab.id);
    return inspectThreadsCanaryResult(parent, action);
  }
  function assertReadOnlyLifecycle(test, created = true) {
    assert.deepEqual(test.forbidden, []);
    assert.deepEqual(test.gets, [test.parent.tab.id], "no get/reclaim on an existing child tab");
    assert.equal(test.creates.length, created ? 1 : 0, "no creation or navigation retries");
    assert.equal(test.parent.clicks, 0);
    assert.deepEqual(test.parent.navigations, []);
    if (test.child) {
      assert.equal(test.child.closes, 1, "close only the one owned child tab, including on failed proof");
      assert.equal(test.child.clicks, 0);
    }
  }
  const positive = nextCase();
  await installCommentCuaRuntime(cua, { browserId });
  const observed = await inspect(positive);
  assert.equal(observed.verifiedNewReply, true);
  assert.equal(observed.replyPermalink, positive.parent.childUrl);
  assert.equal(observed.observedUrl, expected.commentUrl);
  assert.equal(observed.complete, false);
  assert.equal(observed.absence_verified, false);
  assert.ok(positive.stateReads >= 12, "fresh browser ownership surrounds both original-parent and child inspections");
  assert.equal(positive.child.callbacks.filter((name) => name === "readThreadsNativeColumn").length, 2);
  assert.equal(positive.parent.callbacks.filter((name) => name === "readThreadsNativeColumn").length, 3,
    "the unchanged original parent is read initially and twice after the child proof");
  assertReadOnlyLifecycle(positive);

  for (const [name, mutate, error] of [
    ["wrong immediate parent", (t) => { t.parent.childOriginal.anchor.attrs.href = "/@other.reader/post/WrongParent"; }, /native parent context/u],
    ["wrong original ancestor", (t) => { t.parent.childRoot.anchor.attrs.href = "/@example.owner/post/WrongRoot"; }, /native parent context/u],
    ["reversed ancestors", (t) => t.parent.childContext.replaceChildren(t.parent.childParentRow, t.parent.childRootRow), /native parent context/u],
    ["wrong own author", (t) => { t.parent.childFocus.profile.attrs.href = "/@another.owner"; }, /native parent context/u],
    ["wrong full body", (t) => t.parent.childFocus.content.replaceChildren("Not the approved reply"), /approved text and immediate parent/u],
    ["child URL drift", (t) => { t.onChildEvaluate = (name, state) => {
      if (name === "readThreadsNativeColumn") state.url = "https://www.threads.com/@another.owner/post/WrongURL";
    }; }, /URL changed/u],
    ["child ID drift", (t) => { t.onChildEvaluate = (name, state) => {
      if (name === "readThreadsNativeColumn") state.tab.id = `changed-child-${sequence}`;
    }; }, /tab|identity/u],
    ["child retained handle drift", (t) => { t.onChildEvaluate = (name, state) => {
      if (name === "readThreadsNativeColumn") state.tab.url = async () => state.url;
    }; }, /retained CUA Tab handle changed/u],
    ["browser extension drift", (t) => { t.onChildEvaluate = (name) => {
      if (name === "readThreadsNativeColumn") t.extension = "changed-extension";
    }; }, /extensionInstanceId changed/u],
    ["parent URL drift while child inspected", (t) => { t.onChildEvaluate = (name) => {
      if (name === "readThreadsNativeColumn") t.parent.url = "https://www.threads.com/@another.owner/post/WrongURL";
    }; }, /URL differs|URL changed/u],
    ["final parent body drift", (t) => { t.parent.onEvaluate = (name, state) => {
      if (name === "discoverThreadsOwnChildLinks" && ++state.discoveryReads === 2) state.zero.focus.content.replaceChildren("Changed parent body");
    }; }, /verified parent/u],
    ["final parent URL drift", (t) => { t.parent.onEvaluate = (name, state) => {
      if (name === "discoverThreadsOwnChildLinks" && ++state.discoveryReads === 2) state.url = "https://www.threads.com/@another.owner/post/WrongURL";
    }; }, /URL changed/u],
  ]) {
    const test = nextCase(); mutate(test);
    await assert.rejects(inspect(test), error, name);
    assertReadOnlyLifecycle(test);
  }
  const missing = nextCase();
  missing.parent.zero.tailPagelet.replaceChildren();
  await assert.rejects(inspect(missing), /no unique own child candidate/u);
  assertReadOnlyLifecycle(missing, false);

  const creationFailed = nextCase();
  creationFailed.creationError = new Error("documented CUA creation failed");
  await assert.rejects(inspect(creationFailed), (error) => error === creationFailed.creationError);
  assertReadOnlyLifecycle(creationFailed);
  assert.equal(creationFailed.child, null, "creation failure cannot fall back to navigating the parent");
}

testObservedZeroTerminal();
testZeroLayoutAndChildrenRejections();
testZeroMarkerPendingAndIdentityRejections();
testObservedDialogAndRichBody();
testDialogParentAndBodyRejections();
testDialogComposerAndStructureRejections();
await testSourceOwnedPreparationCandidates();
await testSourceOwnedPreparationRejections();
await testFinalBoundSurfaceDriftRejections();
await testPositiveChildReadback();
await testCuaChildUsesNewOwnedTabWithoutParentNavigation();
const revalidation = sourceFixture();
const prepared = await prepareThreadsCanaryReply(revalidation.tab, action);
revalidation.modal.textbox.append(action.reply_text);
const ready = await revalidateThreadsSelection(revalidation.tab, action);
assert.equal(ready.selection_digest, prepared.selection_digest);
assert.equal(ready.composerText, action.reply_text);
revalidation.modal.textbox.attrs.hidden = "true";
await assert.rejects(revalidateThreadsSelection(revalidation.tab, action), /selected dialog differs/u);
assert.equal(revalidation.clicks, 1);
assert.ok(calls.zero >= 45 && calls.modal >= 50, "real callback execution covers anonymous positive and negative DOM shapes");
assert.equal(calls.clicks, 0);
assert.equal(calls.fills, 0);
console.log("PASS Threads source-selected empty preparation and native DOM readers (anonymous; no browser submission)");

/** Anonymous Threads icon identity tests; real DOM callbacks, no browser or mutation. */
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import {
  assertStableNodeSurface, bindObservedSubmitNode, bindObservedThreadsReplyIconNode,
} from "./comment_chrome_node_identity.mjs";
import {
  assertStableNodeSurface as facadeAssertStableNodeSurface,
  bindObservedSubmitNode as facadeBindObservedSubmitNode,
  bindObservedThreadsReplyIconNode as facadeBindObservedThreadsReplyIconNode,
} from "./comment_chrome_send_support.mjs";

assert.strictEqual(facadeAssertStableNodeSurface, assertStableNodeSurface);
assert.strictEqual(facadeBindObservedSubmitNode, bindObservedSubmitNode);
assert.strictEqual(facadeBindObservedThreadsReplyIconNode, bindObservedThreadsReplyIconNode);

const iconLine = (id = "35", text = "回覆", attributes = 'role="button"') =>
  `<div node_id=${id} ${attributes}>${text}</div>`;
const fixtures = [];

function matches(element, selector) {
  return selector.split(",").some((part) => {
    const simple = part.trim();
    const tag = simple.match(/^[A-Za-z][A-Za-z0-9-]*/u)?.[0];
    if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    for (const match of simple.matchAll(/\[([^\]=\s]+)(?:="([^"]*)")?\]/gu)) {
      if (!element.hasAttribute(match[1])) return false;
      if (match[2] !== undefined && element.getAttribute(match[1]) !== match[2]) return false;
    }
    return true;
  });
}

class Element {
  constructor(tag, attributes = {}, children = []) {
    this.nodeType = 1;
    this.tagName = ["svg", "title", "path"].includes(tag) ? tag : tag.toUpperCase();
    this.localName = tag.toLowerCase();
    this.attributes = attributes;
    this.childNodes = [];
    this.parentElement = null;
    for (const child of children) this.append(child);
  }
  append(child) {
    const node = typeof child === "string" ? {
      nodeType: 3, nodeValue: child, get textContent() { return this.nodeValue; },
    } : child;
    node.parentElement = this;
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  get children() { return this.childNodes.filter((child) => child.nodeType === 1); }
  get firstElementChild() { return this.children[0] ?? null; }
  get textContent() { return this.childNodes.map((node) => node.nodeType === 3 ? node.nodeValue : node.textContent).join(""); }
  get innerText() {
    if (!this.getClientRects().length) return "";
    return this.childNodes.map((node) => node.nodeType === 3 ? node.nodeValue : node.innerText).join("");
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  getClientRects() {
    // SVG TITLE is metadata, not rendered text, even while the icon is visible.
    if (this.localName === "title") return [];
    for (let node = this; node; node = node.parentElement) if (node.attributes.hidden === "true") return [];
    return [{ x: 10, y: 10, width: 24, height: 24 }];
  }
  matches(selector) { return matches(this, selector); }
  contains(child) {
    for (let node = child; node; node = node.parentElement) if (node === this) return true;
    return false;
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
const el = (tag, attrs = {}, children = []) => new Element(tag, attrs, children);

function setup({ snapshots = [iconLine()], beforeEvaluate, beforeSnapshot } = {}) {
  const title = el("title", {}, ["回覆"]);
  const path = el("path", { d: "M1 1L2 2" });
  const svg = el("svg", { role: "img", "aria-label": "回覆" }, [title, path]);
  const iconWrapper = el("span", {}, [svg]);
  const emptyWrapper = el("span");
  const button = el("div", { role: "button" }, [iconWrapper, emptyWrapper]);
  const fixture = { title, path, svg, iconWrapper, emptyWrapper, button,
    evaluations: 0, snapshotReads: 0, crossRealmResults: 0, clicks: 0, fills: 0, events: [] };
  const locator = {
    count: async () => 1,
    isVisible: async () => button.getClientRects().length > 0,
    isEnabled: async () => !button.hasAttribute("disabled") && button.getAttribute("aria-disabled") !== "true",
    getAttribute: async (name) => button.getAttribute(name),
    evaluate: async (callback, input) => {
      fixture.evaluations += 1;
      fixture.events.push("evaluate");
      beforeEvaluate?.(fixture, fixture.evaluations);
      const value = runInNewContext(`(${callback.toString()})(element, input)`, {
        element: button, input, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
      });
      if (value && typeof value === "object") {
        assert.notEqual(Object.getPrototypeOf(value), Object.prototype, "source callback result must remain in its own VM realm");
        fixture.crossRealmResults += 1;
      }
      return value;
    },
    click: async () => { fixture.clicks += 1; throw new Error("test forbids locator click"); },
    fill: async () => { fixture.fills += 1; throw new Error("test forbids fill"); },
  };
  const tab = { dom_cua: {
    get_visible_dom: async () => {
      fixture.snapshotReads += 1;
      fixture.events.push("snapshot");
      beforeSnapshot?.(fixture, fixture.snapshotReads);
      return snapshots[Math.min(fixture.snapshotReads - 1, snapshots.length - 1)];
    },
    click: async () => { fixture.clicks += 1; throw new Error("test forbids DOM-CUA click"); },
  } };
  Object.assign(fixture, { locator, tab, bind: () => bindObservedThreadsReplyIconNode(tab, locator) });
  fixtures.push(fixture);
  return fixture;
}

async function testNativeIconMetadataPositiveAndGenericIsolation() {
  const good = setup();
  assert.equal(good.button.innerText, "");
  assert.equal(good.button.textContent, "回覆");
  assert.equal(good.button.hasAttribute("aria-label"), false);
  assert.equal(good.svg.getClientRects().length, 1);
  assert.equal(good.title.getClientRects().length, 0, "non-rendered SVG TITLE metadata is the native accessible icon label");
  assert.equal(await good.bind(), "35");
  assert.ok(good.evaluations >= 2, "two independent source identity evaluations are mandatory");
  assert.ok(good.snapshotReads >= 2, "fresh DOM-CUA snapshots must bind the same exact node ID");
  assert.equal(good.crossRealmResults, good.evaluations, "all actual source callback results retain cross-realm prototypes");
  assert.equal(good.events[0], "snapshot");
  assert.equal(good.events.at(-1), "snapshot");

  const generic = setup();
  await assert.rejects(bindObservedSubmitNode(generic.tab, generic.locator), /exactly one visible DOM node, found 0/u,
    "generic binding must still use empty innerText, with no universal icon/title fallback");
  assert.equal(generic.evaluations, 1);
}

async function testRejectsNonIconTextAndMixedMetadata() {
  for (const [name, mutate] of [
    ["hidden non-title text", (f) => { f.emptyWrapper.attributes.hidden = "true"; f.emptyWrapper.append("hidden suffix"); }],
    ["visible non-title label", (f) => { f.emptyWrapper.append("回覆"); }],
    ["visible suffix", (f) => { f.emptyWrapper.append("回覆其他"); }],
    ["mixed title and non-title label", (f) => { f.title.childNodes[0].nodeValue = "回"; f.emptyWrapper.append("覆"); }],
    ["SVG non-title text", (f) => { f.svg.append("回覆"); }],
    ["hidden SVG descendant text", (f) => { f.svg.append(el("span", { hidden: "true" }, ["hidden suffix"])); }],
    ["hidden additional label with matching suffix", (f) => { f.emptyWrapper.attributes.hidden = "true"; f.emptyWrapper.append("回覆"); }],
    ["unlabelled image", (f) => { f.emptyWrapper.append(el("img")); }],
    ["second labelled image", (f) => { f.emptyWrapper.append(el("img", { alt: "回覆" })); }],
    ["second SVG", (f) => { f.emptyWrapper.append(el("svg", { role: "img", "aria-label": "回覆" }, [el("title", {}, ["回覆"]), el("path")])); }],
    ["hidden second SVG", (f) => { f.emptyWrapper.append(el("svg", { role: "img", "aria-label": "回覆", hidden: "true" }, [el("title", {}, ["回覆"]), el("path")])); }],
    ["another semantic image", (f) => { f.emptyWrapper.append(el("span", { role: "img", "aria-label": "回覆" })); }],
    ["duplicate SVG TITLE", (f) => { f.svg.append(el("title", {}, ["回覆"])); }],
    ["nested duplicate TITLE", (f) => { f.title.append(el("title")); }],
    ["extra SVG PATH child", (f) => { f.svg.append(el("path", { d: "M3 3L4 4" })); }],
    ["TITLE label mismatch", (f) => { f.title.childNodes[0].nodeValue = "按讚"; }],
    ["SVG label mismatch", (f) => { f.svg.attributes["aria-label"] = "按讚"; }],
    ["different icon label", (f) => { f.svg.attributes["aria-label"] = "按讚"; f.title.childNodes[0].nodeValue = "按讚"; }],
    ["missing TITLE", (f) => { f.svg.childNodes = [f.path]; }],
  ]) {
    const current = setup(); mutate(current);
    await assert.rejects(current.bind(), undefined, name);
  }
}

async function testRejectsInvalidControlAndOwnIdentity() {
  for (const [name, mutate] of [
    ["hidden control", (f) => { f.button.attributes.hidden = "true"; }],
    ["hidden SVG", (f) => { f.svg.attributes.hidden = "true"; }],
    ["aria-hidden icon ancestor", (f) => { f.iconWrapper.attributes["aria-hidden"] = "true"; }],
    ["inert icon ancestor", (f) => { f.iconWrapper.attributes.inert = ""; }],
    ["wrong control tag", (f) => { f.button.tagName = "BUTTON"; f.button.localName = "button"; }],
    ["wrong control role", (f) => { f.button.attributes.role = "link"; }],
    ["missing control role", (f) => { delete f.button.attributes.role; }],
    ["disabled", (f) => { f.button.attributes.disabled = ""; }],
    ["aria disabled", (f) => { f.button.attributes["aria-disabled"] = "true"; }],
    ["conflicting own aria label", (f) => { f.button.attributes["aria-label"] = "按讚"; }],
    ["conflicting own title", (f) => { f.button.attributes.title = "Another action"; }],
    ["conflicting own name", (f) => { f.button.attributes.name = "another-action"; }],
    ["conflicting identity href", (f) => { f.button.attributes.href = "/another-target"; }],
    ["conflicting contenteditable", (f) => { f.button.attributes.contenteditable = "true"; }],
    ["wrong SVG role", (f) => { f.svg.attributes.role = "presentation"; }],
    ["missing SVG label", (f) => { delete f.svg.attributes["aria-label"]; }],
  ]) {
    const current = setup(); mutate(current);
    await assert.rejects(current.bind(), undefined, name);
  }
  const ownLabel = setup({ snapshots: [iconLine("35", "回覆", 'role="button" aria-label="回覆"')] });
  ownLabel.button.attributes["aria-label"] = "回覆";
  await assert.rejects(ownLabel.bind(), undefined,
    "even a matching own label and exact DOM snapshot is outside the no-control-label icon shape");
  for (const count of [0, 2]) {
    const ambiguous = setup();
    ambiguous.locator.count = async () => count;
    await assert.rejects(ambiguous.bind(), undefined, `locator count ${count} is not a unique icon`);
    assert.equal(ambiguous.evaluations, 0, "ambiguous locator must reject before any source identity evaluation");
    assert.equal(ambiguous.clicks, 0);
    assert.equal(ambiguous.fills, 0);
  }
}

async function testRejectsSnapshotIdentityAndNodeDrift() {
  for (const [name, snapshots] of [
    ["missing DOM identity", [""]],
    ["mismatched DOM label", [iconLine("35", "回覆其他")]],
    ["mismatched DOM own label", [iconLine("35", "回覆", 'role="button" aria-label="按讚"')]],
    ["mismatched DOM tag", ['<button node_id=35 role="button">回覆</button>']],
    ["duplicate exact DOM identity", [`${iconLine()}\n${iconLine("36")}`]],
    ["duplicate node ID", [`${iconLine()}\n${iconLine("35", "Other")}`]],
    ["second snapshot node ID drift", [iconLine(), iconLine("36")]],
    ["third snapshot node ID drift", [iconLine(), iconLine(), iconLine("36")]],
    ["later duplicate exact identity", [iconLine(), `${iconLine()}\n${iconLine("36")}`]],
    ["later duplicate node ID", [iconLine(), `${iconLine()}\n${iconLine("35", "Other")}`]],
  ]) {
    const current = setup({ snapshots });
    await assert.rejects(current.bind(), undefined, name);
  }
}

async function testRejectsIndependentSourceDrift() {
  for (const [name, mutate] of [
    ["source icon label drift", (f) => { f.svg.attributes["aria-label"] = "按讚"; f.title.childNodes[0].nodeValue = "按讚"; }],
    ["source own role drift", (f) => { f.button.attributes.role = "link"; }],
    ["source hidden text drift", (f) => { f.emptyWrapper.attributes.hidden = "true"; f.emptyWrapper.append("hidden"); }],
    ["source own title drift", (f) => { f.button.attributes.title = "Different action"; }],
  ]) {
    const current = setup({ beforeEvaluate: (fixture, number) => { if (number === 2) mutate(fixture); } });
    await assert.rejects(current.bind(), undefined, name);
    assert.equal(current.evaluations, 2, "drift is injected only into the independent second source evaluation");
  }
}

await testNativeIconMetadataPositiveAndGenericIsolation();
await testRejectsNonIconTextAndMixedMetadata();
await testRejectsInvalidControlAndOwnIdentity();
await testRejectsSnapshotIdentityAndNodeDrift();
await testRejectsIndependentSourceDrift();
for (const fixture of fixtures) {
  assert.equal(fixture.clicks, 0, "binding never clicks a locator or stable DOM node");
  assert.equal(fixture.fills, 0, "binding never fills any composer");
}
console.log("PASS Threads reply icon stable-node identity tests (anonymous; no browser)");

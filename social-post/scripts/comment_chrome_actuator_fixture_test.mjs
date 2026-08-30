import assert from "node:assert/strict";

import { sha256Text } from "./comment_chrome_common.mjs";

function browserRealmClone(value) {
  if (Array.isArray(value)) return value.map(browserRealmClone);
  if (!value || typeof value !== "object") return value;
  const clone = Object.create({ realm: "browser" });
  for (const [key, item] of Object.entries(value)) clone[key] = browserRealmClone(item);
  return clone;
}

class FakeLocator {
  constructor(page, keys) { this.page = page; this.keys = keys; }
  _rows() { return this.keys.map((key) => this.page.nodes[key]).filter(Boolean); }
  _first(label) {
    const row = this._rows()[0];
    if (!row) throw new Error(`fake locator cannot ${label}: no matching node`);
    return row;
  }
  _firstKey(label) {
    const key = this.keys.find((candidate) => Boolean(this.page.nodes[candidate]));
    if (!key) throw new Error(`fake locator cannot ${label}: no matching node`);
    return key;
  }
  _element(key) {
    const row = this.page.nodes[key];
    this.page.elementFacades ??= new WeakMap();
    const cached = this.page.elementFacades.get(row);
    if (cached) return cached;
    const locator = this;
    const element = {
      hasAttribute: (name) => Object.prototype.hasOwnProperty.call(row.attributes ?? {}, name),
      getAttribute: (name) => row.attributes?.[name] ?? null,
    };
    Object.defineProperties(element, {
      tagName: { enumerable: true, get: () => String(row.tagName ?? "div").toUpperCase() },
      value: { enumerable: true, get: () => row.value },
      textContent: { enumerable: true, get: () => row.text ?? "" },
      innerText: { enumerable: true, get: () => row.text ?? "" },
      isContentEditable: { enumerable: true, get: () => Boolean(row.contentEditable) },
      parentElement: {
        enumerable: true,
        get: () => (row.parent ? locator._element(row.parent) : null),
      },
    });
    for (const name of ["checked", "disabled", "multiple", "readOnly", "required", "selected"]) {
      Object.defineProperty(element, name, {
        enumerable: true,
        get: () => Boolean(row[name]),
      });
    }
    this.page.elementFacades.set(row, element);
    return element;
  }
  locator(selector) {
    return new FakeLocator(
      this.page, this._rows().flatMap((row) => row.children?.[selector] ?? []),
    );
  }
  nth(index) { return new FakeLocator(this.page, [this.keys[index]]); }
  async count() { return this._rows().length; }
  async isVisible() {
    const row = this._rows()[0];
    if (row?.onVisible) row.onVisible();
    return Boolean(row) && row.visible !== false;
  }
  async isEnabled() {
    const row = this._rows()[0];
    return Boolean(row) && row.enabled !== false;
  }
  async getAttribute(name) { return this._rows()[0]?.attributes?.[name] ?? null; }
  async textContent() {
    const row = this._first("read text");
    if (row.onTextContent) row.onTextContent();
    return row.text ?? "";
  }
  async evaluate(fn, arg) {
    const value = fn(this._element(this._firstKey("evaluate")), arg);
    return this.page.crossRealmEvaluate ? browserRealmClone(value) : value;
  }
  async fill(value) {
    const row = this._first("fill");
    if (row.contentEditable) row.text = value;
    else row.value = value;
  }
  async click() {
    const row = this._first("click");
    if (row.visible === false || row.enabled === false) {
      throw new Error("fake locator cannot click a hidden or disabled node");
    }
    row.clicks = (row.clicks ?? 0) + 1;
    if (row.onClick) row.onClick();
  }
}

export class FakeTab {
  constructor(page) {
    this.page = page;
    page.domCuaNodeIds ??= new WeakMap();
    page.domCuaNextNodeId ??= 1;
    page.domCuaSnapshotCalls ??= 0;
    page.domCuaClickCalls ??= 0;
    this.playwright = {
      locator: (selector) => new FakeLocator(page, page.selectors[selector] ?? []),
    };
    this.dom_cua = {
      get_visible_dom: async () => {
        page.domCuaSnapshotCalls += 1;
        if (page.onDomCuaSnapshot) {
          await page.onDomCuaSnapshot(page.domCuaSnapshotCalls);
        }
        const bindings = new Map();
        const lines = [];
        for (const [key, row] of Object.entries(page.nodes)) {
          if (!row || row.visible === false || !row.tagName) continue;
          let nodeId = page.domCuaNodeIds.get(row);
          if (nodeId === undefined) {
            nodeId = `node-${page.domCuaNextNodeId}`;
            page.domCuaNextNodeId += 1;
            page.domCuaNodeIds.set(row, nodeId);
          }
          bindings.set(nodeId, { key, row });
          const attrs = Object.entries(row.attributes ?? {})
            .filter(([name]) => new Set([
              "aria-disabled", "aria-label", "contenteditable", "href", "name",
              "placeholder", "role", "title", "type", "value",
            ]).has(name))
            .map(([name, value]) => `${name}="${String(value)
              .replace(/&/gu, "&amp;").replace(/"/gu, "&quot;")
              .replace(/</gu, "&lt;").replace(/>/gu, "&gt;")}"`);
          for (const [name, property] of [
            ["checked", "checked"], ["disabled", "disabled"], ["multiple", "multiple"],
            ["readonly", "readOnly"], ["required", "required"], ["selected", "selected"],
          ]) {
            if (row[property] === true || Object.hasOwn(row.attributes ?? {}, name)) {
              attrs.push(`${name}="true"`);
            }
          }
          const text = String(row.text ?? "").replace(/&/gu, "&amp;")
            .replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
          lines.push(`<${row.tagName} node_id=${nodeId}${attrs.length ? ` ${attrs.join(" ")}` : ""}>${text}</${row.tagName}>`);
        }
        page.domCuaBindings = bindings;
        return lines.join("\n");
      },
      click: async ({ node_id: nodeId }) => {
        page.domCuaClickCalls += 1;
        page.lastDomCuaClickNodeId = nodeId;
        if (page.onDomCuaBeforeClick) await page.onDomCuaBeforeClick(nodeId);
        const binding = page.domCuaBindings?.get(nodeId);
        const row = binding?.row;
        if (!binding || page.nodes[binding.key] !== row || row.connected === false) {
          throw new Error(`DOM node ${nodeId} is stale or missing`);
        }
        if (row.visible === false || row.enabled === false) {
          throw new Error(`DOM node ${nodeId} is hidden or disabled`);
        }
        row.clicks = (row.clicks ?? 0) + 1;
        if (row.onClick) row.onClick();
      },
    };
  }
  async url() { return this.page.url; }
}

export function addReply(page, {
  malformed = false, hidden = false,
  body = "下一集就會揭曉。", author = "account-a",
} = {}) {
  const index = (page.replyCount ?? 0) + 1;
  page.replyCount = index;
  const key = `reply-${index}`;
  page.nodes[key] = {
    visible: !hidden,
    parent: "target",
    children: malformed ? {} : {
      ".reply-author": [`reply-author-${index}`],
      ".reply-body": [`reply-body-${index}`],
    },
  };
  if (!malformed) {
    page.nodes[`reply-author-${index}`] = {
      visible: true, text: author, parent: key,
    };
    page.nodes[`reply-body-${index}`] = {
      visible: true, text: body, parent: key,
    };
  }
  page.nodes.target.children[".reply"].push(key);
  if (page.nodes["reply-exhaustion-state"]) {
    const total = page.nodes.target.children[".reply"].length;
    page.nodes["reply-exhaustion-state"].attributes["data-reply-cursor"] = `terminal-${total}`;
    page.nodes["reply-exhaustion-state"].attributes["data-reply-discovered-count"] = String(total);
    page.nodes["reply-exhaustion-state"].attributes["data-reply-terminal"] = "true";
  }
}

export function fixture({
  composer = "", duplicateSubmit = false, existingReply = false,
  contentEditableComposer = false, crossRealmEvaluate = false,
} = {}) {
  const page = {
    url: "http://127.0.0.1:8765/instagram.html",
    crossRealmEvaluate,
    selectors: { html: ["html"], "#target": ["target"], "#comments": ["target"], "#remaining-expansion": [] },
    nodes: {
      html: { visible: true, attributes: { "data-auth": "authenticated", "data-account": "account-a", "data-post": "post-a" } },
      target: {
        visible: true,
        attributes: {
          "data-id": "comment-a", "data-own": "false",
          "data-parent-post": "https://www.instagram.com/p/post-a",
        },
        children: {
          ".anchor": ["anchor"], ".author": ["author"], ".body": ["body"],
          ".reply-trigger": ["reply-trigger"], ".composer": ["composer"],
          ".submit": duplicateSubmit ? ["submit", "submit2"] : ["submit"],
          ".reply": [], ".remaining-reply-expansion": [], ".parent-post": ["parent-post"],
          ".reply-exhaustion-state": ["reply-exhaustion-state"],
          ".reply-next-viewport": [],
        },
      },
      anchor: { visible: true, attributes: { "data-id": "comment-a" } },
      author: { visible: true, text: "viewer-a" },
      body: { visible: true, text: "這一集會反擊嗎？" },
      "parent-post": { visible: true, attributes: { href: "https://www.instagram.com/p/post-a" } },
      "reply-exhaustion-state": {
        visible: true,
        attributes: {
          "data-reply-cursor": "terminal-0",
          "data-reply-discovered-count": "0",
          "data-reply-terminal": "true",
        },
      },
      composer: {
        visible: false, enabled: false, value: contentEditableComposer ? "" : composer,
        text: contentEditableComposer ? composer : "", contentEditable: contentEditableComposer,
        tagName: contentEditableComposer ? "div" : "textarea",
        attributes: {
          "aria-label": "Reply text",
          ...(contentEditableComposer ? { contenteditable: "true", role: "textbox" } : {}),
        },
      },
      submit2: {
        visible: false, enabled: false, tagName: "button", text: "Reply",
        attributes: { "aria-label": "Submit reply", type: "button" },
      },
      submit: {
        visible: false, enabled: false, tagName: "button", text: "Reply",
        attributes: { "aria-label": "Submit reply", type: "button" },
      },
      "reply-trigger": {
        visible: true, enabled: true, tagName: "button", text: "Reply",
        attributes: { "aria-label": "Open reply composer", type: "button" },
      },
    },
  };
  page.nodes["reply-trigger"].onClick = () => {
    page.nodes.composer.visible = true;
    page.nodes.composer.enabled = true;
    page.nodes.submit.visible = true;
    page.nodes.submit.enabled = true;
    if (duplicateSubmit) {
      page.nodes.submit2.visible = true;
      page.nodes.submit2.enabled = true;
    }
  };
  page.nodes.submit.onClick = () => {
    addReply(page);
    page.nodes.composer.value = "";
    page.nodes.composer.text = "";
    page.nodes.submit.enabled = false;
  };
  page.nodes.target.parent = "html";
  for (const key of [
    "anchor", "author", "body", "parent-post", "composer", "submit", "submit2",
    "reply-trigger", "reply-exhaustion-state",
  ]) {
    page.nodes[key].parent = "target";
  }
  if (existingReply) addReply(page);
  return { page, tab: new FakeTab(page) };
}

export function actionFor(suffix = "1") {
  const reply = "下一集就會揭曉。";
  return {
    schema_version: 1,
    action_id: `action-${suffix}`, intent_id: `intent-${suffix}`,
    session_id: `session-${suffix}`, permit_id: `permit-${suffix}`,
    scope: {
      platform: "instagram", account_key: "account-a", post_key: "post-a",
      comment_key: "instagram:account-a:post-a:comment-a",
    },
    post_permalink: "https://www.instagram.com/p/post-a",
    comment_anchor: { platform_comment_id: "comment-a", comment_permalink: null },
    comment_fingerprint: "fingerprint-1", reply_hash: sha256Text(reply),
    reply_text: reply, expected_body: "這一集會反擊嗎？", author_key: "viewer-a",
  };
}

export const plan = {
  account: { selector: "html", attribute: "data-account" },
  post: { selector: "html", attribute: "data-post" },
  target: { selector: "#target" },
  targetAnchor: {
    selector: ":scope", within: "target", self: true, attribute: "data-id",
  },
  author: { selector: ".author", within: "target" },
  body: { selector: ".body", within: "target" },
  replyTrigger: { selector: ".reply-trigger", within: "target" },
  composer: { selector: ".composer", within: "target", valueProperty: true },
  submit: { selector: ".submit", within: "target" },
  replyItems: { selector: ".reply", within: "target" },
  replyAuthor: { selector: ".reply-author", within: "reply" },
  replyBody: { selector: ".reply-body", within: "reply" },
  replyExpansionControls: { selector: ".remaining-reply-expansion", within: "target" },
  replyExhaustion: {
    schemaVersion: 1,
    state: {
      selector: ".reply-exhaustion-state", within: "target",
      cursorAttribute: "data-reply-cursor",
      discoveredCountAttribute: "data-reply-discovered-count",
      terminalAttribute: "data-reply-terminal",
    },
    viewportTraversalControl: { selector: ".reply-next-viewport", within: "target" },
    stableInstanceAttribute: "data-reply-control-instance",
    maxControlsPerRead: 50,
    maxClicks: 50,
    maxViewportTraversals: 20,
    maxObservationPasses: 100,
    maxElapsedMs: 10000,
    settleMs: 0,
    stableReadDelayMs: 0,
  },
};

export const fixedClock = () => new Date("2026-08-28T04:00:00.000Z");
export const optionsFor = (action) => ({ testOnly: true, receiptObservedUrl: action.post_permalink });

export function createClaimStore() {
  const claimed = new Set();
  return {
    claimed,
    claimSubmit: async (request) => {
      if (claimed.has(request.action_id)) throw new Error("durable claim already consumed");
      claimed.add(request.action_id);
      await Promise.resolve();
      return {
        ...request, decision: "WRITE_OK", claim_id: `claim-${request.action_id}`,
        preflight_id: `preflight-${request.action_id}`,
      };
    },
  };
}

export async function mustReject(fn, pattern) {
  await assert.rejects(fn, pattern);
}

export async function scanPlan() {
  return {
    authentication: { selector: "html", attribute: "data-auth" },
    account: { selector: "html", attribute: "data-account" },
    post: { selector: "html", attribute: "data-post" },
    comments: { selector: "#comments" },
    commentId: { selector: ":scope", self: true, attribute: "data-id" },
    author: { selector: ".author" }, body: { selector: ".body" },
    parentPost: { selector: ".parent-post", attribute: "href" },
    isOwn: { selector: ":scope", self: true, attribute: "data-own" },
    ownReplyItems: { selector: ".reply" },
    ownReplyAuthor: { selector: ".reply-author" },
    bodyComplete: true, language: "zh-Hant",
    expansionControls: { selector: "#remaining-expansion" },
  };
}

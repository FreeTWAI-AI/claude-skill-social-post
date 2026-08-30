/**
 * Fake DOM and immutable fixture builders shared by node/frame mapping tests.
 *
 * This module is fixture-only and cannot create live browser receipts.
 */

import {
  createTrustedFixtureScanPlan,
} from "./comment_chrome_scan_fixture_testonly.mjs";

class FixtureLocator {
  constructor(page, keys) {
    this.page = page;
    this.keys = keys;
  }

  rows() { return this.keys.map((key) => this.page.nodes[key]).filter(Boolean); }

  locator(selector) {
    return new FixtureLocator(
      this.page, this.rows().flatMap((row) => row.children?.[selector] ?? []),
    );
  }

  nth(index) { return new FixtureLocator(this.page, [this.keys[index]]); }
  async count() { return this.rows().length; }
  async isVisible() { return this.rows().length === 1 && this.rows()[0].visible !== false; }
  async isEnabled() { return this.rows().length === 1 && this.rows()[0].enabled !== false; }
  async getAttribute(name) { return this.rows()[0]?.attributes?.[name] ?? null; }
  async textContent() { return this.rows()[0]?.text ?? ""; }
  async evaluate(fn, arg) {
    const row = this.rows()[0];
    if (!row) throw new Error("fixture locator cannot evaluate a missing node");
    return fn({
      value: row.value,
      textContent: row.text ?? "",
      innerText: row.text ?? "",
      isContentEditable: Boolean(row.contentEditable),
    }, arg);
  }
}

class FixtureTab {
  constructor(page) {
    this.playwright = {
      locator: (selector) => new FixtureLocator(page, page.selectors[selector] ?? []),
    };
  }
}

function platformPrefix(platform) {
  if (platform === "facebook") return "fb";
  if (platform === "instagram") return "ig";
  return "threads";
}

function addRow(page, plan, platform, index, identity = `${platform}-identity-${index}`) {
  const prefix = platformPrefix(platform);
  const key = `${platform}-comment-${index}`;
  const author = `${key}-author`;
  const body = `${key}-body`;
  const exhaustion = `${key}-exhaustion`;
  const replyTrigger = `${key}-reply-trigger`;
  const composer = `${key}-composer`;
  const submit = `${key}-submit`;
  const lifecycle = plan.nodeFrameMapping.lifecycle;
  const ownerAttribute = lifecycle.ownerAttribute;
  page.nodes[key] = {
    visible: true,
    attributes: {
      [plan.commentId.attribute]: identity,
      [plan.parentPost.attribute]: `https://fixture.invalid/${platform}/post`,
      [plan.nodeFrameMapping.nodeIdAttribute]: `${key}-node`,
    },
    children: {
      [plan.authorDisplay.selector]: [author],
      [plan.body.selector]: [body],
      [plan.ownReplyItems.selector]: [],
      [plan.nodeFrameMapping.replyExhaustion.selector]: [exhaustion],
      [lifecycle.replyTrigger.selector]: [replyTrigger],
      [lifecycle.composer.selector]: [composer],
      [lifecycle.submit.selector]: [submit],
      [lifecycle.replyItems.selector]: [],
    },
  };
  page.nodes[author] = {
    visible: true,
    text: `${platform}-viewer-${index}`,
    attributes: {
      [plan.nodeFrameMapping.nodeIdAttribute]: `${prefix}-author-node-${index}`,
      [ownerAttribute]: identity,
    },
  };
  page.nodes[body] = {
    visible: true,
    text: `${platform}-body-${index}`,
    attributes: {
      [plan.nodeFrameMapping.nodeIdAttribute]: `${prefix}-body-node-${index}`,
      [ownerAttribute]: identity,
    },
  };
  page.nodes[exhaustion] = {
    visible: true,
    attributes: {
      [plan.nodeFrameMapping.nodeIdAttribute]: `${prefix}-exhaustion-node-${index}`,
      [ownerAttribute]: identity,
      [plan.nodeFrameMapping.replyExhaustion.cursorAttribute]: "terminal-0",
      [plan.nodeFrameMapping.replyExhaustion.discoveredCountAttribute]: "0",
      [plan.nodeFrameMapping.replyExhaustion.terminalAttribute]: "true",
    },
  };
  page.nodes[replyTrigger] = {
    visible: true,
    enabled: true,
    attributes: {
      [plan.nodeFrameMapping.nodeIdAttribute]: `${prefix}-trigger-node-${index}`,
      [ownerAttribute]: identity,
    },
  };
  page.nodes[composer] = {
    visible: false,
    enabled: false,
    value: "",
    attributes: {
      [plan.nodeFrameMapping.nodeIdAttribute]: `${prefix}-composer-node-${index}`,
      [ownerAttribute]: identity,
    },
  };
  page.nodes[submit] = {
    visible: false,
    enabled: false,
    attributes: {
      [plan.nodeFrameMapping.nodeIdAttribute]: `${prefix}-submit-node-${index}`,
      [ownerAttribute]: identity,
    },
  };
  return { key, author, body, exhaustion, replyTrigger, composer, submit };
}

export function fixture(platform, { duplicate = false } = {}) {
  const plan = createTrustedFixtureScanPlan(platform);
  const page = { selectors: {}, nodes: {} };
  page.nodes.root = {
    visible: true,
    attributes: {
      [plan.nodeFrameMapping.frame.frameIdAttribute]: `${platform}-main-frame`,
      [plan.nodeFrameMapping.frame.documentEpochAttribute]: `${platform}-epoch-1`,
      [plan.nodeFrameMapping.nodeIdAttribute]: `${platform}-root-node`,
      [plan.expansion.state.cursorAttribute]: `${platform}-page-1`,
      [plan.expansion.state.discoveredCountAttribute]: "1",
      [plan.expansion.state.terminalAttribute]: "false",
    },
  };
  page.selectors[plan.nodeFrameMapping.frame.selector] = ["root"];
  page.selectors[plan.expansion.state.selector] = ["root"];
  const commentControl = `${platform}-comment-expansion-control`;
  const replyControl = `${platform}-reply-expansion-control`;
  page.nodes[commentControl] = {
    visible: true,
    enabled: true,
    attributes: {
      [plan.nodeFrameMapping.nodeIdAttribute]: `${commentControl}-node`,
    },
  };
  page.nodes[replyControl] = {
    visible: true,
    enabled: true,
    attributes: {
      [plan.nodeFrameMapping.nodeIdAttribute]: `${replyControl}-node`,
    },
  };
  page.selectors[plan.expansion.commentControls.selector] = [commentControl];
  page.selectors[plan.expansion.replyControls.selector] = [replyControl];
  page.selectors[plan.expansion.viewportTraversalControl.selector] = [];
  const first = addRow(page, plan, platform, 1);
  const second = addRow(
    page, plan, platform, 2,
    duplicate ? `${platform}-identity-1` : `${platform}-identity-2`,
  );
  page.selectors[plan.comments.selector] = [first.key, second.key];
  return {
    page, plan, tab: new FixtureTab(page), first, second,
    commentControl, replyControl,
  };
}

export const TEST_OPTIONS = Object.freeze({ testOnly: true });

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}


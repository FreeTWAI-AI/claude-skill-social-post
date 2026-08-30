import assert from "node:assert/strict";

import * as productionAdapters from "./comment_chrome_scan_adapters.mjs";
import {
  createTrustedFixtureScanPlan,
  createTrustedFixtureScanPost,
  isTrustedFixtureExpansionAttestation,
  isTrustedFixtureScanPlan,
  trustedFixtureAdapterVersions,
  verifyTrustedFixtureExpansionStillComplete,
} from "./comment_chrome_scan_fixture_testonly.mjs";

class FakeLocator {
  constructor(page, keys, selector = null) {
    this.page = page;
    this.keys = keys;
    this.selector = selector;
  }

  _rows() { return this.keys.map((key) => this.page.nodes[key]).filter(Boolean); }

  _first(label) {
    const row = this._rows()[0];
    if (!row) throw new Error(`fake scan adapter cannot ${label}: no matching node`);
    return row;
  }

  _firstKey(label) {
    const key = this.keys.find((candidate) => Boolean(this.page.nodes[candidate]));
    if (!key) throw new Error(`fake scan adapter cannot ${label}: no matching node`);
    return key;
  }

  _element(key) {
    const row = this.page.nodes[key];
    const locator = this;
    const element = {
      hasAttribute: (name) => Object.prototype.hasOwnProperty.call(row.attributes ?? {}, name),
      getAttribute: (name) => row.attributes?.[name] ?? null,
    };
    Object.defineProperties(element, {
      value: { enumerable: true, get: () => row.value },
      textContent: { enumerable: true, get: () => row.text ?? "" },
      innerText: { enumerable: true, get: () => row.text ?? "" },
      isContentEditable: { enumerable: true, get: () => Boolean(row.contentEditable) },
      parentElement: {
        enumerable: true,
        get: () => (row.parent ? locator._element(row.parent) : null),
      },
    });
    return element;
  }

  locator(selector) {
    return new FakeLocator(
      this.page,
      this._rows().flatMap((row) => row.children?.[selector] ?? []),
      selector,
    );
  }

  nth(index) { return new FakeLocator(this.page, [this.keys[index]], this.selector); }

  async count() {
    if (this.selector) {
      this.page.countCalls[this.selector] = (this.page.countCalls[this.selector] ?? 0) + 1;
      if (this.page.onCount) {
        this.page.onCount(this.selector, this.page.countCalls[this.selector]);
      }
    }
    return this._rows().length;
  }

  async isVisible() { return this._rows()[0]?.visible !== false && this._rows().length === 1; }
  async isEnabled() { return this._rows()[0]?.enabled !== false && this._rows().length === 1; }
  async getAttribute(name) { return this._rows()[0]?.attributes?.[name] ?? null; }
  async textContent() { return this._first("read text").text ?? ""; }
  async evaluate(fn, arg) { return fn(this._element(this._firstKey("evaluate")), arg); }

  async click() {
    const row = this._first("click");
    if (row.visible === false || row.enabled === false) {
      throw new Error("fake scan adapter cannot click hidden or disabled control");
    }
    row.clicks = (row.clicks ?? 0) + 1;
    if (row.onClick) row.onClick();
  }
}

class FakeTab {
  constructor(page) {
    this.page = page;
    this.playwright = {
      locator: (selector) => new FakeLocator(
        page, page.selectors[selector] ?? [], selector,
      ),
    };
  }

  async url() { return this.page.url; }
}

function addComment(page, plan, key, id, body) {
  const authorKey = `${key}-author`;
  const bodyKey = `${key}-body`;
  const exhaustionKey = `${key}-reply-exhaustion`;
  page.nodes[key] = {
    visible: true,
    parent: "root",
    attributes: {
      [plan.commentId.attribute]: id,
      [plan.author.attribute]: "viewer-account",
      [plan.parentPost.attribute]: "https://www.instagram.com/p/trusted-post",
      [plan.isOwn.attribute]: "false",
      "data-fixture-node-id": `${key}-node`,
    },
    children: {
      [plan.authorDisplay.selector]: [authorKey],
      [plan.body.selector]: [bodyKey],
      [plan.ownReplyItems.selector]: [],
      [plan.nodeFrameMapping.replyExhaustion.selector]: [exhaustionKey],
    },
  };
  page.nodes[authorKey] = {
    visible: true, text: "Viewer", parent: key,
    attributes: { "data-fixture-node-id": `${authorKey}-node` },
  };
  page.nodes[bodyKey] = {
    visible: true, text: body, parent: key,
    attributes: { "data-fixture-node-id": `${bodyKey}-node` },
  };
  page.nodes[exhaustionKey] = {
    visible: true,
    parent: key,
    attributes: {
      "data-fixture-node-id": `${exhaustionKey}-node`,
      [plan.nodeFrameMapping.replyExhaustion.cursorAttribute]: "terminal-0",
      [plan.nodeFrameMapping.replyExhaustion.discoveredCountAttribute]: "0",
      [plan.nodeFrameMapping.replyExhaustion.terminalAttribute]: "true",
    },
  };
}

function stableControl(page, key, text, instanceId, onClick) {
  page.nodes[key] = {
    visible: true,
    enabled: true,
    text,
    attributes: {
      "data-fixture-control-instance": instanceId,
      "aria-label": text,
    },
    onClick,
  };
}

function fixtureFor(plan, options = {}) {
  const postUrl = "https://www.instagram.com/p/trusted-post";
  const page = {
    url: "http://127.0.0.1:8765/instagram.html",
    selectors: {},
    nodes: {},
    countCalls: {},
    scrollCalls: 0,
  };
  const stateSpec = plan.expansion.state;
  page.nodes.root = {
    visible: true,
    attributes: {
      [plan.authentication.attribute]: "authenticated",
      [plan.account.attribute]: "trusted-account",
      [plan.post.attribute]: "trusted-post",
      [stateSpec.cursorAttribute]: options.startCursor ?? "page-1",
      [stateSpec.discoveredCountAttribute]: String(options.startDiscoveredCount ?? 1),
      [stateSpec.terminalAttribute]: options.startTerminal === true ? "true" : "false",
      [plan.nodeFrameMapping.frame.frameIdAttribute]: "instagram-main-frame",
      [plan.nodeFrameMapping.frame.documentEpochAttribute]: "instagram-document-epoch-1",
      [plan.nodeFrameMapping.nodeIdAttribute]: "instagram-root-node",
    },
  };
  for (const spec of [plan.authentication, plan.account, plan.post, stateSpec]) {
    page.selectors[spec.selector] = ["root"];
  }
  addComment(page, plan, "comment-1", "trusted-comment-1", "可信 adapter 測試留言");
  page.selectors[plan.comments.selector] = ["comment-1"];

  const commentSelector = plan.expansion.commentControls.selector;
  const replySelector = plan.expansion.replyControls.selector;
  const traversalSelector = plan.expansion.viewportTraversalControl.selector;
  page.selectors[commentSelector] = [];
  page.selectors[replySelector] = [];
  page.selectors[traversalSelector] = [];

  if (options.excessive) {
    for (let index = 0; index <= plan.expansion.maxControlsPerRead; index += 1) {
      const key = `excessive-${index}`;
      stableControl(page, key, "更多留言", `excessive-${index}`, () => {});
      page.selectors[commentSelector].push(key);
    }
  } else if (options.startTerminal !== true && !options.noInitialControls) {
    stableControl(page, "comment-expander", "更多留言", "comment-instance-1", () => {
      page.selectors[commentSelector] = [];
    });
    stableControl(page, "reply-expander", "查看更多回覆", "reply-instance-1", () => {
      page.selectors[replySelector] = [];
    });
    if (options.hiddenControl) page.nodes["comment-expander"].visible = false;
    page.selectors[commentSelector] = ["comment-expander"];
    page.selectors[replySelector] = ["reply-expander"];
  }

  if (options.startTerminal !== true && !options.noTraversalControl) {
    stableControl(page, "viewport-next", "下一個留言視窗", "viewport-instance-1", () => {
      const root = page.nodes.root.attributes;
      root[stateSpec.cursorAttribute] = options.blankCursorAfterTraversal ? "" : "page-2";
      if (options.missingTerminalEvidence) {
        delete root[stateSpec.terminalAttribute];
      } else {
        root[stateSpec.terminalAttribute] = options.neverTerminal ? "false" : "true";
      }
      if (options.virtualizedLaterPage) {
        root[stateSpec.discoveredCountAttribute] = "2";
        addComment(page, plan, "comment-2", "trusted-comment-2", "第二頁留言");
        page.selectors[plan.comments.selector] = ["comment-2"];
      }
      if (options.lateControlAfterTraversal) {
        stableControl(page, "late-expander", "遲到的更多留言", "late-instance", () => {
          page.selectors[commentSelector] = [];
        });
        page.selectors[commentSelector] = ["late-expander"];
      }
      page.selectors[traversalSelector] = [];
    });
    page.selectors[traversalSelector] = ["viewport-next"];
  }

  if (options.appearOnlyAfterUntrustedScroll) {
    page.scroll = () => {
      page.scrollCalls += 1;
      addComment(page, plan, "comment-after-scroll", "late-comment", "捲動後才出現");
      page.selectors[plan.comments.selector].push("comment-after-scroll");
      stableControl(page, "scroll-expander", "捲動後控制", "scroll-instance", () => {});
      page.selectors[commentSelector] = ["scroll-expander"];
    };
  }

  if (options.replacementSameFingerprint) {
    page.onCount = (selector, callCount) => {
      if (selector === commentSelector && callCount === 3) {
        stableControl(page, "replacement-expander", "更多留言", "replacement-instance", () => {});
        page.selectors[commentSelector] = ["replacement-expander"];
      }
    };
  }

  if (options.appearDuringTerminalStableRead) {
    page.onCount = (selector, callCount) => {
      if (selector === commentSelector && callCount === 3) {
        addComment(page, plan, "late-comment", "late-comment", "穩定讀取後才出現");
        page.selectors[plan.comments.selector].push("late-comment");
        stableControl(page, "late-terminal-expander", "遲到控制", "late-terminal-instance", () => {});
        page.selectors[commentSelector] = ["late-terminal-expander"];
      }
    };
  }

  return { page, tab: new FakeTab(page), postUrl };
}

function requestFor(postUrl, id = "trusted-scan") {
  return {
    scan_request_id: id,
    session_id: "trusted-session",
    platform: "instagram",
    account_key: "trusted-account",
    post_key: "trusted-post",
    post_permalink: postUrl,
  };
}

function fixtureOptions(postUrl) {
  return { testOnly: true, receiptObservedUrl: postUrl };
}

// Production exports contain no fixture factory and no fixture revision.
assert.equal("createTrustedFixtureScanPlan" in productionAdapters, false);
const productionVersions = productionAdapters.trustedPlatformAdapterVersions();
assert.deepEqual(Object.keys(productionVersions).sort(), ["facebook", "instagram", "threads"]);
assert.equal(
  productionVersions.instagram.live_status,
  "unavailable_pending_authenticated_canary_and_live_locator_revision",
);
assert.equal(productionVersions.instagram.live, null);
const productionHostResolver = productionVersions.instagram.trusted_host_resolver;
assert.equal(productionHostResolver.schema_version, 2);
assert.equal(productionHostResolver.resolver_version, "2026-08-30.1");
assert.equal(
  productionHostResolver.status,
  "source_wired_existing_session_only_pending_authenticated_browser_canary",
);
assert.equal(productionHostResolver.frame_policy, "main-frame-only");
assert.equal(productionHostResolver.document_epoch, "readonly-performance-time-origin");
assert.equal(productionHostResolver.caller_authority_inputs, false);
assert.equal(productionHostResolver.runtime.existing_session_only, true);
assert.equal(productionHostResolver.runtime.can_launch_browser, false);
assert.equal(productionHostResolver.runtime.can_navigate, false);
assert.equal(productionHostResolver.runtime.can_mutate_page, false);
assert.equal(productionHostResolver.live_scan_plan_minting, false);
assert.equal(productionHostResolver.live_send_enabled, false);
assert.deepEqual(productionVersions.instagram.stable_node_frame_mapping, {
  schema_version: 1,
  platform: "instagram",
  identity_kind: "comment",
  status: "offline_contract_ready_live_native_frame_owner_unavailable",
  coverage: "test_only_final_scan_comment_nodes",
  full_lifecycle_bound: false,
  live_plan_minting: false,
  fail_closed: true,
});
assert.equal("fixture" in productionVersions.instagram, false);
assert.throws(
  () => productionAdapters.createTrustedPlatformScanPlan("instagram", {
    tab: new FakeTab({ selectors: {}, nodes: {}, countCalls: {} }),
  }),
  /no authenticated-canary-verified live instagram locator revision is available/u,
);
assert.throws(
  () => productionAdapters.createTrustedPlatformScanPlan("unknown"),
  /no registered scan adapter platform unknown/u,
);
await assert.rejects(
  () => productionAdapters.attestTrustedPlatformExpansion(
    new FakeTab({ selectors: {}, nodes: {}, countCalls: {} }),
    Object.freeze({ platform: "instagram" }),
    "instagram",
  ),
  /source-registered trusted-host-resolved platform plan/u,
);

const fixtureVersions = trustedFixtureAdapterVersions();
assert.match(fixtureVersions.facebook, /^facebook-comments-testonly@/u);
assert.match(fixtureVersions.instagram, /^instagram-comments-testonly@/u);
assert.match(fixtureVersions.threads, /^threads-replies-testonly@/u);

for (const platform of ["facebook", "instagram", "threads"]) {
  const selected = createTrustedFixtureScanPlan(platform);
  assert.equal(isTrustedFixtureScanPlan(selected), true);
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(selected.expansion), true);
  assert.equal(isTrustedFixtureScanPlan(structuredClone(selected)), false);
}

assert.throws(
  () => createTrustedFixtureScanPlan("instagram", { adapterVersion: "forged" }),
  /unsupported instagram fixture scan adapter version/u,
);

const plan = createTrustedFixtureScanPlan("instagram");
const scanFixture = createTrustedFixtureScanPost({
  clock: () => new Date("2026-08-28T12:00:00.000Z"),
});
const good = fixtureFor(plan);
const scan = await scanFixture(
  good.tab, requestFor(good.postUrl), plan, fixtureOptions(good.postUrl),
);
assert.equal(scan.test_only, true);
assert.equal(scan.comments.length, 1);
assert.equal(scan.comments[0].body_complete, true);
assert.equal(scan.comments[0].has_own_reply, false);
assert.equal(scan.stable_node_frame_mapping_evidence.test_only, true);
assert.equal(scan.stable_node_frame_mapping_evidence.platform, "instagram");
assert.equal(scan.stable_node_frame_mapping_evidence.row_count, 1);
assert.equal(scan.stable_node_frame_mapping_evidence.stable_read_count, 2);
const attestation = scan.thread_expansion_evidence.adapter_attestation;
assert.equal(isTrustedFixtureExpansionAttestation(attestation), true);
assert.equal(attestation.exhaustion_schema_version, 1);
assert.deepEqual(attestation.viewport_cursors, ["page-1", "page-2"]);
assert.deepEqual(attestation.discovered_count_sequence, [1, 1]);
assert.equal(attestation.viewport_traversal_steps, 1);
assert.equal(attestation.terminal_evidence, true);
assert.equal(attestation.terminal_cursor, "page-2");
assert.equal(attestation.terminal_discovered_count, 1);
assert.equal(attestation.total_clicks, 2);
assert.equal(good.page.nodes["comment-expander"].clicks, 1);
assert.equal(good.page.nodes["reply-expander"].clicks, 1);
assert.equal(good.page.nodes["viewport-next"].clicks, 1);

await assert.rejects(
  () => verifyTrustedFixtureExpansionStillComplete(
    good.tab, plan, "instagram", { ...attestation }, fixtureOptions(good.postUrl),
  ),
  /process-branded attestation/u,
);

await assert.rejects(
  () => scanFixture(
    good.tab, requestFor(good.postUrl, "no-test-mode"), plan, {},
  ),
  /requires testOnly=true/u,
);

const metaFixture = fixtureFor(plan);
metaFixture.page.url = good.postUrl;
await assert.rejects(
  () => scanFixture(
    metaFixture.tab, requestFor(good.postUrl, "meta-fixture"), plan,
    fixtureOptions(good.postUrl),
  ),
  /testOnly URL mapping is restricted to loopback hosts/u,
);

await assert.rejects(
  () => scanFixture(
    good.tab,
    { ...requestFor(good.postUrl, "cross-platform"), platform: "facebook" },
    plan,
    fixtureOptions(good.postUrl),
  ),
  /cross-platform, stale, or malformed/u,
);

const clonePlan = structuredClone(plan);
await assert.rejects(
  () => scanFixture(
    good.tab, requestFor(good.postUrl, "clone-plan"), clonePlan,
    fixtureOptions(good.postUrl),
  ),
  /process-branded test-only plan/u,
);

const excessive = fixtureFor(plan, { excessive: true });
await assert.rejects(
  () => scanFixture(
    excessive.tab, requestFor(excessive.postUrl, "excessive"), plan,
    fixtureOptions(excessive.postUrl),
  ),
  /exceed the registered per-read bound/u,
);

const hidden = fixtureFor(plan, { hiddenControl: true });
await assert.rejects(
  () => scanFixture(
    hidden.tab, requestFor(hidden.postUrl, "hidden"), plan,
    fixtureOptions(hidden.postUrl),
  ),
  /hidden control/u,
);

// Same visible fingerprint, different stable instance: neither old nor
// replacement control is clicked.
const replacement = fixtureFor(plan, { replacementSameFingerprint: true });
await assert.rejects(
  () => scanFixture(
    replacement.tab, requestFor(replacement.postUrl, "replacement"), plan,
    fixtureOptions(replacement.postUrl),
  ),
  /instance changed before click; replacement receives zero clicks/u,
);
assert.equal(replacement.page.nodes["comment-expander"].clicks ?? 0, 0);
assert.equal(replacement.page.nodes["replacement-expander"].clicks ?? 0, 0);

// Controls and comments that could appear only after an arbitrary scroll do
// not turn two empty viewport reads into completeness. Without the registered
// traversal control, the non-terminal cursor fails closed and no scroll runs.
const afterScroll = fixtureFor(plan, {
  noInitialControls: true,
  noTraversalControl: true,
  appearOnlyAfterUntrustedScroll: true,
});
await assert.rejects(
  () => scanFixture(
    afterScroll.tab, requestFor(afterScroll.postUrl, "after-scroll"), plan,
    fixtureOptions(afterScroll.postUrl),
  ),
  /non-terminal expansion cursor page-1 lacks a trusted viewport traversal control/u,
);
assert.equal(afterScroll.page.scrollCalls, 0);

// Even an initial terminal claim is rejected when a later stable read exposes
// controls/comments that the first viewport did not contain.
const lateStable = fixtureFor(plan, {
  startTerminal: true,
  appearDuringTerminalStableRead: true,
});
await assert.rejects(
  () => scanFixture(
    lateStable.tab, requestFor(lateStable.postUrl, "late-stable"), plan,
    fixtureOptions(lateStable.postUrl),
  ),
  /expansion-control count drifted|terminal exhaustion evidence changed/u,
);

// A later virtualized page reports two discovered comments but leaves only one
// inspectable in the terminal DOM. Coverage binding rejects the receipt.
const virtualized = fixtureFor(plan, { virtualizedLaterPage: true });
await assert.rejects(
  () => scanFixture(
    virtualized.tab, requestFor(virtualized.postUrl, "virtualized"), plan,
    fixtureOptions(virtualized.postUrl),
  ),
  /virtualized or partial evidence is forbidden/u,
);

// Cursor without explicit terminal evidence is never interpreted as complete.
const noTerminal = fixtureFor(plan, { missingTerminalEvidence: true });
await assert.rejects(
  () => scanFixture(
    noTerminal.tab, requestFor(noTerminal.postUrl, "no-terminal"), plan,
    fixtureOptions(noTerminal.postUrl),
  ),
  /terminal evidence must be explicit true or false/u,
);

console.log("comment Chrome production authority and fixture exhaustion tests passed");

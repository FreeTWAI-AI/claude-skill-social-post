import assert from "node:assert/strict";

import { createCommentChromeActuator } from "./comment_chrome_actuator.mjs";
import { createPythonLedgerClaimSubmit } from "./comment_chrome_claim_bridge.mjs";
import { sha256Text } from "./comment_chrome_common.mjs";


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
    return fn(this._element(this._firstKey("evaluate")), arg);
  }
  async fill(value) { this._first("fill").value = value; }
  async click() {
    const row = this._first("click");
    if (row.visible === false || row.enabled === false) {
      throw new Error("fake locator cannot click a hidden or disabled node");
    }
    row.clicks = (row.clicks ?? 0) + 1;
    if (row.onClick) row.onClick();
  }
}

class FakeTab {
  constructor(page) {
    this.page = page;
    this.playwright = {
      locator: (selector) => new FakeLocator(page, page.selectors[selector] ?? []),
    };
  }
  async url() { return this.page.url; }
}

function addReply(page, {
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
}

function fixture({ composer = "", duplicateSubmit = false, existingReply = false } = {}) {
  const page = {
    url: "http://127.0.0.1:8765/instagram.html",
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
        },
      },
      anchor: { visible: true, attributes: { "data-id": "comment-a" } },
      author: { visible: true, text: "viewer-a" },
      body: { visible: true, text: "這一集會反擊嗎？" },
      "parent-post": { visible: true, attributes: { href: "https://www.instagram.com/p/post-a" } },
      composer: { visible: false, enabled: false, value: composer },
      submit2: { visible: false, enabled: false },
      submit: { visible: false, enabled: false },
      "reply-trigger": { visible: true, enabled: true },
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
    page.nodes.submit.enabled = false;
  };
  page.nodes.target.parent = "html";
  for (const key of [
    "anchor", "author", "body", "parent-post", "composer", "submit", "submit2",
    "reply-trigger",
  ]) {
    page.nodes[key].parent = "target";
  }
  if (existingReply) addReply(page);
  return { page, tab: new FakeTab(page) };
}

function actionFor(suffix = "1") {
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

const plan = {
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
};

const fixedClock = () => new Date("2026-08-28T04:00:00.000Z");
const optionsFor = (action) => ({ testOnly: true, receiptObservedUrl: action.post_permalink });

function createClaimStore() {
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

async function mustReject(fn, pattern) {
  await assert.rejects(fn, pattern);
}

async function scanPlan() {
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

async function testScan() {
  const action = actionFor("scan");
  const { page, tab } = fixture();
  const actor = createCommentChromeActuator({ clock: fixedClock });
  const request = {
    scan_request_id: "scan-1", session_id: action.session_id, platform: "instagram",
    account_key: "account-a", post_key: "post-a", post_permalink: action.post_permalink,
  };
  const locators = await scanPlan();
  const scan = await actor.scanPost(
    tab, request, locators,
    { ...optionsFor(action), threadExpansionComplete: true },
  );
  assert.equal(scan.test_only, true);
  assert.equal(scan.comments[0].observed_parent_post_permalink, action.post_permalink);
  assert.equal(scan.comments[0].body_complete, true);
  assert.equal(scan.comments[0].has_own_reply, false);

  const partial = await actor.scanPost(tab, {
    ...request, scan_request_id: "scan-partial",
  }, locators, optionsFor(action));
  assert.equal(partial.test_only, true);
  assert.equal(partial.comments[0].body_complete, false);
  assert.equal(partial.comments[0].has_own_reply, null);
  assert.equal(partial.thread_expansion_evidence.comments_expanded, false);
  assert.equal(partial.thread_expansion_evidence.replies_expanded, false);

  const directAnchoredReply = fixture();
  directAnchoredReply.page.nodes["direct-reply"] = {
    visible: true, parent: "target", attributes: { "data-id": "reply-direct" },
    children: { ".reply-author": ["direct-reply-author"] },
  };
  directAnchoredReply.page.nodes["direct-reply-author"] = {
    visible: true, text: "account-a", parent: "direct-reply",
  };
  directAnchoredReply.page.nodes.target.children[".reply"] = ["direct-reply"];
  const directReplyScan = await actor.scanPost(
    directAnchoredReply.tab, { ...request, scan_request_id: "scan-direct-reply" },
    locators, { ...optionsFor(action), threadExpansionComplete: true },
  );
  assert.equal(directReplyScan.comments[0].has_own_reply, true);

  const nestedOwnReply = fixture();
  nestedOwnReply.page.nodes["nested-reply-parent"] = {
    visible: true, parent: "target", attributes: { "data-id": "reply-parent" },
  };
  nestedOwnReply.page.nodes["nested-own-reply"] = {
    visible: true, parent: "nested-reply-parent",
    attributes: { "data-id": "reply-grandchild" },
    children: { ".reply-author": ["nested-own-reply-author"] },
  };
  nestedOwnReply.page.nodes["nested-own-reply-author"] = {
    visible: true, text: "account-a", parent: "nested-own-reply",
  };
  nestedOwnReply.page.nodes.target.children[".reply"] = ["nested-own-reply"];
  await mustReject(
    () => actor.scanPost(
      nestedOwnReply.tab, { ...request, scan_request_id: "scan-nested-own-reply" },
      locators, { ...optionsFor(action), threadExpansionComplete: true },
    ),
    /scan reply item belongs to anchored target "reply-parent", not approved target "comment-a"/,
  );

  const selfAnchoredBody = fixture();
  selfAnchoredBody.page.nodes.body.attributes = { "data-id": "comment-b" };
  await mustReject(
    () => actor.scanPost(
      selfAnchoredBody.tab, { ...request, scan_request_id: "scan-self-anchored-body" },
      locators, { ...optionsFor(action), threadExpansionComplete: true },
    ),
    /scan comment body belongs to anchored target "comment-b", not approved target "comment-a"/,
  );

  const selfAnchoredReplyAuthor = fixture();
  addReply(selfAnchoredReplyAuthor.page, { body: "不同回覆", author: "account-a" });
  selfAnchoredReplyAuthor.page.nodes["reply-author-1"].attributes = {
    "data-id": "reply-decoy",
  };
  await mustReject(
    () => actor.scanPost(
      selfAnchoredReplyAuthor.tab,
      { ...request, scan_request_id: "scan-self-anchored-reply-author" },
      locators, { ...optionsFor(action), threadExpansionComplete: true },
    ),
    /scan own-reply author belongs to anchored target "reply-decoy", not approved target "comment-a"/,
  );

  const emptyPartialFixture = fixture();
  emptyPartialFixture.page.selectors["#comments"] = [];
  const emptyPartial = await actor.scanPost(
    emptyPartialFixture.tab, { ...request, scan_request_id: "scan-empty-partial" },
    locators, optionsFor(action),
  );
  assert.deepEqual(emptyPartial.comments, []);
  assert.equal(emptyPartial.thread_expansion_evidence.provided, false);

  const liveFixture = fixture();
  liveFixture.page.url = action.post_permalink;
  await mustReject(
    () => actor.scanPost(
      liveFixture.tab, { ...request, scan_request_id: "scan-live-partial" },
      locators,
    ),
    /live scan requires verified comment and reply expansion/,
  );

  for (const missing of ["ownReplyItems", "ownReplyAuthor", "isOwn"]) {
    const incompletePlan = structuredClone(locators);
    delete incompletePlan[missing];
    await mustReject(
      () => actor.scanPost(
        tab, { ...request, scan_request_id: `scan-missing-${missing}` },
        incompletePlan, { ...optionsFor(action), threadExpansionComplete: true },
      ),
      new RegExp(`scan locator plan\\.${missing} is required`),
    );
  }
  await mustReject(
    () => actor.scanPost(
      tab, { ...request, scan_request_id: "scan-broad-comment-id" },
      {
        ...locators,
        commentId: { selector: ".anchor", attribute: "data-id" },
      },
      { ...optionsFor(action), threadExpansionComplete: true },
    ),
    /commentId must be an attribute on each comment item itself/,
  );

  const driftingComments = fixture();
  driftingComments.page.nodes.body.onTextContent = () => {
    delete driftingComments.page.nodes.body.onTextContent;
    driftingComments.page.nodes["scan-decoy"] = {
      visible: true, parent: "html",
      attributes: { "data-id": "comment-decoy", "data-own": "false" },
      children: {
        ".author": ["scan-decoy-author"], ".body": ["scan-decoy-body"],
        ".parent-post": ["scan-decoy-parent"], ".reply": [],
      },
    };
    driftingComments.page.nodes["scan-decoy-author"] = {
      visible: true, text: "viewer-decoy", parent: "scan-decoy",
    };
    driftingComments.page.nodes["scan-decoy-body"] = {
      visible: true, text: "後來出現的留言", parent: "scan-decoy",
    };
    driftingComments.page.nodes["scan-decoy-parent"] = {
      visible: true, parent: "scan-decoy",
      attributes: { href: action.post_permalink },
    };
    driftingComments.page.selectors["#comments"].push("scan-decoy");
  };
  await mustReject(
    () => actor.scanPost(
      driftingComments.tab, { ...request, scan_request_id: "scan-comment-drift" },
      locators, { ...optionsFor(action), threadExpansionComplete: true },
    ),
    /scan comment count drifted|scan comment evidence changed/,
  );

  const driftingExpansion = fixture();
  driftingExpansion.page.nodes.body.onTextContent = () => {
    delete driftingExpansion.page.nodes.body.onTextContent;
    driftingExpansion.page.nodes["late-expander"] = { visible: true, parent: "html" };
    driftingExpansion.page.selectors["#remaining-expansion"].push("late-expander");
  };
  await mustReject(
    () => actor.scanPost(
      driftingExpansion.tab, { ...request, scan_request_id: "scan-expansion-drift" },
      locators, { ...optionsFor(action), threadExpansionComplete: true },
    ),
    /scan expansion-control count drifted|comment thread expansion is incomplete/,
  );

  const snapshotAction = actionFor("scan-snapshot");
  const snapshotFixture = fixture();
  const snapshotRequest = {
    scan_request_id: "scan-snapshot", session_id: snapshotAction.session_id,
    platform: "instagram", account_key: "account-a", post_key: "post-a",
    post_permalink: snapshotAction.post_permalink,
  };
  const snapshotPlan = await scanPlan();
  const snapshotOptions = {
    ...optionsFor(snapshotAction), threadExpansionComplete: true,
  };
  snapshotFixture.page.nodes.html.onVisible = () => {
    delete snapshotFixture.page.nodes.html.onVisible;
    snapshotRequest.account_key = "mutated-account";
    snapshotPlan.account.selector = "#mutated-account";
    snapshotOptions.testOnly = false;
    snapshotOptions.receiptObservedUrl = "https://evil.example/post";
  };
  const snapshotScan = await createCommentChromeActuator({ clock: fixedClock }).scanPost(
    snapshotFixture.tab, snapshotRequest, snapshotPlan, snapshotOptions,
  );
  assert.equal(snapshotRequest.account_key, "mutated-account");
  assert.equal(snapshotScan.account_key, "account-a");
  assert.equal(snapshotScan.test_only, true);

  page.nodes["parent-post"].attributes.href = "https://www.instagram.com/p/other";
  await mustReject(
    () => actor.scanPost(
      tab, { ...request, scan_request_id: "scan-2" }, locators, optionsFor(action),
    ),
    /parent post differs/,
  );
}

async function testPrepareSnapshotsInputs() {
  const mutableAction = actionFor("prepare-snapshot");
  const approvedReplyHash = mutableAction.reply_hash;
  const mutablePlan = structuredClone(plan);
  const mutableOptions = optionsFor(mutableAction);
  const { page, tab } = fixture();
  const approvedLiveUrl = mutableAction.post_permalink;
  const openComposer = page.nodes["reply-trigger"].onClick;
  page.nodes["reply-trigger"].onClick = () => {
    openComposer();
    mutableAction.reply_text = "準備期間遭竄改";
    mutablePlan.submit.selector = ".mutated-submit";
    mutableOptions.testOnly = false;
    mutableOptions.receiptObservedUrl = "https://evil.example/post";
    page.url = approvedLiveUrl;
  };
  const preparation = await createCommentChromeActuator({ clock: fixedClock }).prepareReply(
    tab, mutableAction, mutablePlan, mutableOptions,
  );
  assert.equal(mutableAction.reply_text, "準備期間遭竄改");
  assert.equal(mutablePlan.submit.selector, ".mutated-submit");
  assert.equal(preparation.reply_hash, approvedReplyHash);
  assert.equal(preparation.test_only, true);
  assert.equal(preparation.observed_url, approvedLiveUrl);
}

async function testSafeSend() {
  const action = actionFor("safe");
  const { page, tab } = fixture();
  const store = createClaimStore();
  const actor = createCommentChromeActuator({ clock: fixedClock, claimSubmit: store.claimSubmit });
  const options = optionsFor(action);
  const preparation = await actor.prepareReply(tab, action, plan, options);
  assert.equal(preparation.baseline_exact_reply_count, 0);
  const [first, second] = await Promise.allSettled([
    actor.submitOnce(tab, action, plan, preparation, options),
    actor.submitOnce(tab, action, plan, preparation, options),
  ]);
  assert.equal([first, second].filter((row) => row.status === "fulfilled").length, 1);
  assert.equal(page.nodes.submit.clicks, 1);
  const attempt = [first, second].find((row) => row.status === "fulfilled").value;
  const result = await actor.inspectResult(
    tab, action, plan, attempt, preparation, options,
  );
  assert.equal(result.exact_reply_visible, true);
  addReply(page);
  const duplicate = await actor.inspectResult(
    tab, action, plan, attempt, preparation, options,
  );
  assert.equal(duplicate.exact_reply_visible, false);
  await mustReject(
    () => createCommentChromeActuator({ claimSubmit: store.claimSubmit })
      .submitOnce(tab, action, plan, preparation, options),
    /second in-process|durable claim already consumed/,
  );
}

async function testReplyAppearsBetweenPreparationAndClaim() {
  const action = actionFor("claim-race");
  const { page, tab } = fixture();
  const actor = createCommentChromeActuator({
    clock: fixedClock,
    claimSubmit: async (request) => {
      await Promise.resolve();
      addReply(page);
      return {
        ...request, decision: "WRITE_OK", claim_id: "claim-race",
        preflight_id: "preflight-race",
      };
    },
  });
  const options = optionsFor(action);
  const preparation = await actor.prepareReply(tab, action, plan, options);
  const attempt = await actor.submitOnce(tab, action, plan, preparation, options);
  assert.equal(attempt.submission_attempted, false);
  assert.equal(attempt.submission_possible, false);
  assert.match(attempt.pre_click_error, /reply appeared after preparation/);
  assert.equal(page.nodes.submit.clicks ?? 0, 0);
  assert.equal(page.nodes.target.children[".reply"].length, 1);
}

async function testClaimCannotMutateActionOrPlan() {
  const mutableAction = actionFor("claim-mutation");
  const mutablePlan = structuredClone(plan);
  const { page, tab } = fixture();
  page.nodes.target.children[".evil-submit"] = ["evil-submit"];
  page.nodes["evil-submit"] = { visible: true, enabled: true };
  const actor = createCommentChromeActuator({
    clock: fixedClock,
    claimSubmit: async (request) => {
      await Promise.resolve();
      mutableAction.reply_text = "被竄改的回覆";
      mutableAction.reply_hash = sha256Text(mutableAction.reply_text);
      mutablePlan.submit.selector = ".evil-submit";
      return {
        ...request, decision: "WRITE_OK", claim_id: "claim-mutation",
        preflight_id: "preflight-mutation",
      };
    },
  });
  const options = optionsFor(mutableAction);
  const preparation = await actor.prepareReply(
    tab, mutableAction, mutablePlan, options,
  );
  const attempt = await actor.submitOnce(
    tab, mutableAction, mutablePlan, preparation, options,
  );
  assert.equal(attempt.submission_attempted, true);
  assert.equal(mutableAction.reply_text, "被竄改的回覆");
  assert.equal(mutablePlan.submit.selector, ".evil-submit");
  assert.equal(page.nodes.submit.clicks, 1);
  assert.equal(page.nodes["evil-submit"].clicks ?? 0, 0);
  assert.equal(page.nodes.target.children[".reply"].length, 1);
}

async function testOptionsCannotEscalateAcrossClaim() {
  const action = actionFor("options-escalation");
  const { page, tab } = fixture();
  const mutableOptions = optionsFor(action);
  const actor = createCommentChromeActuator({
    clock: fixedClock,
    claimSubmit: async (request) => {
      await Promise.resolve();
      mutableOptions.testOnly = false;
      mutableOptions.receiptObservedUrl = "https://evil.example/post";
      page.url = action.post_permalink;
      return {
        ...request, decision: "WRITE_OK", claim_id: "claim-options-escalation",
        preflight_id: "preflight-options-escalation",
      };
    },
  });
  const preparation = await actor.prepareReply(
    tab, action, plan, optionsFor(action),
  );
  const attempt = await actor.submitOnce(
    tab, action, plan, preparation, mutableOptions,
  );
  assert.equal(mutableOptions.testOnly, false);
  assert.equal(attempt.submission_attempted, false);
  assert.equal(attempt.submission_possible, false);
  assert.match(attempt.pre_click_error, /testOnly URL mapping is restricted to loopback hosts/);
  assert.equal(page.nodes.submit.clicks ?? 0, 0);
  assert.equal(page.nodes.target.children[".reply"].length, 0);
}

async function testReplyAppendDuringFinalScanIsBlocked() {
  const action = actionFor("reply-scan-append");
  const { page, tab } = fixture();
  addReply(page, { body: "先前不同的回覆" });
  let armed = false;
  let appended = false;
  page.nodes["reply-body-1"].onTextContent = () => {
    if (!armed || appended) return;
    appended = true;
    addReply(page);
  };
  const actor = createCommentChromeActuator({
    clock: fixedClock,
    claimSubmit: async (request) => {
      armed = true;
      return {
        ...request, decision: "WRITE_OK", claim_id: "claim-reply-scan-append",
        preflight_id: "preflight-reply-scan-append",
      };
    },
  });
  const options = optionsFor(action);
  const preparation = await actor.prepareReply(tab, action, plan, options);
  assert.equal(preparation.baseline_total_reply_count, 1);
  const attempt = await actor.submitOnce(tab, action, plan, preparation, options);
  assert.equal(appended, true);
  assert.equal(attempt.submission_attempted, false);
  assert.equal(attempt.submission_possible, false);
  assert.match(
    attempt.pre_click_error,
    /reply evidence (?:count drifted|changed during stability verification)/,
  );
  assert.equal(page.nodes.submit.clicks ?? 0, 0);
  assert.equal(page.nodes.target.children[".reply"].length, 2);
}

async function testComposerMutationDuringFinalScanIsBlocked() {
  const action = actionFor("composer-scan-mutation");
  const { page, tab } = fixture();
  addReply(page, { body: "先前不同的回覆" });
  let armed = false;
  page.nodes["reply-body-1"].onTextContent = () => {
    if (armed) page.nodes.composer.value = "掃描期間遭竄改";
  };
  const actor = createCommentChromeActuator({
    clock: fixedClock,
    claimSubmit: async (request) => {
      armed = true;
      return {
        ...request, decision: "WRITE_OK", claim_id: "claim-composer-scan-mutation",
        preflight_id: "preflight-composer-scan-mutation",
      };
    },
  });
  const options = optionsFor(action);
  const preparation = await actor.prepareReply(tab, action, plan, options);
  const attempt = await actor.submitOnce(tab, action, plan, preparation, options);
  assert.equal(attempt.submission_attempted, false);
  assert.equal(attempt.submission_possible, false);
  assert.match(attempt.pre_click_error, /composer changed during final reply verification/);
  assert.equal(page.nodes.submit.clicks ?? 0, 0);
  assert.equal(page.nodes.target.children[".reply"].length, 1);
}

async function testFreshClickContextAfterFinalScan() {
  const scenarios = [
    {
      suffix: "url",
      mutate: (page) => { page.url = "https://evil.example/post"; },
      error: /testOnly URL mapping is restricted to loopback hosts/,
    },
    {
      suffix: "context",
      mutate: (page) => { page.nodes.body.text = "掃描期間遭竄改"; },
      error: /comment body evidence mismatch/,
    },
    {
      suffix: "submit",
      mutate: (page) => {
        page.nodes["replacement-submit"] = {
          visible: true, enabled: true, parent: "target",
          attributes: { "data-id": "comment-b" },
        };
        page.nodes.target.children[".submit"] = ["replacement-submit"];
      },
      error: /reply submit control belongs to anchored target "comment-b", not approved target "comment-a"/,
    },
  ];
  for (const scenario of scenarios) {
    const action = actionFor(`final-click-${scenario.suffix}`);
    const { page, tab } = fixture();
    const actor = createCommentChromeActuator({
      clock: fixedClock,
      claimSubmit: async (request) => {
        addReply(page, { body: "另一則回覆", author: "other-account" });
        page.nodes["reply-body-1"].onTextContent = () => {
          delete page.nodes["reply-body-1"].onTextContent;
          scenario.mutate(page);
        };
        return {
          ...request, decision: "WRITE_OK",
          claim_id: `claim-final-click-${scenario.suffix}`,
          preflight_id: `preflight-final-click-${scenario.suffix}`,
        };
      },
    });
    const options = optionsFor(action);
    const preparation = await actor.prepareReply(tab, action, plan, options);
    const attempt = await actor.submitOnce(tab, action, plan, preparation, options);
    assert.equal(attempt.submission_attempted, false);
    assert.equal(attempt.submission_possible, false);
    assert.match(attempt.pre_click_error, scenario.error);
    assert.equal(page.nodes.submit.clicks ?? 0, 0);
    assert.equal(page.nodes["replacement-submit"]?.clicks ?? 0, 0);
  }
}

async function testGuards() {
  const action = actionFor("guards");
  const options = optionsFor(action);
  await mustReject(
    () => createCommentChromeActuator().prepareReply(
      fixture().tab, { ...action, reply_text: "被竄改" }, plan, options,
    ),
    /reply_hash does not match/,
  );
  await mustReject(
    () => createCommentChromeActuator().prepareReply(
      fixture().tab, action, { ...plan, account: { ...plan.account, expected: "attacker" } }, options,
    ),
    /expected is forbidden/,
  );
  const broad = fixture();
  delete broad.page.nodes.target.attributes["data-id"];
  broad.page.nodes.target.children[".comment"] = ["comment-a-row", "comment-b-row"];
  broad.page.nodes["comment-a-row"] = {
    visible: true, attributes: { "data-id": "comment-a" },
  };
  broad.page.nodes["comment-b-row"] = {
    visible: true, attributes: { "data-id": "comment-b" },
  };
  const broadContainerPlan = {
    ...plan,
    targetAnchor: { selector: ".anchor", within: "target", attribute: "data-id" },
  };
  await mustReject(
    () => createCommentChromeActuator().prepareReply(
      broad.tab, action, broadContainerPlan, options,
    ),
    /targetAnchor must be an attribute on the unique target element itself/,
  );
  const nested = fixture();
  nested.page.nodes["nested-comment"] = {
    visible: true, parent: "target", attributes: { "data-id": "comment-b" },
  };
  for (const [key, row] of Object.entries({
    "nested-author": { visible: true, text: "viewer-a" },
    "nested-body": { visible: true, text: "這一集會反擊嗎？" },
    "nested-trigger": { visible: true, enabled: true },
    "nested-composer": { visible: true, enabled: true, value: "" },
    "nested-submit": { visible: true, enabled: true },
  })) {
    nested.page.nodes[key] = { ...row, parent: "nested-comment" };
  }
  nested.page.nodes["nested-reply"] = {
    visible: true, parent: "nested-comment",
    children: {
      ".reply-author": ["nested-reply-author"],
      ".reply-body": ["nested-reply-body"],
    },
  };
  nested.page.nodes["nested-reply-author"] = {
    visible: true, text: "account-a", parent: "nested-reply",
  };
  nested.page.nodes["nested-reply-body"] = {
    visible: true, text: "不同的既有回覆", parent: "nested-reply",
  };
  Object.assign(nested.page.nodes.target.children, {
    ".nested-author": ["nested-author"],
    ".nested-body": ["nested-body"],
    ".nested-trigger": ["nested-trigger"],
    ".nested-composer": ["nested-composer"],
    ".nested-submit": ["nested-submit"],
    ".nested-reply": ["nested-reply"],
  });
  await mustReject(
    () => createCommentChromeActuator().prepareReply(
      nested.tab, action, {
        ...plan,
        author: { selector: ".nested-author", within: "target" },
        body: { selector: ".nested-body", within: "target" },
      }, options,
    ),
    /comment body belongs to anchored target "comment-b", not approved target "comment-a"/,
  );
  await mustReject(
    () => createCommentChromeActuator().prepareReply(
      nested.tab, action, {
        ...plan,
        replyItems: { selector: ".nested-reply", within: "target" },
      }, options,
    ),
    /reply item belongs to anchored target "comment-b", not approved target "comment-a"/,
  );
  await mustReject(
    () => createCommentChromeActuator().prepareReply(
      nested.tab, action, {
        ...plan,
        replyTrigger: { selector: ".nested-trigger", within: "target" },
        composer: {
          selector: ".nested-composer", within: "target", valueProperty: true,
        },
        submit: { selector: ".nested-submit", within: "target" },
      }, options,
    ),
    /reply trigger belongs to anchored target "comment-b", not approved target "comment-a"/,
  );
  for (const [nodeKey, label] of [
    ["body", "comment body"],
    ["author", "comment author"],
    ["reply-trigger", "reply trigger"],
    ["composer", "reply composer"],
    ["submit", "reply submit control"],
  ]) {
    const selfAnchored = fixture();
    selfAnchored.page.nodes[nodeKey].attributes = { "data-id": "comment-b" };
    await mustReject(
      () => createCommentChromeActuator().prepareReply(
        selfAnchored.tab, action, plan, options,
      ),
      new RegExp(`${label} belongs to anchored target "comment-b", not approved target "comment-a"`),
    );
  }
  for (const [nodeKey, label] of [
    ["reply-body-1", "reply body"],
    ["reply-author-1", "reply author"],
  ]) {
    const selfAnchoredReplyEvidence = fixture();
    addReply(selfAnchoredReplyEvidence.page, {
      body: "不同的既有回覆", author: "other-account",
    });
    selfAnchoredReplyEvidence.page.nodes[nodeKey].attributes = {
      "data-id": "reply-decoy",
    };
    await mustReject(
      () => createCommentChromeActuator().prepareReply(
        selfAnchoredReplyEvidence.tab, action, plan, options,
      ),
      new RegExp(`${label} belongs to anchored target "reply-decoy", not approved target "comment-a"`),
    );
  }
  await mustReject(
    () => createCommentChromeActuator().prepareReply(
      fixture({ existingReply: true }).tab, action, plan, options,
    ),
    /already exists/,
  );
  const directAnchoredExisting = fixture();
  addReply(directAnchoredExisting.page);
  directAnchoredExisting.page.nodes["reply-1"].attributes = {
    "data-id": "reply-direct",
  };
  await mustReject(
    () => createCommentChromeActuator().prepareReply(
      directAnchoredExisting.tab, action, plan, options,
    ),
    /already exists/,
  );
  const hiddenExisting = fixture();
  addReply(hiddenExisting.page, { hidden: true });
  await mustReject(
    () => createCommentChromeActuator().prepareReply(
      hiddenExisting.tab, action, plan, options,
    ),
    /reply evidence is incomplete/,
  );
  const wrongParentPlan = {
    ...plan, composer: { selector: ".other-composer", within: "target", valueProperty: true },
  };
  await mustReject(
    () => createCommentChromeActuator().prepareReply(fixture().tab, action, wrongParentPlan, options),
    /exactly one match/,
  );
  const duplicate = fixture({ duplicateSubmit: true });
  await mustReject(
    () => createCommentChromeActuator().prepareReply(duplicate.tab, action, plan, options),
    /exactly one match/,
  );
  const noClaim = fixture();
  const prep = await createCommentChromeActuator().prepareReply(noClaim.tab, action, plan, options);
  await mustReject(
    () => createCommentChromeActuator().submitOnce(noClaim.tab, action, plan, prep, options),
    /durable atomic claimSubmit/,
  );
  const changedPlanStore = createClaimStore();
  await mustReject(
    () => createCommentChromeActuator({ claimSubmit: changedPlanStore.claimSubmit }).submitOnce(
      noClaim.tab, action, { ...plan, submit: { ...plan.submit, selector: ".changed" } }, prep, options,
    ),
    /locator-plan digest is stale/,
  );
  await mustReject(
    () => createCommentChromeActuator().prepareReply(
      new FakeTab({ ...fixture().page, url: "https://evil.example/post" }), action, plan,
    ),
    /untrusted host/,
  );
  await mustReject(
    () => createCommentChromeActuator().prepareReply(
      fixture().tab, action, plan,
      { ...options, receiptObservedUrl: "https://user@www.instagram.com/p/post-a" },
    ),
    /credentials are forbidden/,
  );

  const liveAction = actionFor("live-unbranded");
  const live = fixture();
  live.page.url = liveAction.post_permalink;
  const liveStore = createClaimStore();
  const liveActor = createCommentChromeActuator({ claimSubmit: liveStore.claimSubmit });
  const livePreparation = await liveActor.prepareReply(live.tab, liveAction, plan);
  await mustReject(
    () => liveActor.submitOnce(live.tab, liveAction, plan, livePreparation),
    /live submit requires a constructed Python ledger claim bridge/,
  );
  assert.equal(liveStore.claimed.size, 0);
  assert.equal(live.page.nodes.submit.clicks ?? 0, 0);
  let forgedRunnerCalls = 0;
  const forgedFactoryBridge = createPythonLedgerClaimSubmit({
    preparation: livePreparation,
    runner: async (request) => {
      forgedRunnerCalls += 1;
      return request;
    },
  });
  await mustReject(
    () => createCommentChromeActuator({ claimSubmit: forgedFactoryBridge }).submitOnce(
      live.tab, liveAction, plan, livePreparation,
    ),
    /live submit requires a constructed Python ledger claim bridge/,
  );
  assert.equal(forgedRunnerCalls, 0);
  assert.equal(live.page.nodes.submit.clicks ?? 0, 0);

  const defaultDeniedLive = fixture();
  defaultDeniedLive.page.url = liveAction.post_permalink;
  const preparationForDefaultBridge = await createCommentChromeActuator().prepareReply(
    defaultDeniedLive.tab, liveAction, plan,
  );
  const defaultBridge = createPythonLedgerClaimSubmit({
    preparation: preparationForDefaultBridge,
  });
  assert.equal(defaultBridge instanceof Function, true);
  await mustReject(
    () => createCommentChromeActuator({ claimSubmit: defaultBridge }).submitOnce(
      defaultDeniedLive.tab, liveAction, plan, preparationForDefaultBridge,
    ),
    /live browser ledger mutation is disabled by policy/,
  );
  assert.equal(defaultDeniedLive.page.nodes.submit.clicks ?? 0, 0);
  assert.equal(defaultDeniedLive.page.nodes.target.children[".reply"].length, 0);
}

async function testDelayedReplyRequiresFreshReinspection() {
  const action = actionFor("delayed-render");
  const options = optionsFor(action);
  const delayed = fixture();
  delayed.page.nodes.submit.onClick = () => {
    delayed.page.nodes.composer.value = "";
    delayed.page.nodes.submit.enabled = false;
  };
  const store = createClaimStore();
  const actor = createCommentChromeActuator({
    clock: fixedClock, claimSubmit: store.claimSubmit,
  });
  const preparation = await actor.prepareReply(
    delayed.tab, action, plan, options,
  );
  const attempt = await actor.submitOnce(
    delayed.tab, action, plan, preparation, options,
  );
  const immediate = await actor.inspectResult(
    delayed.tab, action, plan, attempt, preparation, options,
  );
  assert.equal(immediate.submission_attempted, true);
  assert.equal(immediate.exact_reply_visible, false);
  assert.equal(immediate.own_author_verified, false);
  addReply(delayed.page);
  const fresh = await actor.reinspect(
    delayed.tab, action, plan, attempt, action.session_id,
    "session-delayed-reinspect", preparation, options,
  );
  assert.equal(fresh.exact_reply_visible, true);
  assert.equal(fresh.own_author_verified, true);
  assert.equal(fresh.absence_verified, false);
}

async function testReinspectionCompleteness() {
  const action = actionFor("reinspect");
  const options = optionsFor(action);
  const empty = fixture();
  const actor = createCommentChromeActuator();
  const preparation = await actor.prepareReply(empty.tab, action, plan, options);
  const attempt = {
    action_id: action.action_id, claim_id: "claim-reinspect",
    preflight_id: "preflight-reinspect", preparation_id: preparation.preparation_id,
  };
  const absent = await actor.reinspect(
    empty.tab, action, plan, attempt, action.session_id, "session-r2",
    preparation, options,
  );
  assert.equal(absent.absence_verified, true);
  assert.equal(absent.reinspection_total_reply_count, 0);
  addReply(empty.page, { body: "下一集就會揭曉" });
  const normalizedByPlatform = await actor.reinspect(
    empty.tab, action, plan, attempt, action.session_id, "session-r3",
    preparation, options,
  );
  assert.equal(normalizedByPlatform.exact_reply_visible, false);
  assert.equal(normalizedByPlatform.absence_verified, false);
  assert.equal(normalizedByPlatform.own_author_reply_count, 1);
  assert.equal(normalizedByPlatform.reinspection_total_reply_count, 1);
  assert.match(
    normalizedByPlatform.evidence,
    /own-account replies but no exact approved text/,
  );
  const virtualizedAction = actionFor("virtualized-reinspection");
  const virtualizedOptions = optionsFor(virtualizedAction);
  const virtualized = fixture();
  addReply(virtualized.page, { body: "先前不同的回覆" });
  const virtualizedActor = createCommentChromeActuator();
  const virtualizedPreparation = await virtualizedActor.prepareReply(
    virtualized.tab, virtualizedAction, plan, virtualizedOptions,
  );
  assert.equal(virtualizedPreparation.baseline_total_reply_count, 1);
  const virtualizedAttempt = {
    action_id: virtualizedAction.action_id, claim_id: "claim-virtualized",
    preflight_id: "preflight-virtualized",
    preparation_id: virtualizedPreparation.preparation_id,
  };
  virtualized.page.nodes.target.children[".reply"] = [];
  const countRegression = await virtualizedActor.reinspect(
    virtualized.tab, virtualizedAction, plan, virtualizedAttempt,
    virtualizedAction.session_id, "session-virtualized-reinspect",
    virtualizedPreparation, virtualizedOptions,
  );
  assert.equal(countRegression.reinspection_total_reply_count, 0);
  assert.equal(countRegression.own_author_reply_count, 0);
  assert.equal(countRegression.exact_reply_visible, false);
  assert.equal(countRegression.own_author_verified, false);
  assert.equal(countRegression.absence_verified, false);
  assert.match(countRegression.evidence, /below preparation baseline/);
  const equalTotalAction = actionFor("equal-total-exact");
  const equalTotalOptions = optionsFor(equalTotalAction);
  const equalTotal = fixture();
  addReply(equalTotal.page, { body: "先前不同的回覆" });
  const equalTotalActor = createCommentChromeActuator();
  const equalTotalPreparation = await equalTotalActor.prepareReply(
    equalTotal.tab, equalTotalAction, plan, equalTotalOptions,
  );
  assert.equal(equalTotalPreparation.baseline_total_reply_count, 1);
  equalTotal.page.nodes["reply-body-1"].text = equalTotalAction.reply_text;
  const equalTotalAttempt = {
    action_id: equalTotalAction.action_id, claim_id: "claim-equal-total",
    preflight_id: "preflight-equal-total",
    preparation_id: equalTotalPreparation.preparation_id,
    submission_attempted: true, submission_possible: true,
  };
  const equalTotalResult = await equalTotalActor.inspectResult(
    equalTotal.tab, equalTotalAction, plan, equalTotalAttempt,
    equalTotalPreparation, equalTotalOptions,
  );
  assert.equal(equalTotalResult.post_submit_total_reply_count, 1);
  assert.equal(equalTotalResult.exact_reply_visible, false);
  assert.equal(equalTotalResult.own_author_verified, false);
  assert.match(equalTotalResult.evidence, /does not exceed preparation baseline/);
  const equalTotalReinspection = await equalTotalActor.reinspect(
    equalTotal.tab, equalTotalAction, plan, equalTotalAttempt,
    equalTotalAction.session_id, "session-equal-total-reinspect",
    equalTotalPreparation, equalTotalOptions,
  );
  assert.equal(equalTotalReinspection.reinspection_total_reply_count, 1);
  assert.equal(equalTotalReinspection.exact_reply_visible, false);
  assert.equal(equalTotalReinspection.own_author_verified, false);
  assert.equal(equalTotalReinspection.absence_verified, false);
  assert.match(equalTotalReinspection.evidence, /does not exceed preparation baseline/);
  empty.page.nodes.expander = { visible: true };
  empty.page.nodes.target.children[".remaining-reply-expansion"] = ["expander"];
  await mustReject(
    () => actor.reinspect(
      empty.tab, action, plan, attempt, action.session_id, "session-r2",
      preparation, options,
    ),
    /expansion is incomplete/,
  );
  const malformed = fixture();
  const malformedPrep = await createCommentChromeActuator().prepareReply(
    malformed.tab, actionFor("malformed"), plan, optionsFor(actionFor("malformed")),
  );
  addReply(malformed.page, { malformed: true });
  const malformedAction = actionFor("malformed");
  const malformedAttempt = {
    action_id: malformedAction.action_id, claim_id: "claim-malformed",
    preflight_id: "preflight-malformed", preparation_id: malformedPrep.preparation_id,
  };
  await mustReject(
    () => createCommentChromeActuator().reinspect(
      malformed.tab, malformedAction, plan, malformedAttempt, "session-m", "session-m2",
      malformedPrep, optionsFor(actionFor("malformed")),
    ),
    /evidence is incomplete/,
  );
}

await testScan();
await testPrepareSnapshotsInputs();
await testSafeSend();
await testReplyAppearsBetweenPreparationAndClaim();
await testClaimCannotMutateActionOrPlan();
await testOptionsCannotEscalateAcrossClaim();
await testReplyAppendDuringFinalScanIsBlocked();
await testComposerMutationDuringFinalScanIsBlocked();
await testFreshClickContextAfterFinalScan();
await testGuards();
await testDelayedReplyRequiresFreshReinspection();
await testReinspectionCompleteness();
console.log("comment Chrome actuator test passed");

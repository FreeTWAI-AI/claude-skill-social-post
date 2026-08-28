/** Localhost-only real-browser E2E driver for the comment Chrome actuator. */

import assert from "node:assert/strict";
import { createCommentChromeActuator } from "./comment_chrome_actuator.mjs";
import { sha256Text } from "./comment_chrome_common.mjs";

const FIXTURES = {
  facebook: {
    file: "facebook.html", postKey: "fixture-facebook-post", commentId: "fb-comment-001",
    decoyId: "fb-comment-decoy",
    viewer: "viewer-facebook", body: "這個測試太精彩了🔥", reply: "謝謝你來看這個測試！",
    receiptUrl: "https://www.facebook.com/fixture/posts/fixture-facebook-post",
    target: "[data-fb-comment-id]", idAttribute: "data-fb-comment-id",
    author: "[data-fb-author]", bodySelector: "[data-fb-body]",
    trigger: "[data-fb-reply-trigger]",
    composer: "[data-fb-composer]", submit: "[data-fb-submit]",
    replyItems: "[data-fb-own-reply]",
  },
  instagram: {
    file: "instagram.html", postKey: "fixture-instagram-post", commentId: "ig-comment-001",
    decoyId: "ig-comment-decoy",
    viewer: "viewer-instagram", body: "女主角下一集會反擊嗎？", reply: "下一集就會揭曉。",
    receiptUrl: "https://www.instagram.com/p/fixture-instagram-post",
    target: "[data-ig-comment-id]", idAttribute: "data-ig-comment-id",
    author: "[data-ig-author]", bodySelector: "[data-ig-body]",
    trigger: "[data-ig-reply-trigger]",
    composer: "[data-ig-composer]", submit: "[data-ig-submit]",
    replyItems: "[data-ig-own-reply]",
  },
  threads: {
    file: "threads.html", postKey: "fixture-threads-post", commentId: "threads-reply-001",
    decoyId: "threads-reply-decoy",
    viewer: "viewer-threads", body: "有下一集記得通知我！", reply: "有更新我會公開發出來！",
    receiptUrl: "https://www.threads.com/@fixture/post/fixture-threads-post",
    target: "[data-threads-reply-id]", idAttribute: "data-threads-reply-id",
    author: "[data-threads-author]", bodySelector: "[data-threads-body]",
    trigger: "[data-threads-reply-trigger]",
    composer: "[data-threads-composer]", submit: "[data-threads-submit]",
    replyItems: "[data-threads-own-reply]",
  },
};

function values(platform, baseUrl) {
  const fixture = FIXTURES[platform];
  if (!fixture) throw new Error(`unknown fixture platform ${platform}`);
  const sessionId = `fixture-session-${platform}`;
  const scope = {
    platform, account_key: "fixture-account", post_key: fixture.postKey,
    comment_key: `${platform}:fixture-account:${fixture.postKey}:${fixture.commentId}`,
  };
  const action = {
    schema_version: 1, action_id: `fixture-action-${platform}`,
    intent_id: `fixture-intent-${platform}`, session_id: sessionId,
    permit_id: `fixture-permit-${platform}`, scope,
    post_permalink: fixture.receiptUrl,
    comment_fingerprint: `fixture-fingerprint-${platform}`,
    reply_hash: sha256Text(fixture.reply), reply_text: fixture.reply,
    expected_body: fixture.body, author_key: fixture.viewer,
    comment_anchor: { platform_comment_id: fixture.commentId, comment_permalink: null },
  };
  const exactTarget = `${fixture.target}[${fixture.idAttribute}="${fixture.commentId}"]`;
  const decoyTarget = `${fixture.target}[${fixture.idAttribute}="${fixture.decoyId}"]`;
  const plan = {
    account: { selector: "html", attribute: "data-account-key" },
    post: { selector: "html", attribute: "data-post-key" },
    target: { selector: exactTarget },
    targetAnchor: { selector: ":scope", within: "target", self: true, attribute: fixture.idAttribute },
    author: { selector: ":scope", within: "target", self: true, attribute: "data-author-key" },
    body: { selector: fixture.bodySelector, within: "target" },
    replyTrigger: { selector: fixture.trigger, within: "target" },
    composer: { selector: fixture.composer, within: "target", valueProperty: true },
    submit: { selector: fixture.submit, within: "target" },
    replyItems: { selector: fixture.replyItems, within: "target" },
    replyAuthor: { selector: "[data-fixture-own-author]", within: "reply" },
    replyBody: { selector: "[data-fixture-own-body]", within: "reply" },
    replyExpansionControls: { selector: "[data-fixture-reply-expand-control]", within: "target" },
  };
  const scanRequest = {
    schema_version: 1, scan_request_id: `fixture-scan-${platform}`,
    session_id: sessionId, platform, account_key: "fixture-account",
    post_key: fixture.postKey, post_permalink: fixture.receiptUrl,
  };
  const scanPlan = {
    authentication: { selector: "html", attribute: "data-authentication-state" },
    account: { selector: "html", attribute: "data-account-key" },
    post: { selector: "html", attribute: "data-post-key" },
    comments: { selector: fixture.target },
    commentId: { selector: ":scope", self: true, attribute: fixture.idAttribute },
    author: { selector: ":scope", self: true, attribute: "data-author-key" },
    authorDisplay: { selector: fixture.author }, body: { selector: fixture.bodySelector },
    parentPost: { selector: ":scope", self: true, attribute: "data-parent-post-permalink" },
    isOwn: { selector: ":scope", self: true, attribute: "data-is-own" },
    ownReplyItems: { selector: fixture.replyItems },
    ownReplyAuthor: { selector: "[data-fixture-own-author]" },
    bodyComplete: true, language: "zh-Hant",
    expansionControls: { selector: "[data-fixture-expand-control]" },
  };
  return {
    fixture, action, plan, scanRequest, scanPlan, exactTarget, decoyTarget,
    pageUrl: `${baseUrl.replace(/\/$/, "")}/${fixture.file}`,
  };
}

function requireLoopbackBaseUrl(raw) {
  const url = new URL(raw);
  const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (url.protocol !== "http:" || !loopback.has(url.hostname)
      || url.username || url.password || url.search || url.hash) {
    throw new Error("fixture Browser E2E requires a plain loopback HTTP base URL");
  }
  return url.toString().replace(/\/$/u, "");
}

export async function runFixtureBrowserE2E(tab, platform, {
  baseUrl = "http://127.0.0.1:8765", navigate = true,
} = {}) {
  const setup = values(platform, requireLoopbackBaseUrl(baseUrl));
  if (navigate) await tab.goto(setup.pageUrl);
  const claimed = new Set();
  const actor = createCommentChromeActuator({ claimSubmit: async (request) => {
    if (claimed.has(request.action_id)) throw new Error("fixture durable claim already consumed");
    claimed.add(request.action_id);
    return {
      ...request, decision: "WRITE_OK", claim_id: `fixture-claim-${platform}`,
      preflight_id: `fixture-preflight-${platform}`,
    };
  } });
  const testOptions = { testOnly: true, receiptObservedUrl: setup.fixture.receiptUrl };
  const scan = await actor.scanPost(tab, setup.scanRequest, setup.scanPlan, {
    ...testOptions, threadExpansionComplete: true,
  });
  assert.equal(scan.comments.length, 2);
  assert.deepEqual(
    new Set(scan.comments.map((comment) => comment.platform_comment_id)),
    new Set([setup.fixture.commentId, setup.fixture.decoyId]),
  );
  const preflight = await actor.prepareReply(tab, setup.action, setup.plan, testOptions);
  const attempt = await actor.submitOnce(
    tab, setup.action, setup.plan, preflight, testOptions,
  );
  const result = await actor.inspectResult(
    tab, setup.action, setup.plan, attempt, preflight, testOptions,
  );
  const root = tab.playwright.locator("html");
  const target = tab.playwright.locator(setup.exactTarget);
  const decoy = tab.playwright.locator(setup.decoyTarget);
  const composer = target.locator(setup.fixture.composer);
  const submit = target.locator(setup.fixture.submit);
  const decoyReplies = decoy.locator(setup.fixture.replyItems);
  const attempts = await root.getAttribute("data-submit-attempts");
  const accepted = await root.getAttribute("data-accepted-count");
  const triggerAttempts = await root.getAttribute("data-reply-trigger-attempts");
  const parent = await root.getAttribute("data-accepted-parent-comment-id");
  const composerValue = await composer.evaluate((element) => (
    "value" in element ? element.value : element.textContent
  ));
  assert.equal(attempts, "1");
  assert.equal(accepted, "1");
  assert.equal(triggerAttempts, "1");
  assert.equal(parent, setup.fixture.commentId);
  assert.equal(composerValue, "");
  assert.equal(await submit.isEnabled(), false);
  assert.equal(await decoyReplies.count(), 0);
  assert.equal(result.exact_reply_visible, true);
  assert.equal(result.own_author_verified, true);
  assert.equal(result.parent_verified, true);
  return { platform, page_url: setup.pageUrl, scan, preflight, attempt, result, dom: {
    submit_attempts: Number(attempts), accepted_count: Number(accepted),
    reply_trigger_attempts: Number(triggerAttempts),
    parent_comment_id: parent, composer_empty: composerValue === "", submit_disabled: true,
  } };
}

export function fixturePlatforms() { return Object.keys(FIXTURES); }

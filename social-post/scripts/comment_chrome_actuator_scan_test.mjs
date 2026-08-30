import assert from "node:assert/strict";

import { createCommentChromeActuator } from "./comment_chrome_actuator.mjs";
import {
  actionFor, addReply, fixedClock, fixture, mustReject, optionsFor, scanPlan,
} from "./comment_chrome_actuator_fixture_test.mjs";
import { digestObject } from "./comment_chrome_common.mjs";

export async function testScan() {
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
    /raw scanPost is test-only; live scan must use scanAndCommit/,
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

  const fusedAction = actionFor("scan-fused");
  const fusedFixture = fixture();
  const fusedLocators = await scanPlan();
  const fusedTarget = {
    platform: "instagram", account_key: "account-a", post_key: "post-a",
    post_permalink: fusedAction.post_permalink, session_id: fusedAction.session_id,
    ttl_minutes: 5,
  };
  const capability = Object.freeze({
    schema_version: 1, operation: "browser-scan",
    capability_id: "4".repeat(32), nonce: "d".repeat(43),
  });
  const authorization = (suffix = "ok") => ({
    schema_version: 1, decision: "SCAN_AUTHORIZED",
    scan_request: {
      schema_version: 1, scan_request_id: `scan-fused-${suffix}`,
      ...fusedTarget, requested_at: "2030-01-02T12:00:00+00:00",
      expires_at: "2030-01-02T12:05:00+00:00",
    },
    receipt_capability: capability,
  });
  let privateEnvelope;
  const commitFor = ({ request, envelope }) => {
    privateEnvelope = envelope;
    return {
      schema_version: 1, operation: "browser-scan",
      scan_request_id: request.scan_request_id, scan_id: "scan-fused-result",
      receipt_digest: digestObject(envelope.receipt),
      comment_count: envelope.receipt.comments.length,
      added_count: envelope.receipt.comments.length, unchanged_count: 0,
      zero_result: envelope.receipt.comments.length === 0,
    };
  };
  const fusedActor = createCommentChromeActuator({
    clock: fixedClock,
    scanRequestRunner: async () => authorization(),
    scanCommitRunner: async (input) => commitFor(input),
  });
  const fusedCommit = await fusedActor.scanAndCommit(
    fusedFixture.tab, fusedTarget, fusedLocators,
    { ...optionsFor(fusedAction), threadExpansionComplete: true },
  );
  assert.equal(fusedCommit.comment_count, 1);
  assert.equal(privateEnvelope.provenance.nonce, capability.nonce);
  assert.equal(JSON.stringify(fusedCommit).includes("nonce"), false);
  assert.equal(JSON.stringify(fusedActor).includes("nonce"), false);
  assert.equal(Object.isFrozen(fusedCommit), true);

  const tamperedCommitActor = createCommentChromeActuator({
    clock: fixedClock,
    scanRequestRunner: async () => authorization("tamper"),
    scanCommitRunner: async ({ request, envelope }) => ({
      ...commitFor({ request, envelope }), receipt_digest: "0".repeat(64),
    }),
  });
  await mustReject(
    () => tamperedCommitActor.scanAndCommit(
      fixture().tab, fusedTarget, fusedLocators,
      { ...optionsFor(fusedAction), threadExpansionComplete: true },
    ),
    /commit receipt digest is not bound/,
  );

  const childFailureActor = createCommentChromeActuator({
    clock: fixedClock,
    scanRequestRunner: async () => authorization("child-failure"),
    scanCommitRunner: async () => { throw new Error("child process failed"); },
  });
  await mustReject(
    () => childFailureActor.scanAndCommit(
      fixture().tab, fusedTarget, fusedLocators,
      { ...optionsFor(fusedAction), threadExpansionComplete: true },
    ),
    /child process failed/,
  );

  const timeoutActor = createCommentChromeActuator({
    clock: fixedClock,
    scanRequestRunner: async () => { throw new Error("durable scan request timed out"); },
    scanCommitRunner: async () => { throw new Error("must not run"); },
  });
  await mustReject(
    () => timeoutActor.scanAndCommit(
      fixture().tab, fusedTarget, fusedLocators,
      { ...optionsFor(fusedAction), threadExpansionComplete: true },
    ),
    /timed out/,
  );

  let releaseAuthorization;
  const blockedAuthorization = new Promise((resolve) => { releaseAuthorization = resolve; });
  const doubleActor = createCommentChromeActuator({
    clock: fixedClock,
    scanRequestRunner: async () => blockedAuthorization,
    scanCommitRunner: async (input) => commitFor(input),
  });
  const first = doubleActor.scanAndCommit(
    fixture().tab, fusedTarget, fusedLocators,
    { ...optionsFor(fusedAction), threadExpansionComplete: true },
  );
  await mustReject(
    () => doubleActor.scanAndCommit(
      fixture().tab, fusedTarget, fusedLocators,
      { ...optionsFor(fusedAction), threadExpansionComplete: true },
    ),
    /already in flight/,
  );
  releaseAuthorization(authorization("double"));
  assert.equal((await first).comment_count, 1);
}

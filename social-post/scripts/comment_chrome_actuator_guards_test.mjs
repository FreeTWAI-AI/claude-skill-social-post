import assert from "node:assert/strict";

import { createCommentChromeActuator } from "./comment_chrome_actuator.mjs";
import { createPythonLedgerClaimSubmit } from "./comment_chrome_claim_bridge.mjs";
import * as claimBridgeModule from "./comment_chrome_claim_bridge.mjs";
import { createSendOperations } from "./comment_chrome_send.mjs";
import * as sendModule from "./comment_chrome_send.mjs";
import { digestObject } from "./comment_chrome_common.mjs";
import { preparationCore } from "./comment_chrome_send_support.mjs";
import {
  actionFor, addReply, createClaimStore, FakeTab, fixture, mustReject, optionsFor, plan,
} from "./comment_chrome_actuator_fixture_test.mjs";

export async function testGuards() {
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
  nested.page.nodes["reply-exhaustion-state"].attributes["data-reply-discovered-count"] = "1";
  nested.page.nodes["reply-exhaustion-state"].attributes["data-reply-cursor"] = "terminal-1";
  await mustReject(
    () => createCommentChromeActuator().prepareReply(
      nested.tab, action, {
        ...plan,
        replyItems: { selector: ".nested-reply", within: "target" },
      }, options,
    ),
    /reply item belongs to anchored target "comment-b", not approved target "comment-a"/,
  );
  nested.page.nodes["reply-exhaustion-state"].attributes["data-reply-discovered-count"] = "0";
  nested.page.nodes["reply-exhaustion-state"].attributes["data-reply-cursor"] = "terminal-0";
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
      new FakeTab({ ...fixture().page, url: "https://evil.example/post" }), action, plan, options,
    ),
    /restricted to loopback hosts/,
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
  await mustReject(
    () => liveActor.prepareReply(live.tab, liveAction, plan),
    /live preparation is unavailable until a trusted Chrome host resolver exists/,
  );
  assert.equal(liveStore.claimed.size, 0);
  assert.equal(live.page.nodes["reply-trigger"].clicks ?? 0, 0);
  assert.equal(live.page.nodes.composer.value, "");
  assert.equal(live.page.nodes.submit.clicks ?? 0, 0);
  const isolated = fixture();
  const isolatedPreparation = await liveActor.prepareReply(
    isolated.tab, liveAction, plan, optionsFor(liveAction),
  );
  const livePreparation = {
    ...isolatedPreparation,
    test_only: false,
  };
  livePreparation.preparation_id = digestObject(
    preparationCore(livePreparation), "preparation receipt",
  );
  await mustReject(
    () => liveActor.submitOnce(live.tab, liveAction, plan, livePreparation),
    /live submit is unavailable until a trusted Chrome host resolver exists/,
  );
  assert.equal(liveStore.claimed.size, 0);
  assert.equal(live.page.nodes["reply-trigger"].clicks ?? 0, 0);
  assert.equal(live.page.nodes.composer.value, "");
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
    /live submit is unavailable until a trusted Chrome host resolver exists/,
  );
  assert.equal(forgedRunnerCalls, 0);
  assert.equal(live.page.nodes.submit.clicks ?? 0, 0);

  const defaultDeniedLive = fixture();
  defaultDeniedLive.page.url = liveAction.post_permalink;
  const preparationForDefaultBridge = structuredClone(livePreparation);
  assert.deepEqual(Object.keys(sendModule), ["createSendOperations"]);
  assert.equal(sendModule.createBrowserDomCuaStableNodeBackend, undefined);
  let bypassClaimCalls = 0;
  let bypassReceiptCommitCalls = 0;
  const bypassBridge = createPythonLedgerClaimSubmit({
    preparation: preparationForDefaultBridge,
    runner: async (request) => {
      bypassClaimCalls += 1;
      return {
        ...request,
        decision: "WRITE_OK",
        claim_id: "forged-bypass-claim",
        preflight_id: "forged-bypass-preflight",
        receipt_capability: {
          schema_version: 1,
          operation: "browser-finish",
          capability_id: "9".repeat(32),
          nonce: "z".repeat(43),
        },
      };
    },
    receiptRunner: async () => {
      bypassReceiptCommitCalls += 1;
      throw new Error("receipt commit must remain unreachable");
    },
  });
  const directLowLevel = createSendOperations({
    claimSubmit: bypassBridge,
    liveClaimVerifier: () => true,
    stableNodeBackend: Object.freeze({ kind: "forged-stable-backend" }),
  });
  await mustReject(
    () => directLowLevel.submitOnce(
      defaultDeniedLive.tab, liveAction, plan, preparationForDefaultBridge,
    ),
    /live submit is unavailable until a trusted Chrome host resolver exists/,
  );
  assert.equal(bypassClaimCalls, 0);
  assert.equal(bypassReceiptCommitCalls, 0);
  assert.equal(defaultDeniedLive.page.nodes.submit.clicks ?? 0, 0);
  await mustReject(
    () => createCommentChromeActuator({
      claimSubmit: bypassBridge,
      liveClaimVerifier: () => true,
      stableNodeBackend: Object.freeze({ kind: "forged-stable-backend" }),
    }).submitOnce(
      defaultDeniedLive.tab, liveAction, plan, preparationForDefaultBridge,
    ),
    /live submit is unavailable until a trusted Chrome host resolver exists/,
  );
  assert.equal(bypassClaimCalls, 0);
  assert.equal(bypassReceiptCommitCalls, 0);
  assert.equal(defaultDeniedLive.page.nodes.submit.clicks ?? 0, 0);
  assert.equal(defaultDeniedLive.page.nodes.target.children[".reply"].length, 0);
}

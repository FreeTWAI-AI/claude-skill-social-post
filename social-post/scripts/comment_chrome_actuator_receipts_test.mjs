import assert from "node:assert/strict";

import { createCommentChromeActuator } from "./comment_chrome_actuator.mjs";
import { createPythonLedgerClaimSubmit } from "./comment_chrome_claim_bridge.mjs";
import * as claimBridgeModule from "./comment_chrome_claim_bridge.mjs";
import { digestObject } from "./comment_chrome_common.mjs";
import { createSendOperations } from "./comment_chrome_send.mjs";
import { preparationCore } from "./comment_chrome_send_support.mjs";
import {
  actionFor, addReply, createClaimStore, fixedClock, fixture, mustReject,
  optionsFor, plan,
} from "./comment_chrome_actuator_fixture_test.mjs";

export async function testDelayedReplyRequiresFreshReinspection() {
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

export async function testLiveReceiptsUseFusedCommitClosure() {
  const action = actionFor("fused-receipt");
  const live = fixture();
  live.page.url = action.post_permalink;
  const preflightActor = createCommentChromeActuator({ clock: fixedClock });
  const isolated = fixture();
  const isolatedPreparation = await preflightActor.prepareReply(
    isolated.tab, action, plan, optionsFor(action),
  );
  const preparation = { ...isolatedPreparation, test_only: false };
  preparation.preparation_id = digestObject(
    preparationCore(preparation), "preparation receipt",
  );
  assert.equal(preparation.test_only, false);
  const finishCapability = {
    schema_version: 1, operation: "browser-finish",
    capability_id: "1".repeat(32), nonce: "a".repeat(43),
  };
  const reconcileCapability = {
    schema_version: 1, operation: "browser-reconcile",
    capability_id: "2".repeat(32), nonce: "b".repeat(43),
  };
  let receiptCommitCalls = 0;
  let recoveryCalls = 0;
  const claimSubmit = createPythonLedgerClaimSubmit({
    preparation,
    runner: async () => ({
      ...request,
      decision: "WRITE_OK",
      claim_id: "claim-fused-receipt",
      preflight_id: "preflight-fused-receipt",
      receipt_capability: finishCapability,
    }),
    receiptRunner: async ({ operation, envelope }) => {
      receiptCommitCalls += 1;
      return {
        schema_version: 1,
        operation,
        outcome: operation === "browser-finish" ? "unknown" : "not-sent",
        receipt_digest: digestObject(envelope.receipt),
        next_capability: operation === "browser-finish" ? reconcileCapability : null,
      };
    },
    recoveryRunner: async () => {
      recoveryCalls += 1;
      throw new Error("recovery runner must remain unreachable");
    },
  });
  const request = Object.fromEntries([
    "action_id", "intent_id", "session_id", "permit_id", "reply_hash",
    "action_digest", "plan_digest", "preparation_id",
  ].map((key) => [key, preparation[key]]));
  const decision = await claimSubmit(request);
  const attempt = {
    action_id: action.action_id,
    claim_id: decision.claim_id,
    preflight_id: decision.preflight_id,
    preparation_id: preparation.preparation_id,
    submission_attempted: true,
    submission_possible: true,
  };
  const actor = createCommentChromeActuator({ clock: fixedClock, claimSubmit });
  const lowLevel = createSendOperations({ clock: fixedClock, claimSubmit });
  await mustReject(
    () => lowLevel.inspectResult(
      live.tab, action, plan, attempt, preparation, {},
    ),
    /live finish inspection is unavailable until a trusted Chrome host resolver exists/,
  );
  assert.equal(claimBridgeModule.commitPythonLedgerBrowserReceipt, undefined);
  assert.equal(receiptCommitCalls, 0);
  await mustReject(
    () => actor.inspectResult(live.tab, action, plan, attempt, preparation, {}),
    /live finish inspection is unavailable until a trusted Chrome host resolver exists/,
  );
  assert.equal(receiptCommitCalls, 0);
  await mustReject(
    () => actor.inspectAndFinish(
      live.tab, action, plan, attempt, preparation, {},
    ),
    /live finish is unavailable until a trusted Chrome host resolver exists/,
  );
  assert.equal(receiptCommitCalls, 0);
  assert.equal(claimSubmit.finishReceipt, undefined);
  assert.equal(claimSubmit.reconcileReceipt, undefined);
  await mustReject(
    () => actor.reinspect(
      live.tab, action, plan, attempt, action.session_id,
      "session-fused-reconcile", preparation, {},
    ),
    /live reconcile inspection is unavailable until a trusted Chrome host resolver exists/,
  );
  assert.equal(receiptCommitCalls, 0);
  await mustReject(
    () => actor.reinspectAndReconcile(
      live.tab, action, plan, attempt, action.session_id,
      "session-fused-reconcile", preparation, {},
    ),
    /live reconcile is unavailable until a trusted Chrome host resolver exists/,
  );
  assert.equal(receiptCommitCalls, 0);
  await mustReject(
    () => actor.recoverAndReconcile(
      live.tab, action, plan, attempt, action.session_id,
      "session-fused-recovery", preparation, {}, "browser_process_restarted",
    ),
    /live recovery is unavailable until a trusted Chrome host resolver exists/,
  );
  assert.equal(recoveryCalls, 0);
  assert.equal(receiptCommitCalls, 0);
}

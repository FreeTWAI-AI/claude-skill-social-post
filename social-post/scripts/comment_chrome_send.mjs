import {
  digestObject,
  fail,
  immutableJsonSnapshot,
  locate,
  nowIso,
  readComposer,
  receiptTestOnly,
  requiredString,
  unique,
  verifyNearestAnchorOwner,
} from "./comment_chrome_common.mjs";
import { requireExhaustedReplySet } from "./comment_chrome_reply_exhaustion.mjs";
import {
  actionDigest,
  assertAction,
  assertPlan,
  assertStableNodeSurface,
  attemptBinding,
  bindStableSubmitNode,
  claimRequest,
  planDigest,
  preparationCore,
  resultAttempt,
  targetOwnership,
  validatePreparation,
  validateWriteDecision,
  verifyContext,
} from "./comment_chrome_send_support.mjs";

const inProcessSubmitClaims = new Set();

export function createSendOperations({ clock, claimSubmit } = {}) {
  async function prepareReply(tab, rawAction, rawPlan, rawOptions = {}) {
    const action = assertAction(immutableJsonSnapshot(rawAction, "action"));
    const plan = assertPlan(immutableJsonSnapshot(rawPlan, "locator plan"));
    const options = immutableJsonSnapshot(rawOptions, "send options");
    const testOnly = receiptTestOnly(options);
    if (!testOnly) {
      // Preparation expands the reply thread, opens the composer and fills text.
      // Those are browser mutations even though the final submit click is still
      // separately gated.  Production must therefore fail before the first DOM
      // inspection that can trigger expansion, click or fill until the trusted
      // Chrome host resolver exists.
      fail("live preparation is unavailable until a trusted Chrome host resolver exists");
    }
    const { observedUrl, target } = await verifyContext(tab, action, plan, options);
    const ownership = targetOwnership(action, plan);
    const baseline = await requireExhaustedReplySet(
      tab, target, plan, action.reply_text, action.scope.account_key,
      ownership,
    );
    if (baseline.matches.length !== 0) {
      fail("an exact own-account reply already exists under the approved parent");
    }
    const trigger = await unique(
      locate(tab, target, plan.replyTrigger), "reply trigger", { enabled: true },
    );
    await verifyNearestAnchorOwner(trigger, {
      ...ownership, fromParent: false,
    }, "reply trigger");
    await trigger.click({ timeoutMs: options.timeoutMs ?? 5000 });
    const composer = await unique(
      locate(tab, target, plan.composer), "reply composer", { enabled: true },
    );
    await verifyNearestAnchorOwner(composer, {
      ...ownership, fromParent: false,
    }, "reply composer");
    const submit = await unique(
      locate(tab, target, plan.submit), "reply submit control", { enabled: true },
    );
    await verifyNearestAnchorOwner(submit, {
      ...ownership, fromParent: false,
    }, "reply submit control");
    const emptyBefore = (await readComposer(composer)) === "";
    if (!emptyBefore) fail("reply composer was not empty before fill");
    await composer.fill(action.reply_text, { timeoutMs: options.timeoutMs ?? 5000 });
    const matches = (await readComposer(composer)) === action.reply_text;
    if (!matches) fail("reply composer does not exactly match the immutable action");
    const receipt = {
      schema_version: 1,
      test_only: testOnly,
      action_id: action.action_id,
      intent_id: action.intent_id,
      session_id: action.session_id,
      permit_id: action.permit_id,
      scope: action.scope,
      comment_fingerprint: action.comment_fingerprint,
      reply_hash: action.reply_hash,
      action_digest: actionDigest(action),
      plan_digest: planDigest(plan),
      observed_url: observedUrl,
      observed_at: nowIso(clock),
      baseline_exact_reply_count: baseline.matches.length,
      baseline_total_reply_count: baseline.total,
      account_verified: true,
      post_verified: true,
      target_verified: true,
      body_complete: true,
      composer_empty_before_fill: emptyBefore,
      composer_matches_reply: matches,
      reply_control_verified: true,
      evidence: "approved target and parent-scoped controls verified after terminal reply exhaustion with zero exact-own baseline",
    };
    receipt.preparation_id = digestObject(preparationCore(receipt), "preparation receipt");
    return receipt;
  }

  async function submitOnce(tab, rawAction, rawPlan, rawPreparation, rawOptions = {}) {
    const action = assertAction(immutableJsonSnapshot(rawAction, "action"));
    const plan = assertPlan(immutableJsonSnapshot(rawPlan, "locator plan"));
    const options = immutableJsonSnapshot(rawOptions, "send options");
    const preparation = validatePreparation(
      immutableJsonSnapshot(rawPreparation, "preparation receipt"), action, plan, options,
    );
    if (preparation.test_only === false) {
      fail("live submit is unavailable until a trusted Chrome host resolver exists");
    }
    if (typeof claimSubmit !== "function") fail("submit requires a durable atomic claimSubmit callback");
    const stableSurface = assertStableNodeSurface(tab, preparation);
    // Re-establish terminal reply coverage before consuming the durable claim.
    // Lazy items, a newly exposed expander, or an exact own reply therefore
    // stop before ledger mutation and before any submit click.
    const preClaimContext = await verifyContext(tab, action, plan, options);
    const preClaimOwnership = targetOwnership(action, plan);
    const preClaimComposer = await unique(
      locate(tab, preClaimContext.target, plan.composer),
      "reply composer", { enabled: true },
    );
    await verifyNearestAnchorOwner(preClaimComposer, {
      ...preClaimOwnership, fromParent: false,
    }, "reply composer");
    if ((await readComposer(preClaimComposer)) !== action.reply_text) {
      fail("composer changed before the durable claim");
    }
    const preClaimReplySet = await requireExhaustedReplySet(
      tab, preClaimContext.target, plan, action.reply_text,
      action.scope.account_key, preClaimOwnership,
    );
    if (preClaimReplySet.matches.length !== 0) {
      fail("an exact own-account reply appeared before durable claim; submit is blocked");
    }
    if (inProcessSubmitClaims.has(action.action_id)) {
      fail("a second in-process submit attempt for this action is blocked");
    }
    inProcessSubmitClaims.add(action.action_id);
    const request = claimRequest(action, plan, preparation);
    const decision = validateWriteDecision(await claimSubmit(request), request);
    let target;
    try {
      ({ target } = await verifyContext(tab, action, plan, options));
      const ownership = targetOwnership(action, plan);
      const composer = await unique(
        locate(tab, target, plan.composer), "reply composer", { enabled: true },
      );
      await verifyNearestAnchorOwner(composer, {
        ...ownership, fromParent: false,
      }, "reply composer");
      if ((await readComposer(composer)) !== action.reply_text) {
        fail("composer changed after the durable claim");
      }
      const submit = await unique(
        locate(tab, target, plan.submit), "reply submit control", { enabled: true },
      );
      await verifyNearestAnchorOwner(submit, {
        ...ownership, fromParent: false,
      }, "reply submit control");
      const finalReplySet = await requireExhaustedReplySet(
        tab, target, plan, action.reply_text, action.scope.account_key,
        ownership,
      );
      if (finalReplySet.matches.length !== 0) {
        fail("an exact own-account reply appeared after preparation; submit is blocked");
      }
      const stableNodeId = await bindStableSubmitNode(
        stableSurface, tab, action, plan, preparation, options,
      );
      try {
        await stableSurface.click({ node_id: stableNodeId });
      } catch (error) {
        return {
          test_only: receiptTestOnly(options),
          action_id: action.action_id, claim_id: decision.claim_id,
          preflight_id: decision.preflight_id, preparation_id: preparation.preparation_id,
          submission_attempted: true, submission_possible: true,
          click_error: String(error),
        };
      }
    } catch (error) {
      // No submit dispatch was attempted anywhere in this branch. Releasing the
      // process reservation is safe; the durable ledger still owns its claim.
      // Once stableSurface.click is invoked, success/timeout/error is ambiguous
      // and the reservation intentionally remains held until reconciliation.
      inProcessSubmitClaims.delete(action.action_id);
      return {
        test_only: receiptTestOnly(options),
        action_id: action.action_id, claim_id: decision.claim_id,
        preflight_id: decision.preflight_id, preparation_id: preparation.preparation_id,
        submission_attempted: false, submission_possible: false,
        pre_click_error: String(error),
      };
    }
    return {
      test_only: receiptTestOnly(options),
      action_id: action.action_id, claim_id: decision.claim_id,
      preflight_id: decision.preflight_id, preparation_id: preparation.preparation_id,
      submission_attempted: true, submission_possible: true,
    };
  }

  async function inspectResult(
    tab, rawAction, rawPlan, attempt, rawPreparation, rawOptions = {},
  ) {
    const action = assertAction(immutableJsonSnapshot(rawAction, "action"));
    const plan = assertPlan(immutableJsonSnapshot(rawPlan, "locator plan"));
    const options = immutableJsonSnapshot(rawOptions, "send options");
    const preparation = validatePreparation(
      immutableJsonSnapshot(rawPreparation, "preparation receipt"), action, plan, options,
    );
    if (preparation.test_only === false) {
      fail("live finish inspection is unavailable until a trusted Chrome host resolver exists");
    }
    const { observedUrl, target } = await verifyContext(tab, action, plan, options);
    const ownership = targetOwnership(action, plan);
    const found = await requireExhaustedReplySet(
      tab, target, plan, action.reply_text, action.scope.account_key,
      ownership,
    );
    const countSupportsNewReply = found.total >= preparation.baseline_total_reply_count + 1;
    const exactOne = countSupportsNewReply
      && preparation.baseline_exact_reply_count === 0
      && found.matches.length === 1;
    const attemptFlags = resultAttempt(attempt, action, preparation);
    return immutableJsonSnapshot({
      schema_version: 1,
      test_only: receiptTestOnly(options),
      action_id: action.action_id,
      preflight_id: attemptFlags.preflight_id,
      claim_id: attemptFlags.claim_id,
      intent_id: action.intent_id,
      session_id: action.session_id,
      scope: action.scope,
      comment_fingerprint: action.comment_fingerprint,
      reply_hash: action.reply_hash,
      preparation_id: preparation.preparation_id,
      observed_url: observedUrl,
      observed_at: nowIso(clock),
      submission_attempted: attemptFlags.submission_attempted,
      submission_possible: attemptFlags.submission_possible,
      account_verified: true,
      post_verified: true,
      target_verified: true,
      parent_verified: true,
      exact_reply_visible: exactOne,
      own_author_verified: exactOne,
      post_submit_total_reply_count: found.total,
      evidence: exactOne
        ? "one new exact own-account reply is visible under the verified parent"
        : found.matches.length === 1 && !countSupportsNewReply
          ? `post-submit reply count ${found.total} does not exceed preparation baseline ${preparation.baseline_total_reply_count}`
          : `complete post-submit DOM found ${found.matches.length} exact own replies`,
    }, "browser-finish browser receipt");
  }

  async function reinspect(
    tab, rawAction, rawPlan, attempt, attemptSessionId, currentSessionId,
    rawPreparation, rawOptions = {},
  ) {
    const action = assertAction(immutableJsonSnapshot(rawAction, "action"));
    const plan = assertPlan(immutableJsonSnapshot(rawPlan, "locator plan"));
    const options = immutableJsonSnapshot(rawOptions, "send options");
    const preparation = validatePreparation(
      immutableJsonSnapshot(rawPreparation, "preparation receipt"), action, plan, options,
    );
    if (preparation.test_only === false) {
      fail("live reconcile inspection is unavailable until a trusted Chrome host resolver exists");
    }
    const binding = attemptBinding(attempt, action, preparation);
    const { observedUrl, target } = await verifyContext(tab, action, plan, options);
    const ownership = targetOwnership(action, plan);
    const found = await requireExhaustedReplySet(
      tab, target, plan, action.reply_text, action.scope.account_key,
      ownership,
    );
    const countAtOrAboveBaseline = found.total >= preparation.baseline_total_reply_count;
    const countSupportsNewReply = found.total >= preparation.baseline_total_reply_count + 1;
    const exactOne = countSupportsNewReply
      && preparation.baseline_exact_reply_count === 0
      && found.matches.length === 1;
    const absence = countAtOrAboveBaseline
      && found.matches.length === 0 && found.own_author_count === 0;
    return immutableJsonSnapshot({
      schema_version: 1,
      test_only: receiptTestOnly(options),
      action_id: action.action_id,
      preflight_id: binding.preflight_id,
      claim_id: binding.claim_id,
      intent_id: action.intent_id,
      session_id: requiredString(currentSessionId, "currentSessionId"),
      attempt_session_id: requiredString(attemptSessionId, "attemptSessionId"),
      scope: action.scope,
      comment_fingerprint: action.comment_fingerprint,
      reply_hash: action.reply_hash,
      preparation_id: preparation.preparation_id,
      observed_url: observedUrl,
      observed_at: nowIso(clock),
      account_verified: true,
      post_verified: true,
      target_verified: true,
      parent_verified: true,
      exact_reply_visible: exactOne,
      own_author_verified: exactOne,
      absence_verified: absence,
      own_author_reply_count: found.own_author_count,
      reinspection_total_reply_count: found.total,
      evidence: exactOne
        ? "fresh complete DOM found one new exact own-account reply under the parent"
        : absence
          ? "fresh complete and fully-expanded DOM found no own-account reply"
          : !countAtOrAboveBaseline
            ? `fresh DOM reply count ${found.total} is below preparation baseline ${preparation.baseline_total_reply_count}`
            : found.matches.length === 1 && !countSupportsNewReply
              ? `fresh exact reply is visible but total ${found.total} does not exceed preparation baseline ${preparation.baseline_total_reply_count}`
            : found.matches.length === 0
              ? `fresh complete DOM found ${found.own_author_count} own-account replies but no exact approved text`
              : "fresh complete DOM found ambiguous duplicate exact replies",
    }, "browser-reconcile browser receipt");
  }

  return Object.freeze({ prepareReply, submitOnce, inspectResult, reinspect });
}

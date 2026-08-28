import {
  SUPPORTED_PLATFORMS,
  assertSingleLine,
  digestObject,
  fail,
  immutableJsonSnapshot,
  locate,
  mappedObservedUrl,
  nowIso,
  readComposer,
  receiptTestOnly,
  requireBoolean,
  requireCompleteReplySet,
  requiredString,
  sha256Text,
  unique,
  verifyEvidence,
  verifyNearestAnchorOwner,
} from "./comment_chrome_common.mjs";
import { isPythonLedgerClaimSubmit } from "./comment_chrome_claim_bridge.mjs";

const inProcessSubmitClaims = new Set();

function assertAction(action) {
  if (!action || typeof action !== "object") fail("action must be an object");
  for (const key of ["action_id", "intent_id", "session_id", "permit_id", "comment_fingerprint", "reply_hash"]) {
    requiredString(action[key], `action.${key}`);
  }
  const replyText = assertSingleLine(action.reply_text, "action.reply_text");
  if (sha256Text(replyText) !== action.reply_hash) {
    fail("action.reply_hash does not match the approved reply_text");
  }
  requiredString(action.expected_body, "action.expected_body");
  const scope = action.scope;
  if (!scope || typeof scope !== "object") fail("action.scope must be an object");
  for (const key of ["platform", "account_key", "post_key", "comment_key"]) {
    requiredString(scope[key], `action.scope.${key}`);
  }
  if (!SUPPORTED_PLATFORMS.has(scope.platform)) fail(`unsupported platform ${scope.platform}`);
  const anchor = action.comment_anchor;
  if (!anchor || typeof anchor !== "object") fail("action.comment_anchor is required");
  if (!anchor.platform_comment_id && !anchor.comment_permalink) {
    fail("action.comment_anchor requires platform_comment_id or comment_permalink");
  }
  return action;
}

function assertPlan(plan) {
  if (!plan || typeof plan !== "object") fail("locator plan must be an object");
  const keys = [
    "account", "post", "target", "targetAnchor", "author", "body", "replyTrigger",
    "composer", "submit", "replyItems", "replyAuthor", "replyBody", "replyExpansionControls",
  ];
  for (const key of keys) {
    if (!plan[key] || typeof plan[key] !== "object") fail(`locator plan.${key} is required`);
    requiredString(plan[key].selector, `locator plan.${key}.selector`);
  }
  for (const key of ["targetAnchor", "author", "body", "replyTrigger", "composer", "submit", "replyItems", "replyExpansionControls"]) {
    if (plan[key].within !== "target") fail(`locator plan.${key} must be scoped to the target`);
  }
  if (plan.targetAnchor.self !== true) {
    fail("locator plan.targetAnchor must be an attribute on the unique target element itself");
  }
  requiredString(plan.targetAnchor.attribute, "locator plan.targetAnchor.attribute");
  if (plan.replyAuthor.within !== "reply" || plan.replyBody.within !== "reply") {
    fail("reply evidence must be scoped target → reply item → author/body");
  }
  return plan;
}

function actionDigest(action) {
  return digestObject(action, "action");
}

function planDigest(plan) {
  return digestObject(plan, "locator plan");
}

function approvedAnchor(action) {
  return action.comment_anchor.platform_comment_id
    || action.comment_anchor.comment_permalink;
}

function targetOwnership(action, plan) {
  return Object.freeze({
    attribute: plan.targetAnchor.attribute,
    expected: approvedAnchor(action),
  });
}

async function verifyContext(tab, action, plan, options) {
  const observedUrl = mappedObservedUrl(await tab.url(), action, options);
  const target = await unique(locate(tab, null, plan.target), "target comment");
  const ownership = targetOwnership(action, plan);
  await verifyEvidence(
    locate(tab, target, plan.targetAnchor), plan.targetAnchor,
    approvedAnchor(action), "target comment anchor",
  );
  await verifyEvidence(
    locate(tab, target, plan.account), plan.account,
    action.scope.account_key, "account",
  );
  await verifyEvidence(
    locate(tab, target, plan.post), plan.post,
    action.scope.post_key, "post",
  );
  await verifyEvidence(
    locate(tab, target, plan.body), plan.body,
    action.expected_body, "comment body", ownership,
  );
  const expectedAuthor = action.author_key || action.author_display;
  await verifyEvidence(
    locate(tab, target, plan.author), plan.author,
    expectedAuthor, "comment author", ownership,
  );
  return { observedUrl, target };
}

function preparationCore(receipt) {
  return {
    action_digest: receipt.action_digest,
    plan_digest: receipt.plan_digest,
    observed_url: receipt.observed_url,
    observed_at: receipt.observed_at,
    baseline_exact_reply_count: receipt.baseline_exact_reply_count,
    baseline_total_reply_count: receipt.baseline_total_reply_count,
    test_only: receipt.test_only,
  };
}

function validatePreparation(raw, action, plan, options) {
  if (!raw || typeof raw !== "object") fail("preparation receipt is required");
  const expectedActionDigest = actionDigest(action);
  const expectedPlanDigest = planDigest(plan);
  if (raw.action_digest !== expectedActionDigest) fail("preparation action digest is stale");
  if (raw.plan_digest !== expectedPlanDigest) fail("preparation locator-plan digest is stale");
  if (raw.reply_hash !== action.reply_hash || raw.action_id !== action.action_id) {
    fail("preparation is not bound to the approved action");
  }
  if (raw.baseline_exact_reply_count !== 0) {
    fail("preparation baseline contains an existing exact own reply");
  }
  if (!Number.isInteger(raw.baseline_total_reply_count) || raw.baseline_total_reply_count < 0) {
    fail("preparation baseline total is invalid");
  }
  if (raw.test_only !== receiptTestOnly(options)) fail("preparation test/live boundary changed");
  const expectedId = digestObject(preparationCore(raw), "preparation receipt");
  if (raw.preparation_id !== expectedId) fail("preparation receipt integrity check failed");
  return raw;
}

function claimRequest(action, plan, preparation) {
  return Object.freeze({
    schema_version: 1,
    action_id: action.action_id,
    intent_id: action.intent_id,
    session_id: action.session_id,
    permit_id: action.permit_id,
    reply_hash: action.reply_hash,
    action_digest: actionDigest(action),
    plan_digest: planDigest(plan),
    preparation_id: preparation.preparation_id,
  });
}

function validateWriteDecision(raw, request) {
  if (!raw || typeof raw !== "object" || raw.decision !== "WRITE_OK") {
    fail("durable claim did not return a structured WRITE_OK decision");
  }
  requiredString(raw.claim_id, "write decision.claim_id");
  requiredString(raw.preflight_id, "write decision.preflight_id");
  for (const key of [
    "action_id", "intent_id", "session_id", "permit_id", "reply_hash",
    "action_digest", "plan_digest", "preparation_id",
  ]) {
    if (raw[key] !== request[key]) fail(`write decision.${key} differs from the claim request`);
  }
  return raw;
}

function attemptBinding(attempt, action, preparation) {
  if (!attempt || typeof attempt !== "object") fail("submit attempt is required");
  const binding = {
    action_id: requiredString(attempt.action_id, "attempt.action_id"),
    claim_id: requiredString(attempt.claim_id, "attempt.claim_id"),
    preflight_id: requiredString(attempt.preflight_id, "attempt.preflight_id"),
    preparation_id: requiredString(attempt.preparation_id, "attempt.preparation_id"),
  };
  if (binding.action_id !== action.action_id) fail("submit attempt belongs to another action");
  if (binding.preparation_id !== preparation.preparation_id) {
    fail("submit attempt belongs to another preparation");
  }
  return binding;
}

function resultAttempt(attempt, action, preparation) {
  return {
    ...attemptBinding(attempt, action, preparation),
    submission_attempted: requireBoolean(
      attempt?.submission_attempted, "attempt.submission_attempted",
    ),
    submission_possible: requireBoolean(
      attempt?.submission_possible, "attempt.submission_possible",
    ),
  };
}

export function createSendOperations({ clock, claimSubmit } = {}) {
  async function prepareReply(tab, rawAction, rawPlan, rawOptions = {}) {
    const action = assertAction(immutableJsonSnapshot(rawAction, "action"));
    const plan = assertPlan(immutableJsonSnapshot(rawPlan, "locator plan"));
    const options = immutableJsonSnapshot(rawOptions, "send options");
    const { observedUrl, target } = await verifyContext(tab, action, plan, options);
    const ownership = targetOwnership(action, plan);
    const baseline = await requireCompleteReplySet(
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
      test_only: receiptTestOnly(options),
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
      evidence: "approved target and parent-scoped controls verified with zero exact-own baseline",
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
    if (typeof claimSubmit !== "function") fail("submit requires a durable atomic claimSubmit callback");
    const liveContext = preparation.test_only === false;
    if (liveContext && !isPythonLedgerClaimSubmit(claimSubmit)) {
      fail("live submit requires a constructed Python ledger claim bridge");
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
      const finalReplySet = await requireCompleteReplySet(
        tab, target, plan, action.reply_text, action.scope.account_key,
        ownership,
      );
      if (finalReplySet.matches.length !== 0) {
        fail("an exact own-account reply appeared after preparation; submit is blocked");
      }
      const { target: clickTarget } = await verifyContext(tab, action, plan, options);
      const clickOwnership = targetOwnership(action, plan);
      const clickComposer = await unique(
        locate(tab, clickTarget, plan.composer), "reply composer", { enabled: true },
      );
      await verifyNearestAnchorOwner(clickComposer, {
        ...clickOwnership, fromParent: false,
      }, "reply composer");
      if ((await readComposer(clickComposer)) !== action.reply_text) {
        fail("composer changed during final reply verification");
      }
      const clickSubmit = await unique(
        locate(tab, clickTarget, plan.submit), "reply submit control", { enabled: true },
      );
      await verifyNearestAnchorOwner(clickSubmit, {
        ...clickOwnership, fromParent: false,
      }, "reply submit control");
      if (preparation.test_only === false && !isPythonLedgerClaimSubmit(claimSubmit)) {
        fail("live click requires a constructed Python ledger claim bridge");
      }
      try {
        await clickSubmit.click({ timeoutMs: options.timeoutMs ?? 5000 });
      } catch (error) {
        return {
          action_id: action.action_id, claim_id: decision.claim_id,
          preflight_id: decision.preflight_id, preparation_id: preparation.preparation_id,
          submission_attempted: true, submission_possible: true,
          click_error: String(error),
        };
      }
    } catch (error) {
      return {
        action_id: action.action_id, claim_id: decision.claim_id,
        preflight_id: decision.preflight_id, preparation_id: preparation.preparation_id,
        submission_attempted: false, submission_possible: false,
        pre_click_error: String(error),
      };
    }
    return {
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
    const { observedUrl, target } = await verifyContext(tab, action, plan, options);
    const ownership = targetOwnership(action, plan);
    const found = await requireCompleteReplySet(
      tab, target, plan, action.reply_text, action.scope.account_key,
      ownership,
    );
    const countSupportsNewReply = found.total >= preparation.baseline_total_reply_count + 1;
    const exactOne = countSupportsNewReply
      && preparation.baseline_exact_reply_count === 0
      && found.matches.length === 1;
    const attemptFlags = resultAttempt(attempt, action, preparation);
    return {
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
    };
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
    const binding = attemptBinding(attempt, action, preparation);
    const { observedUrl, target } = await verifyContext(tab, action, plan, options);
    const ownership = targetOwnership(action, plan);
    const found = await requireCompleteReplySet(
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
    return {
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
    };
  }

  return Object.freeze({ prepareReply, submitOnce, inspectResult, reinspect });
}

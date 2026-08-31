/** Action, parent context, claim and result contracts; DOM node identity is delegated. */
import {
  SUPPORTED_PLATFORMS,
  assertSingleLine,
  digestObject,
  fail,
  locate,
  mappedObservedUrl,
  readComposer,
  receiptTestOnly,
  requireBoolean,
  requiredString,
  sha256Text,
  unique,
  verifyEvidence,
  verifyNearestAnchorOwner,
} from "./comment_chrome_common.mjs";
import { assertReplyExhaustionPlan } from "./comment_chrome_reply_exhaustion.mjs";
import {
  bindExactVisibleNode, captureDomCuaSnapshot, readStableSubmitIdentity,
} from "./comment_chrome_node_identity.mjs";
export {
  assertStableNodeSurface, bindObservedSubmitNode, bindObservedThreadsReplyIconNode,
} from "./comment_chrome_node_identity.mjs";


export function assertAction(action) {
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

export function assertPlan(plan) {
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
  assertReplyExhaustionPlan(plan);
  return plan;
}

export function actionDigest(action) {
  return digestObject(action, "action");
}

export function planDigest(plan) {
  return digestObject(plan, "locator plan");
}

function approvedAnchor(action) {
  return action.comment_anchor.platform_comment_id
    || action.comment_anchor.comment_permalink;
}

export function targetOwnership(action, plan) {
  return Object.freeze({
    attribute: plan.targetAnchor.attribute,
    expected: approvedAnchor(action),
  });
}

function revalidateImmutableBindings(action, plan, preparation) {
  if (actionDigest(action) !== preparation.action_digest) {
    fail("action digest changed before stable-node submit");
  }
  if (planDigest(plan) !== preparation.plan_digest) {
    fail("locator-plan digest changed before stable-node submit");
  }
}

export async function verifyContext(tab, action, plan, options) {
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

async function verifyStableSubmitContext(
  tab, action, plan, preparation, options, expectedIdentity = null,
) {
  revalidateImmutableBindings(action, plan, preparation);
  const { target } = await verifyContext(tab, action, plan, options);
  const ownership = targetOwnership(action, plan);
  const composer = await unique(
    locate(tab, target, plan.composer), "reply composer", { enabled: true },
  );
  await verifyNearestAnchorOwner(composer, {
    ...ownership, fromParent: false,
  }, "reply composer");
  if ((await readComposer(composer)) !== action.reply_text) {
    fail("composer changed during final reply verification");
  }
  const submit = await unique(
    locate(tab, target, plan.submit), "reply submit control", { enabled: true },
  );
  await verifyNearestAnchorOwner(submit, {
    ...ownership, fromParent: false,
  }, "reply submit control");
  const identity = await readStableSubmitIdentity(submit);
  if (expectedIdentity
      && digestObject(identity, "stable submit identity")
        !== digestObject(expectedIdentity, "expected stable submit identity")) {
    fail("stable submit DOM identity changed during revalidation");
  }
  return identity;
}

export async function bindStableSubmitNode(
  surface, tab, action, plan, preparation, options,
) {
  // Snapshot before verification, then sandwich two independent, parent-scoped
  // verifications between fresh visible-DOM snapshots. A selector replacement
  // therefore receives a different node_id instead of being lazily re-resolved.
  const firstSnapshot = captureDomCuaSnapshot(await surface.get_visible_dom());
  const identity = await verifyStableSubmitContext(
    tab, action, plan, preparation, options,
  );
  const firstNodeId = bindExactVisibleNode(firstSnapshot, identity);
  const secondSnapshot = captureDomCuaSnapshot(await surface.get_visible_dom());
  const secondNodeId = bindExactVisibleNode(secondSnapshot, identity);
  if (secondNodeId !== firstNodeId) {
    fail("stable submit node_id changed across ownership verification");
  }
  await verifyStableSubmitContext(
    tab, action, plan, preparation, options, identity,
  );
  const thirdSnapshot = captureDomCuaSnapshot(await surface.get_visible_dom());
  const thirdNodeId = bindExactVisibleNode(thirdSnapshot, identity);
  if (thirdNodeId !== firstNodeId) {
    fail("stable submit node_id changed during final revalidation");
  }
  revalidateImmutableBindings(action, plan, preparation);
  return firstNodeId;
}

export function preparationCore(receipt) {
  const core = {
    action_digest: receipt.action_digest,
    plan_digest: receipt.plan_digest,
    observed_url: receipt.observed_url,
    observed_at: receipt.observed_at,
    baseline_exact_reply_count: receipt.baseline_exact_reply_count,
    baseline_total_reply_count: receipt.baseline_total_reply_count,
    test_only: receipt.test_only,
  };
  if (Object.hasOwn(receipt, "composer_initial_state")) {
    for (const key of ["composer_initial_state", "composer_initial_text",
      "selected_parent_evidence", "selected_parent_evidence_digest"]) core[key] = receipt[key];
  }
  return core;
}

export function validatePreparation(raw, action, plan, options) {
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

export function claimRequest(action, plan, preparation) {
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

export function validateWriteDecision(raw, request) {
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

export function attemptBinding(attempt, action, preparation) {
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

export function resultAttempt(attempt, action, preparation) {
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

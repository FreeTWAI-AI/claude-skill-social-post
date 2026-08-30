import assert from "node:assert/strict";

import {
  captureTestOnlyNodeFrameLifecycleStage,
  createTestOnlyNodeFrameLifecycleSession,
  finalizeTestOnlyNodeFrameLifecycle,
  isTrustedTestOnlyNodeFrameLifecycleAttestation,
  nodeFrameLifecycleEvidence,
  TEST_ONLY_NODE_FRAME_LIFECYCLE_STAGES,
  testOnlyNodeFrameLifecycleContractDescriptor,
} from "./comment_chrome_node_frame_lifecycle_testonly.mjs";
import {
  deepFreeze,
  fixture,
  TEST_OPTIONS,
} from "./comment_chrome_node_frame_mapping_fixture_testonly.mjs";
import {
  createTrustedFixtureNodeFrameLifecycleSession,
} from "./comment_chrome_scan_fixture_testonly.mjs";

const LIFECYCLE_REPLY = "下一集就會揭曉。";
const LIFECYCLE_AUTHOR = "account-a";

function lifecycleBinding(platform) {
  return {
    run_id: `${platform}-lifecycle-run`,
    target_anchor: `${platform}-identity-1`,
    parent_anchor: `https://fixture.invalid/${platform}/post`,
    reply_text: LIFECYCLE_REPLY,
    own_author: LIFECYCLE_AUTHOR,
    baseline_reply_count: 0,
  };
}

function lifecycleContext(platform = "instagram") {
  const sample = fixture(platform);
  const session = createTrustedFixtureNodeFrameLifecycleSession(
    sample.plan, platform, lifecycleBinding(platform), TEST_OPTIONS,
  );
  return { sample, platform, session, previous: null, stages: {} };
}

async function captureLifecycleStage(context, stage) {
  const attestation = await captureTestOnlyNodeFrameLifecycleStage(
    context.sample.tab,
    context.sample.plan,
    context.platform,
    context.session,
    stage,
    context.previous,
    TEST_OPTIONS,
  );
  context.previous = attestation;
  context.stages[stage] = attestation;
  return attestation;
}

function completeLifecycleExpansion(context) {
  const { page, plan } = context.sample;
  page.selectors[plan.expansion.commentControls.selector] = [];
  page.selectors[plan.expansion.replyControls.selector] = [];
  page.selectors[plan.expansion.viewportTraversalControl.selector] = [];
  const root = page.nodes.root.attributes;
  root[plan.expansion.state.cursorAttribute] = `${context.platform}-terminal-page`;
  root[plan.expansion.state.discoveredCountAttribute] = "2";
  root[plan.expansion.state.terminalAttribute] = "true";
}

function fillLifecycleComposer(context) {
  const { page, first } = context.sample;
  page.nodes[first.composer].visible = true;
  page.nodes[first.composer].enabled = true;
  page.nodes[first.composer].value = LIFECYCLE_REPLY;
  page.nodes[first.submit].visible = true;
  page.nodes[first.submit].enabled = true;
}

function appendLifecycleReply(context) {
  const { page, plan, first } = context.sample;
  const lifecycle = plan.nodeFrameMapping.lifecycle;
  const owner = lifecycle.ownerAttribute;
  const item = `${context.platform}-lifecycle-reply-item`;
  const author = `${item}-author`;
  const body = `${item}-body`;
  page.nodes[item] = {
    visible: true,
    attributes: {
      [plan.nodeFrameMapping.nodeIdAttribute]: `${item}-node`,
      [owner]: lifecycleBinding(context.platform).target_anchor,
    },
    children: {
      [lifecycle.replyAuthor.selector]: [author],
      [lifecycle.replyBody.selector]: [body],
    },
  };
  page.nodes[author] = {
    visible: true,
    text: LIFECYCLE_AUTHOR,
    attributes: {
      [plan.nodeFrameMapping.nodeIdAttribute]: `${author}-node`,
      [owner]: lifecycleBinding(context.platform).target_anchor,
    },
  };
  page.nodes[body] = {
    visible: true,
    text: LIFECYCLE_REPLY,
    attributes: {
      [plan.nodeFrameMapping.nodeIdAttribute]: `${body}-node`,
      [owner]: lifecycleBinding(context.platform).target_anchor,
    },
  };
  page.nodes[first.key].children[lifecycle.replyItems.selector] = [item];
  const exhaustion = page.nodes[first.exhaustion].attributes;
  exhaustion[plan.nodeFrameMapping.replyExhaustion.cursorAttribute] = "terminal-1";
  exhaustion[plan.nodeFrameMapping.replyExhaustion.discoveredCountAttribute] = "1";
  exhaustion[plan.nodeFrameMapping.replyExhaustion.terminalAttribute] = "true";
  return { item, author, body };
}

async function advanceLifecycleThroughPreflight(context) {
  await captureLifecycleStage(context, "expand");
  completeLifecycleExpansion(context);
  await captureLifecycleStage(context, "reply_trigger");
  fillLifecycleComposer(context);
  await captureLifecycleStage(context, "composer_fill");
  await captureLifecycleStage(context, "submit_preflight");
}

async function assertPositiveLifecyclePlatform(platform) {
  const descriptor = testOnlyNodeFrameLifecycleContractDescriptor(platform);
  assert.equal(descriptor.test_only, true);
  assert.equal(descriptor.capability_promotion_eligible, false);
  assert.equal(descriptor.live_full_lifecycle_bound, false);
  assert.equal(descriptor.previous_stage_process_brand_required, true);
  assert.equal(descriptor.previous_stage_one_time_consume, true);
  const context = lifecycleContext(platform);
  await advanceLifecycleThroughPreflight(context);
  appendLifecycleReply(context);
  await captureLifecycleStage(context, "finish");
  await captureLifecycleStage(context, "recovery_reinspection");
  const final = finalizeTestOnlyNodeFrameLifecycle(
    context.session, context.previous,
  );
  assert.equal(isTrustedTestOnlyNodeFrameLifecycleAttestation(final), true);
  assert.equal(final.evidence_class, "test_only_full_lifecycle_mapping");
  assert.equal(final.test_only, true);
  assert.equal(final.capability_promotion_eligible, false);
  assert.equal(final.live_browser_actuation_enabled, false);
  assert.equal(final.live_plan_minting, false);
  assert.equal(final.browser_receipt_eligible, false);
  assert.equal(final.coverage, "test_only_full_comment_reply_lifecycle");
  assert.equal(final.test_only_full_lifecycle_bound, true);
  assert.equal(final.live_full_lifecycle_bound, false);
  assert.deepEqual(final.stage_order, TEST_ONLY_NODE_FRAME_LIFECYCLE_STAGES);
  assert.deepEqual(final.stages.map((stage) => stage.stage), TEST_ONLY_NODE_FRAME_LIFECYCLE_STAGES);
  assert.equal(final.stage_count, TEST_ONLY_NODE_FRAME_LIFECYCLE_STAGES.length);
  assert.equal(final.stages[0].expansion_terminal, false);
  assert.equal(final.stages.at(-1).reply_cardinality.exact_own_reply_count, 1);
  for (const forbidden of [
    "scan_request_id", "preparation_id", "claim_id", "preflight_id",
    "submission_attempted", "exact_reply_visible", "absence_verified",
  ]) {
    assert.equal(forbidden in final, false, `${forbidden} must not enter mapping evidence`);
  }
  const evidence = nodeFrameLifecycleEvidence(final);
  assert.equal(evidence.lifecycle_attestation_id, final.lifecycle_attestation_id);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(isTrustedTestOnlyNodeFrameLifecycleAttestation(structuredClone(final)), false);
  assert.throws(
    () => nodeFrameLifecycleEvidence(structuredClone(final)),
    /process-branded test-only attestation/u,
  );
  assert.throws(
    () => finalizeTestOnlyNodeFrameLifecycle(context.session, context.previous),
    /already finalized/u,
  );
}

async function assertLifecycleBrandOrderReplayAndPlatformFailClosed() {
  const context = lifecycleContext("facebook");
  await assert.rejects(
    () => captureTestOnlyNodeFrameLifecycleStage(
      context.sample.tab, context.sample.plan, "facebook", context.session,
      "reply_trigger", null, TEST_OPTIONS,
    ),
    /expected stage expand/u,
  );
  await assert.rejects(
    () => captureTestOnlyNodeFrameLifecycleStage(
      context.sample.tab, context.sample.plan, "facebook", structuredClone(context.session),
      "expand", null, TEST_OPTIONS,
    ),
    /process-branded test-only session/u,
  );
  await assert.rejects(
    () => captureTestOnlyNodeFrameLifecycleStage(
      context.sample.tab, context.sample.plan, "instagram", context.session,
      "expand", null, TEST_OPTIONS,
    ),
    /cross-platform/u,
  );
  const expand = await captureLifecycleStage(context, "expand");
  completeLifecycleExpansion(context);
  await assert.rejects(
    () => captureTestOnlyNodeFrameLifecycleStage(
      context.sample.tab, context.sample.plan, "facebook", context.session,
      "reply_trigger", structuredClone(expand), TEST_OPTIONS,
    ),
    /process-branded attestation/u,
  );
  await captureLifecycleStage(context, "reply_trigger");
  await assert.rejects(
    () => captureTestOnlyNodeFrameLifecycleStage(
      context.sample.tab, context.sample.plan, "facebook", context.session,
      "reply_trigger", context.previous, TEST_OPTIONS,
    ),
    /expected stage composer_fill/u,
  );
  const second = lifecycleContext("facebook");
  await captureLifecycleStage(second, "expand");
  completeLifecycleExpansion(second);
  await assert.rejects(
    () => captureTestOnlyNodeFrameLifecycleStage(
      second.sample.tab, second.sample.plan, "facebook", second.session,
      "reply_trigger", context.stages.reply_trigger, TEST_OPTIONS,
    ),
    /stale, cross-stage, or cross-session/u,
  );
  const clonedPlanContext = lifecycleContext("facebook");
  const clonePlan = structuredClone(clonedPlanContext.sample.plan);
  deepFreeze(clonePlan);
  assert.throws(
    () => createTrustedFixtureNodeFrameLifecycleSession(
      clonePlan, "facebook", lifecycleBinding("facebook"), TEST_OPTIONS,
    ),
    /process-branded test-only plan/u,
  );
  await assert.rejects(
    () => captureTestOnlyNodeFrameLifecycleStage(
      clonedPlanContext.sample.tab, clonePlan, "facebook", clonedPlanContext.session,
      "expand", null, TEST_OPTIONS,
    ),
    /plan instance changed or was cloned/u,
  );
  const staleStagePlan = structuredClone(context.sample.plan);
  staleStagePlan.nodeFrameMapping.lifecycle.stageOrder = ["expand", "finish"];
  deepFreeze(staleStagePlan);
  assert.throws(
    () => createTestOnlyNodeFrameLifecycleSession(
      staleStagePlan, "facebook", lifecycleBinding("facebook"), TEST_OPTIONS,
    ),
    /stage plan is stale, reordered, or incomplete/u,
  );

  const shallowFrozenStagePlan = structuredClone(context.sample.plan);
  Object.freeze(shallowFrozenStagePlan.nodeFrameMapping.lifecycle.stageOrder);
  Object.freeze(shallowFrozenStagePlan.nodeFrameMapping.lifecycle);
  Object.freeze(shallowFrozenStagePlan.nodeFrameMapping);
  Object.freeze(shallowFrozenStagePlan);
  assert.throws(
    () => createTestOnlyNodeFrameLifecycleSession(
      shallowFrozenStagePlan, "facebook", lifecycleBinding("facebook"), TEST_OPTIONS,
    ),
    /stage plan must remain deeply immutable/u,
  );
}

async function assertLifecycleFrameNodeAndOwnershipDriftFailClosed() {
  const frame = lifecycleContext("facebook");
  await captureLifecycleStage(frame, "expand");
  completeLifecycleExpansion(frame);
  frame.sample.page.nodes.root.attributes[
    frame.sample.plan.nodeFrameMapping.frame.frameIdAttribute
  ] = "facebook-replacement-frame";
  await assert.rejects(
    () => captureLifecycleStage(frame, "reply_trigger"),
    /frame, document, comment, parent, or common node binding drifted/u,
  );

  const epoch = lifecycleContext("instagram");
  await captureLifecycleStage(epoch, "expand");
  completeLifecycleExpansion(epoch);
  epoch.sample.page.nodes.root.attributes[
    epoch.sample.plan.nodeFrameMapping.frame.documentEpochAttribute
  ] = "instagram-epoch-replaced";
  await assert.rejects(
    () => captureLifecycleStage(epoch, "reply_trigger"),
    /frame, document, comment, parent, or common node binding drifted/u,
  );

  const parent = lifecycleContext("instagram");
  await captureLifecycleStage(parent, "expand");
  completeLifecycleExpansion(parent);
  parent.sample.page.nodes[parent.sample.first.key].attributes[
    parent.sample.plan.parentPost.attribute
  ] = "https://fixture.invalid/instagram/other-post";
  await assert.rejects(
    () => captureLifecycleStage(parent, "reply_trigger"),
    /parent anchor drifted/u,
  );

  const identity = lifecycleContext("threads");
  await captureLifecycleStage(identity, "expand");
  completeLifecycleExpansion(identity);
  identity.sample.page.nodes[identity.sample.first.key].attributes[
    identity.sample.plan.commentId.attribute
  ] = "threads-replacement-identity";
  await assert.rejects(
    () => captureLifecycleStage(identity, "reply_trigger"),
    /requires exactly one comment/u,
  );

  const node = lifecycleContext("facebook");
  await captureLifecycleStage(node, "expand");
  completeLifecycleExpansion(node);
  await captureLifecycleStage(node, "reply_trigger");
  fillLifecycleComposer(node);
  await captureLifecycleStage(node, "composer_fill");
  node.sample.page.nodes[node.sample.first.composer].attributes[
    node.sample.plan.nodeFrameMapping.nodeIdAttribute
  ] = "facebook-replacement-composer-node";
  await assert.rejects(
    () => captureLifecycleStage(node, "submit_preflight"),
    /composer\/submit nodes differ/u,
  );
}

async function assertLifecycleRoleCardinalityAndRecoveryFailClosed() {
  const collision = lifecycleContext("instagram");
  await captureLifecycleStage(collision, "expand");
  completeLifecycleExpansion(collision);
  await captureLifecycleStage(collision, "reply_trigger");
  fillLifecycleComposer(collision);
  collision.sample.page.nodes[collision.sample.first.composer].attributes[
    collision.sample.plan.nodeFrameMapping.nodeIdAttribute
  ] = collision.sample.page.nodes[collision.sample.first.submit].attributes[
    collision.sample.plan.nodeFrameMapping.nodeIdAttribute
  ];
  await assert.rejects(
    () => captureLifecycleStage(collision, "composer_fill"),
    /node roles must be pairwise unique/u,
  );

  const cardinality = lifecycleContext("instagram");
  await advanceLifecycleThroughPreflight(cardinality);
  await assert.rejects(
    () => captureLifecycleStage(cardinality, "finish"),
    /requires exactly one new exact own reply/u,
  );

  const recovery = lifecycleContext("threads");
  await advanceLifecycleThroughPreflight(recovery);
  const reply = appendLifecycleReply(recovery);
  await captureLifecycleStage(recovery, "finish");
  recovery.sample.page.nodes[reply.body].attributes[
    recovery.sample.plan.nodeFrameMapping.nodeIdAttribute
  ] = "threads-rerendered-reply-body";
  await assert.rejects(
    () => captureLifecycleStage(recovery, "recovery_reinspection"),
    /reply nodes or cardinality differ/u,
  );
}

export async function testTestOnlyFullLifecycleNodeFrameMapping() {
  for (const platform of ["facebook", "instagram", "threads"]) {
    await assertPositiveLifecyclePlatform(platform);
  }
  await assertLifecycleBrandOrderReplayAndPlatformFailClosed();
  await assertLifecycleFrameNodeAndOwnershipDriftFailClosed();
  await assertLifecycleRoleCardinalityAndRecoveryFailClosed();
}


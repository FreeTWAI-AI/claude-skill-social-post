/**
 * Process-branded, test-only six-stage comment-reply lifecycle attestation.
 *
 * This module cannot mint live plans, actuate Chrome, or produce browser receipts.
 * Production modules never import this fixture-only boundary.
 */

import {
  digestObject,
  fail,
  immutableJsonSnapshot,
  requiredString,
  sha256Text,
} from "./comment_chrome_common.mjs";
import {
  stableNodeFrameMappingContractDescriptor,
} from "./comment_chrome_node_frame_mapping.mjs";
import {
  assertTestOnlyNodeFrameLifecycleStageContinuity,
  stableTestOnlyNodeFrameLifecycleStageSnapshot,
  TEST_ONLY_NODE_FRAME_LIFECYCLE_SCHEMA_VERSION,
  TEST_ONLY_NODE_FRAME_LIFECYCLE_STAGES,
  testOnlyNodeFrameLifecycleCommonBinding,
  requireTestOnlyNodeFrameLifecyclePlan,
} from "./comment_chrome_node_frame_lifecycle_snapshot_testonly.mjs";

export {
  TEST_ONLY_NODE_FRAME_LIFECYCLE_SCHEMA_VERSION,
  TEST_ONLY_NODE_FRAME_LIFECYCLE_STAGES,
};

const TRUSTED_TEST_ONLY_LIFECYCLE_SESSIONS = new WeakMap();
const TRUSTED_TEST_ONLY_LIFECYCLE_STAGES = new WeakSet();
const CONSUMED_TEST_ONLY_LIFECYCLE_STAGES = new WeakSet();
const TRUSTED_TEST_ONLY_LIFECYCLE_ATTESTATIONS = new WeakSet();

export function testOnlyNodeFrameLifecycleSpec() {
  return immutableJsonSnapshot({
    schemaVersion: TEST_ONLY_NODE_FRAME_LIFECYCLE_SCHEMA_VERSION,
    testOnly: true,
    environment: "fixture_testonly",
    stageOrder: TEST_ONLY_NODE_FRAME_LIFECYCLE_STAGES,
    ownerAttribute: "data-fixture-parent-comment-id",
    replyTrigger: {
      selector: "[data-fixture-reply-trigger]", within: "target",
    },
    composer: {
      selector: "[data-fixture-reply-composer]", within: "target", valueProperty: true,
    },
    submit: {
      selector: "[data-fixture-reply-submit]", within: "target",
    },
    replyItems: {
      selector: "[data-fixture-reply-item]", within: "target",
    },
    replyAuthor: {
      selector: "[data-fixture-reply-author]", within: "reply",
    },
    replyBody: {
      selector: "[data-fixture-reply-body]", within: "reply",
    },
  }, "test-only node/frame lifecycle spec");
}

function exactNonNegativeInteger(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${label} must be an exact non-negative integer`);
  }
  return value;
}

function lifecycleBoundaryFields() {
  return {
    evidence_class: "test_only_full_lifecycle_mapping",
    test_only: true,
    capability_promotion_eligible: false,
    live_browser_actuation_enabled: false,
    live_plan_minting: false,
    browser_receipt_eligible: false,
  };
}

export function testOnlyNodeFrameLifecycleContractDescriptor(platform) {
  const key = stableNodeFrameMappingContractDescriptor(platform).platform;
  return immutableJsonSnapshot({
    schema_version: TEST_ONLY_NODE_FRAME_LIFECYCLE_SCHEMA_VERSION,
    platform: key,
    ...lifecycleBoundaryFields(),
    coverage: "test_only_full_comment_reply_lifecycle",
    test_only_full_lifecycle_bound: true,
    live_full_lifecycle_bound: false,
    stage_order: TEST_ONLY_NODE_FRAME_LIFECYCLE_STAGES,
    stable_reads_per_stage: 2,
    previous_stage_process_brand_required: true,
    previous_stage_one_time_consume: true,
    fail_closed: true,
  }, `${key} test-only node/frame lifecycle descriptor`);
}

function requireLifecycleBinding(rawBinding) {
  if (!rawBinding || typeof rawBinding !== "object") {
    fail("node/frame lifecycle binding is required");
  }
  const binding = immutableJsonSnapshot({
    run_id: requiredString(rawBinding.run_id, "node/frame lifecycle run_id"),
    target_anchor: requiredString(
      rawBinding.target_anchor, "node/frame lifecycle target_anchor",
    ),
    parent_anchor: requiredString(
      rawBinding.parent_anchor, "node/frame lifecycle parent_anchor",
    ),
    reply_text: requiredString(rawBinding.reply_text, "node/frame lifecycle reply_text")
      .normalize("NFC"),
    own_author: requiredString(rawBinding.own_author, "node/frame lifecycle own_author")
      .normalize("NFC"),
    baseline_reply_count: exactNonNegativeInteger(
      rawBinding.baseline_reply_count, "node/frame lifecycle baseline_reply_count",
    ),
  }, "node/frame lifecycle binding");
  return binding;
}

export function createTestOnlyNodeFrameLifecycleSession(
  plan, platform, rawBinding, options = {},
) {
  const { key, lifecycle } = requireTestOnlyNodeFrameLifecyclePlan(plan, platform, options);
  const binding = requireLifecycleBinding(rawBinding);
  const core = {
    schema_version: TEST_ONLY_NODE_FRAME_LIFECYCLE_SCHEMA_VERSION,
    ...lifecycleBoundaryFields(),
    platform: key,
    adapter_id: plan.adapterId,
    adapter_version: plan.adapterVersion,
    coverage: "test_only_full_comment_reply_lifecycle",
    stage_order: lifecycle.stageOrder,
    run_id_sha256: sha256Text(binding.run_id),
    target_anchor_sha256: sha256Text(binding.target_anchor),
    parent_anchor_sha256: sha256Text(binding.parent_anchor),
    reply_hash: sha256Text(binding.reply_text),
    own_author_sha256: sha256Text(binding.own_author),
    baseline_reply_count: binding.baseline_reply_count,
    plan_digest: digestObject(plan, "test-only node/frame lifecycle plan"),
  };
  const session = immutableJsonSnapshot({
    ...core,
    lifecycle_session_id: digestObject(core, "test-only node/frame lifecycle session"),
  }, "test-only node/frame lifecycle session");
  TRUSTED_TEST_ONLY_LIFECYCLE_SESSIONS.set(session, {
    plan,
    platform: key,
    binding,
    next_stage_index: 0,
    latest_stage: null,
    base_binding_digest: null,
    stage_snapshots: new Map(),
    failed: false,
    finalized: false,
  });
  return session;
}

function lifecycleSessionState(session, plan, platform, options) {
  const state = session && typeof session === "object"
    ? TRUSTED_TEST_ONLY_LIFECYCLE_SESSIONS.get(session) : null;
  if (!state) fail("node/frame lifecycle requires its process-branded test-only session");
  requireTestOnlyNodeFrameLifecyclePlan(plan, platform, options);
  if (state.plan !== plan) fail("node/frame lifecycle plan instance changed or was cloned");
  if (state.platform !== platform || session.platform !== platform) {
    fail("node/frame lifecycle session is cross-platform");
  }
  if (state.failed) fail("node/frame lifecycle session is permanently fail-closed");
  if (state.finalized) fail("node/frame lifecycle session was already finalized");
  return state;
}

function requirePreviousLifecycleStage(state, stage, previousStage) {
  const expectedIndex = state.next_stage_index;
  const expectedStage = TEST_ONLY_NODE_FRAME_LIFECYCLE_STAGES[expectedIndex];
  if (stage !== expectedStage) {
    fail(`node/frame lifecycle expected stage ${expectedStage ?? "complete"}, not ${stage}`);
  }
  if (expectedIndex === 0) {
    if (previousStage !== null && previousStage !== undefined) {
      fail("expand stage cannot consume a previous-stage attestation");
    }
    return;
  }
  if (!previousStage || typeof previousStage !== "object"
      || !TRUSTED_TEST_ONLY_LIFECYCLE_STAGES.has(previousStage)) {
    fail("node/frame lifecycle previous stage requires its process-branded attestation");
  }
  if (previousStage !== state.latest_stage) {
    fail("node/frame lifecycle previous stage is stale, cross-stage, or cross-session");
  }
  if (CONSUMED_TEST_ONLY_LIFECYCLE_STAGES.has(previousStage)) {
    fail("node/frame lifecycle previous-stage attestation was already consumed");
  }
  CONSUMED_TEST_ONLY_LIFECYCLE_STAGES.add(previousStage);
}

export async function captureTestOnlyNodeFrameLifecycleStage(
  tab, plan, platform, session, stage, previousStage = null, options = {},
) {
  const state = lifecycleSessionState(session, plan, platform, options);
  requirePreviousLifecycleStage(state, stage, previousStage);
  let snapshot;
  try {
    snapshot = await stableTestOnlyNodeFrameLifecycleStageSnapshot(
      tab, plan, platform, stage, state, options,
    );
    assertTestOnlyNodeFrameLifecycleStageContinuity(stage, snapshot, state);
  } catch (error) {
    state.failed = true;
    throw error;
  }
  const core = {
    schema_version: TEST_ONLY_NODE_FRAME_LIFECYCLE_SCHEMA_VERSION,
    evidence_class: "test_only_full_lifecycle_mapping_stage",
    test_only: true,
    capability_promotion_eligible: false,
    live_browser_actuation_enabled: false,
    live_plan_minting: false,
    browser_receipt_eligible: false,
    lifecycle_session_id: session.lifecycle_session_id,
    platform,
    stage,
    stage_index: state.next_stage_index,
    previous_stage_attestation_id: previousStage?.stage_attestation_id ?? null,
    stable_read_count: 2,
    snapshot_digest: digestObject(snapshot, `${stage} lifecycle snapshot`),
    common_binding_sha256: testOnlyNodeFrameLifecycleCommonBinding(snapshot),
    role_bindings_sha256: digestObject(snapshot.roles, `${stage} lifecycle roles`),
    role_count: snapshot.role_count,
    expansion_terminal: snapshot.expansion.terminal,
    expansion_control_count: snapshot.expansion.control_count,
    reply_cardinality: snapshot.reply_cardinality,
  };
  const attestation = immutableJsonSnapshot({
    ...core,
    stage_attestation_id: digestObject(core, `${stage} lifecycle stage attestation`),
  }, `${stage} test-only node/frame lifecycle stage attestation`);
  TRUSTED_TEST_ONLY_LIFECYCLE_STAGES.add(attestation);
  state.latest_stage = attestation;
  state.stage_snapshots.set(stage, snapshot);
  state.next_stage_index += 1;
  return attestation;
}

export function finalizeTestOnlyNodeFrameLifecycle(session, finalStage) {
  const state = session && typeof session === "object"
    ? TRUSTED_TEST_ONLY_LIFECYCLE_SESSIONS.get(session) : null;
  if (!state) fail("node/frame lifecycle finalization requires its process-branded session");
  if (state.failed) fail("node/frame lifecycle session is permanently fail-closed");
  if (state.finalized) fail("node/frame lifecycle session was already finalized");
  if (state.next_stage_index !== TEST_ONLY_NODE_FRAME_LIFECYCLE_STAGES.length
      || finalStage !== state.latest_stage
      || !TRUSTED_TEST_ONLY_LIFECYCLE_STAGES.has(finalStage)) {
    fail("node/frame lifecycle cannot finalize an incomplete, cloned, or stale stage chain");
  }
  if (CONSUMED_TEST_ONLY_LIFECYCLE_STAGES.has(finalStage)) {
    fail("node/frame lifecycle final stage was already consumed");
  }
  CONSUMED_TEST_ONLY_LIFECYCLE_STAGES.add(finalStage);
  state.finalized = true;
  const stages = TEST_ONLY_NODE_FRAME_LIFECYCLE_STAGES.map((stage) => {
    const snapshot = state.stage_snapshots.get(stage);
    return {
      stage,
      snapshot_digest: digestObject(snapshot, `${stage} final lifecycle snapshot`),
      role_bindings_sha256: digestObject(snapshot.roles, `${stage} final lifecycle roles`),
      role_count: snapshot.role_count,
      expansion_terminal: snapshot.expansion.terminal,
      reply_cardinality: snapshot.reply_cardinality,
    };
  });
  const core = {
    schema_version: TEST_ONLY_NODE_FRAME_LIFECYCLE_SCHEMA_VERSION,
    ...lifecycleBoundaryFields(),
    coverage: "test_only_full_comment_reply_lifecycle",
    test_only_full_lifecycle_bound: true,
    live_full_lifecycle_bound: false,
    lifecycle_session_id: session.lifecycle_session_id,
    platform: session.platform,
    adapter_id: session.adapter_id,
    adapter_version: session.adapter_version,
    plan_digest: session.plan_digest,
    stage_order: TEST_ONLY_NODE_FRAME_LIFECYCLE_STAGES,
    stage_count: stages.length,
    stable_reads_per_stage: 2,
    previous_stage_one_time_consume: true,
    stages,
    final_stage_attestation_id: finalStage.stage_attestation_id,
  };
  const attestation = immutableJsonSnapshot({
    ...core,
    lifecycle_attestation_id: digestObject(core, "test-only full lifecycle attestation"),
  }, "test-only full node/frame lifecycle attestation");
  TRUSTED_TEST_ONLY_LIFECYCLE_ATTESTATIONS.add(attestation);
  return attestation;
}

export function isTrustedTestOnlyNodeFrameLifecycleAttestation(attestation) {
  return Boolean(attestation && typeof attestation === "object"
    && TRUSTED_TEST_ONLY_LIFECYCLE_ATTESTATIONS.has(attestation));
}

export function nodeFrameLifecycleEvidence(attestation) {
  if (!isTrustedTestOnlyNodeFrameLifecycleAttestation(attestation)) {
    fail("node/frame lifecycle evidence requires its process-branded test-only attestation");
  }
  return immutableJsonSnapshot(
    { ...attestation }, "node/frame lifecycle public test evidence",
  );
}

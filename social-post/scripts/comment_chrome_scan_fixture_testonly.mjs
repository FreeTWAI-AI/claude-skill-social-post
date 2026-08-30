/**
 * Isolated loopback-only fixture authority for scan-adapter regression tests.
 *
 * Nothing in the production actuator import graph imports this module. Its
 * plans and attestations can only drive createIsolatedTestOnlyScanPost(), which
 * requires testOnly=true and a loopback browser URL before reading or clicking.
 */
import {
  digestObject, fail, immutableJsonSnapshot, locate, normalizedText, requiredString, unique,
} from "./comment_chrome_common.mjs";
import {
  captureTestOnlyNodeFrameMapping, nodeFrameMappingEvidence, testOnlyNodeFrameMappingSpec,
  verifyTestOnlyNodeFrameMappingStillCurrent,
} from "./comment_chrome_node_frame_mapping_testonly.mjs";
import {
  createTestOnlyNodeFrameLifecycleSession, testOnlyNodeFrameLifecycleSpec,
} from "./comment_chrome_node_frame_lifecycle_testonly.mjs";
import { createIsolatedTestOnlyScanPost } from "./comment_chrome_scan.mjs";
export const FIXTURE_SCAN_ADAPTER_SCHEMA_VERSION = 1;
export const FIXTURE_EXPANSION_EXHAUSTION_SCHEMA_VERSION = 1;
const TRUSTED_FIXTURE_PLANS = new WeakSet();
const TRUSTED_FIXTURE_ATTESTATIONS = new WeakSet();
function fixtureDefinition(
  platform, prefix, commentSelector, adapterId,
  commentIdAttribute = `data-${prefix}-comment-id`,
) {
  return {
    adapterId,
    adapterVersion: "2026-08-30.1-testonly",
    adapterEnvironment: "fixture_testonly",
    platform,
    authentication: { selector: "html", attribute: "data-authentication-state" },
    account: { selector: "html", attribute: "data-account-key" },
    post: { selector: "html", attribute: "data-post-key" },
    comments: { selector: commentSelector },
    commentId: { selector: ":scope", self: true, attribute: commentIdAttribute },
    author: { selector: ":scope", self: true, attribute: "data-author-key" },
    authorDisplay: { selector: `[data-${prefix}-author]` },
    body: { selector: `[data-${prefix}-body]` },
    permalink: {
      selector: `[data-${prefix}-comment-permalink]`, attribute: "href", optional: true,
    },
    parentPost: {
      selector: ":scope", self: true, attribute: "data-parent-post-permalink",
    },
    isOwn: { selector: ":scope", self: true, attribute: "data-is-own" },
    ownReplyItems: { selector: `[data-${prefix}-own-reply]` },
    ownReplyAuthor: { selector: "[data-fixture-own-author]" },
    bodyComplete: true,
    language: "und",
    nodeFrameMapping: {
      ...testOnlyNodeFrameMappingSpec(platform), lifecycle: testOnlyNodeFrameLifecycleSpec(),
    },
    expansion: {
      commentControls: { selector: `[data-${prefix}-comment-expand-control]` },
      replyControls: { selector: `[data-${prefix}-reply-expand-control]` },
      state: {
        selector: "html",
        cursorAttribute: "data-fixture-expansion-cursor",
        discoveredCountAttribute: "data-fixture-discovered-count",
        terminalAttribute: "data-fixture-expansion-terminal",
      },
      viewportTraversalControl: { selector: "[data-fixture-viewport-next]" },
      stableInstanceAttribute: "data-fixture-control-instance",
      maxControlsPerRead: 200,
      maxClicks: 200,
      maxViewportTraversals: 32,
      maxObservationPasses: 256,
      maxElapsedMs: 60000,
      settleMs: 0,
      stableReadDelayMs: 0,
    },
  };
}
const FIXTURE_ADAPTERS = immutableJsonSnapshot({
  facebook: fixtureDefinition("facebook", "fb", "[data-fb-comment-id]",
    "facebook-comments-testonly"),
  instagram: fixtureDefinition("instagram", "ig", "[data-ig-comment-id]",
    "instagram-comments-testonly"),
  threads: fixtureDefinition("threads", "threads", "[data-threads-reply-id]",
    "threads-replies-testonly", "data-threads-reply-id"),
}, "isolated fixture scan adapters");
function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function knownFixturePlatform(platform) {
  const key = requiredString(platform, "fixture scan adapter platform");
  if (!Object.prototype.hasOwnProperty.call(FIXTURE_ADAPTERS, key)) {
    fail(`no registered fixture scan adapter platform ${key}`);
  }
  return key;
}
export function trustedFixtureAdapterVersions() {
  return immutableJsonSnapshot(Object.fromEntries(
    Object.entries(FIXTURE_ADAPTERS).map(([platform, adapter]) => [
      platform, `${adapter.adapterId}@${adapter.adapterVersion}`,
    ]),
  ), "isolated fixture scan adapter versions");
}
export function createTrustedFixtureScanPlan(platform, { adapterVersion } = {}) {
  const key = knownFixturePlatform(platform);
  const adapter = FIXTURE_ADAPTERS[key];
  if (adapterVersion !== undefined
      && requiredString(adapterVersion, "fixture scan adapter version")
        !== adapter.adapterVersion) {
    fail(`unsupported ${key} fixture scan adapter version ${adapterVersion}`);
  }
  const plan = immutableJsonSnapshot({
    ...adapter,
    adapterSchemaVersion: FIXTURE_SCAN_ADAPTER_SCHEMA_VERSION,
    exhaustionSchemaVersion: FIXTURE_EXPANSION_EXHAUSTION_SCHEMA_VERSION,
  }, `${key} isolated fixture scan plan`);
  TRUSTED_FIXTURE_PLANS.add(plan);
  return plan;
}
export function isTrustedFixtureScanPlan(plan) {
  return Boolean(plan && typeof plan === "object" && TRUSTED_FIXTURE_PLANS.has(plan));
}

function requireTrustedFixtureScanPlan(plan, platform, { testOnly = false } = {}) {
  const expectedPlatform = knownFixturePlatform(platform);
  if (testOnly !== true) {
    fail("fixture scan plan requires testOnly=true and can never attest live expansion");
  }
  if (!isTrustedFixtureScanPlan(plan)) {
    fail("isolated fixture scan requires its process-branded test-only plan");
  }
  const registered = FIXTURE_ADAPTERS[expectedPlatform];
  if (plan.platform !== expectedPlatform
      || plan.adapterEnvironment !== "fixture_testonly"
      || plan.adapterSchemaVersion !== FIXTURE_SCAN_ADAPTER_SCHEMA_VERSION
      || plan.exhaustionSchemaVersion !== FIXTURE_EXPANSION_EXHAUSTION_SCHEMA_VERSION
      || plan.adapterId !== registered.adapterId
      || plan.adapterVersion !== registered.adapterVersion) {
    fail("isolated fixture scan plan is cross-platform, stale, or malformed");
  }
  if (!Object.isFrozen(plan) || !Object.isFrozen(plan.expansion)) {
    fail("isolated fixture scan plan must remain deeply immutable");
  }
  return plan;
}

function parseTerminal(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  fail("expansion terminal evidence must be explicit true or false");
}

function parseDiscoveredCount(value) {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    fail("expansion discovered-count evidence must be a non-negative integer");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) fail("expansion discovered-count is outside safe bounds");
  return count;
}

async function readExhaustionState(tab, plan) {
  const spec = plan.expansion.state;
  const state = locate(tab, null, spec);
  await unique(state, "fixture expansion exhaustion state");
  const cursor = requiredString(
    normalizedText(await state.getAttribute(spec.cursorAttribute)),
    "fixture expansion cursor",
  );
  const discoveredCount = parseDiscoveredCount(normalizedText(
    await state.getAttribute(spec.discoveredCountAttribute),
  ));
  const terminal = parseTerminal(normalizedText(
    await state.getAttribute(spec.terminalAttribute),
  ));
  return immutableJsonSnapshot({
    cursor,
    discovered_count: discoveredCount,
    terminal,
    digest: digestObject({ cursor, discoveredCount, terminal }, "fixture exhaustion state"),
  }, "fixture expansion exhaustion state");
}

async function readControl(tab, spec, kind, index, instanceAttribute) {
  const locator = locate(tab, null, spec).nth(index);
  if (!(await locator.isVisible())) fail(`${kind} expansion contains a hidden control`);
  if (!(await locator.isEnabled())) fail(`${kind} expansion contains a disabled control`);
  return {
    kind,
    index,
    instance_id: requiredString(
      normalizedText(await locator.getAttribute(instanceAttribute)),
      `${kind} expansion stable instance`,
    ),
    label: normalizedText(await locator.getAttribute("aria-label")),
    text: normalizedText(await locator.textContent()),
  };
}

async function controlSnapshot(tab, plan) {
  const entries = [];
  const instances = new Set();
  for (const [kind, spec] of [
    ["comment", plan.expansion.commentControls],
    ["reply", plan.expansion.replyControls],
  ]) {
    const controls = locate(tab, null, spec);
    const count = await controls.count();
    if (!Number.isInteger(count) || count < 0) fail(`${kind} expansion count is invalid`);
    if (count > plan.expansion.maxControlsPerRead) {
      fail(`${kind} expansion controls exceed the registered per-read bound`);
    }
    for (let index = 0; index < count; index += 1) {
      const entry = await readControl(
        tab, spec, kind, index, plan.expansion.stableInstanceAttribute,
      );
      if (instances.has(entry.instance_id)) {
        fail("fixture expansion control stable instances must be unique");
      }
      instances.add(entry.instance_id);
      entries.push(entry);
    }
    if (await locate(tab, null, spec).count() !== count) {
      fail(`${kind} expansion-control count drifted during inspection`);
    }
  }
  return immutableJsonSnapshot({
    total: entries.length,
    entries,
    digest: digestObject(entries, "fixture expansion control snapshot"),
  }, "fixture expansion control snapshot");
}

async function traversalSnapshot(tab, plan) {
  const spec = plan.expansion.viewportTraversalControl;
  const controls = locate(tab, null, spec);
  const count = await controls.count();
  if (count === 0) return null;
  if (count !== 1) fail(`viewport traversal expected at most one control, found ${count}`);
  const control = controls.nth(0);
  if (!(await control.isVisible())) fail("viewport traversal control is hidden");
  if (!(await control.isEnabled())) fail("viewport traversal control is disabled");
  return immutableJsonSnapshot({
    instance_id: requiredString(
      normalizedText(await control.getAttribute(plan.expansion.stableInstanceAttribute)),
      "viewport traversal stable instance",
    ),
    label: normalizedText(await control.getAttribute("aria-label")),
    text: normalizedText(await control.textContent()),
  }, "viewport traversal snapshot");
}

async function clickStableControl(tab, plan, snapshotEntry) {
  const spec = snapshotEntry.kind === "comment"
    ? plan.expansion.commentControls : plan.expansion.replyControls;
  const controls = locate(tab, null, spec);
  const sameKind = snapshotEntry.kind;
  const count = await controls.count();
  if (count < 1) fail(`${sameKind} expansion control disappeared before click`);
  const current = await readControl(
    tab, spec, sameKind, 0, plan.expansion.stableInstanceAttribute,
  );
  if (current.instance_id !== snapshotEntry.instance_id
      || current.label !== snapshotEntry.label
      || current.text !== snapshotEntry.text) {
    fail("expansion control instance changed before click; replacement receives zero clicks");
  }
  await controls.nth(0).click();
  await wait(plan.expansion.settleMs);
  return sameKind;
}

async function clickStableTraversal(tab, plan, expected) {
  const spec = plan.expansion.viewportTraversalControl;
  const controls = locate(tab, null, spec);
  if (await controls.count() !== 1) {
    fail("viewport traversal control changed before click");
  }
  const current = await traversalSnapshot(tab, plan);
  if (!current
      || current.instance_id !== expected.instance_id
      || current.label !== expected.label
      || current.text !== expected.text) {
    fail("viewport traversal instance changed before click; replacement receives zero clicks");
  }
  await controls.nth(0).click();
  await wait(plan.expansion.settleMs);
}

function assertMonotonic(previous, current, { afterTraversal = false, seenCursors } = {}) {
  if (current.discovered_count < previous.discovered_count) {
    fail("expansion discovered count decreased; virtualized evidence cannot attest completeness");
  }
  if (afterTraversal) {
    if (current.cursor === previous.cursor) {
      fail("viewport traversal did not advance the exhaustion cursor");
    }
    if (seenCursors.has(current.cursor)) {
      fail("viewport traversal repeated an earlier cursor without terminal exhaustion");
    }
  } else if (current.cursor !== previous.cursor) {
    fail("expansion cursor changed without a verified viewport traversal");
  }
}

function createAttestation(plan, evidence, terminalState, stableControlSnapshot) {
  const core = {
    schema_version: FIXTURE_SCAN_ADAPTER_SCHEMA_VERSION,
    exhaustion_schema_version: FIXTURE_EXPANSION_EXHAUSTION_SCHEMA_VERSION,
    test_only: true,
    platform: plan.platform,
    adapter_id: plan.adapterId,
    adapter_version: plan.adapterVersion,
    plan_digest: digestObject(plan, "isolated fixture scan plan"),
    total_clicks: evidence.clickedKinds.length,
    clicked_control_kinds: evidence.clickedKinds,
    viewport_traversal_steps: evidence.viewportTraversals,
    viewport_cursors: evidence.cursorSequence,
    discovered_count_sequence: evidence.discoveredCounts,
    monotonic_discovered_count: true,
    terminal_evidence: true,
    terminal_cursor: terminalState.cursor,
    terminal_discovered_count: terminalState.discovered_count,
    observation_passes: evidence.observationPasses,
    stable_read_count: 2,
    terminal_control_count: stableControlSnapshot.total,
    terminal_snapshot_digest: digestObject({
      state: terminalState.digest,
      controls: stableControlSnapshot.digest,
    }, "fixture terminal exhaustion snapshot"),
    bounded_by: {
      max_controls_per_read: plan.expansion.maxControlsPerRead,
      max_clicks: plan.expansion.maxClicks,
      max_viewport_traversals: plan.expansion.maxViewportTraversals,
      max_observation_passes: plan.expansion.maxObservationPasses,
      max_elapsed_ms: plan.expansion.maxElapsedMs,
    },
  };
  const attestation = immutableJsonSnapshot({
    ...core,
    attestation_id: digestObject(core, "fixture expansion exhaustion attestation"),
  }, "fixture expansion exhaustion attestation");
  TRUSTED_FIXTURE_ATTESTATIONS.add(attestation);
  return attestation;
}

async function attestFixtureExpansion(tab, plan, platform, options = {}) {
  requireTrustedFixtureScanPlan(plan, platform, options);
  const startedAt = Date.now();
  const clickedKinds = [];
  const cursorSequence = [];
  const discoveredCounts = [];
  const seenCursors = new Set();
  let viewportTraversals = 0;
  let observationPasses = 0;
  let previousState = null;

  while (true) {
    if (observationPasses >= plan.expansion.maxObservationPasses
        || Date.now() - startedAt > plan.expansion.maxElapsedMs) {
      fail("fixture expansion exhausted its evidence bounds before terminal cursor proof");
    }
    observationPasses += 1;
    const state = await readExhaustionState(tab, plan);
    if (previousState) assertMonotonic(previousState, state, { seenCursors });
    if (!seenCursors.has(state.cursor)) {
      seenCursors.add(state.cursor);
      cursorSequence.push(state.cursor);
      discoveredCounts.push(state.discovered_count);
    }
    previousState = state;

    const controls = await controlSnapshot(tab, plan);
    if (controls.total > 0) {
      if (clickedKinds.length >= plan.expansion.maxClicks) {
        fail(`fixture expansion exceeded maxClicks=${plan.expansion.maxClicks}`);
      }
      clickedKinds.push(await clickStableControl(tab, plan, controls.entries[0]));
      continue;
    }

    const traversal = await traversalSnapshot(tab, plan);
    if (state.terminal) {
      if (traversal) {
        fail("terminal expansion cursor still exposes a viewport traversal control");
      }
      await wait(plan.expansion.stableReadDelayMs);
      const stableState = await readExhaustionState(tab, plan);
      const stableControls = await controlSnapshot(tab, plan);
      const stableTraversal = await traversalSnapshot(tab, plan);
      if (!stableState.terminal
          || stableState.cursor !== state.cursor
          || stableState.discovered_count !== state.discovered_count
          || stableControls.total !== 0
          || stableTraversal) {
        fail("terminal exhaustion evidence changed during stable verification");
      }
      return createAttestation(plan, {
        clickedKinds,
        viewportTraversals,
        cursorSequence,
        discoveredCounts,
        observationPasses,
      }, stableState, stableControls);
    }

    if (!traversal) {
      fail(`non-terminal expansion cursor ${state.cursor} lacks a trusted viewport traversal control`);
    }
    if (viewportTraversals >= plan.expansion.maxViewportTraversals) {
      fail("fixture expansion exceeded its viewport traversal bound without terminal cursor proof");
    }
    await clickStableTraversal(tab, plan, traversal);
    viewportTraversals += 1;
    const advanced = await readExhaustionState(tab, plan);
    assertMonotonic(state, advanced, { afterTraversal: true, seenCursors });
    seenCursors.add(advanced.cursor);
    cursorSequence.push(advanced.cursor);
    discoveredCounts.push(advanced.discovered_count);
    previousState = advanced;
  }
}

async function verifyFixtureExpansionStillComplete(
  tab, plan, platform, attestation, options = {},
) {
  requireTrustedFixtureScanPlan(plan, platform, options);
  if (!attestation || typeof attestation !== "object"
      || !TRUSTED_FIXTURE_ATTESTATIONS.has(attestation)) {
    fail("fixture expansion verification requires its process-branded attestation");
  }
  if (attestation.test_only !== true
      || attestation.exhaustion_schema_version
        !== FIXTURE_EXPANSION_EXHAUSTION_SCHEMA_VERSION
      || attestation.platform !== platform
      || attestation.plan_digest !== digestObject(plan, "isolated fixture scan plan")) {
    fail("fixture expansion attestation is stale, malformed, or cross-platform");
  }
  const firstState = await readExhaustionState(tab, plan);
  const firstControls = await controlSnapshot(tab, plan);
  const firstTraversal = await traversalSnapshot(tab, plan);
  if (!firstState.terminal
      || firstState.cursor !== attestation.terminal_cursor
      || firstState.discovered_count !== attestation.terminal_discovered_count
      || firstControls.total !== 0
      || firstTraversal) {
    fail("fixture terminal exhaustion no longer holds after attestation");
  }
  await wait(plan.expansion.stableReadDelayMs);
  const secondState = await readExhaustionState(tab, plan);
  const secondControls = await controlSnapshot(tab, plan);
  const secondTraversal = await traversalSnapshot(tab, plan);
  if (secondState.digest !== firstState.digest
      || secondControls.digest !== firstControls.digest
      || secondControls.total !== 0
      || secondTraversal) {
    fail("fixture terminal exhaustion drifted during stable re-verification");
  }
  return true;
}

const FIXTURE_AUTHORITY = Object.freeze({
  attest: attestFixtureExpansion,
  isTrustedPlan: isTrustedFixtureScanPlan,
  requirePlan: requireTrustedFixtureScanPlan,
  verifyComplete: verifyFixtureExpansionStillComplete,
});

export function createTrustedFixtureScanPost(options = {}) {
  const scan = createIsolatedTestOnlyScanPost(options, FIXTURE_AUTHORITY);
  return async function scanWithStableNodeFrameMapping(
    tab, request, plan, rawOptions = {},
  ) {
    requireTrustedFixtureScanPlan(plan, request?.platform, rawOptions);
    const receipt = await scan(tab, request, plan, rawOptions);
    const mapping = await captureTestOnlyNodeFrameMapping(
      tab, plan, request.platform, rawOptions,
    );
    await verifyTestOnlyNodeFrameMappingStillCurrent(
      tab, plan, request.platform, mapping, rawOptions,
    );
    return Object.freeze({
      ...receipt,
      stable_node_frame_mapping_evidence: nodeFrameMappingEvidence(mapping),
    });
  };
}

export function createTrustedFixtureNodeFrameLifecycleSession(
  plan, platform, binding, options = {},
) {
  requireTrustedFixtureScanPlan(plan, platform, options);
  return createTestOnlyNodeFrameLifecycleSession(plan, platform, binding, options);
}

export function isTrustedFixtureExpansionAttestation(attestation) {
  return Boolean(attestation && typeof attestation === "object"
    && TRUSTED_FIXTURE_ATTESTATIONS.has(attestation));
}

export async function verifyTrustedFixtureExpansionStillComplete(
  tab, plan, platform, attestation, options = {},
) {
  return verifyFixtureExpansionStillComplete(tab, plan, platform, attestation, options);
}

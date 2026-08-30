/** Versioned, fail-closed completeness authority for a single reply thread. */

import { randomUUID } from "node:crypto";

import {
  digestObject,
  fail,
  immutableJsonSnapshot,
  locate,
  matchingOwnReplies,
  normalizedText,
  requiredString,
  unique,
} from "./comment_chrome_common.mjs";

export const REPLY_THREAD_EXHAUSTION_SCHEMA_VERSION = 1;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

export function assertReplyExhaustionPlan(plan) {
  const contract = plan?.replyExhaustion;
  if (!contract || typeof contract !== "object") {
    fail("locator plan.replyExhaustion is required");
  }
  if (contract.schemaVersion !== REPLY_THREAD_EXHAUSTION_SCHEMA_VERSION) {
    fail(`reply exhaustion schemaVersion must be ${REPLY_THREAD_EXHAUSTION_SCHEMA_VERSION}`);
  }
  for (const [name, spec] of [
    ["state", contract.state],
    ["viewportTraversalControl", contract.viewportTraversalControl],
  ]) {
    if (!spec || typeof spec !== "object") fail(`replyExhaustion.${name} is required`);
    requiredString(spec.selector, `replyExhaustion.${name}.selector`);
    if (spec.within !== "target") fail(`replyExhaustion.${name} must be scoped to target`);
  }
  for (const name of ["cursorAttribute", "discoveredCountAttribute", "terminalAttribute"]) {
    requiredString(contract.state[name], `replyExhaustion.state.${name}`);
  }
  requiredString(contract.stableInstanceAttribute, "replyExhaustion.stableInstanceAttribute");
  for (const name of [
    "maxControlsPerRead", "maxClicks", "maxViewportTraversals",
    "maxObservationPasses", "maxElapsedMs", "settleMs", "stableReadDelayMs",
  ]) {
    nonNegativeInteger(contract[name], `replyExhaustion.${name}`);
  }
  if (contract.maxControlsPerRead < 1
      || contract.maxObservationPasses < 1
      || contract.maxElapsedMs < 1) {
    fail("reply exhaustion positive bounds cannot be zero");
  }
  return contract;
}

function parseDiscoveredCount(value) {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    fail("reply exhaustion discovered count must be explicit non-negative integer evidence");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail("reply exhaustion discovered count is unsafe");
  return parsed;
}

function parseTerminal(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  fail("reply exhaustion terminal evidence must be explicit true or false");
}

async function readState(tab, target, contract) {
  const locator = locate(tab, target, contract.state);
  await unique(locator, "reply exhaustion state");
  const cursor = requiredString(
    normalizedText(await locator.getAttribute(contract.state.cursorAttribute)),
    "reply exhaustion cursor",
  );
  const discoveredCount = parseDiscoveredCount(normalizedText(
    await locator.getAttribute(contract.state.discoveredCountAttribute),
  ));
  const terminal = parseTerminal(normalizedText(
    await locator.getAttribute(contract.state.terminalAttribute),
  ));
  return immutableJsonSnapshot({
    cursor,
    discovered_count: discoveredCount,
    terminal,
    digest: digestObject({ cursor, discoveredCount, terminal }, "reply exhaustion state"),
  }, "reply exhaustion state");
}

async function bindControlNode(locator, label, expected = null) {
  if (expected) {
    const observed = await locator.evaluate(
      (element, binding) => element[binding.property] ?? null,
      { property: expected.property },
    );
    if (observed !== expected.token) {
      fail(`${label} DOM node changed before click; replacement receives zero clicks`);
    }
    return expected;
  }
  const binding = {
    property: `__codex_reply_control_${randomUUID().replaceAll("-", "")}`,
    token: randomUUID(),
  };
  const observed = await locator.evaluate((element, candidate) => {
    if (!Object.prototype.hasOwnProperty.call(element, candidate.property)) {
      Object.defineProperty(element, candidate.property, {
        value: candidate.token, configurable: false, enumerable: false, writable: false,
      });
    }
    return element[candidate.property];
  }, binding);
  if (observed !== binding.token) fail(`${label} DOM node binding could not be established`);
  return immutableJsonSnapshot(binding, `${label} DOM node binding`);
}

async function readControl(locator, label, instanceAttribute, expectedBinding = null) {
  if (!(await locator.isVisible())) fail(`${label} is hidden`);
  if (!(await locator.isEnabled())) fail(`${label} is disabled`);
  const nodeBinding = await bindControlNode(locator, label, expectedBinding);
  return immutableJsonSnapshot({
    instance_id: requiredString(
      normalizedText(await locator.getAttribute(instanceAttribute)),
      `${label} stable instance`,
    ),
    label: normalizedText(await locator.getAttribute("aria-label")),
    text: normalizedText(await locator.textContent()),
    node_binding: nodeBinding,
  }, `${label} snapshot`);
}

async function expansionSnapshot(tab, target, plan, contract) {
  const controls = locate(tab, target, plan.replyExpansionControls);
  const count = await controls.count();
  if (count > contract.maxControlsPerRead) {
    fail("reply expansion controls exceed the registered per-read bound");
  }
  const entries = [];
  const instances = new Set();
  for (let index = 0; index < count; index += 1) {
    const entry = await readControl(
      controls.nth(index), "reply expansion control", contract.stableInstanceAttribute,
    );
    if (instances.has(entry.instance_id)) {
      fail("reply expansion control stable instances must be unique");
    }
    instances.add(entry.instance_id);
    entries.push(entry);
  }
  if (await locate(tab, target, plan.replyExpansionControls).count() !== count) {
    fail("reply expansion-control count drifted during inspection");
  }
  return immutableJsonSnapshot({
    total: count,
    entries,
    digest: digestObject(entries, "reply expansion controls"),
  }, "reply expansion controls");
}

async function traversalSnapshot(tab, target, contract) {
  const controls = locate(tab, target, contract.viewportTraversalControl);
  const count = await controls.count();
  if (count === 0) return null;
  if (count !== 1) fail(`reply viewport traversal expected at most one control, found ${count}`);
  return readControl(
    controls.nth(0), "reply viewport traversal control", contract.stableInstanceAttribute,
  );
}

function sameControl(first, second) {
  return second
    && first.instance_id === second.instance_id
    && first.label === second.label
    && first.text === second.text
    && first.node_binding.property === second.node_binding.property
    && first.node_binding.token === second.node_binding.token;
}

async function clickExpansion(tab, target, plan, contract, expected) {
  const controls = locate(tab, target, plan.replyExpansionControls);
  if (await controls.count() < 1) fail("reply expansion control disappeared before click");
  const current = await readControl(
    controls.nth(0), "reply expansion control", contract.stableInstanceAttribute,
    expected.node_binding,
  );
  if (!sameControl(expected, current)) {
    fail("reply expansion control instance changed before click; replacement receives zero clicks");
  }
  await controls.nth(0).click();
  await wait(contract.settleMs);
}

async function clickTraversal(tab, target, contract, expected) {
  const controls = locate(tab, target, contract.viewportTraversalControl);
  if (await controls.count() !== 1) fail("reply viewport traversal changed before click");
  const current = await readControl(
    controls.nth(0), "reply viewport traversal control",
    contract.stableInstanceAttribute, expected.node_binding,
  );
  if (!sameControl(expected, current)) {
    fail("reply viewport traversal instance changed before click; replacement receives zero clicks");
  }
  await controls.nth(0).click();
  await wait(contract.settleMs);
}

function assertMonotonic(previous, current, { afterTraversal = false, seen } = {}) {
  if (current.discovered_count < previous.discovered_count) {
    fail("reply exhaustion discovered count decreased; virtualized evidence is incomplete");
  }
  if (afterTraversal) {
    if (current.cursor === previous.cursor) {
      fail("reply viewport traversal did not advance its cursor");
    }
    if (seen.has(current.cursor)) fail("reply exhaustion cursor repeated before terminal proof");
  } else if (current.cursor !== previous.cursor) {
    fail("reply exhaustion cursor changed without verified viewport traversal");
  }
}

async function verifyTerminalCoverage(tab, target, plan, state) {
  const visibleCount = await locate(tab, target, plan.replyItems).count();
  if (visibleCount !== state.discovered_count) {
    fail(
      `reply terminal cursor discovered ${state.discovered_count} items but `
      + `${visibleCount} remain inspectable; virtualized or partial coverage is forbidden`,
    );
  }
  return visibleCount;
}

async function exhaustReplyThread(tab, target, plan, contract) {
  const startedAt = Date.now();
  const cursors = [];
  const discoveredCounts = [];
  const seen = new Set();
  let clicks = 0;
  let traversals = 0;
  let passes = 0;
  let previous = null;

  while (true) {
    if (passes >= contract.maxObservationPasses
        || Date.now() - startedAt > contract.maxElapsedMs) {
      fail("reply exhaustion reached its bound without terminal cursor coverage");
    }
    passes += 1;
    const state = await readState(tab, target, contract);
    if (previous) assertMonotonic(previous, state, { seen });
    seen.add(state.cursor);
    cursors.push(state.cursor);
    discoveredCounts.push(state.discovered_count);
    previous = state;

    const expansion = await expansionSnapshot(tab, target, plan, contract);
    if (expansion.total > 0) {
      if (clicks >= contract.maxClicks) fail("reply exhaustion exceeded its click bound");
      await clickExpansion(tab, target, plan, contract, expansion.entries[0]);
      clicks += 1;
      continue;
    }

    const traversal = await traversalSnapshot(tab, target, contract);
    if (state.terminal) {
      if (traversal) fail("terminal reply cursor still exposes viewport traversal");
      await verifyTerminalCoverage(tab, target, plan, state);
      await wait(contract.stableReadDelayMs);
      const stableState = await readState(tab, target, contract);
      const stableExpansion = await expansionSnapshot(tab, target, plan, contract);
      const stableTraversal = await traversalSnapshot(tab, target, contract);
      await verifyTerminalCoverage(tab, target, plan, stableState);
      if (!stableState.terminal
          || stableState.digest !== state.digest
          || stableExpansion.total !== 0
          || stableTraversal) {
        fail("reply terminal exhaustion changed during stable verification");
      }
      const core = {
        schema_version: REPLY_THREAD_EXHAUSTION_SCHEMA_VERSION,
        authority: "reply-thread-exhaustion-v1",
        cursor_sequence: cursors,
        discovered_count_sequence: discoveredCounts,
        monotonic_discovered_count: true,
        terminal_evidence: true,
        terminal_cursor: stableState.cursor,
        terminal_discovered_count: stableState.discovered_count,
        expansion_clicks: clicks,
        viewport_traversals: traversals,
        observation_passes: passes,
        stable_read_count: 2,
      };
      return immutableJsonSnapshot({
        ...core,
        attestation_id: digestObject(core, "reply exhaustion attestation"),
      }, "reply exhaustion attestation");
    }

    if (!traversal) {
      fail(`non-terminal reply cursor ${state.cursor} has no trusted traversal control`);
    }
    if (traversals >= contract.maxViewportTraversals) {
      fail("reply exhaustion exceeded its traversal bound without terminal proof");
    }
    await clickTraversal(tab, target, contract, traversal);
    traversals += 1;
    const advanced = await readState(tab, target, contract);
    assertMonotonic(state, advanced, { afterTraversal: true, seen });
    seen.add(advanced.cursor);
    previous = advanced;
  }
}

async function verifyExhaustionStillTerminal(tab, target, plan, contract, attestation) {
  const state = await readState(tab, target, contract);
  const expansion = await expansionSnapshot(tab, target, plan, contract);
  const traversal = await traversalSnapshot(tab, target, contract);
  await verifyTerminalCoverage(tab, target, plan, state);
  if (!state.terminal
      || state.cursor !== attestation.terminal_cursor
      || state.discovered_count !== attestation.terminal_discovered_count
      || expansion.total !== 0
      || traversal) {
    fail("reply exhaustion no longer has terminal complete coverage");
  }
}

export async function requireExhaustedReplySet(
  tab, target, plan, replyText, ownAuthor, ownership,
) {
  const contract = assertReplyExhaustionPlan(plan);
  const attestation = await exhaustReplyThread(tab, target, plan, contract);
  const first = await matchingOwnReplies(
    tab, target, plan, replyText, ownAuthor, ownership,
  );
  if (first.end_total !== first.total || first.inspectable !== first.total) {
    fail(`reply evidence is incomplete: ${first.inspectable} of ${first.total} items are inspectable`);
  }
  await verifyExhaustionStillTerminal(tab, target, plan, contract, attestation);
  const found = await matchingOwnReplies(
    tab, target, plan, replyText, ownAuthor, ownership,
  );
  if (found.end_total !== found.total || found.inspectable !== found.total) {
    fail(`reply evidence is incomplete: ${found.inspectable} of ${found.total} items are inspectable`);
  }
  await verifyExhaustionStillTerminal(tab, target, plan, contract, attestation);
  if (first.total !== found.total || first.snapshot_digest !== found.snapshot_digest) {
    fail("reply evidence changed during exhaustion stability verification");
  }
  return Object.freeze({ ...found, exhaustion_attestation: attestation });
}

/**
 * Fixture-only final-scan comment identity -> frame/node mapping.
 *
 * All DOM readers, process brands, and attestations in this module are
 * test-only. Production modules never import or re-export this boundary.
 */

import {
  digestObject,
  fail,
  immutableJsonSnapshot,
  normalizedText,
  requiredString,
  unique,
} from "./comment_chrome_common.mjs";
import {
  STABLE_NODE_FRAME_MAPPING_SCHEMA_VERSION,
  stableNodeFrameMappingContractDescriptor,
} from "./comment_chrome_node_frame_mapping.mjs";

const TRUSTED_TEST_ONLY_MAPPINGS = new WeakSet();

function knownPlatform(platform) {
  return stableNodeFrameMappingContractDescriptor(platform).platform;
}

export function testOnlyNodeFrameMappingSpec(platform) {
  const key = knownPlatform(platform);
  return immutableJsonSnapshot({
    schemaVersion: STABLE_NODE_FRAME_MAPPING_SCHEMA_VERSION,
    testOnly: true,
    environment: "fixture_testonly",
    identityKind: stableNodeFrameMappingContractDescriptor(key).identity_kind,
    frame: {
      selector: "html",
      frameIdAttribute: "data-fixture-frame-id",
      documentEpochAttribute: "data-fixture-document-epoch",
    },
    nodeIdAttribute: "data-fixture-node-id",
    replyExhaustion: {
      selector: "[data-fixture-reply-exhaustion-state]",
      cursorAttribute: "data-reply-cursor",
      discoveredCountAttribute: "data-reply-discovered-count",
      terminalAttribute: "data-reply-terminal",
    },
    stableReadDelayMs: 0,
  }, `${key} test-only node/frame mapping spec`);
}

export function requireTestOnlyNodeFrameMappingPlan(plan, platform, options = {}) {
  const key = knownPlatform(platform);
  if (options.testOnly !== true) fail("node/frame fixture mapping requires testOnly=true");
  const spec = plan?.nodeFrameMapping;
  if (!plan || plan.platform !== key || plan.adapterEnvironment !== "fixture_testonly"
      || spec?.schemaVersion !== STABLE_NODE_FRAME_MAPPING_SCHEMA_VERSION
      || spec?.testOnly !== true || spec?.environment !== "fixture_testonly"
      || spec?.identityKind !== stableNodeFrameMappingContractDescriptor(key).identity_kind) {
    fail("node/frame mapping plan is cross-platform, live, stale, or malformed");
  }
  for (const field of ["adapterId", "adapterVersion"]) {
    requiredString(plan[field], `node/frame mapping plan.${field}`);
  }
  for (const field of ["comments", "commentId", "parentPost", "authorDisplay", "body",
    "ownReplyItems"]) {
    if (!plan[field] || typeof plan[field] !== "object") {
      fail(`node/frame mapping plan.${field} is required`);
    }
  }
  if (plan.commentId.self !== true || !plan.commentId.attribute
      || plan.parentPost.self !== true || !plan.parentPost.attribute) {
    fail("node/frame identity and parent anchors must be attributes on the comment item");
  }
  if (!Object.isFrozen(plan) || !Object.isFrozen(spec)) {
    fail("node/frame mapping plan must remain deeply immutable");
  }
  if (!Number.isInteger(spec.stableReadDelayMs)
      || spec.stableReadDelayMs < 0 || spec.stableReadDelayMs > 1000) {
    fail("node/frame mapping stableReadDelayMs must be an integer from 0 to 1000");
  }
  return { key, spec };
}

export function parseTestOnlyNodeFrameCount(value, label) {
  const text = normalizedText(value);
  if (!/^(0|[1-9][0-9]*)$/u.test(text)) fail(`${label} must be a non-negative integer`);
  const count = Number(text);
  if (!Number.isSafeInteger(count)) fail(`${label} is outside safe integer bounds`);
  return count;
}

export function parseTestOnlyNodeFrameTerminal(value) {
  const text = normalizedText(value);
  if (text === "true") return true;
  if (text === "false") return false;
  fail("reply exhaustion terminal evidence must be explicit true or false");
}

export async function requiredTestOnlyNodeFrameAttribute(locator, attribute, label) {
  return requiredString(normalizedText(await locator.getAttribute(attribute)), label);
}

async function childNodeId(item, childSpec, nodeIdAttribute, label) {
  const locator = childSpec.self === true ? item : item.locator(childSpec.selector, {});
  await unique(locator, label);
  return requiredTestOnlyNodeFrameAttribute(locator, nodeIdAttribute, `${label} node id`);
}

export async function readTestOnlyNodeFrame(tab, spec) {
  const frame = tab.playwright.locator(spec.frame.selector, {});
  await unique(frame, "node/frame fixture document root");
  return {
    frame_id: await requiredTestOnlyNodeFrameAttribute(
      frame, spec.frame.frameIdAttribute, "fixture native frame id",
    ),
    document_epoch: await requiredTestOnlyNodeFrameAttribute(
      frame, spec.frame.documentEpochAttribute, "fixture document epoch",
    ),
  };
}

async function readReplyExhaustion(item, plan, spec) {
  const state = item.locator(spec.replyExhaustion.selector, {});
  await unique(state, "comment reply exhaustion state");
  const cursor = await requiredTestOnlyNodeFrameAttribute(
    state, spec.replyExhaustion.cursorAttribute, "comment reply exhaustion cursor",
  );
  const discovered = parseTestOnlyNodeFrameCount(
    await state.getAttribute(spec.replyExhaustion.discoveredCountAttribute),
    "comment reply exhaustion discovered count",
  );
  const terminal = parseTestOnlyNodeFrameTerminal(
    await state.getAttribute(spec.replyExhaustion.terminalAttribute),
  );
  const inspectable = await item.locator(plan.ownReplyItems.selector, {}).count();
  if (!terminal) fail("comment reply exhaustion must be terminal before mapping");
  if (discovered !== inspectable) {
    fail("comment reply exhaustion discovered count does not match inspectable replies");
  }
  return {
    reply_exhaustion_node_id: await requiredTestOnlyNodeFrameAttribute(
      state, spec.nodeIdAttribute, "comment reply exhaustion node id",
    ),
    reply_cursor: cursor,
    reply_discovered_count: discovered,
    reply_terminal: terminal,
    reply_inspectable_count: inspectable,
  };
}

async function readCommentRow(items, index, plan, spec) {
  const item = items.nth(index);
  if (!(await item.isVisible())) fail("node/frame mapping contains a hidden comment item");
  const anchorId = await requiredTestOnlyNodeFrameAttribute(
    item, plan.commentId.attribute, "comment identity anchor",
  );
  const row = {
    collection_index: index,
    comment_identity: { kind: spec.identityKind, anchor_id: anchorId },
    parent_anchor: await requiredTestOnlyNodeFrameAttribute(
      item, plan.parentPost.attribute, "comment parent anchor",
    ),
    comment_node_id: await requiredTestOnlyNodeFrameAttribute(
      item, spec.nodeIdAttribute, "comment node id",
    ),
    author_node_id: await childNodeId(
      item, plan.authorDisplay, spec.nodeIdAttribute, "comment author",
    ),
    body_node_id: await childNodeId(
      item, plan.body, spec.nodeIdAttribute, "comment body",
    ),
    ...await readReplyExhaustion(item, plan, spec),
  };
  return immutableJsonSnapshot(row, "comment node/frame mapping row");
}

function validateUniqueRows(rows) {
  const identities = new Set();
  const nodeOwners = new Map();
  for (const row of rows) {
    const identity = `${row.comment_identity.kind}:${row.comment_identity.anchor_id}`;
    if (identities.has(identity)) fail("duplicate comment identity is forbidden");
    identities.add(identity);
    const roleFields = ["comment_node_id", "author_node_id", "body_node_id",
      "reply_exhaustion_node_id"];
    if (new Set(roleFields.map((field) => row[field])).size !== roleFields.length) {
      fail("node id role collision within one comment identity is forbidden");
    }
    for (const field of roleFields) {
      const node = row[field];
      const owner = nodeOwners.get(node);
      if (owner && owner !== identity) fail("node id reuse across comment identities is forbidden");
      nodeOwners.set(node, identity);
    }
  }
}

async function readSnapshot(tab, plan, platform, options) {
  const { key, spec } = requireTestOnlyNodeFrameMappingPlan(plan, platform, options);
  const frame = await readTestOnlyNodeFrame(tab, spec);
  const items = tab.playwright.locator(plan.comments.selector, {});
  const count = await items.count();
  if (!Number.isInteger(count) || count < 1) {
    fail("node/frame mapping requires a non-empty stable comment collection");
  }
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(await readCommentRow(items, index, plan, spec));
  }
  if (await items.count() !== count) fail("comment collection changed during node/frame mapping");
  validateUniqueRows(rows);
  return immutableJsonSnapshot({
    schema_version: STABLE_NODE_FRAME_MAPPING_SCHEMA_VERSION,
    test_only: true,
    platform: key,
    adapter_id: plan.adapterId,
    adapter_version: plan.adapterVersion,
    ...frame,
    rows,
  }, `${key} node/frame mapping snapshot`);
}

function snapshotBinding(snapshot) {
  return {
    snapshot_digest: digestObject(snapshot, "node/frame mapping snapshot"),
    frame_id_sha256: digestObject(snapshot.frame_id, "node/frame mapping frame id"),
    document_epoch_sha256: digestObject(
      snapshot.document_epoch, "node/frame mapping document epoch",
    ),
    comment_identity_sha256: digestObject(
      snapshot.rows.map((row) => row.comment_identity), "comment identity binding",
    ),
    parent_anchor_sha256: digestObject(
      snapshot.rows.map((row) => row.parent_anchor), "comment parent binding",
    ),
    node_bindings_sha256: digestObject(snapshot.rows.map((row) => ({
      index: row.collection_index,
      comment: row.comment_node_id,
      author: row.author_node_id,
      body: row.body_node_id,
      exhaustion: row.reply_exhaustion_node_id,
    })), "comment node bindings"),
    reply_exhaustion_sha256: digestObject(snapshot.rows.map((row) => ({
      cursor: row.reply_cursor,
      discovered: row.reply_discovered_count,
      inspectable: row.reply_inspectable_count,
      terminal: row.reply_terminal,
    })), "comment reply exhaustion binding"),
  };
}

async function stableSnapshot(tab, plan, platform, options) {
  const first = await readSnapshot(tab, plan, platform, options);
  await new Promise((resolve) => setTimeout(resolve, plan.nodeFrameMapping.stableReadDelayMs));
  const second = await readSnapshot(tab, plan, platform, options);
  if (digestObject(first) !== digestObject(second)) {
    fail("node/frame mapping changed across stable reads");
  }
  return second;
}

export async function captureTestOnlyNodeFrameMapping(
  tab, plan, platform, options = {},
) {
  const snapshot = await stableSnapshot(tab, plan, platform, options);
  const core = {
    schema_version: STABLE_NODE_FRAME_MAPPING_SCHEMA_VERSION,
    test_only: true,
    platform: snapshot.platform,
    adapter_id: snapshot.adapter_id,
    adapter_version: snapshot.adapter_version,
    row_count: snapshot.rows.length,
    stable_read_count: 2,
    coverage: "test_only_final_scan_comment_nodes",
    full_lifecycle_bound: false,
    ...snapshotBinding(snapshot),
  };
  const mapping = immutableJsonSnapshot({
    ...core,
    mapping_attestation_id: digestObject(core, "test-only node/frame mapping attestation"),
  }, "test-only node/frame mapping attestation");
  TRUSTED_TEST_ONLY_MAPPINGS.add(mapping);
  return mapping;
}

export function isTrustedTestOnlyNodeFrameMapping(mapping) {
  return Boolean(mapping && typeof mapping === "object"
    && TRUSTED_TEST_ONLY_MAPPINGS.has(mapping));
}

export async function verifyTestOnlyNodeFrameMappingStillCurrent(
  tab, plan, platform, mapping, options = {},
) {
  if (!isTrustedTestOnlyNodeFrameMapping(mapping)) {
    fail("node/frame verification requires its process-branded test-only attestation");
  }
  const snapshot = await stableSnapshot(tab, plan, platform, options);
  const binding = snapshotBinding(snapshot);
  if (mapping.platform !== platform || mapping.adapter_id !== plan.adapterId
      || mapping.adapter_version !== plan.adapterVersion
      || mapping.row_count !== snapshot.rows.length
      || mapping.snapshot_digest !== binding.snapshot_digest) {
    fail("comment identity/frame/node mapping is stale, reordered, rerendered, or cross-platform");
  }
  return true;
}

export function nodeFrameMappingEvidence(mapping) {
  if (!isTrustedTestOnlyNodeFrameMapping(mapping)) {
    fail("node/frame evidence requires its process-branded test-only attestation");
  }
  return immutableJsonSnapshot({ ...mapping }, "node/frame mapping public test evidence");
}



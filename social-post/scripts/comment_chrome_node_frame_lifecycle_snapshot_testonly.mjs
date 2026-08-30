/**
 * Test-only DOM snapshot reader for the six-stage comment-reply lifecycle.
 *
 * This fixture-only module imports the production final-scan mapping helpers.
 * Production modules never import this module and no result is receipt-eligible.
 */

import {
  digestObject,
  fail,
  immutableJsonSnapshot,
  normalizedText,
  readComposer,
  requiredString,
  sha256Text,
  unique,
} from "./comment_chrome_common.mjs";
import {
  parseTestOnlyNodeFrameCount,
  parseTestOnlyNodeFrameTerminal,
  readTestOnlyNodeFrame,
  requiredTestOnlyNodeFrameAttribute,
  requireTestOnlyNodeFrameMappingPlan,
} from "./comment_chrome_node_frame_mapping_testonly.mjs";

export const TEST_ONLY_NODE_FRAME_LIFECYCLE_SCHEMA_VERSION = 1;
export const TEST_ONLY_NODE_FRAME_LIFECYCLE_STAGES = Object.freeze([
  "expand",
  "reply_trigger",
  "composer_fill",
  "submit_preflight",
  "finish",
  "recovery_reinspection",
]);

function exactLifecycleStageOrder(value) {
  if (!Array.isArray(value)
      || value.length !== TEST_ONLY_NODE_FRAME_LIFECYCLE_STAGES.length
      || value.some((stage, index) => stage !== TEST_ONLY_NODE_FRAME_LIFECYCLE_STAGES[index])) {
    fail("node/frame lifecycle stage plan is stale, reordered, or incomplete");
  }
}

function requireDeeplyFrozenLifecyclePlan(value, label, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  if (!Object.isFrozen(value)) {
    fail(`${label} must remain deeply immutable`);
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    requireDeeplyFrozenLifecyclePlan(child, label, seen);
  }
}

function requireLifecycleSelector(spec, label, within) {
  if (!spec || typeof spec !== "object") fail(`${label} is required`);
  requiredString(spec.selector, `${label}.selector`);
  if (spec.within !== within) fail(`${label} must be scoped to ${within}`);
}

export function requireTestOnlyNodeFrameLifecyclePlan(plan, platform, options = {}) {
  const base = requireTestOnlyNodeFrameMappingPlan(plan, platform, options);
  const lifecycle = base.spec.lifecycle;
  if (!lifecycle || typeof lifecycle !== "object"
      || lifecycle.schemaVersion !== TEST_ONLY_NODE_FRAME_LIFECYCLE_SCHEMA_VERSION
      || lifecycle.testOnly !== true
      || lifecycle.environment !== "fixture_testonly") {
    fail("node/frame lifecycle plan is live, stale, or malformed");
  }
  requireDeeplyFrozenLifecyclePlan(lifecycle, "node/frame lifecycle stage plan");
  exactLifecycleStageOrder(lifecycle.stageOrder);
  requiredString(lifecycle.ownerAttribute, "node/frame lifecycle ownerAttribute");
  for (const name of ["replyTrigger", "composer", "submit", "replyItems"]) {
    requireLifecycleSelector(lifecycle[name], `node/frame lifecycle.${name}`, "target");
  }
  for (const name of ["replyAuthor", "replyBody"]) {
    requireLifecycleSelector(lifecycle[name], `node/frame lifecycle.${name}`, "reply");
  }
  const expansion = plan.expansion;
  if (!expansion || typeof expansion !== "object") {
    fail("node/frame lifecycle requires an immutable fixture expansion plan");
  }
  requireDeeplyFrozenLifecyclePlan(expansion, "node/frame lifecycle expansion plan");
  for (const name of ["commentControls", "replyControls", "state", "viewportTraversalControl"]) {
    if (!expansion[name] || typeof expansion[name] !== "object") {
      fail(`node/frame lifecycle expansion.${name} is required`);
    }
    requiredString(expansion[name].selector, `node/frame lifecycle expansion.${name}.selector`);
  }
  for (const name of ["cursorAttribute", "discoveredCountAttribute", "terminalAttribute"]) {
    requiredString(expansion.state[name], `node/frame lifecycle expansion.state.${name}`);
  }
  if (typeof expansion.maxControlsPerRead !== "number"
      || !Number.isInteger(expansion.maxControlsPerRead)
      || expansion.maxControlsPerRead < 1) {
    fail("node/frame lifecycle expansion.maxControlsPerRead must be an exact positive integer");
  }
  return { ...base, lifecycle, expansion };
}

async function lifecycleOwnedNodeId(target, spec, mappingSpec, ownerAttribute, expected, label) {
  const locator = target.locator(spec.selector, {});
  await unique(locator, label);
  const owner = requiredString(
    normalizedText(await locator.getAttribute(ownerAttribute)), `${label} owner anchor`,
  );
  if (owner !== expected) fail(`${label} owner anchor drifted from the approved comment`);
  return requiredTestOnlyNodeFrameAttribute(locator, mappingSpec.nodeIdAttribute, `${label} node id`);
}

async function readLifecycleTarget(tab, plan, mappingSpec, lifecycle, binding) {
  const items = tab.playwright.locator(plan.comments.selector, {});
  const count = await items.count();
  if (!Number.isInteger(count) || count < 1) {
    fail("node/frame lifecycle requires a non-empty comment collection");
  }
  const matches = [];
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    if (!(await item.isVisible())) fail("node/frame lifecycle contains a hidden comment");
    const anchor = await requiredTestOnlyNodeFrameAttribute(
      item, plan.commentId.attribute, "node/frame lifecycle comment anchor",
    );
    if (anchor === binding.target_anchor) matches.push(item);
  }
  if (await items.count() !== count) {
    fail("node/frame lifecycle comment collection changed during target binding");
  }
  if (matches.length !== 1) {
    fail(`node/frame lifecycle target identity requires exactly one comment, found ${matches.length}`);
  }
  const target = matches[0];
  const parent = await requiredTestOnlyNodeFrameAttribute(
    target, plan.parentPost.attribute, "node/frame lifecycle parent anchor",
  );
  if (parent !== binding.parent_anchor) {
    fail("node/frame lifecycle parent anchor drifted from the approved post");
  }
  const commonRoles = {
    target_comment: await requiredTestOnlyNodeFrameAttribute(
      target, mappingSpec.nodeIdAttribute, "node/frame lifecycle target node id",
    ),
    comment_author: await lifecycleOwnedNodeId(
      target, plan.authorDisplay, mappingSpec, lifecycle.ownerAttribute,
      binding.target_anchor, "node/frame lifecycle comment author",
    ),
    comment_body: await lifecycleOwnedNodeId(
      target, plan.body, mappingSpec, lifecycle.ownerAttribute,
      binding.target_anchor, "node/frame lifecycle comment body",
    ),
  };
  return { target, commentCount: count, parent, commonRoles };
}

async function lifecycleNodeIds(locator, mappingSpec, label, maximum) {
  const count = await locator.count();
  if (!Number.isInteger(count) || count < 0 || count > maximum) {
    fail(`${label} count is outside its registered bound`);
  }
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    await unique(item, `${label} ${index + 1}`, { enabled: true });
    ids.push(await requiredTestOnlyNodeFrameAttribute(
      item, mappingSpec.nodeIdAttribute, `${label} ${index + 1} node id`,
    ));
  }
  if (await locator.count() !== count) fail(`${label} count drifted during mapping`);
  return ids;
}

async function readLifecycleExpansion(tab, plan, mappingSpec, stage, commentCount) {
  const expansion = plan.expansion;
  const stateLocator = tab.playwright.locator(expansion.state.selector, {});
  await unique(stateLocator, "node/frame lifecycle expansion state");
  const cursor = await requiredTestOnlyNodeFrameAttribute(
    stateLocator, expansion.state.cursorAttribute, "node/frame lifecycle expansion cursor",
  );
  const discovered = parseTestOnlyNodeFrameCount(
    await stateLocator.getAttribute(expansion.state.discoveredCountAttribute),
    "node/frame lifecycle expansion discovered count",
  );
  const terminal = parseTestOnlyNodeFrameTerminal(
    await stateLocator.getAttribute(expansion.state.terminalAttribute),
  );
  const commentControls = await lifecycleNodeIds(
    tab.playwright.locator(expansion.commentControls.selector, {}), mappingSpec,
    "node/frame lifecycle comment expansion controls", expansion.maxControlsPerRead,
  );
  const replyControls = await lifecycleNodeIds(
    tab.playwright.locator(expansion.replyControls.selector, {}), mappingSpec,
    "node/frame lifecycle reply expansion controls", expansion.maxControlsPerRead,
  );
  const traversal = await lifecycleNodeIds(
    tab.playwright.locator(expansion.viewportTraversalControl.selector, {}), mappingSpec,
    "node/frame lifecycle viewport traversal controls", 1,
  );
  const controlCount = commentControls.length + replyControls.length + traversal.length;
  if (stage === "expand") {
    if (terminal || controlCount < 1 || discovered > commentCount) {
      fail("expand stage requires non-terminal bounded controls before fixture expansion");
    }
  } else if (!terminal || controlCount !== 0 || discovered !== commentCount) {
    fail("post-expand lifecycle stages require terminal complete comment coverage");
  }
  return {
    cursor,
    discovered_count: discovered,
    terminal,
    comment_collection_count: commentCount,
    control_count: controlCount,
    roles: {
      expansion_state: await requiredTestOnlyNodeFrameAttribute(
        stateLocator, mappingSpec.nodeIdAttribute,
        "node/frame lifecycle expansion state node id",
      ),
      comment_expansion_controls: commentControls,
      reply_expansion_controls: replyControls,
      viewport_traversal_controls: traversal,
    },
  };
}

async function readLifecycleReplySet(target, plan, mappingSpec, lifecycle, binding) {
  const state = target.locator(mappingSpec.replyExhaustion.selector, {});
  await unique(state, "node/frame lifecycle reply exhaustion state");
  const stateOwner = await requiredTestOnlyNodeFrameAttribute(
    state, lifecycle.ownerAttribute, "node/frame lifecycle reply exhaustion owner",
  );
  if (stateOwner !== binding.target_anchor) {
    fail("node/frame lifecycle reply exhaustion owner drifted");
  }
  const terminal = parseTestOnlyNodeFrameTerminal(
    await state.getAttribute(mappingSpec.replyExhaustion.terminalAttribute),
  );
  const cursor = await requiredTestOnlyNodeFrameAttribute(
    state, mappingSpec.replyExhaustion.cursorAttribute,
    "node/frame lifecycle reply exhaustion cursor",
  );
  const discovered = parseTestOnlyNodeFrameCount(
    await state.getAttribute(mappingSpec.replyExhaustion.discoveredCountAttribute),
    "node/frame lifecycle reply exhaustion discovered count",
  );
  const replies = target.locator(lifecycle.replyItems.selector, {});
  const total = await replies.count();
  const rows = [];
  let exactReplyCount = 0;
  let ownAuthorCount = 0;
  for (let index = 0; index < total; index += 1) {
    const item = replies.nth(index);
    await unique(item, `node/frame lifecycle reply ${index + 1}`);
    const owner = await requiredTestOnlyNodeFrameAttribute(
      item, lifecycle.ownerAttribute, `node/frame lifecycle reply ${index + 1} owner`,
    );
    if (owner !== binding.target_anchor) {
      fail("node/frame lifecycle reply parent/comment ownership drifted");
    }
    const author = item.locator(lifecycle.replyAuthor.selector, {});
    const body = item.locator(lifecycle.replyBody.selector, {});
    await unique(author, `node/frame lifecycle reply ${index + 1} author`);
    await unique(body, `node/frame lifecycle reply ${index + 1} body`);
    for (const [locator, label] of [
      [author, `node/frame lifecycle reply ${index + 1} author`],
      [body, `node/frame lifecycle reply ${index + 1} body`],
    ]) {
      const childOwner = await requiredTestOnlyNodeFrameAttribute(
        locator, lifecycle.ownerAttribute, `${label} owner`,
      );
      if (childOwner !== binding.target_anchor) fail(`${label} owner drifted`);
    }
    const authorText = normalizedText(await author.textContent());
    const bodyText = normalizedText(await body.textContent());
    if (authorText === binding.own_author) ownAuthorCount += 1;
    if (authorText === binding.own_author && bodyText === binding.reply_text) {
      exactReplyCount += 1;
    }
    rows.push({
      reply_item: await requiredTestOnlyNodeFrameAttribute(
        item, mappingSpec.nodeIdAttribute, `node/frame lifecycle reply ${index + 1} node id`,
      ),
      reply_author: await requiredTestOnlyNodeFrameAttribute(
        author, mappingSpec.nodeIdAttribute,
        `node/frame lifecycle reply ${index + 1} author node id`,
      ),
      reply_body: await requiredTestOnlyNodeFrameAttribute(
        body, mappingSpec.nodeIdAttribute,
        `node/frame lifecycle reply ${index + 1} body node id`,
      ),
      author_sha256: sha256Text(authorText),
      body_sha256: sha256Text(bodyText),
      exact_own_reply: authorText === binding.own_author && bodyText === binding.reply_text,
    });
  }
  if (await replies.count() !== total) {
    fail("node/frame lifecycle reply collection changed during mapping");
  }
  if (!terminal || discovered !== total) {
    fail("node/frame lifecycle reply cardinality lacks terminal complete coverage");
  }
  return {
    terminal,
    cursor,
    discovered_count: discovered,
    total_reply_count: total,
    exact_own_reply_count: exactReplyCount,
    own_author_reply_count: ownAuthorCount,
    roles: {
      reply_exhaustion_state: await requiredTestOnlyNodeFrameAttribute(
        state, mappingSpec.nodeIdAttribute,
        "node/frame lifecycle reply exhaustion state node id",
      ),
      replies: rows,
    },
  };
}

function flattenRoleNodeIds(roles) {
  const output = [];
  function visit(value) {
    if (typeof value === "string") output.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  }
  visit(roles);
  return output;
}

function assertUniqueLifecycleRoleNodes(roles) {
  const ids = flattenRoleNodeIds(roles);
  if (new Set(ids).size !== ids.length) {
    fail("node/frame lifecycle stage node roles must be pairwise unique");
  }
  return ids.length;
}

function assertLifecycleCardinality(stage, replySet, binding) {
  const beforeSubmit = !["finish", "recovery_reinspection"].includes(stage);
  if (beforeSubmit) {
    if (replySet.total_reply_count !== binding.baseline_reply_count
        || replySet.exact_own_reply_count !== 0) {
      fail(`${stage} stage reply cardinality differs from the zero-exact baseline`);
    }
    return;
  }
  if (replySet.total_reply_count !== binding.baseline_reply_count + 1
      || replySet.exact_own_reply_count !== 1
      || replySet.own_author_reply_count < 1) {
    fail(`${stage} stage requires exactly one new exact own reply under terminal coverage`);
  }
}

async function readLifecycleStageSnapshot(tab, plan, platform, stage, state, options) {
  const { spec: mappingSpec, lifecycle } = requireTestOnlyNodeFrameLifecyclePlan(plan, platform, options);
  const frame = await readTestOnlyNodeFrame(tab, mappingSpec);
  const target = await readLifecycleTarget(
    tab, plan, mappingSpec, lifecycle, state.binding,
  );
  const expansion = await readLifecycleExpansion(
    tab, plan, mappingSpec, stage, target.commentCount,
  );
  const replies = await readLifecycleReplySet(
    target.target, plan, mappingSpec, lifecycle, state.binding,
  );
  assertLifecycleCardinality(stage, replies, state.binding);
  const stageRoles = {};
  if (stage === "reply_trigger") {
    stageRoles.reply_trigger = await lifecycleOwnedNodeId(
      target.target, lifecycle.replyTrigger, mappingSpec, lifecycle.ownerAttribute,
      state.binding.target_anchor, "node/frame lifecycle reply trigger",
    );
  }
  if (stage === "composer_fill" || stage === "submit_preflight") {
    stageRoles.composer = await lifecycleOwnedNodeId(
      target.target, lifecycle.composer, mappingSpec, lifecycle.ownerAttribute,
      state.binding.target_anchor, "node/frame lifecycle composer",
    );
    stageRoles.submit = await lifecycleOwnedNodeId(
      target.target, lifecycle.submit, mappingSpec, lifecycle.ownerAttribute,
      state.binding.target_anchor, "node/frame lifecycle submit",
    );
    const composer = target.target.locator(lifecycle.composer.selector, {});
    if ((await readComposer(composer)) !== state.binding.reply_text) {
      fail(`${stage} stage composer does not exactly match the approved reply`);
    }
  }
  const roles = {
    ...target.commonRoles,
    expansion_state: expansion.roles.expansion_state,
    reply_exhaustion_state: replies.roles.reply_exhaustion_state,
    ...(stage === "expand" ? {
      comment_expansion_controls: expansion.roles.comment_expansion_controls,
      reply_expansion_controls: expansion.roles.reply_expansion_controls,
      viewport_traversal_controls: expansion.roles.viewport_traversal_controls,
    } : {}),
    ...stageRoles,
    ...(["finish", "recovery_reinspection"].includes(stage)
      ? { replies: replies.roles.replies.map((row) => ({
        reply_item: row.reply_item,
        reply_author: row.reply_author,
        reply_body: row.reply_body,
      })) }
      : {}),
  };
  const roleCount = assertUniqueLifecycleRoleNodes(roles);
  return immutableJsonSnapshot({
    schema_version: TEST_ONLY_NODE_FRAME_LIFECYCLE_SCHEMA_VERSION,
    test_only: true,
    platform,
    stage,
    frame_id: frame.frame_id,
    document_epoch: frame.document_epoch,
    comment_identity: {
      kind: mappingSpec.identityKind,
      anchor_id: state.binding.target_anchor,
    },
    parent_anchor: target.parent,
    roles,
    role_count: roleCount,
    expansion: {
      cursor: expansion.cursor,
      discovered_count: expansion.discovered_count,
      terminal: expansion.terminal,
      comment_collection_count: expansion.comment_collection_count,
      control_count: expansion.control_count,
    },
    reply_cardinality: {
      cursor: replies.cursor,
      discovered_count: replies.discovered_count,
      terminal: replies.terminal,
      total_reply_count: replies.total_reply_count,
      exact_own_reply_count: replies.exact_own_reply_count,
      own_author_reply_count: replies.own_author_reply_count,
    },
    reply_rows_sha256: digestObject(replies.roles.replies, "lifecycle reply rows"),
  }, `${stage} node/frame lifecycle snapshot`);
}

export function testOnlyNodeFrameLifecycleCommonBinding(snapshot) {
  return digestObject({
    platform: snapshot.platform,
    frame_id: snapshot.frame_id,
    document_epoch: snapshot.document_epoch,
    comment_identity: snapshot.comment_identity,
    parent_anchor: snapshot.parent_anchor,
    target_comment: snapshot.roles.target_comment,
    comment_author: snapshot.roles.comment_author,
    comment_body: snapshot.roles.comment_body,
    expansion_state: snapshot.roles.expansion_state,
    reply_exhaustion_state: snapshot.roles.reply_exhaustion_state,
  }, "node/frame lifecycle common binding");
}

export function assertTestOnlyNodeFrameLifecycleStageContinuity(stage, snapshot, state) {
  const common = testOnlyNodeFrameLifecycleCommonBinding(snapshot);
  if (state.base_binding_digest === null) state.base_binding_digest = common;
  else if (common !== state.base_binding_digest) {
    fail("node/frame lifecycle frame, document, comment, parent, or common node binding drifted");
  }
  if (stage === "submit_preflight") {
    const filled = state.stage_snapshots.get("composer_fill");
    if (!filled || filled.roles.composer !== snapshot.roles.composer
        || filled.roles.submit !== snapshot.roles.submit) {
      fail("submit preflight composer/submit nodes differ from composer-fill binding");
    }
  }
  if (stage === "recovery_reinspection") {
    const finished = state.stage_snapshots.get("finish");
    if (!finished || finished.reply_rows_sha256 !== snapshot.reply_rows_sha256
        || digestObject(finished.roles.replies, "finish reply roles")
          !== digestObject(snapshot.roles.replies, "reinspection reply roles")) {
      fail("recovery reinspection reply nodes or cardinality differ from finish binding");
    }
  }
}

export async function stableTestOnlyNodeFrameLifecycleStageSnapshot(tab, plan, platform, stage, state, options) {
  const first = await readLifecycleStageSnapshot(tab, plan, platform, stage, state, options);
  await new Promise((resolve) => setTimeout(
    resolve, plan.nodeFrameMapping.stableReadDelayMs,
  ));
  const second = await readLifecycleStageSnapshot(tab, plan, platform, stage, state, options);
  if (digestObject(first) !== digestObject(second)) {
    fail(`${stage} node/frame lifecycle mapping changed across stable reads`);
  }
  return second;
}

import {
  SUPPORTED_PLATFORMS,
  assertSingleLine,
  digestObject,
  fail,
  immutableJsonSnapshot,
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

const DOM_CUA_ATTRIBUTES = Object.freeze([
  "aria-disabled", "aria-label", "contenteditable", "href", "name",
  "placeholder", "role", "title", "type", "value",
]);
const DOM_CUA_BOOLEAN_ATTRIBUTES = Object.freeze([
  "checked", "disabled", "multiple", "readonly", "required", "selected",
]);

function stableVisibleText(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim().slice(0, 160);
}

function decodeDomCuaText(value) {
  return String(value ?? "")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

function parseDomCuaAttributes(raw) {
  const attributes = {};
  const booleans = [];
  const pattern = /([^\s=]+)(?:="([^"]*)")?/gu;
  for (const match of String(raw ?? "").matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (name === "node_id") continue;
    if (DOM_CUA_BOOLEAN_ATTRIBUTES.includes(name)
        && (match[2] === undefined || match[2] === "true")) {
      booleans.push(name);
    } else if (DOM_CUA_ATTRIBUTES.includes(name) && match[2] !== undefined) {
      attributes[name] = decodeDomCuaText(match[2]).normalize("NFC");
    }
  }
  return {
    attributes: Object.fromEntries(Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b))),
    booleans: [...new Set(booleans)].sort(),
  };
}

function parseDomCuaLine(rawLine) {
  const line = String(rawLine ?? "").trim();
  const opening = line.match(/^<([a-z][\w:-]*)\b([^>]*)>([\s\S]*)$/iu);
  if (!opening) return null;
  const tag = opening[1].toLowerCase();
  const nodeMatch = opening[2].match(/(?:^|\s)node_id=(?:"([^"]+)"|([^\s>]+))(?:\s|$)/u);
  if (!nodeMatch) return null;
  let body = opening[3];
  const closing = `</${tag}>`;
  if (body.toLowerCase().endsWith(closing)) body = body.slice(0, -closing.length);
  else if (body && body !== "/") return null;
  const parsed = parseDomCuaAttributes(opening[2]);
  return immutableJsonSnapshot({
    node_id: String(nodeMatch[1] ?? nodeMatch[2]).trim(),
    tag,
    attributes: parsed.attributes,
    booleans: parsed.booleans,
    text: stableVisibleText(decodeDomCuaText(body === "/" ? "" : body)),
  }, "DOM-CUA node");
}

function captureDomCuaSnapshot(raw) {
  if (typeof raw !== "string") fail("stable-node visible DOM snapshot must be a string");
  const nodes = raw.split(/\r?\n/u).map(parseDomCuaLine).filter(Boolean);
  const ids = new Set();
  for (const node of nodes) {
    if (typeof node.node_id !== "string" || !node.node_id) {
      fail("stable-node visible DOM snapshot contains an invalid node_id");
    }
    if (ids.has(node.node_id)) fail("stable-node visible DOM snapshot contains duplicate node_id values");
    ids.add(node.node_id);
  }
  return immutableJsonSnapshot({ nodes }, "stable-node visible DOM snapshot");
}

function nodeIdentity(node) {
  return {
    tag: node.tag,
    attributes: node.attributes,
    booleans: node.booleans,
    text: node.text,
  };
}

function rehydrateStableSubmitIdentity(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("stable submit identity must be an object");
  }
  const expectedKeys = ["attributes", "booleans", "tag", "text"];
  const keys = Object.keys(raw).sort();
  if (keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])) {
    fail("stable submit identity has an unexpected shape");
  }
  if (!raw.attributes || typeof raw.attributes !== "object"
      || Array.isArray(raw.attributes)) {
    fail("stable submit identity attributes must be an object");
  }
  const attributes = {};
  for (const [name, value] of Object.entries(raw.attributes)) {
    if (!DOM_CUA_ATTRIBUTES.includes(name) || typeof value !== "string" || value === "") {
      fail("stable submit identity contains an invalid attribute");
    }
    attributes[name] = value.normalize("NFC");
  }
  if (!Array.isArray(raw.booleans)
      || raw.booleans.some((name) => (
        typeof name !== "string" || !DOM_CUA_BOOLEAN_ATTRIBUTES.includes(name)
      ))
      || new Set(raw.booleans).size !== raw.booleans.length) {
    fail("stable submit identity contains invalid boolean attributes");
  }
  if (typeof raw.tag !== "string" || typeof raw.text !== "string") {
    fail("stable submit identity tag and text must be strings");
  }
  // Browser-controlled locator evaluation can return plain data whose object
  // prototype belongs to a different JavaScript realm.  Rebuild only this
  // reviewed schema into local plain objects instead of weakening the global
  // JSON/prototype guard used for actions, plans and receipts.
  return immutableJsonSnapshot({
    tag: raw.tag.normalize("NFC").toLowerCase(),
    attributes: Object.fromEntries(
      Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right)),
    ),
    booleans: [...raw.booleans].sort(),
    text: stableVisibleText(raw.text),
  }, "stable submit identity");
}

function bindExactVisibleNode(snapshot, identity) {
  const expected = digestObject(identity, "stable submit identity");
  const matches = snapshot.nodes.filter(
    (node) => digestObject(nodeIdentity(node), "visible DOM node identity") === expected,
  );
  if (matches.length !== 1) {
    fail(`stable submit identity requires exactly one visible DOM node, found ${matches.length}`);
  }
  return matches[0].node_id;
}

async function readStableSubmitIdentity(locator) {
  const raw = await locator.evaluate((element, input) => {
    const attributes = {};
    for (const name of input.attributes) {
      const value = element.getAttribute(name);
      if (element.hasAttribute(name) && value !== null && value !== "") attributes[name] = value;
    }
    const booleans = input.booleans.filter((name) => element.hasAttribute(name));
    const tag = String(element.tagName ?? "").toLowerCase();
    const visibleText = tag === "textarea" ? element.value : (element.innerText ?? element.textContent ?? "");
    if (tag === "textarea" && typeof visibleText !== "string") {
      throw new Error("textarea current value is unavailable for stable-node binding");
    }
    const text = String(visibleText)
      .normalize("NFC").replace(/\s+/gu, " ").trim().slice(0, 160);
    return {
      tag,
      attributes,
      booleans,
      text,
    };
  }, { attributes: DOM_CUA_ATTRIBUTES, booleans: DOM_CUA_BOOLEAN_ATTRIBUTES });
  const identity = rehydrateStableSubmitIdentity(raw);
  if (!identity.tag || !/^[a-z][\w:-]*$/u.test(identity.tag)) {
    fail("stable submit identity has no valid DOM tag");
  }
  return identity;
}

function requireDomCuaSurface(tab) {
  if (!tab?.dom_cua
      || typeof tab.dom_cua.get_visible_dom !== "function"
      || typeof tab.dom_cua.click !== "function") {
    fail("submit requires the Browser DOM-CUA stable-node surface");
  }
  return tab.dom_cua;
}

export function assertStableNodeSurface(tab, preparation) {
  const surface = requireDomCuaSurface(tab);
  if (preparation.test_only === false) {
    fail("live submit is unavailable until a trusted Chrome host resolver exists");
  }
  return surface;
}

/** Read-only binding of an already verified, source-owned live submit locator. */
export async function bindObservedSubmitNode(tab, locator) {
  const surface = requireDomCuaSurface(tab);
  const first = captureDomCuaSnapshot(await surface.get_visible_dom());
  const identity = await readStableSubmitIdentity(locator);
  const nodeId = bindExactVisibleNode(first, identity);
  const second = captureDomCuaSnapshot(await surface.get_visible_dom());
  if (bindExactVisibleNode(second, identity) !== nodeId) {
    fail("live submit node changed during read-only binding");
  }
  return nodeId;
}

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

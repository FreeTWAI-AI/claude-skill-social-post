/** Fixed-path atomic persistence for localhost-only fixture evidence. */

import { digestObject } from "./comment_chrome_common.mjs";

const MAX_RECEIPT_BYTES = 262144;
const HEX_256 = /^[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PLATFORM_ORDER = Object.freeze(["facebook", "instagram", "threads"]);
const DOES_NOT_PROVE = Object.freeze([
  "authenticated Meta host authority",
  "live Meta draft or send",
  "stable tab/frame/document mapping",
  "automatic reply eligibility",
]);
const ARCHITECTURE_EVALUATOR_PATHS = Object.freeze([
  "scripts/comment_js_architecture_contract.mjs",
  "scripts/comment_js_architecture_core.mjs",
  "scripts/comment_js_architecture_gate.mjs",
  "scripts/comment_js_architecture_loaders.mjs",
  "scripts/comment_js_architecture_receipt.mjs",
  "scripts/comment_js_architecture_selftest.mjs",
]);
const SOURCE_PATHS = Object.freeze([
  "scripts/comment_fixture_browser_e2e.mjs",
  "scripts/comment_chrome_common.mjs",
  "scripts/comment_chrome_node_frame_mapping.mjs",
  "scripts/comment_chrome_fixture_evidence_testonly.mjs",
  "scripts/comment_chrome_fixture_receipt_testonly.mjs",
  "scripts/comment_chrome_reply_exhaustion.mjs",
  "scripts/comment_chrome_scan.mjs",
  "scripts/comment_chrome_scan_adapters.mjs",
  "scripts/comment_chrome_scan_fixture_testonly.mjs",
  "scripts/comment_chrome_send.mjs",
  "scripts/comment_chrome_send_support.mjs",
  ...ARCHITECTURE_EVALUATOR_PATHS,
  "scripts/comment_adapter_fixtures/facebook.html",
  "scripts/comment_adapter_fixtures/instagram.html",
  "scripts/comment_adapter_fixtures/threads.html",
  "scripts/comment_adapter_fixtures/fixture-runtime.js",
]);
const SERVED_ROUTES = Object.freeze([
  Object.freeze(["/facebook.html", "scripts/comment_adapter_fixtures/facebook.html"]),
  Object.freeze(["/instagram.html", "scripts/comment_adapter_fixtures/instagram.html"]),
  Object.freeze(["/threads.html", "scripts/comment_adapter_fixtures/threads.html"]),
  Object.freeze(["/fixture-runtime.js", "scripts/comment_adapter_fixtures/fixture-runtime.js"]),
]);
const RESULT_PARENT_IDS = Object.freeze({
  facebook: "fb-comment-001",
  instagram: "ig-comment-001",
  threads: "threads-reply-001",
});
const TOP_LEVEL_KEYS = Object.freeze([
  "schema_version", "gate", "status", "hash_algorithm", "run_id", "evidence_scope",
  "capability_promotion_eligible", "live_browser_actuation_enabled", "claim_authority",
  "trusted_host_verified", "stable_node_frame_mapping_verified", "does_not_prove",
  "platform_order", "observed_at", "browser_surface", "owned_ephemeral_loopback_server",
  "architecture_gate",
  "served_sources", "request_log", "active_state_unchanged",
  "policy_sha256", "active_state_snapshot_sha256",
  "source_snapshot_sha256", "sources", "results",
]);
const RESULT_KEYS = Object.freeze([
  "platform", "page_url", "scanned_comment_count", "action_id", "parent_comment_id",
  "submit_attempts", "accepted_count", "reply_trigger_attempts", "decoy_reply_count",
  "exact_reply_visible", "own_author_verified", "parent_verified", "test_only",
  "phase_sha256",
]);
const PRIVATE_PATH = /(?:^|\/)(?:users?|home|\.codex|\.claude|secrets?|credentials?|tokens?|passwords?|api[_-]?keys?)(?:\/|$)/iu;

function fail(label) {
  throw new Error(`invalid three-platform fixture receipt: ${label}`);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} schema must contain the exact required keys`);
  }
}

function requireExactArray(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length
      || value.some((item, index) => item !== expected[index])) {
    fail(`${label} must match the exact required order`);
  }
}

function requireHex256(value, label) {
  if (typeof value !== "string" || !HEX_256.test(value)) fail(`${label} must be a 64-hex sha256`);
}

function requireInteger(value, expected, label) {
  if (!Number.isInteger(value) || value !== expected) fail(`${label} must equal ${expected}`);
}

function requireSafeRelativePath(value, label) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")
      || value.includes(":") || value.split("/").some((part) => !part || part === "." || part === "..")
      || !/^[A-Za-z0-9._/-]+$/u.test(value) || PRIVATE_PATH.test(value)) {
    fail(`${label} must be a non-sensitive repo-relative POSIX path`);
  }
}

function requireSafeRoute(value, label) {
  if (typeof value !== "string" || !/^\/[A-Za-z0-9._/-]+$/u.test(value)
      || value.includes("//") || value.split("/").some((part) => part === "." || part === "..")) {
    fail(`${label} must be a safe absolute route path`);
  }
}

function validateSources(receipt) {
  if (!Array.isArray(receipt.sources) || receipt.sources.length !== SOURCE_PATHS.length) {
    fail("sources must contain the exact source evidence set");
  }
  receipt.sources.forEach((source, index) => {
    requireExactKeys(source, ["path", "exists", "size", "sha256"], `sources[${index}]`);
    requireSafeRelativePath(source.path, `sources[${index}].path`);
    if (source.path !== SOURCE_PATHS[index]) fail("sources must use the exact reviewed path order");
    if (source.exists !== true) fail(`sources[${index}].exists must be true`);
    if (!Number.isSafeInteger(source.size) || source.size <= 0) fail(`sources[${index}].size must be positive`);
    requireHex256(source.sha256, `sources[${index}].sha256`);
  });
  requireHex256(receipt.source_snapshot_sha256, "source_snapshot_sha256");
  if (receipt.source_snapshot_sha256 !== digestObject(receipt.sources, "fixture receipt sources")) {
    fail("source_snapshot_sha256 must bind the exact sources array");
  }
}

function validateServedSources(receipt) {
  if (!Array.isArray(receipt.served_sources) || receipt.served_sources.length !== SERVED_ROUTES.length) {
    fail("served_sources must contain the exact reviewed route set");
  }
  const sources = new Map(receipt.sources.map((source) => [source.path, source]));
  receipt.served_sources.forEach((served, index) => {
    requireExactKeys(served, ["route", "path", "size", "sha256"], `served_sources[${index}]`);
    const [expectedRoute, expectedPath] = SERVED_ROUTES[index];
    requireSafeRoute(served.route, `served_sources[${index}].route`);
    requireSafeRelativePath(served.path, `served_sources[${index}].path`);
    if (served.route !== expectedRoute || served.path !== expectedPath) {
      fail("served_sources must use the exact reviewed route and path order");
    }
    const source = sources.get(served.path);
    if (!source || served.size !== source.size || served.sha256 !== source.sha256) {
      fail(`served_sources[${index}] must match its source snapshot`);
    }
  });
}

function validateRequestLog(receipt) {
  if (!Array.isArray(receipt.request_log) || receipt.request_log.length < SERVED_ROUTES.length) {
    fail("request_log must cover every served route");
  }
  const reviewed = new Set(SERVED_ROUTES.map(([route]) => route));
  const successful = new Set();
  const platformLoads = [];
  const platformRoutes = new Set(PLATFORM_ORDER.map((platform) => `/${platform}.html`));
  receipt.request_log.forEach((request, index) => {
    requireExactKeys(request, ["method", "path", "status"], `request_log[${index}]`);
    if (request.method !== "GET") fail(`request_log[${index}].method must be GET`);
    requireSafeRoute(request.path, `request_log[${index}].path`);
    if (!Number.isInteger(request.status) || ![200, 404].includes(request.status)) {
      fail(`request_log[${index}].status must be 200 or a bounded 404`);
    }
    if (request.status === 200) {
      if (!reviewed.has(request.path)) fail("request_log contains an unreviewed successful route");
      successful.add(request.path);
      if (platformRoutes.has(request.path)) platformLoads.push(request.path);
    } else if (reviewed.has(request.path)) {
      fail("request_log failed a reviewed served route");
    }
  });
  for (const route of reviewed) {
    if (!successful.has(route)) fail(`request_log did not load reviewed route ${route}`);
  }
  requireExactArray(platformLoads, PLATFORM_ORDER.map((platform) => `/${platform}.html`), "request_log platform loads");
}

function validateResults(receipt) {
  if (!Array.isArray(receipt.results) || receipt.results.length !== PLATFORM_ORDER.length) {
    fail("results must contain exactly three platform rows");
  }
  let expectedOrigin = null;
  receipt.results.forEach((result, index) => {
    const platform = PLATFORM_ORDER[index];
    requireExactKeys(result, RESULT_KEYS, `results[${index}]`);
    if (result.platform !== platform) fail("results must use the exact platform order");
    let url;
    try {
      url = new URL(result.page_url);
    } catch {
      fail(`results[${index}].page_url must be a valid URL`);
    }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
        || url.username || url.password || url.search || url.hash
        || url.pathname !== `/${platform}.html`) {
      fail(`results[${index}].page_url must bind the owned loopback fixture route`);
    }
    expectedOrigin ??= url.origin;
    if (url.origin !== expectedOrigin) fail("all result URLs must use one owned loopback origin");
    requireInteger(result.scanned_comment_count, 2, `results[${index}].scanned_comment_count`);
    if (result.action_id !== `fixture-action-${receipt.run_id}-${platform}`) {
      fail(`results[${index}].action_id must bind the shared fixture run and platform`);
    }
    if (result.parent_comment_id !== RESULT_PARENT_IDS[platform]) {
      fail(`results[${index}].parent_comment_id must identify the reviewed target`);
    }
    requireInteger(result.submit_attempts, 1, `results[${index}].submit_attempts`);
    requireInteger(result.accepted_count, 1, `results[${index}].accepted_count`);
    requireInteger(result.reply_trigger_attempts, 1, `results[${index}].reply_trigger_attempts`);
    requireInteger(result.decoy_reply_count, 0, `results[${index}].decoy_reply_count`);
    for (const flag of ["exact_reply_visible", "own_author_verified", "parent_verified", "test_only"]) {
      if (result[flag] !== true) fail(`results[${index}].${flag} must be true`);
    }
    requireExactKeys(result.phase_sha256, ["scan", "preflight", "attempt", "result"], `results[${index}].phase_sha256`);
    for (const phase of ["scan", "preflight", "attempt", "result"]) {
      requireHex256(result.phase_sha256[phase], `results[${index}].phase_sha256.${phase}`);
    }
  });
}

export function validateThreePlatformFixtureReceipt(receipt) {
  requireExactKeys(receipt, TOP_LEVEL_KEYS, "receipt");
  requireInteger(receipt.schema_version, 1, "schema_version");
  if (receipt.gate !== "social-post-three-platform-browser-fixture") fail("gate is invalid");
  if (receipt.status !== "PASS") fail("status must be PASS");
  if (typeof receipt.run_id !== "string" || !UUID_V4.test(receipt.run_id)) {
    fail("run_id must be a canonical lowercase UUID v4");
  }
  if (receipt.evidence_scope !== "localhost_test_only_candidate") fail("evidence_scope is invalid");
  if (receipt.capability_promotion_eligible !== false) fail("capability promotion must remain false");
  if (receipt.live_browser_actuation_enabled !== false) fail("live browser actuation must remain false");
  if (receipt.claim_authority !== "in_memory_test_only") fail("claim authority must remain in-memory test-only");
  if (receipt.trusted_host_verified !== false) fail("trusted host verification must remain false");
  if (receipt.stable_node_frame_mapping_verified !== false) fail("stable node/frame mapping must remain false");
  requireExactArray(receipt.does_not_prove, DOES_NOT_PROVE, "does_not_prove");
  requireExactArray(receipt.platform_order, PLATFORM_ORDER, "platform_order");
  if (typeof receipt.observed_at !== "string" || Number.isNaN(Date.parse(receipt.observed_at))
      || new Date(receipt.observed_at).toISOString() !== receipt.observed_at) {
    fail("observed_at must be a canonical ISO timestamp");
  }
  requireExactKeys(receipt.browser_surface, ["goto", "playwright", "dom_cua"], "browser_surface");
  for (const surface of ["goto", "playwright", "dom_cua"]) {
    if (receipt.browser_surface[surface] !== true) fail(`browser_surface.${surface} must be true`);
  }
  requireExactKeys(receipt.architecture_gate, [
    "gate", "status", "receipt_sha256", "evaluator_sha256", "inventory_sha256",
    "graph_sha256", "policy_sha256", "report_sha256",
  ], "architecture_gate");
  if (receipt.architecture_gate.gate !== "social-post-js-architecture-gate"
      || receipt.architecture_gate.status !== "PASS") {
    fail("architecture_gate must bind a passing native gate");
  }
  for (const label of [
    "receipt_sha256", "evaluator_sha256", "inventory_sha256",
    "graph_sha256", "policy_sha256", "report_sha256",
  ]) {
    requireHex256(receipt.architecture_gate[label], `architecture_gate.${label}`);
  }
  if (receipt.owned_ephemeral_loopback_server !== true) fail("owned loopback server evidence must be true");
  if (receipt.active_state_unchanged !== true) fail("active state must remain unchanged");
  if (receipt.hash_algorithm !== "sha256") fail("hash_algorithm must be sha256");
  requireHex256(receipt.policy_sha256, "policy_sha256");
  requireHex256(receipt.active_state_snapshot_sha256, "active_state_snapshot_sha256");
  validateSources(receipt);
  const sourcesByPath = new Map(receipt.sources.map((source) => [source.path, source]));
  const evaluatorFiles = ARCHITECTURE_EVALUATOR_PATHS.map((path) => ({
    path, sha256: sourcesByPath.get(path).sha256,
  }));
  if (receipt.architecture_gate.evaluator_sha256
      !== digestObject(evaluatorFiles, "fixture receipt architecture evaluator files")) {
    fail("architecture_gate.evaluator_sha256 must bind the six evaluator source hashes");
  }
  validateServedSources(receipt);
  validateRequestLog(receipt);
  validateResults(receipt);
  return true;
}

export function parseCanonicalThreePlatformFixtureReceipt(serialized) {
  if (typeof serialized !== "string" || !serialized.endsWith("\n")) {
    throw new Error("fixture receipt must be newline-terminated JSON text");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECEIPT_BYTES) {
    throw new Error("fixture receipt exceeds the bounded evidence size");
  }
  const parsed = JSON.parse(serialized);
  validateThreePlatformFixtureReceipt(parsed);
  if (serialized !== `${JSON.stringify(parsed, null, 2)}\n`) {
    throw new Error("fixture receipt must use canonical pretty JSON without duplicate keys");
  }
  return parsed;
}

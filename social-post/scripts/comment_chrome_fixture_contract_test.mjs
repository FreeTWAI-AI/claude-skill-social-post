import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertSnapshotsUnchanged,
  fixturePlatforms,
  requireLoopbackBaseUrl,
  testFixtureNavigationReadiness,
  testFixturePersistenceFinalizer,
  validateExactFixtureBatch,
} from "./comment_fixture_browser_e2e.mjs";
import { digestObject } from "./comment_chrome_common.mjs";
import {
  requireFreshFixtureArchitectureGate,
  snapshotFixtureIntegrity,
  testOnlyInspectFixtureRelativePath,
  testOnlyValidateArchitectureInventorySnapshot,
} from "./comment_chrome_fixture_evidence_testonly.mjs";
import {
  parseCanonicalThreePlatformFixtureReceipt,
  validateThreePlatformFixtureReceipt,
} from "./comment_chrome_fixture_receipt_testonly.mjs";

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
  "scripts/comment_chrome_node_identity.mjs",
  "scripts/comment_js_architecture_contract.mjs",
  "scripts/comment_js_architecture_core.mjs",
  "scripts/comment_js_architecture_gate.mjs",
  "scripts/comment_js_architecture_loaders.mjs",
  "scripts/comment_js_architecture_receipt.mjs",
  "scripts/comment_js_architecture_selftest.mjs",
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
const PARENTS = Object.freeze({
  facebook: "fb-comment-001",
  instagram: "ig-comment-001",
  threads: "threads-reply-001",
});

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureReceipt() {
  const platforms = ["facebook", "instagram", "threads"];
  const runId = "12345678-1234-4abc-8def-1234567890ab";
  const sources = SOURCE_PATHS.map((path, index) => ({
    path, exists: true, size: 100 + index, sha256: digest(`source:${path}`),
  }));
  const byPath = new Map(sources.map((source) => [source.path, source]));
  const served_sources = SERVED_ROUTES.map(([route, path]) => ({
    route, path, size: byPath.get(path).size, sha256: byPath.get(path).sha256,
  }));
  const evaluatorFiles = [
    "scripts/comment_js_architecture_contract.mjs",
    "scripts/comment_js_architecture_core.mjs",
    "scripts/comment_js_architecture_gate.mjs",
    "scripts/comment_js_architecture_loaders.mjs",
    "scripts/comment_js_architecture_receipt.mjs",
    "scripts/comment_js_architecture_selftest.mjs",
  ].map((path) => ({ path, sha256: byPath.get(path).sha256 }));
  const results = platforms.map((platform, index) => ({
    platform,
    page_url: `http://127.0.0.1:8765/${platform}.html`,
    scanned_comment_count: 2,
    action_id: `fixture-action-${runId}-${platform}`,
    parent_comment_id: PARENTS[platform],
    submit_attempts: 1,
    accepted_count: 1,
    reply_trigger_attempts: 1,
    decoy_reply_count: 0,
    exact_reply_visible: true,
    own_author_verified: true,
    parent_verified: true,
    test_only: true,
    phase_sha256: {
      scan: digest(`scan:${index}`),
      preflight: digest(`preflight:${index}`),
      attempt: digest(`attempt:${index}`),
      result: digest(`result:${index}`),
    },
  }));
  return {
    schema_version: 1,
    gate: "social-post-three-platform-browser-fixture",
    status: "PASS",
    run_id: runId,
    evidence_scope: "localhost_test_only_candidate",
    capability_promotion_eligible: false,
    live_browser_actuation_enabled: false,
    claim_authority: "in_memory_test_only",
    trusted_host_verified: false,
    stable_node_frame_mapping_verified: false,
    does_not_prove: [
      "authenticated Meta host authority",
      "live Meta draft or send",
      "stable tab/frame/document mapping",
      "automatic reply eligibility",
    ],
    platform_order: platforms,
    observed_at: "2026-08-28T00:00:00.000Z",
    browser_surface: { goto: true, playwright: true, dom_cua: true },
    architecture_gate: {
      gate: "social-post-js-architecture-gate",
      status: "PASS",
      receipt_sha256: digest("architecture-receipt"),
      evaluator_sha256: digestObject(evaluatorFiles, "fixture receipt architecture evaluator files"),
      inventory_sha256: digest("architecture-inventory"),
      graph_sha256: digest("architecture-graph"),
      policy_sha256: digest("architecture-policy"),
      report_sha256: digest("architecture-report"),
    },
    owned_ephemeral_loopback_server: true,
    served_sources,
    request_log: served_sources.map(({ route }) => ({ method: "GET", path: route, status: 200 })),
    active_state_unchanged: true,
    hash_algorithm: "sha256",
    policy_sha256: digest("policy"),
    active_state_snapshot_sha256: digest("active-state"),
    source_snapshot_sha256: digestObject(sources, "fixture receipt sources"),
    sources,
    results,
  };
}

function assertReceiptMutationRejected(label, mutate) {
  const receipt = structuredClone(fixtureReceipt());
  mutate(receipt);
  assert.throws(
    () => validateThreePlatformFixtureReceipt(receipt),
    /invalid three-platform fixture receipt/u,
    label,
  );
}

function testFixtureReceiptValidator() {
  const valid = fixtureReceipt();
  assert.equal(validateThreePlatformFixtureReceipt(valid), true);
  const canonical = `${JSON.stringify(valid, null, 2)}\n`;
  assert.deepEqual(parseCanonicalThreePlatformFixtureReceipt(canonical), valid);
  assert.throws(
    () => parseCanonicalThreePlatformFixtureReceipt(` ${canonical}`),
    /canonical pretty JSON/u,
  );
  const duplicateRunId = canonical.replace(
    /  "run_id": "([^"]+)",/u,
    '  "run_id": "personal-secret",\n  "run_id": "$1",',
  );
  assert.throws(
    () => parseCanonicalThreePlatformFixtureReceipt(duplicateRunId),
    /canonical pretty JSON/u,
  );
  for (const [label, mutate] of [
    ["extra schema key", (value) => { value.extra = true; }],
    ["wrong schema version", (value) => { value.schema_version = 2; }],
    ["wrong gate", (value) => { value.gate = "other-gate"; }],
    ["wrong status", (value) => { value.status = "UNKNOWN"; }],
    ["invalid run id", (value) => { value.run_id = "not-a-uuid"; }],
    ["mixed result run", (value) => { value.results[1].action_id = "fixture-action-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-instagram"; }],
    ["secret action payload", (value) => { value.results[0].action_id = `fixture-action-${value.run_id}-secret-facebook`; }],
    ["wrong evidence scope", (value) => { value.evidence_scope = "live"; }],
    ["promotion enabled", (value) => { value.capability_promotion_eligible = true; }],
    ["live enabled", (value) => { value.live_browser_actuation_enabled = true; }],
    ["non-memory claim", (value) => { value.claim_authority = "durable"; }],
    ["trusted host claimed", (value) => { value.trusted_host_verified = true; }],
    ["stable mapping claimed", (value) => { value.stable_node_frame_mapping_verified = true; }],
    ["missing disclaimer", (value) => { value.does_not_prove.pop(); }],
    ["platform order drift", (value) => { [value.platform_order[0], value.platform_order[1]] = [value.platform_order[1], value.platform_order[0]]; }],
    ["result count drift", (value) => { value.results.pop(); }],
    ["result order drift", (value) => { [value.results[0], value.results[1]] = [value.results[1], value.results[0]]; }],
    ["result not test-only", (value) => { value.results[1].test_only = false; }],
    ["phase set drift", (value) => { value.results[1].phase_sha256.extra = digest("extra"); }],
    ["invalid phase hash", (value) => { value.results[2].phase_sha256.result = "abc"; }],
    ["invalid active snapshot hash", (value) => { value.active_state_snapshot_sha256 = "0"; }],
    ["invalid source snapshot hash", (value) => { value.source_snapshot_sha256 = "f".repeat(64); }],
    ["active state changed", (value) => { value.active_state_unchanged = false; }],
    ["server not owned", (value) => { value.owned_ephemeral_loopback_server = false; }],
    ["architecture gate not pass", (value) => { value.architecture_gate.status = "FAIL"; }],
    ["architecture digest invalid", (value) => { value.architecture_gate.graph_sha256 = "bad"; }],
    ["architecture evaluator cross-binding drift", (value) => { value.architecture_gate.evaluator_sha256 = digest("wrong-but-valid"); }],
    ["wrong hash algorithm", (value) => { value.hash_algorithm = "sha1"; }],
    ["uppercase policy hash", (value) => { value.policy_sha256 = "A".repeat(64); }],
    ["private source path", (value) => {
      value.sources[0].path = ["C:", "Users", "private", "secret"].join("/");
    }],
    ["source order drift", (value) => { [value.sources[0], value.sources[1]] = [value.sources[1], value.sources[0]]; }],
    ["served route drift", (value) => { value.served_sources[0].route = "/unreviewed.html"; }],
    ["served hash drift", (value) => { value.served_sources[0].sha256 = digest("drift"); }],
    ["request coverage missing", (value) => { value.request_log = value.request_log.filter((row) => row.path !== "/threads.html"); }],
    ["unreviewed request success", (value) => { value.request_log.push({ method: "GET", path: "/unknown", status: 200 }); }],
    ["remote result URL", (value) => { value.results[0].page_url = "https://www.facebook.com/fixture"; }],
  ]) {
    assertReceiptMutationRejected(label, mutate);
  }
}

function row(platform) {
  return {
    platform,
    page_url: `http://127.0.0.1:8765/${platform}.html`,
    scan: { test_only: true },
    preflight: { test_only: true },
    attempt: { test_only: true },
    result: {
      test_only: true,
      exact_reply_visible: true,
      own_author_verified: true,
      parent_verified: true,
    },
    dom: {
      submit_attempts: 1,
      accepted_count: 1,
      reply_trigger_attempts: 1,
      composer_empty: true,
      submit_disabled: true,
      decoy_reply_count: 0,
    },
  };
}

export async function testThreePlatformFixtureContract() {
  assert.equal(await testFixtureNavigationReadiness(), true);
  assert.equal(await testFixturePersistenceFinalizer(), true);
  const scratch = await mkdtemp(join(tmpdir(), "social-fixture-path-"));
  try {
    assert.equal(await testOnlyInspectFixtureRelativePath(
      scratch, ".rd/capability-ledger.json", { kind: "file", missingAllowed: true },
    ), null);
    await mkdir(join(scratch, ".rd"));
    await writeFile(join(scratch, ".rd", "capability-ledger.json"), "", "utf8");
    const created = await testOnlyInspectFixtureRelativePath(
      scratch, ".rd/capability-ledger.json", { kind: "file", missingAllowed: true },
    );
    assert.equal(created?.isFile(), true);
    assert.equal(created?.size, 0);
    const syntheticWindowsPrivatePath = ["C:", "Users", "private"].join("/");
    for (const unsafe of ["../outside", "/absolute", syntheticWindowsPrivatePath, "nested\\outside"]) {
      await assert.rejects(
        testOnlyInspectFixtureRelativePath(
          scratch, unsafe, { kind: "file", missingAllowed: true },
        ),
        /repo-relative POSIX path/u,
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const currentIntegrity = await snapshotFixtureIntegrity();
  const currentArchitecture = await requireFreshFixtureArchitectureGate(currentIntegrity.sources);
  assert.equal(currentArchitecture.status, "PASS");
  const staleEvaluatorSnapshot = currentIntegrity.sources.map((row) => (
    row.path === "scripts/comment_js_architecture_contract.mjs"
      ? Object.freeze({ ...row, sha256: "0".repeat(64) }) : row
  ));
  await assert.rejects(
    requireFreshFixtureArchitectureGate(staleEvaluatorSnapshot),
    /evaluator evidence is stale/u,
  );
  const savedInventory = [
    { path: "scripts/comment_chrome_actuator.mjs", bytes: 100, sha256: digest("actuator"), role: "production" },
    { path: "scripts/comment_chrome_send.mjs", bytes: 200, sha256: digest("send"), role: "production" },
    { path: "scripts/comment_js_architecture_gate.mjs", bytes: 300, sha256: digest("gate"), role: "tools" },
  ];
  const currentInventory = savedInventory.map((row) => ({
    path: row.path, exists: true, size: row.bytes, sha256: row.sha256,
  }));
  assert.equal(testOnlyValidateArchitectureInventorySnapshot(savedInventory, currentInventory), true);
  assert.throws(
    () => testOnlyValidateArchitectureInventorySnapshot(savedInventory, currentInventory.map(
      (row) => row.path === "scripts/comment_chrome_actuator.mjs"
        ? { ...row, sha256: digest("changed-outside-fixture-closure") } : row,
    )),
    /inventory is stale/u,
  );
  testFixtureReceiptValidator();
  const platforms = fixturePlatforms();
  assert.equal(Object.isFrozen(platforms), true);
  assert.deepEqual(platforms, ["facebook", "instagram", "threads"]);
  assert.equal(requireLoopbackBaseUrl("http://localhost:8765/"), "http://localhost:8765");
  assert.throws(() => requireLoopbackBaseUrl("https://127.0.0.1:8765"), /plain loopback/);
  assert.throws(() => requireLoopbackBaseUrl("http://example.com"), /plain loopback/);
  assert.throws(() => requireLoopbackBaseUrl("http://user:pass@localhost:8765"), /plain loopback/);
  assert.throws(() => requireLoopbackBaseUrl("http://localhost:8765/?mode=1"), /plain loopback/);
  assert.throws(() => requireLoopbackBaseUrl("http://localhost:8765/#fragment"), /plain loopback/);

  const clean = platforms.map(row);
  assert.equal(validateExactFixtureBatch(clean), true);
  assert.throws(() => validateExactFixtureBatch(clean.slice(0, 2)), /all three/);
  assert.throws(() => validateExactFixtureBatch([clean[0], clean[0], clean[2]]), /exact fixed/);
  assert.throws(() => validateExactFixtureBatch([clean[1], clean[0], clean[2]]), /exact fixed/);
  assert.throws(() => validateExactFixtureBatch([
    { ...clean[0], page_url: "https://www.facebook.com/fixture" }, clean[1], clean[2],
  ]), /plain loopback/);
  assert.throws(() => validateExactFixtureBatch([
    clean[0], { ...clean[1], result: { ...clean[1].result, test_only: false } }, clean[2],
  ]), /must be test-only/);
  assert.throws(() => validateExactFixtureBatch([
    { ...clean[0], scan: { test_only: false } }, clean[1], clean[2],
  ]), /must be test-only/);
  assert.throws(() => validateExactFixtureBatch([
    clean[0], clean[1], { ...clean[2], dom: { ...clean[2].dom, submit_attempts: 2 } },
  ]));

  const snapshot = Object.freeze([
    Object.freeze({ path: "data/comment_events.jsonl", exists: true, size: 1, sha256: "a" }),
    Object.freeze({ path: "data/browser_scan_requests.jsonl", exists: false }),
  ]);
  assert.equal(assertSnapshotsUnchanged(snapshot, snapshot, "fixture state"), true);
  assert.throws(() => assertSnapshotsUnchanged(snapshot, [
    snapshot[0],
    { path: "data/browser_scan_requests.jsonl", exists: true, size: 0, sha256: "e3b0" },
  ], "fixture state"), /changed during/);
}

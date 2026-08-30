/** Calibrated negative fixtures for the social-post JavaScript architecture gate. */

import {
  mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";

import {
  EXPECTED_INVENTORY,
  REQUIRED_EDGES,
  SCHEMA_VERSION,
  GATE_NAME,
  moduleRoleFor,
} from "./comment_js_architecture_contract.mjs";
import {
  digest,
  evaluateArchitecture,
  evaluateFixtureWriteAuthority,
  evaluateInventoryManifest,
  evaluateModuleRoles,
  evaluateReviewedExternalImports,
  importPolicyFinding,
  isReviewedExternalDynamicImport,
  parseStaticModuleSpecifiers,
} from "./comment_js_architecture_core.mjs";
import {
  atomicWriteTextFile,
  safeOutputPath,
  safeSidecarPath,
  writeReceiptBundle,
} from "./comment_js_architecture_receipt.mjs";

function edge(source, target) {
  return { source, target, specifier: `./${posix.basename(target)}`, line: 1 };
}

function hasCode(result, code) {
  return result.findings.some((item) => item.code === code);
}

function checkRecorder() {
  const checks = [];
  const assertCheck = (id, condition) => {
    if (!condition) throw new Error(`self-test failed: ${id}`);
    checks.push(id);
  };
  return { checks, assertCheck };
}

function runParserChecks(assertCheck) {
  const parsed = parseStaticModuleSpecifiers(
    'import x from "./a.mjs"; export { y } from "./b.mjs";\n'
      + 'const z = import("./dynamic.mjs"); object.safeImport("./ignored.mjs");',
  );
  assertCheck("same-line-static-import-export-detected", (
    parsed.filter((item) => item.kind === "static").length === 2
  ));
  assertCheck("dynamic-import-detected", parsed.some((item) => item.kind === "dynamic"));
  assertCheck("ordinary-property-call-ignored", !parsed.some(
    (item) => item.specifier === "./ignored.mjs",
  ));
  const dynamic = parsed.find((item) => item.kind === "dynamic");
  assertCheck("dynamic-import-policy-fails-closed", (
    importPolicyFinding("scripts/source.mjs", dynamic)?.code === "dynamic-import-not-allowed"
  ));
  assertCheck("bare-import-policy-fails-closed", (
    importPolicyFinding("scripts/source.mjs", {
      kind: "static", specifier: "package", line: 1,
    })?.code === "external-static-import-not-allowed"
  ));
  const trustedBrowserClient = {
    kind: "dynamic",
    specifier: "../../../plugins/cache/openai-bundled/chrome/26.818.41509/scripts/browser-client.mjs",
    line: 1,
  };
  assertCheck("reviewed-browser-client-boundary-accepted", isReviewedExternalDynamicImport(
    "scripts/comment_chrome_runtime_authority.mjs", trustedBrowserClient,
  ));
  assertCheck("browser-client-version-drift-rejected", !isReviewedExternalDynamicImport(
    "scripts/comment_chrome_runtime_authority.mjs",
    { ...trustedBrowserClient, specifier: trustedBrowserClient.specifier.replace("26.818.41509", "drifted") },
  ));
  assertCheck("browser-client-source-drift-rejected", !isReviewedExternalDynamicImport(
    "scripts/other.mjs", trustedBrowserClient,
  ));
  assertCheck("browser-client-eager-static-import-rejected", !isReviewedExternalDynamicImport(
    "scripts/comment_chrome_runtime_authority.mjs", { ...trustedBrowserClient, kind: "static" },
  ));
  const exactExternal = [{
    source: "scripts/comment_chrome_runtime_authority.mjs",
    ...trustedBrowserClient,
  }];
  const exactExternalResult = evaluateReviewedExternalImports(exactExternal);
  assertCheck("reviewed-external-import-exact-cardinality-accepted", (
    exactExternalResult.findings.length === 0
      && exactExternalResult.dependencies.length === 1
      && exactExternalResult.dependencies[0].count === 1
  ));
  assertCheck("reviewed-external-import-missing-rejected", (
    evaluateReviewedExternalImports([]).findings.some(
      (item) => item.code === "reviewed-external-import-cardinality",
    )
  ));
  assertCheck("reviewed-external-import-duplicate-rejected", (
    evaluateReviewedExternalImports([...exactExternal, ...exactExternal]).findings.some(
      (item) => item.code === "reviewed-external-import-cardinality",
    )
  ));
  assertCheck("reviewed-external-import-drift-rejected", (
    evaluateReviewedExternalImports([{
      ...exactExternal[0],
      specifier: exactExternal[0].specifier.replace("26.818.41509", "drifted"),
    }]).findings.some((item) => item.code === "reviewed-external-import-drift")
  ));
  assertCheck("reviewed-external-import-covered-by-graph-digest", (
    digest({ modules: ["a"], edges: [], external_dependencies: exactExternalResult.dependencies })
      !== digest({
        modules: ["a"], edges: [],
        external_dependencies: [{ ...exactExternalResult.dependencies[0], count: 0 }],
      })
  ));
  assertCheck("node-import-policy-accepted", importPolicyFinding(
    "scripts/source.mjs", { kind: "static", specifier: "node:path", line: 1 },
  ) === null);
  assertCheck("fixture-child-process-import-rejected", (
    importPolicyFinding("scripts/comment_fixture_browser_e2e.mjs", {
      kind: "static", specifier: "node:child_process", line: 1,
    })?.code === "fixture-evidence-forbidden-node-import"
  ));
  assertCheck("fixture-unreviewed-node-net-import-rejected", (
    importPolicyFinding("scripts/comment_fixture_browser_e2e.mjs", {
      kind: "static", specifier: "node:net", line: 1,
    })?.code === "fixture-evidence-node-import-unreviewed"
  ));
  assertCheck("fixture-reviewed-node-crypto-import-accepted", importPolicyFinding(
    "scripts/comment_fixture_browser_e2e.mjs",
    { kind: "static", specifier: "node:crypto", line: 1 },
  ) === null);
  assertCheck("fixture-node-require-style-rejected", (
    importPolicyFinding("scripts/comment_fixture_browser_e2e.mjs", {
      kind: "require", specifier: "node:crypto", line: 1,
    })?.code === "fixture-evidence-node-import-unreviewed"
  ));
  const hiddenTemplate = parseStaticModuleSpecifiers(
    "const hidden = `${await import('./evil.mjs')}`;",
  );
  assertCheck("template-interpolation-dynamic-import-detected", hiddenTemplate.some(
    (item) => item.kind === "dynamic" && item.specifier === "./evil.mjs",
  ));
  const regexTemplate = parseStaticModuleSpecifiers(
    'const hidden = `${ /}/.test("}") ? import("./evil2.mjs") : 0 }`;',
  );
  assertCheck("template-regex-brace-dynamic-import-detected", regexTemplate.some(
    (item) => item.kind === "dynamic" && item.specifier === "./evil2.mjs",
  ));
  const hiddenLoader = parseStaticModuleSpecifiers(
    'import { createRequire } from "node:module";\n'
      + 'const require = createRequire(import.meta.url); require("./evil.cjs");',
  );
  assertCheck("create-require-loader-rejected", hiddenLoader.some((item) => (
    importPolicyFinding("scripts/source.mjs", item)?.code
      === "create-require-loader-not-allowed"
  )));
  assertCheck("executable-require-loader-rejected", hiddenLoader.some((item) => (
    importPolicyFinding("scripts/source.mjs", item)?.code === "require-loader-not-allowed"
  )));
  const evaluatedLoaders = parseStaticModuleSpecifiers(
    'eval("import(\\"./evil3.mjs\\")"); Function("return import(\\"./evil4.mjs\\")")();',
  );
  assertCheck("eval-loader-rejected", evaluatedLoaders.some((item) => (
    importPolicyFinding("scripts/source.mjs", item)?.code === "eval-loader-not-allowed"
  )));
  assertCheck("function-loader-rejected", evaluatedLoaders.some((item) => (
    importPolicyFinding("scripts/source.mjs", item)?.code === "function-loader-not-allowed"
  )));
  const aliasEval = parseStaticModuleSpecifiers(
    'const e = eval; e("import(\\"./aliased-eval.mjs\\")");',
  );
  assertCheck("bare-eval-alias-reference-rejected", aliasEval.some((item) => (
    importPolicyFinding("scripts/source.mjs", item)?.code
      === "loader-shaped-reference-not-allowed"
  )));
  const aliasedCreateRequire = parseStaticModuleSpecifiers(
    'import { createRequire as cr } from "node:module";'
      + ' const rq = cr(import.meta.url); rq("./aliased.cjs");',
  );
  assertCheck("aliased-create-require-reference-rejected", aliasedCreateRequire.some((item) => (
    importPolicyFinding("scripts/source.mjs", item)?.code
      === "loader-shaped-reference-not-allowed"
  )));
  const namespaceCreateRequire = parseStaticModuleSpecifiers(
    'import * as mod from "node:module"; mod.createRequire(import.meta.url);',
  );
  assertCheck("namespace-create-require-call-rejected", namespaceCreateRequire.some((item) => (
    importPolicyFinding("scripts/source.mjs", item)?.code
      === "create-require-loader-not-allowed"
  )));
  const executableMembers = parseStaticModuleSpecifiers(
    'object.require("./method.cjs"); object.createRequire("./method.cjs");'
      + ' object.import("./method.mjs"); object["eval"]("code");',
  );
  assertCheck("executable-loader-members-rejected", executableMembers.filter((item) => (
    importPolicyFinding("scripts/source.mjs", item) !== null
  )).length === 4);
  const pureLoaderData = parseStaticModuleSpecifiers(
    'const data = { "require": "text", "createRequire": "text",'
      + ' "import": "text", "eval": "text", "Function": "text" };',
  );
  assertCheck("pure-loader-name-string-data-not-misclassified", pureLoaderData.length === 0);
  const ordinaryIdentifiers = parseStaticModuleSpecifiers(
    "const constructor = Object; value.toString();",
  );
  assertCheck("prototype-named-identifiers-not-misclassified", ordinaryIdentifiers.length === 0);
  const memberEvaluators = parseStaticModuleSpecifiers(
    'globalThis.eval("import(\\"./evil5.mjs\\")"); globalThis.Function("return 1")();',
  );
  assertCheck("member-eval-loader-rejected", memberEvaluators.some((item) => (
    importPolicyFinding("scripts/source.mjs", item)?.code === "eval-loader-not-allowed"
  )));
  assertCheck("member-function-loader-rejected", memberEvaluators.some((item) => (
    importPolicyFinding("scripts/source.mjs", item)?.code === "function-loader-not-allowed"
  )));
  const stringInsideTemplate = parseStaticModuleSpecifiers(
    "const inert = `${\"require('./not-code.cjs')\"}`;",
  );
  assertCheck("template-string-loader-text-not-misclassified", stringInsideTemplate.length === 0);
}

function runManifestAndRoleChecks(assertCheck) {
  assertCheck("exact-inventory-manifest-accepted", (
    evaluateInventoryManifest(EXPECTED_INVENTORY).length === 0
  ));
  assertCheck("missing-inventory-member-rejected", evaluateInventoryManifest(
    EXPECTED_INVENTORY.slice(1),
  ).some((item) => item.code === "closed-inventory-member-missing"));
  assertCheck("extra-inventory-member-rejected", evaluateInventoryManifest([
    ...EXPECTED_INVENTORY, "scripts/comment_chrome_unreviewed.mjs",
  ]).some((item) => item.code === "closed-inventory-member-unreviewed"));
  assertCheck("unknown-module-has-no-default-role", (
    moduleRoleFor("scripts/comment_chrome_unreviewed.mjs") === null
  ));
  assertCheck("unreviewed-module-role-rejected", evaluateModuleRoles([{
    path: "scripts/comment_chrome_unreviewed.mjs", role: null,
  }]).some((item) => item.code === "module-role-unreviewed"));
  assertCheck("module-role-misclassification-rejected", evaluateModuleRoles([{
    path: "scripts/comment_chrome_send.mjs", role: "test",
  }]).some((item) => item.code === "module-role-misclassified"));
}

function runFixtureWriteAuthorityChecks(assertCheck) {
  const evidencePath = "scripts/comment_chrome_fixture_evidence_testonly.mjs";
  const receiptPath = "scripts/comment_chrome_fixture_receipt_testonly.mjs";
  const e2ePath = "scripts/comment_fixture_browser_e2e.mjs";
  const evidenceImport = 'import { lstat, readFile, readdir } from "node:fs/promises";';
  const receiptImport = `export function validateThreePlatformFixtureReceipt() {}
export function parseCanonicalThreePlatformFixtureReceipt() {}
`;
  const e2eImport = `import { lstat, mkdir, open, readFile, rename, rm, rmdir } from "node:fs/promises";
export function requireLoopbackBaseUrl() {}
export function assertSnapshotsUnchanged() {}
export function validateExactFixtureBatch() {}
export async function runAllFixtureBrowserE2E() {}
export async function testFixtureNavigationReadiness() {}
export async function testFixturePersistenceFinalizer() {}
export function fixturePlatforms() {}
const entry = typeof process === "undefined" ? undefined : process.argv?.[1];`;
  assertCheck("fixture-reviewed-fs-bindings-accepted", evaluateFixtureWriteAuthority([
    { path: evidencePath, source: evidenceImport },
    { path: receiptPath, source: receiptImport },
    { path: e2ePath, source: e2eImport },
  ]).length === 0);
  assertCheck("fixture-evidence-write-binding-rejected", evaluateFixtureWriteAuthority([
    { path: evidencePath, source: evidenceImport.replace("readdir", "readdir, writeFile") },
    { path: receiptPath, source: receiptImport },
  ]).some((item) => item.code === "fixture-evidence-fs-bindings-drift"));
  assertCheck("fixture-receipt-fs-authority-rejected", evaluateFixtureWriteAuthority([
    { path: evidencePath, source: evidenceImport },
    { path: receiptPath, source: `import { writeFile } from "node:fs/promises";\n${receiptImport}` },
    { path: e2ePath, source: e2eImport },
  ]).some((item) => item.code === "fixture-evidence-fs-authority-unreviewed"));
  assertCheck("fixture-e2e-unreviewed-fs-binding-rejected", evaluateFixtureWriteAuthority([
    { path: evidencePath, source: evidenceImport },
    { path: receiptPath, source: receiptImport },
    { path: e2ePath, source: e2eImport.replace("rmdir", "rmdir, writeFile") },
  ]).some((item) => item.code === "fixture-evidence-fs-bindings-drift"));
  for (const [label, unsafeAuthority] of [
    ["fixture-process-pid-rejected", "process.pid;"],
    ["fixture-process-binding-rejected", 'process.binding("fs");'],
    ["fixture-process-linked-binding-rejected", 'process._linkedBinding("fs");'],
    ["fixture-process-binding-computed-rejected", 'process["binding"]("fs");'],
    ["fixture-process-binding-alias-rejected", 'const p = process; p.binding("fs");'],
    ["fixture-process-get-builtin-module-rejected", 'process.getBuiltinModule("fs");'],
    ["fixture-globalthis-process-binding-rejected", 'globalThis.process.binding("fs");'],
  ]) {
    assertCheck(label, evaluateFixtureWriteAuthority([
      { path: evidencePath, source: evidenceImport },
      { path: receiptPath, source: `${receiptImport}\n${unsafeAuthority}` },
      { path: e2ePath, source: e2eImport },
    ]).some((item) => item.code === "fixture-evidence-node-global-authority-unreviewed"));
  }
  assertCheck("fixture-raw-receipt-writer-export-rejected", evaluateFixtureWriteAuthority([
    { path: evidencePath, source: evidenceImport },
    { path: receiptPath, source: `${receiptImport}\nexport async function writeThreePlatformFixtureReceipt() {}` },
    { path: e2ePath, source: e2eImport },
  ]).some((item) => item.code === "fixture-public-function-surface-drift"));
  for (const [label, unsafeExport] of [
    ["fixture-raw-receipt-const-export-rejected", "export const writeThreePlatformFixtureReceipt = async () => {};"],
    ["fixture-raw-receipt-named-alias-export-rejected", "const localWriter = async () => {}; export { localWriter as writeThreePlatformFixtureReceipt };"],
    ["fixture-raw-receipt-export-star-rejected", "export * from \"./unreviewed-writer.mjs\";"],
  ]) {
    assertCheck(label, evaluateFixtureWriteAuthority([
      { path: evidencePath, source: evidenceImport },
      { path: receiptPath, source: `${receiptImport}\n${unsafeExport}` },
      { path: e2ePath, source: e2eImport },
    ]).some((item) => item.code === "fixture-public-function-surface-drift"));
  }
}

function baselineGraph() {
  return {
    modules: [...EXPECTED_INVENTORY],
    edges: REQUIRED_EDGES.map(([source, target]) => edge(source, target)),
  };
}

function runGraphChecks(assertCheck) {
  const baseline = baselineGraph();
  assertCheck("known-clean-graph-passes", (
    evaluateArchitecture(baseline.modules, baseline.edges).findings.length === 0
  ));
  const cycle = evaluateArchitecture(baseline.modules, [
    ...baseline.edges,
    edge("scripts/comment_chrome_send.mjs", "scripts/comment_chrome_claim_bridge.mjs"),
  ]);
  assertCheck("known-cycle-rejected", hasCode(cycle, "dependency-cycle"));
  assertCheck("send-reverse-import-rejected", hasCode(cycle, "send-imports-claim-bridge"));
  const productionToTest = evaluateArchitecture(baseline.modules, [
    ...baseline.edges,
    edge("scripts/comment_chrome_send.mjs", "scripts/comment_chrome_actuator_test.mjs"),
  ]);
  assertCheck("production-test-boundary-rejected", (
    hasCode(productionToTest, "production-imports-test")
  ));
  const productionToFixture = evaluateArchitecture(baseline.modules, [
    ...baseline.edges,
    edge(
      "scripts/comment_chrome_node_frame_mapping.mjs",
      "scripts/comment_chrome_node_frame_lifecycle_testonly.mjs",
    ),
  ]);
  assertCheck("production-fixture-boundary-rejected", (
    hasCode(productionToFixture, "role-boundary-violation")
      && hasCode(productionToFixture, "fixture-testonly-imported-outside-test")
  ));
  const fixtureToTest = evaluateArchitecture(baseline.modules, [
    ...baseline.edges,
    edge(
      "scripts/comment_chrome_scan_fixture_testonly.mjs",
      "scripts/comment_chrome_actuator_test.mjs",
    ),
  ]);
  assertCheck("fixture-testonly-boundary-rejected", (
    hasCode(fixtureToTest, "role-boundary-violation")
  ));
  const e2eToClaimBridge = evaluateArchitecture(baseline.modules, [
    ...baseline.edges,
    edge("scripts/comment_fixture_browser_e2e.mjs", "scripts/comment_chrome_claim_bridge.mjs"),
  ]);
  assertCheck("fixture-e2e-claim-bridge-rejected", (
    hasCode(e2eToClaimBridge, "fixture-e2e-direct-target-unreviewed")
      && hasCode(e2eToClaimBridge, "fixture-evidence-closure-unreviewed")
  ));
  const missing = evaluateArchitecture(baseline.modules, baseline.edges.slice(1));
  assertCheck("missing-required-edge-rejected", hasCode(missing, "missing-required-edge"));
  const runnerMissing = evaluateArchitecture(baseline.modules, baseline.edges.filter((item) => !(
    item.source === "scripts/comment_chrome_actuator_test.mjs"
      && item.target === "scripts/comment_chrome_actuator_send_test.mjs"
  )));
  assertCheck("runner-spec-required-edge-missing-rejected", (
    hasCode(runnerMissing, "missing-required-edge")
  ));
  const supportMissing = evaluateArchitecture(baseline.modules, baseline.edges.filter((item) => !(
    item.source === "scripts/comment_chrome_send_support.mjs"
      && item.target === "scripts/comment_chrome_reply_exhaustion.mjs"
  )));
  assertCheck("send-support-required-edge-missing-rejected", (
    hasCode(supportMissing, "missing-required-edge")
  ));
}

async function expectRejected(assertCheck, id, action) {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  assertCheck(id, rejected);
}

async function symlinkFixture(target, link, type, measurements, id, action) {
  try {
    await symlink(target, link, process.platform === "win32" ? type : undefined);
    await action();
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
    measurements.push({
      id, status: "NOT_CHECKED", reason: `platform denied symlink fixture: ${error.code}`,
    });
  } finally {
    await rm(link, { recursive: true, force: true });
  }
}

async function runOutputSyntaxChecks(root, assertCheck) {
  await mkdir(join(root, ".rd", "receipts"), { recursive: true });
  await expectRejected(assertCheck, "output-traversal-rejected", () => (
    safeOutputPath(".rd/receipts/../escape.json", root)
  ));
  await expectRejected(assertCheck, "source-overwrite-rejected", () => (
    safeOutputPath("scripts/comment_js_architecture_gate.mjs", root)
  ));
  await expectRejected(assertCheck, "nested-receipt-path-rejected", () => (
    safeOutputPath(".rd/receipts/nested/gate.json", root)
  ));
  const safe = await safeOutputPath(".rd/receipts/gate.json", root);
  assertCheck("immediate-receipt-path-accepted", safe.relative === ".rd/receipts/gate.json");
}

async function runSymlinkChecks(root, assertCheck, measurements) {
  const outside = await mkdtemp(join(tmpdir(), "comment-js-gate-outside-"));
  try {
    const rd = join(root, ".rd");
    await rm(rd, { recursive: true, force: true });
    await symlinkFixture(outside, rd, "junction", measurements, "rd-symlink-rejected", async () => {
      await expectRejected(assertCheck, "rd-symlink-rejected", () => (
        safeOutputPath(".rd/receipts/gate.json", root)
      ));
    });
    await mkdir(join(root, ".rd", "receipts"), { recursive: true });
    const output = await safeOutputPath(".rd/receipts/gate.json", root);
    const linked = output.absolute;
    const outsideFile = join(outside, "outside.json");
    await writeFile(outsideFile, "outside\n", "utf8");
    await symlinkFixture(outsideFile, linked, "file", measurements, "receipt-symlink-rejected", async () => {
      await expectRejected(assertCheck, "receipt-symlink-rejected", () => (
        safeOutputPath(output.relative, root)
      ));
    });
    await writeFile(linked, "{}\n", "utf8");
    const sidecar = await safeSidecarPath(output, root);
    await symlinkFixture(outsideFile, sidecar.absolute, "file", measurements, "sidecar-symlink-rejected", async () => {
      await expectRejected(assertCheck, "sidecar-symlink-rejected", () => (
        safeSidecarPath(output, root)
      ));
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
}

async function assertNoAtomicTemp(target, assertCheck, id) {
  const prefix = `.${basename(target)}.`;
  const leftovers = (await readdir(dirname(target))).filter(
    (name) => name.startsWith(prefix) && name.endsWith(".tmp"),
  );
  assertCheck(id, leftovers.length === 0);
}

async function runAtomicChecks(root, assertCheck) {
  const receipts = join(root, ".rd", "receipts");
  await mkdir(receipts, { recursive: true });
  const receipt = join(receipts, "atomic.json");
  const sidecar = `${receipt}.sha256`;
  for (const [target, id] of [[receipt, "receipt"], [sidecar, "sidecar"]]) {
    await writeFile(target, `original-${id}\n`, "utf8");
    await expectRejected(assertCheck, `atomic-${id}-partial-write-rejected`, () => (
      atomicWriteTextFile(target, `replacement-${id}\n`, {
        beforeRename() { throw new Error("injected pre-rename failure"); },
      })
    ));
    assertCheck(`atomic-${id}-preserves-prior-file`, (
      (await readFile(target, "utf8")) === `original-${id}\n`
    ));
    await assertNoAtomicTemp(target, assertCheck, `atomic-${id}-temp-cleaned`);
  }
  const serialized = '{"status":"PASS"}\n';
  await writeReceiptBundle(".rd/receipts/atomic.json", root, serialized);
  assertCheck("atomic-receipt-readback-matches", await readFile(receipt, "utf8") === serialized);
  assertCheck("atomic-sidecar-readback-matches", (
    (await readFile(sidecar, "utf8")).endsWith("  atomic.json\n")
  ));
}

export async function runSelfTest() {
  const { checks, assertCheck } = checkRecorder();
  const measurements = [];
  runParserChecks(assertCheck);
  runManifestAndRoleChecks(assertCheck);
  runFixtureWriteAuthorityChecks(assertCheck);
  runGraphChecks(assertCheck);
  const root = await mkdtemp(join(tmpdir(), "comment-js-gate-selftest-"));
  try {
    await runOutputSyntaxChecks(root, assertCheck);
    await runSymlinkChecks(root, assertCheck, measurements);
    await runAtomicChecks(root, assertCheck);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const core = {
    schema_version: SCHEMA_VERSION,
    gate: GATE_NAME,
    marker: "comment JS architecture gate self-test passed",
    status: "PASS",
    root: ".",
    self_test: { passed: true, checks, measurements },
  };
  return { ...core, evidence: { algorithm: "sha256", report_sha256: digest(core) } };
}

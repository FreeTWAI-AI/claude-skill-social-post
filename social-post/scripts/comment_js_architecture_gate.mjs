#!/usr/bin/env node
/** Closed-world JavaScript architecture gate for the Chrome comment surface. */

import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_INVENTORY,
  EXPECTED_MODULE_ROLES,
  GATE_NAME,
  INVENTORY_SCOPE,
  REQUIRED_EDGES,
  SCHEMA_VERSION,
  moduleRoleFor,
} from "./comment_js_architecture_contract.mjs";
import {
  ROLE_POLICY_EVIDENCE,
  digest,
  evaluateArchitecture,
  evaluateFixtureWriteAuthority,
  evaluateInventoryManifest,
  evaluateModuleRoles,
  evaluateReviewedExternalImports,
  finding,
  importPolicyFinding,
  isReviewedExternalDynamicImport,
  parseStaticModuleSpecifiers,
  resolveImport,
  sha256,
} from "./comment_js_architecture_core.mjs";
import {
  safeOutputPath,
  writeReceiptBundle,
} from "./comment_js_architecture_receipt.mjs";
import { runSelfTest } from "./comment_js_architecture_selftest.mjs";

const SCRIPTS_ROOT = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = dirname(SCRIPTS_ROOT);

function relativePath(absolute) {
  const canonicalRoot = resolve(SKILL_ROOT);
  const normalizedRoot = `${canonicalRoot}${sep}`;
  const normalized = resolve(absolute);
  if (!normalized.startsWith(normalizedRoot)) {
    throw new Error("path escapes the canonical skill root");
  }
  return normalized.slice(normalizedRoot.length).split(sep).join("/");
}

async function inventoryEntry(absolute) {
  const relative = relativePath(absolute);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`closed inventory member is not a regular file: ${relative}`);
  }
  const bytes = await readFile(absolute);
  return {
    path: relative,
    bytes: bytes.length,
    sha256: sha256(bytes),
    role: moduleRoleFor(relative),
    source: bytes.toString("utf8"),
  };
}

async function buildInventory() {
  const entries = await readdir(SCRIPTS_ROOT, { withFileTypes: true });
  const selected = entries.filter((entry) => (
    entry.name.endsWith(".mjs")
      && (entry.name.startsWith("comment_chrome_")
        || entry.name.startsWith("comment_js_architecture_")
        || entry.name === "comment_meta_snapshot_parser.mjs")
  ));
  const absoluteFiles = selected.map((entry) => {
    if (!entry.isFile()) {
      throw new Error(`closed inventory member is not a regular file: scripts/${entry.name}`);
    }
    return resolve(SCRIPTS_ROOT, entry.name);
  });
  absoluteFiles.push(resolve(SCRIPTS_ROOT, "comment_fixture_browser_e2e.mjs"));
  absoluteFiles.push(resolve(SCRIPTS_ROOT, "comment_adapter_fixtures", "fixture-runtime.js"));
  const unique = [...new Set(absoluteFiles)].sort((left, right) => (
    relativePath(left).localeCompare(relativePath(right))
  ));
  if (unique.length < 3) throw new Error("closed JavaScript inventory is vacuous");
  return Promise.all(unique.map(inventoryEntry));
}

function collectGraph(rawInventory, findings) {
  const modules = rawInventory.map((entry) => entry.path);
  const moduleSet = new Set(modules);
  const edges = [];
  const observedExternalImports = [];
  for (const entry of rawInventory) {
    for (const parsed of parseStaticModuleSpecifiers(entry.source)) {
      if (parsed.kind === "dynamic") {
        observedExternalImports.push({
          source: entry.path,
          specifier: parsed.specifier,
          kind: parsed.kind,
          line: parsed.line,
        });
      }
      const policyFailure = importPolicyFinding(entry.path, parsed);
      if (policyFailure) {
        findings.push(policyFailure);
        continue;
      }
      if (!parsed.specifier.startsWith(".")) continue;
      if (isReviewedExternalDynamicImport(entry.path, parsed)) continue;
      const target = resolveImport(entry.path, parsed.specifier, moduleSet);
      if (!moduleSet.has(target)) {
        findings.push(finding(
          "relative-import-outside-closed-inventory",
          "relative static import is outside the closed JavaScript inventory",
          [entry.path, target],
          { source: entry.path, target, specifier: parsed.specifier, line: parsed.line },
        ));
        continue;
      }
      edges.push({
        source: entry.path, target, specifier: parsed.specifier, line: parsed.line,
      });
    }
  }
  edges.sort((left, right) => (
    `${left.source}\u0000${left.target}\u0000${left.line}`
      .localeCompare(`${right.source}\u0000${right.target}\u0000${right.line}`)
  ));
  const external = evaluateReviewedExternalImports(observedExternalImports);
  findings.push(...external.findings);
  return { modules, edges, externalDependencies: external.dependencies };
}

function evidenceFor(core, inventory, modules, edges, externalDependencies) {
  const evaluators = inventory.filter((entry) => entry.role === "tools").map(
    (entry) => ({ path: entry.path, sha256: entry.sha256 }),
  );
  return {
    algorithm: "sha256",
    evaluator_sha256: digest(evaluators),
    evaluator_files: evaluators,
    inventory_sha256: digest(inventory),
    graph_sha256: digest({ modules, edges, external_dependencies: externalDependencies }),
    policy_sha256: digest({
      inventory_scope: INVENTORY_SCOPE,
      expected_inventory: EXPECTED_INVENTORY,
      expected_module_roles: EXPECTED_MODULE_ROLES,
      required: REQUIRED_EDGES,
      role_policy: ROLE_POLICY_EVIDENCE,
    }),
    report_sha256: digest(core),
  };
}

async function actualReport(outputPath = null) {
  const rawInventory = await buildInventory();
  const modules = rawInventory.map((entry) => entry.path);
  const findings = [
    ...evaluateInventoryManifest(modules),
    ...evaluateModuleRoles(rawInventory),
    ...evaluateFixtureWriteAuthority(rawInventory),
  ];
  const graph = collectGraph(rawInventory, findings);
  const evaluated = evaluateArchitecture(graph.modules, graph.edges);
  findings.push(...evaluated.findings);
  findings.sort((left, right) => (
    `${left.code}\u0000${left.paths.join("\u0000")}`
      .localeCompare(`${right.code}\u0000${right.paths.join("\u0000")}`)
  ));
  const inventory = rawInventory.map(({ source, ...entry }) => entry);
  const status = findings.length === 0 ? "PASS" : "FAIL";
  const core = {
    schema_version: SCHEMA_VERSION,
    gate: GATE_NAME,
    marker: status === "PASS"
      ? "comment JS architecture gate passed" : "comment JS architecture gate failed",
    status,
    root: ".",
    output: outputPath,
    inventory_scope: {
      closed: true,
      patterns: INVENTORY_SCOPE,
      reviewed_exact_manifest: EXPECTED_INVENTORY,
      reviewed_exact_roles: EXPECTED_MODULE_ROLES,
    },
    summary: {
      modules: graph.modules.length,
      edges: graph.edges.length,
      external_dependencies: graph.externalDependencies.reduce(
        (total, row) => total + row.count, 0,
      ),
      cycles: evaluated.cycles.length,
      failures: findings.length,
    },
    inventory,
    edges: graph.edges,
    external_dependencies: graph.externalDependencies,
    strongly_connected_components: evaluated.components,
    required_edges: evaluated.required,
    findings,
  };
  return {
    ...core,
    evidence: evidenceFor(
      core, inventory, graph.modules, graph.edges, graph.externalDependencies,
    ),
  };
}

function parseArguments(argv) {
  let selfTest = false;
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--self-test") selfTest = true;
    else if (argument === "--output") {
      output = argv[index + 1];
      index += 1;
      if (!output) throw new Error("--output requires a repo-relative path");
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return { selfTest, output };
}

function failureReport(error, selfTest = false) {
  const core = {
    schema_version: SCHEMA_VERSION,
    gate: GATE_NAME,
    marker: selfTest
      ? "comment JS architecture gate self-test failed"
      : "comment JS architecture gate measurement failed",
    status: "FAIL",
    root: ".",
    findings: [finding(
      "measurement-error",
      error instanceof Error ? error.message : "unknown measurement error",
      [],
    )],
  };
  return { ...core, evidence: { algorithm: "sha256", report_sha256: digest(core) } };
}

async function main() {
  let parsed = { selfTest: false, output: null };
  try {
    parsed = parseArguments(process.argv.slice(2));
    const output = await safeOutputPath(parsed.output, SKILL_ROOT);
    const report = parsed.selfTest ? await runSelfTest() : await actualReport(output.relative);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (output.absolute) {
      await writeReceiptBundle(parsed.output, SKILL_ROOT, serialized);
    }
    process.stdout.write(serialized);
    return report.status === "PASS" ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(failureReport(error, parsed.selfTest), null, 2)}\n`);
    return 2;
  }
}

process.exitCode = await main();

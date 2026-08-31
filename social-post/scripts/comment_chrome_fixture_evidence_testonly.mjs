/** Source-bound server and integrity evidence for localhost-only Browser fixtures. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { digestObject } from "./comment_chrome_common.mjs";

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARCHITECTURE_RECEIPT_PATH = ".rd/receipts/js-architecture-gate.json";
const ARCHITECTURE_SIDECAR_PATH = `${ARCHITECTURE_RECEIPT_PATH}.sha256`;
const REVIEWED_BROWSER_CLIENT_DEPENDENCY = Object.freeze({
  source: "scripts/comment_chrome_runtime_authority.mjs",
  specifier: "../../../plugins/cache/openai-bundled/chrome/26.825.51511/scripts/browser-client.mjs",
  kind: "dynamic",
  count: 1,
});
const ACTIVE_STATE_PATHS = Object.freeze([
  "comment-capabilities.json",
  "references/comment-policy.json",
  ".rd/capability-ledger.json",
]);
const ARCHITECTURE_EVALUATOR_PATHS = Object.freeze([
  "scripts/comment_js_architecture_contract.mjs",
  "scripts/comment_js_architecture_core.mjs",
  "scripts/comment_js_architecture_gate.mjs",
  "scripts/comment_js_architecture_loaders.mjs",
  "scripts/comment_js_architecture_receipt.mjs",
  "scripts/comment_js_architecture_selftest.mjs",
]);
const FIXTURE_SOURCE_PATHS = Object.freeze([
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

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalDigest(value) {
  return digestObject(value, "fixture evidence digest input");
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function requireRepoRelativePosixPath(relative) {
  if (typeof relative !== "string" || !relative
      || relative.startsWith("/") || relative.startsWith("\\")
      || relative.includes("\\") || relative.includes(":")
      || !/^[A-Za-z0-9._/-]+$/u.test(relative)
      || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("fixture evidence path must be a repo-relative POSIX path");
  }
}

async function requireSafeRelativePathAt(root, relative, { kind, missingAllowed = false }) {
  requireRepoRelativePosixPath(relative);
  const segments = relative.split("/");
  let current = root;
  const rootStat = await lstat(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("fixture evidence skill root must be a regular non-symlink directory");
  }
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    const stat = await lstatIfPresent(current);
    const leaf = index === segments.length - 1;
    if (!stat) {
      if (missingAllowed) return null;
      throw new Error(`fixture evidence path component is missing: ${relative}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`fixture evidence path contains a symlink or junction: ${relative}`);
    }
    if (!leaf && !stat.isDirectory()) {
      throw new Error(`fixture evidence parent must be a directory: ${relative}`);
    }
    if (leaf && kind === "file" && !stat.isFile()) {
      throw new Error(`fixture evidence path must be a regular file: ${relative}`);
    }
    if (leaf && kind === "directory" && !stat.isDirectory()) {
      throw new Error(`fixture evidence path must be a regular directory: ${relative}`);
    }
  }
  return lstat(current);
}

async function requireSafeRelativePath(relative, options) {
  return requireSafeRelativePathAt(SKILL_ROOT, relative, options);
}

export async function testOnlyInspectFixtureRelativePath(root, relative, options) {
  return requireSafeRelativePathAt(root, relative, options);
}

async function snapshotBoundFiles(relativePaths, { missingAllowed }) {
  const rows = [];
  for (const relative of relativePaths) {
    const absolute = join(SKILL_ROOT, ...relative.split("/"));
    const stat = await requireSafeRelativePath(relative, {
      kind: "file", missingAllowed,
    });
    if (!stat) {
      rows.push(Object.freeze({ path: relative, exists: false }));
      continue;
    }
    const bytes = await readFile(absolute);
    rows.push(Object.freeze({
      path: relative,
      exists: true,
      size: bytes.byteLength,
      sha256: sha256Bytes(bytes),
    }));
  }
  return Object.freeze(rows);
}

async function snapshotCurrentArchitectureInventory() {
  await requireSafeRelativePath("scripts", { kind: "directory", missingAllowed: false });
  const scriptsRoot = join(SKILL_ROOT, "scripts");
  const entries = await readdir(scriptsRoot, { withFileTypes: true });
  const selected = entries.filter((entry) => (
    entry.name.endsWith(".mjs")
      && (entry.name.startsWith("comment_chrome_")
        || entry.name.startsWith("comment_js_architecture_"))
  ));
  if (selected.some((entry) => !entry.isFile())) {
    throw new Error("fixture architecture inventory contains a non-regular module entry");
  }
  const paths = selected.map((entry) => `scripts/${entry.name}`);
  paths.push("scripts/comment_meta_snapshot_parser.mjs");
  paths.push("scripts/comment_fixture_browser_e2e.mjs");
  paths.push("scripts/comment_adapter_fixtures/fixture-runtime.js");
  const exact = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  return snapshotBoundFiles(exact, { missingAllowed: false });
}

export function testOnlyValidateArchitectureInventorySnapshot(receiptInventory, currentInventory) {
  if (!Array.isArray(receiptInventory) || !Array.isArray(currentInventory)
      || receiptInventory.length !== currentInventory.length || receiptInventory.length < 3) {
    throw new Error("fixture architecture inventory is not the exact current closed set");
  }
  for (let index = 0; index < receiptInventory.length; index += 1) {
    const saved = receiptInventory[index];
    const current = currentInventory[index];
    if (!saved || Object.keys(saved).sort().join(",") !== "bytes,path,role,sha256"
        || typeof saved.path !== "string" || typeof saved.role !== "string"
        || !Number.isSafeInteger(saved.bytes) || saved.bytes <= 0
        || typeof saved.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(saved.sha256)
        || !current || current.path !== saved.path || current.exists !== true
        || current.size !== saved.bytes || current.sha256 !== saved.sha256) {
      throw new Error(`fixture architecture inventory is stale at index ${index}`);
    }
  }
  return true;
}

async function snapshotDirectoryTree(relativeRoot) {
  const root = join(SKILL_ROOT, ...relativeRoot.split("/"));
  const rootStat = await requireSafeRelativePath(relativeRoot, {
    kind: "directory", missingAllowed: true,
  });
  if (!rootStat) return Object.freeze([{ path: `${relativeRoot}/`, exists: false }]);
  const rows = [{ path: `${relativeRoot}/`, exists: true, type: "directory" }];
  async function visit(absoluteDirectory, relativeDirectory) {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relative = `${relativeDirectory}/${entry.name}`;
      const absolute = join(absoluteDirectory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`active state tree contains a symlink: ${relative}`);
      if (stat.isDirectory()) {
        rows.push({ path: `${relative}/`, exists: true, type: "directory" });
        await visit(absolute, relative);
      } else if (stat.isFile()) {
        const bytes = await readFile(absolute);
        rows.push({
          path: relative,
          exists: true,
          type: "file",
          size: bytes.byteLength,
          sha256: sha256Bytes(bytes),
        });
      } else {
        throw new Error(`active state tree contains a non-regular entry: ${relative}`);
      }
    }
  }
  await visit(root, relativeRoot);
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

async function requireLivePolicyDisabled() {
  const path = join(SKILL_ROOT, "references", "comment-policy.json");
  await requireSafeRelativePath("references/comment-policy.json", {
    kind: "file", missingAllowed: false,
  });
  const bytes = await readFile(path);
  const policy = JSON.parse(bytes.toString("utf8"));
  if (policy?.live_browser_actuation_enabled !== false) {
    throw new Error("three-platform fixture requires live_browser_actuation_enabled=false");
  }
  return Object.freeze({ size: bytes.byteLength, sha256: sha256Bytes(bytes) });
}

export async function snapshotFixtureIntegrity() {
  const fixed = await snapshotBoundFiles(ACTIVE_STATE_PATHS, { missingAllowed: true });
  const data = await snapshotDirectoryTree("data");
  return Object.freeze({
    policy: await requireLivePolicyDisabled(),
    active: Object.freeze([...fixed, ...data]),
    sources: await snapshotBoundFiles(FIXTURE_SOURCE_PATHS, { missingAllowed: false }),
  });
}

export async function requireFreshFixtureArchitectureGate(sourceSnapshot) {
  await requireSafeRelativePath(ARCHITECTURE_RECEIPT_PATH, {
    kind: "file", missingAllowed: false,
  });
  await requireSafeRelativePath(ARCHITECTURE_SIDECAR_PATH, {
    kind: "file", missingAllowed: false,
  });
  const receiptBytes = await readFile(join(SKILL_ROOT, ...ARCHITECTURE_RECEIPT_PATH.split("/")));
  const sidecar = await readFile(
    join(SKILL_ROOT, ...ARCHITECTURE_SIDECAR_PATH.split("/")), "utf8",
  );
  const receiptSha256 = sha256Bytes(receiptBytes);
  if (sidecar !== `${receiptSha256}  js-architecture-gate.json\n`) {
    throw new Error("fixture architecture gate sidecar does not bind the receipt bytes");
  }
  const receiptText = receiptBytes.toString("utf8");
  const receipt = JSON.parse(receiptText);
  if (receiptText !== `${JSON.stringify(receipt, null, 2)}\n`) {
    throw new Error("fixture architecture gate receipt must be canonical JSON");
  }
  if (receipt?.schema_version !== 1
      || receipt?.gate !== "social-post-js-architecture-gate"
      || receipt?.status !== "PASS"
      || receipt?.marker !== "comment JS architecture gate passed"
      || receipt?.root !== "."
      || receipt?.output !== ARCHITECTURE_RECEIPT_PATH
      || receipt?.summary?.cycles !== 0
      || receipt?.summary?.failures !== 0
      || receipt?.summary?.external_dependencies !== 1
      || !Array.isArray(receipt?.findings)
      || receipt.findings.length !== 0) {
    throw new Error("fixture architecture gate receipt is not a passing canonical report");
  }
  const { evidence, ...core } = receipt;
  if (evidence?.algorithm !== "sha256"
      || evidence?.report_sha256 !== canonicalDigest(core)) {
    throw new Error("fixture architecture gate report digest is invalid");
  }
  for (const label of ["evaluator_sha256", "inventory_sha256", "graph_sha256", "policy_sha256", "report_sha256"]) {
    if (typeof evidence[label] !== "string" || !/^[0-9a-f]{64}$/u.test(evidence[label])) {
      throw new Error(`fixture architecture gate ${label} is invalid`);
    }
  }
  if (!Array.isArray(sourceSnapshot)
      || sourceSnapshot.length !== FIXTURE_SOURCE_PATHS.length
      || sourceSnapshot.some((source, index) => (
        source?.path !== FIXTURE_SOURCE_PATHS[index]
          || source?.exists !== true
          || !Number.isSafeInteger(source?.size)
          || source.size <= 0
          || typeof source?.sha256 !== "string"
          || !/^[0-9a-f]{64}$/u.test(source.sha256)
      ))) {
    throw new Error("fixture architecture gate source snapshot is not the exact reviewed set");
  }
  const sourceByPath = new Map(sourceSnapshot.map((source) => [source.path, source]));
  if (!Array.isArray(evidence.evaluator_files)
      || evidence.evaluator_files.length !== ARCHITECTURE_EVALUATOR_PATHS.length
      || evidence.evaluator_files.some((row, index) => {
        const current = sourceByPath.get(ARCHITECTURE_EVALUATOR_PATHS[index]);
        return row?.path !== ARCHITECTURE_EVALUATOR_PATHS[index]
          || Object.keys(row).sort().join(",") !== "path,sha256"
          || row.sha256 !== current?.sha256;
      })
      || evidence.evaluator_sha256 !== canonicalDigest(evidence.evaluator_files)) {
    throw new Error("fixture architecture gate evaluator evidence is stale or unreviewed");
  }
  if (!Array.isArray(receipt.inventory)
      || receipt.inventory.length !== receipt.summary.modules
      || evidence.inventory_sha256 !== canonicalDigest(receipt.inventory)
      || !Array.isArray(receipt.edges)
      || receipt.edges.length !== receipt.summary.edges
      || !Array.isArray(receipt.external_dependencies)
      || receipt.external_dependencies.length !== 1
      || JSON.stringify(receipt.external_dependencies[0])
        !== JSON.stringify(REVIEWED_BROWSER_CLIENT_DEPENDENCY)
      || evidence.graph_sha256 !== canonicalDigest({
        modules: receipt.inventory.map((row) => row.path),
        edges: receipt.edges,
        external_dependencies: receipt.external_dependencies,
      })) {
    throw new Error("fixture architecture gate inventory or graph digest is invalid");
  }
  const currentArchitectureInventory = await snapshotCurrentArchitectureInventory();
  testOnlyValidateArchitectureInventorySnapshot(
    receipt.inventory, currentArchitectureInventory,
  );
  const inventoryPaths = receipt.inventory.map((row) => row.path)
    .sort((left, right) => left.localeCompare(right));
  const reviewedManifest = Array.isArray(receipt?.inventory_scope?.reviewed_exact_manifest)
    ? [...receipt.inventory_scope.reviewed_exact_manifest]
      .sort((left, right) => left.localeCompare(right)) : null;
  if (!Array.isArray(receipt?.inventory_scope?.reviewed_exact_manifest)
      || JSON.stringify(reviewedManifest) !== JSON.stringify(inventoryPaths)) {
    throw new Error("fixture architecture gate reviewed manifest does not bind its inventory");
  }
  const inventory = new Map((receipt.inventory || []).map((row) => [row.path, row]));
  for (const source of sourceSnapshot) {
    if (!(source.path.endsWith(".mjs") || source.path.endsWith("fixture-runtime.js"))) continue;
    const architectureSource = inventory.get(source.path);
    if (!architectureSource || architectureSource.bytes !== source.size
        || architectureSource.sha256 !== source.sha256) {
      throw new Error(`fixture architecture gate is stale for ${source.path}`);
    }
  }
  return Object.freeze({
    gate: receipt.gate,
    status: receipt.status,
    receipt_sha256: receiptSha256,
    evaluator_sha256: evidence.evaluator_sha256,
    inventory_sha256: evidence.inventory_sha256,
    graph_sha256: evidence.graph_sha256,
    policy_sha256: evidence.policy_sha256,
    report_sha256: evidence.report_sha256,
  });
}

export function assertFixtureIntegrityUnchanged(before, after) {
  assert.deepEqual(after.sources, before.sources, "fixture source snapshot changed during the run");
  assert.deepEqual(after.active, before.active, "active comment state changed during the run");
  assert.deepEqual(after.policy, before.policy, "live policy bytes changed during the run");
  return true;
}

export async function startCanonicalFixtureServer() {
  const routes = new Map();
  for (const [route, relative, contentType] of [
    ["/facebook.html", "scripts/comment_adapter_fixtures/facebook.html", "text/html; charset=utf-8"],
    ["/instagram.html", "scripts/comment_adapter_fixtures/instagram.html", "text/html; charset=utf-8"],
    ["/threads.html", "scripts/comment_adapter_fixtures/threads.html", "text/html; charset=utf-8"],
    ["/fixture-runtime.js", "scripts/comment_adapter_fixtures/fixture-runtime.js", "text/javascript; charset=utf-8"],
  ]) {
    const absolute = join(SKILL_ROOT, ...relative.split("/"));
    await requireSafeRelativePath(relative, { kind: "file", missingAllowed: false });
    const body = await readFile(absolute);
    routes.set(route, Object.freeze({ relative, contentType, body, sha256: sha256Bytes(body) }));
  }
  const requests = [];
  const server = createServer((request, response) => {
    const method = request.method || "";
    let status = 404;
    let pathname = null;
    try {
      const parsed = new URL(request.url || "", "http://127.0.0.1");
      pathname = parsed.pathname;
      if (method !== "GET" || parsed.search || parsed.hash) {
        status = 400;
      } else {
        const fixture = routes.get(pathname);
        if (fixture) {
          status = 200;
          response.statusCode = status;
          response.setHeader("Content-Type", fixture.contentType);
          response.setHeader("Content-Length", String(fixture.body.byteLength));
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("X-Content-Type-Options", "nosniff");
          response.end(fixture.body);
        }
      }
    } catch {
      status = 400;
    }
    requests.push(Object.freeze({ method, path: pathname, status }));
    if (!response.writableEnded) {
      response.statusCode = status;
      response.setHeader("Cache-Control", "no-store");
      response.end(status === 400 ? "bad request" : "not found");
    }
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    server.close();
    throw new Error("fixture server failed to bind an ephemeral IPv4 loopback port");
  }
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    routes,
    close: () => new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
    }),
  });
}

export function requireCanonicalServerCoverage(serverEvidence) {
  const successful = new Set(
    serverEvidence.requests.filter((row) => row.status === 200).map((row) => row.path),
  );
  for (const route of serverEvidence.routes.keys()) {
    assert.equal(successful.has(route), true, `canonical fixture route was not loaded: ${route}`);
  }
  assert.equal(
    serverEvidence.requests.some((row) => row.status === 200 && !serverEvidence.routes.has(row.path)),
    false,
    "fixture server returned success for an unreviewed route",
  );
  return true;
}

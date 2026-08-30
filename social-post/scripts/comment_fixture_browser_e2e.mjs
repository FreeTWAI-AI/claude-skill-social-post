/** Localhost-only real-browser E2E driver for the comment Chrome send core. */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat, mkdir, open, readFile, rename, rm, rmdir,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Text } from "./comment_chrome_common.mjs";
import {
  assertFixtureIntegrityUnchanged,
  canonicalDigest,
  requireCanonicalServerCoverage,
  requireFreshFixtureArchitectureGate,
  snapshotFixtureIntegrity,
  startCanonicalFixtureServer,
} from "./comment_chrome_fixture_evidence_testonly.mjs";
import {
  createTrustedFixtureScanPlan,
  createTrustedFixtureScanPost,
} from "./comment_chrome_scan_fixture_testonly.mjs";
import {
  parseCanonicalThreePlatformFixtureReceipt,
} from "./comment_chrome_fixture_receipt_testonly.mjs";
import { createSendOperations } from "./comment_chrome_send.mjs";

const FIXTURE_PLATFORM_ORDER = Object.freeze(["facebook", "instagram", "threads"]);
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIRECTORY = resolve(SKILL_ROOT, "data");
const DATA_WRITE_LOCK = resolve(DATA_DIRECTORY, ".write.lock");
const RECEIPT_DIRECTORY = resolve(SKILL_ROOT, ".rd", "receipts");
const RECEIPT_PATH = resolve(RECEIPT_DIRECTORY, "three-platform-browser-fixture.json");
const SIDECAR_PATH = `${RECEIPT_PATH}.sha256`;
const RECEIPT_WRITE_LOCK = resolve(
  RECEIPT_DIRECTORY, ".three-platform-browser-fixture.lock",
);
const FIXTURE_READINESS_TIMEOUT_MS = 10000;

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function requireSafePath(path, kind, label, { required = false } = {}) {
  const stat = await lstatIfPresent(path);
  if (!stat) {
    if (required) throw new Error(`${label} is missing`);
    return null;
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink or junction`);
  if (kind === "directory" && !stat.isDirectory()) throw new Error(`${label} must be a directory`);
  if (kind === "file" && !stat.isFile()) throw new Error(`${label} must be a regular file`);
  return stat;
}

function stagedPathFor(target) {
  return join(dirname(target), `.${basename(target)}.${randomUUID()}.staged`);
}

async function stageTextFile(target, contents) {
  const temporary = stagedPathFor(target);
  let handle = null;
  try {
    await requireSafePath(dirname(target), "directory", "fixture receipt staging parent", {
      required: true,
    });
    await requireSafePath(target, "file", "fixture receipt target");
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = null;
    await requireSafePath(temporary, "file", "fixture receipt staged file", { required: true });
    if ((await readFile(temporary, "utf8")) !== contents) {
      throw new Error("fixture receipt staged read-back mismatch");
    }
    return Object.freeze({ temporary, target, contents });
  } catch (error) {
    const cleanupErrors = [];
    if (handle) {
      try { await handle.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    try { await rm(temporary, { force: true }); } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "fixture receipt staging cleanup failed");
    }
    throw error;
  }
}

async function publishStagedFile(staged, onRenamed, hooks = {}) {
  const verifyPath = hooks.verifyPath ?? requireSafePath;
  const renameFile = hooks.renameFile ?? rename;
  const readText = hooks.readText ?? ((path) => readFile(path, "utf8"));
  const removeFile = hooks.removeFile ?? ((path) => rm(path, { force: true }));
  await verifyPath(staged.temporary, "file", "fixture receipt staged file", {
    required: true,
  });
  await verifyPath(staged.target, "file", "fixture receipt publish target");
  await renameFile(staged.temporary, staged.target);
  onRenamed();
  try {
    if ((await readText(staged.target)) !== staged.contents) {
      throw new Error("fixture receipt publish read-back mismatch");
    }
  } catch (error) {
    try {
      await removeFile(staged.target);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError], "fixture receipt publish rollback failed",
      );
    }
    throw error;
  }
}

function withoutOwnedDataWriteLock(integrity) {
  const own = integrity.active.filter((row) => row.path === "data/.write.lock/");
  const descendants = integrity.active.filter((row) => row.path.startsWith("data/.write.lock/")
    && row.path !== "data/.write.lock/");
  if (own.length !== 1 || own[0].type !== "directory" || descendants.length !== 0) {
    throw new Error("owned data write lock is missing, duplicated, or not empty");
  }
  return Object.freeze({
    ...integrity,
    active: Object.freeze(integrity.active.filter((row) => row.path !== "data/.write.lock/")),
  });
}

async function acquireDirectoryLock(path, label) {
  try {
    await mkdir(path);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`${label} is already held`);
    throw error;
  }
  try {
    await requireSafePath(path, "directory", label, { required: true });
  } catch (error) {
    try {
      await rmdir(path);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${label} acquisition cleanup failed`);
    }
    throw error;
  }
}

async function releaseDirectoryLock(path, label) {
  await requireSafePath(path, "directory", label, { required: true });
  await rmdir(path);
}

async function removePublishedFixturePair() {
  const errors = [];
  for (const path of [RECEIPT_PATH, SIDECAR_PATH]) {
    try { await rm(path, { force: true }); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "fixture receipt pair rollback failed");
  }
}

async function readExistingFixturePair() {
  const receiptStat = await requireSafePath(RECEIPT_PATH, "file", "existing fixture receipt");
  const sidecarStat = await requireSafePath(SIDECAR_PATH, "file", "existing fixture sidecar");
  if (Boolean(receiptStat) !== Boolean(sidecarStat)) {
    throw new Error("existing fixture receipt pair is incomplete");
  }
  if (!receiptStat) return null;
  const receipt = await readFile(RECEIPT_PATH, "utf8");
  const sidecar = await readFile(SIDECAR_PATH, "utf8");
  const digest = createHash("sha256").update(receipt, "utf8").digest("hex");
  if (sidecar !== `${digest}  ${basename(RECEIPT_PATH)}\n`) {
    throw new Error("existing fixture receipt pair has an invalid sidecar");
  }
  return Object.freeze({ receipt, sidecar });
}

async function rollbackPublishedFixturePair(previousPair) {
  if (!previousPair) return removePublishedFixturePair();
  let receiptStage = null;
  let sidecarStage = null;
  let primaryError = null;
  try {
    receiptStage = await stageTextFile(RECEIPT_PATH, previousPair.receipt);
    sidecarStage = await stageTextFile(SIDECAR_PATH, previousPair.sidecar);
    await publishStagedFile(receiptStage, () => {});
    receiptStage = null;
    await publishStagedFile(sidecarStage, () => {});
    sidecarStage = null;
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  for (const stage of [receiptStage, sidecarStage]) {
    if (!stage) continue;
    try { await rm(stage.temporary, { force: true }); } catch (error) { cleanupErrors.push(error); }
  }
  if (primaryError || cleanupErrors.length > 0) {
    try { await removePublishedFixturePair(); } catch (error) { cleanupErrors.push(error); }
    throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      "fixture receipt pair restoration failed",
    );
  }
}

async function finalizeFixturePersistence(state, hooks = {}) {
  const operations = {
    rollbackPair: hooks.rollbackPair ?? rollbackPublishedFixturePair,
    removeStage: hooks.removeStage ?? ((stage) => rm(stage.temporary, { force: true })),
    releaseReceiptLock: hooks.releaseReceiptLock ?? (() => releaseDirectoryLock(
      RECEIPT_WRITE_LOCK, "fixture receipt write lock",
    )),
    releaseDataLock: hooks.releaseDataLock ?? (() => releaseDirectoryLock(
      DATA_WRITE_LOCK, "shared data write lock",
    )),
  };
  const cleanupErrors = [];
  let pairRemovalAttempted = false;
  const attempt = async (label, operation) => {
    try { await operation(); } catch (error) {
      cleanupErrors.push(new Error(`${label} failed`, { cause: error }));
    }
  };
  const removePair = async () => {
    pairRemovalAttempted = true;
    await attempt(
      "fixture receipt pair rollback", () => operations.rollbackPair(state.previousPair),
    );
  };

  if (state.primaryError && state.publishedAny) await removePair();
  if (state.receiptStage) await attempt(
    "fixture receipt staged-file cleanup", () => operations.removeStage(state.receiptStage),
  );
  if (state.sidecarStage) await attempt(
    "fixture sidecar staged-file cleanup", () => operations.removeStage(state.sidecarStage),
  );
  if (state.receiptLockHeld) await attempt(
    "fixture receipt lock release", operations.releaseReceiptLock,
  );
  if (state.dataLockHeld) await attempt(
    "shared data lock release", operations.releaseDataLock,
  );
  if (!state.primaryError && cleanupErrors.length > 0
      && state.publishedAny && !pairRemovalAttempted) {
    await removePair();
  }

  const failures = state.primaryError
    ? [state.primaryError, ...cleanupErrors] : cleanupErrors;
  if (failures.length > 0) {
    throw new AggregateError(failures, "fixture receipt persistence did not complete cleanly");
  }
  return state.result;
}

export async function testFixturePersistenceFinalizer() {
  const calls = [];
  const hooks = {
    rollbackPair: async () => { calls.push("rollback-pair"); },
    removeStage: async (stage) => {
      calls.push(`remove-${stage.name}`);
      if (stage.name === "receipt-stage") throw new Error("injected stage cleanup failure");
    },
    releaseReceiptLock: async () => {
      calls.push("release-receipt-lock");
      throw new Error("injected receipt lock release failure");
    },
    releaseDataLock: async () => { calls.push("release-data-lock"); },
  };
  await assert.rejects(finalizeFixturePersistence({
    primaryError: new Error("injected primary failure"),
    publishedAny: true,
    previousPair: Object.freeze({ receipt: "old", sidecar: "old-sidecar" }),
    receiptStage: { name: "receipt-stage" },
    sidecarStage: { name: "sidecar-stage" },
    receiptLockHeld: true,
    dataLockHeld: true,
    result: null,
  }, hooks), AggregateError);
  assert.deepEqual(calls, [
    "rollback-pair", "remove-receipt-stage", "remove-sidecar-stage",
    "release-receipt-lock", "release-data-lock",
  ]);

  const releaseFailureCalls = [];
  await assert.rejects(finalizeFixturePersistence({
    primaryError: null,
    publishedAny: true,
    previousPair: null,
    receiptStage: null,
    sidecarStage: null,
    receiptLockHeld: true,
    dataLockHeld: true,
    result: Object.freeze({ status: "PASS" }),
  }, {
    rollbackPair: async () => { releaseFailureCalls.push("rollback-pair"); },
    releaseReceiptLock: async () => { releaseFailureCalls.push("release-receipt-lock"); },
    releaseDataLock: async () => {
      releaseFailureCalls.push("release-data-lock");
      throw new Error("injected data lock release failure");
    },
  }), AggregateError);
  assert.deepEqual(releaseFailureCalls, [
    "release-receipt-lock", "release-data-lock", "rollback-pair",
  ]);

  const publishCalls = [];
  await assert.rejects(publishStagedFile(
    { temporary: "staged", target: "target", contents: "expected" },
    () => { publishCalls.push("renamed-callback"); },
    {
      verifyPath: async () => {},
      renameFile: async () => { publishCalls.push("rename"); },
      readText: async () => { publishCalls.push("readback"); return "mismatch"; },
      removeFile: async () => { publishCalls.push("remove-target"); },
    },
  ), /read-back mismatch/u);
  assert.deepEqual(publishCalls, [
    "rename", "renamed-callback", "readback", "remove-target",
  ]);
  return true;
}

async function persistVerifiedFixtureReceipt(serialized, integrityBefore, architectureGate) {
  const parsed = parseCanonicalThreePlatformFixtureReceipt(serialized);
  if (JSON.stringify(parsed.architecture_gate) !== JSON.stringify(architectureGate)) {
    throw new Error("fixture receipt architecture evidence changed before persistence");
  }
  await requireSafePath(SKILL_ROOT, "directory", "skill root", { required: true });
  await requireSafePath(DATA_DIRECTORY, "directory", "data directory", { required: true });
  await requireSafePath(resolve(SKILL_ROOT, ".rd"), "directory", ".rd", { required: true });
  await requireSafePath(RECEIPT_DIRECTORY, "directory", ".rd/receipts");
  await mkdir(RECEIPT_DIRECTORY, { recursive: true });
  await requireSafePath(RECEIPT_DIRECTORY, "directory", ".rd/receipts", { required: true });

  let dataLockHeld = false;
  let receiptLockHeld = false;
  let receiptStage = null;
  let sidecarStage = null;
  let publishedAny = false;
  let previousPair = null;
  let primaryError = null;
  let result = null;
  try {
    await acquireDirectoryLock(DATA_WRITE_LOCK, "shared data write lock");
    dataLockHeld = true;
    await acquireDirectoryLock(RECEIPT_WRITE_LOCK, "fixture receipt write lock");
    receiptLockHeld = true;
    previousPair = await readExistingFixturePair();

    const currentArchitecture = await requireFreshFixtureArchitectureGate(integrityBefore.sources);
    if (JSON.stringify(currentArchitecture) !== JSON.stringify(architectureGate)) {
      throw new Error("fixture architecture gate changed before receipt publish");
    }
    const beforePublish = withoutOwnedDataWriteLock(await snapshotFixtureIntegrity());
    assertFixtureIntegrityUnchanged(integrityBefore, beforePublish);

    receiptStage = await stageTextFile(RECEIPT_PATH, serialized);
    const receiptDigest = createHash("sha256").update(serialized, "utf8").digest("hex");
    sidecarStage = await stageTextFile(
      SIDECAR_PATH, `${receiptDigest}  ${basename(RECEIPT_PATH)}\n`,
    );
    const afterStage = withoutOwnedDataWriteLock(await snapshotFixtureIntegrity());
    assertFixtureIntegrityUnchanged(integrityBefore, afterStage);

    await publishStagedFile(receiptStage, () => { publishedAny = true; });
    receiptStage = null;
    await publishStagedFile(sidecarStage, () => { publishedAny = true; });
    sidecarStage = null;

    const afterPublish = withoutOwnedDataWriteLock(await snapshotFixtureIntegrity());
    assertFixtureIntegrityUnchanged(integrityBefore, afterPublish);
    result = Object.freeze({
      receipt: ".rd/receipts/three-platform-browser-fixture.json",
      sidecar: ".rd/receipts/three-platform-browser-fixture.json.sha256",
    });
  } catch (error) {
    primaryError = error;
  }
  return finalizeFixturePersistence({
    primaryError, publishedAny, previousPair, receiptStage, sidecarStage,
    receiptLockHeld, dataLockHeld, result,
  });
}

const FIXTURES = {
  facebook: {
    file: "facebook.html", postKey: "fixture-facebook-post", commentId: "fb-comment-001",
    decoyId: "fb-comment-decoy",
    viewer: "viewer-facebook", body: "這個測試太精彩了🔥", reply: "謝謝你來看這個測試！",
    receiptUrl: "https://www.facebook.com/fixture/posts/fixture-facebook-post",
    target: "[data-fb-comment-id]", idAttribute: "data-fb-comment-id",
    author: "[data-fb-author]", bodySelector: "[data-fb-body]",
    trigger: "[data-fb-reply-trigger]",
    composer: "[data-fb-composer]", submit: "[data-fb-submit]",
    replyItems: "[data-fb-own-reply]",
  },
  instagram: {
    file: "instagram.html", postKey: "fixture-instagram-post", commentId: "ig-comment-001",
    decoyId: "ig-comment-decoy",
    viewer: "viewer-instagram", body: "女主角下一集會反擊嗎？", reply: "下一集就會揭曉。",
    receiptUrl: "https://www.instagram.com/p/fixture-instagram-post",
    target: "[data-ig-comment-id]", idAttribute: "data-ig-comment-id",
    author: "[data-ig-author]", bodySelector: "[data-ig-body]",
    trigger: "[data-ig-reply-trigger]",
    composer: "[data-ig-composer]", submit: "[data-ig-submit]",
    replyItems: "[data-ig-own-reply]",
  },
  threads: {
    file: "threads.html", postKey: "fixture-threads-post", commentId: "threads-reply-001",
    decoyId: "threads-reply-decoy",
    viewer: "viewer-threads", body: "有下一集記得通知我！", reply: "有更新我會公開發出來！",
    receiptUrl: "https://www.threads.com/@fixture/post/fixture-threads-post",
    target: "[data-threads-reply-id]", idAttribute: "data-threads-reply-id",
    author: "[data-threads-author]", bodySelector: "[data-threads-body]",
    trigger: "[data-threads-reply-trigger]",
    composer: "[data-threads-composer]", submit: "[data-threads-submit]",
    replyItems: "[data-threads-own-reply]",
  },
};

function values(platform, baseUrl, runNonce) {
  const fixture = FIXTURES[platform];
  if (!fixture) throw new Error(`unknown fixture platform ${platform}`);
  const sessionId = `fixture-session-${runNonce}-${platform}`;
  const scope = {
    platform, account_key: "fixture-account", post_key: fixture.postKey,
    comment_key: `${platform}:fixture-account:${fixture.postKey}:${fixture.commentId}`,
  };
  const action = {
    schema_version: 1, action_id: `fixture-action-${runNonce}-${platform}`,
    intent_id: `fixture-intent-${runNonce}-${platform}`, session_id: sessionId,
    permit_id: `fixture-permit-${runNonce}-${platform}`, scope,
    post_permalink: fixture.receiptUrl,
    comment_fingerprint: `fixture-fingerprint-${platform}`,
    reply_hash: sha256Text(fixture.reply), reply_text: fixture.reply,
    expected_body: fixture.body, author_key: fixture.viewer,
    comment_anchor: { platform_comment_id: fixture.commentId, comment_permalink: null },
  };
  const exactTarget = `${fixture.target}[${fixture.idAttribute}="${fixture.commentId}"]`;
  const decoyTarget = `${fixture.target}[${fixture.idAttribute}="${fixture.decoyId}"]`;
  const plan = {
    account: { selector: "html", attribute: "data-account-key" },
    post: { selector: "html", attribute: "data-post-key" },
    target: { selector: exactTarget },
    targetAnchor: { selector: ":scope", within: "target", self: true, attribute: fixture.idAttribute },
    author: { selector: ":scope", within: "target", self: true, attribute: "data-author-key" },
    body: { selector: fixture.bodySelector, within: "target" },
    replyTrigger: { selector: fixture.trigger, within: "target" },
    composer: { selector: fixture.composer, within: "target", valueProperty: true },
    submit: { selector: fixture.submit, within: "target" },
    replyItems: { selector: fixture.replyItems, within: "target" },
    replyAuthor: { selector: "[data-fixture-own-author]", within: "reply" },
    replyBody: { selector: "[data-fixture-own-body]", within: "reply" },
    replyExpansionControls: { selector: "[data-fixture-reply-expand-control]", within: "target" },
    replyExhaustion: {
      schemaVersion: 1,
      state: {
        selector: "[data-fixture-reply-exhaustion-state]", within: "target",
        cursorAttribute: "data-reply-cursor",
        discoveredCountAttribute: "data-reply-discovered-count",
        terminalAttribute: "data-reply-terminal",
      },
      viewportTraversalControl: {
        selector: "[data-fixture-reply-next-viewport]", within: "target",
      },
      stableInstanceAttribute: "data-reply-control-instance",
      maxControlsPerRead: 20,
      maxClicks: 20,
      maxViewportTraversals: 20,
      maxObservationPasses: 60,
      maxElapsedMs: 10000,
      settleMs: 0,
      stableReadDelayMs: 0,
    },
  };
  const scanRequest = {
    schema_version: 1, scan_request_id: `fixture-scan-${runNonce}-${platform}`,
    session_id: sessionId, platform, account_key: "fixture-account",
    post_key: fixture.postKey, post_permalink: fixture.receiptUrl,
  };
  const scanPlan = createTrustedFixtureScanPlan(platform);
  return {
    fixture, action, plan, scanRequest, scanPlan, exactTarget, decoyTarget,
    pageUrl: `${baseUrl.replace(/\/$/, "")}/${fixture.file}`,
  };
}

export function requireLoopbackBaseUrl(raw) {
  const url = new URL(raw);
  const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (url.protocol !== "http:" || !loopback.has(url.hostname)
      || url.username || url.password || url.search || url.hash) {
    throw new Error("fixture Browser E2E requires a plain loopback HTTP base URL");
  }
  return url.toString().replace(/\/$/u, "");
}

function requireExactFixturePageUrl(expectedRaw, observedRaw) {
  const expected = requireLoopbackBaseUrl(expectedRaw);
  const observed = requireLoopbackBaseUrl(observedRaw);
  if (new URL(observed).href !== new URL(expected).href) {
    throw new Error(`fixture navigation resolved to an unexpected URL: ${observed}`);
  }
  return observed;
}

async function waitForFixtureDocumentReady(tab, platform, setup, {
  timeoutMs = FIXTURE_READINESS_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || timeoutMs > FIXTURE_READINESS_TIMEOUT_MS) {
    throw new Error("fixture readiness timeout must be a bounded positive integer");
  }
  const expectedPageUrl = requireLoopbackBaseUrl(setup.pageUrl);
  await tab.playwright.waitForURL(expectedPageUrl, {
    waitUntil: "load", timeoutMs,
  });
  await tab.playwright.waitForLoadState({ state: "load", timeoutMs });
  const observedPageUrl = requireExactFixturePageUrl(expectedPageUrl, await tab.url());

  const readySelector = [
    "html[data-fixture-origin=\"local-only\"]",
    "[data-fixture-runtime-state=\"ready\"]",
    "[data-authentication-state=\"authenticated\"]",
    `[data-platform="${platform}"]`,
  ].join("");
  const readyRoot = tab.playwright.locator(readySelector);
  await readyRoot.waitFor({ state: "visible", timeoutMs });
  assert.equal(
    await readyRoot.count(), 1,
    `${platform} fixture must expose exactly one ready document root`,
  );

  const root = tab.playwright.locator("html");
  assert.equal(await root.count(), 1, `${platform} fixture must expose exactly one html root`);
  for (const [attribute, expected] of [
    ["data-fixture-origin", "local-only"],
    ["data-fixture-runtime-state", "ready"],
    ["data-authentication-state", "authenticated"],
    ["data-platform", platform],
    ["data-account-key", "fixture-account"],
    ["data-post-key", setup.fixture.postKey],
  ]) {
    assert.equal(
      await root.getAttribute(attribute), expected,
      `${platform} fixture document identity mismatch for ${attribute}`,
    );
  }

  const targets = tab.playwright.locator(setup.fixture.target);
  await targets.nth(0).waitFor({ state: "attached", timeoutMs });
  const targetCount = await targets.count();
  assert.equal(targetCount, 2, `${platform} fixture must expose exactly two comment targets`);
  const targetIds = [];
  for (let index = 0; index < targetCount; index += 1) {
    const target = targets.nth(index);
    await target.waitFor({ state: "visible", timeoutMs });
    assert.equal(
      await target.isVisible(), true,
      `${platform} fixture comment target ${index} is not stably visible`,
    );
    const attributeId = await target.getAttribute(setup.fixture.idAttribute);
    const evaluatedIds = await target.evaluateAll((elements, attribute) => (
      elements.map((element) => element.getAttribute(attribute))
    ), setup.fixture.idAttribute);
    assert.equal(
      Array.isArray(evaluatedIds)
        && evaluatedIds.length === 1
        && typeof evaluatedIds[0] === "string"
        && evaluatedIds[0] === attributeId,
      true,
      `${platform} fixture locator evaluation channel is not identity-stable`,
    );
    targetIds.push(attributeId);
  }
  assert.deepEqual(
    new Set(targetIds),
    new Set([setup.fixture.commentId, setup.fixture.decoyId]),
    `${platform} fixture target identities changed before scan`,
  );
  return Object.freeze({
    platform,
    page_url: observedPageUrl,
    runtime_state: "ready",
    target_count: targetCount,
  });
}

function readinessFake(platform, setup, {
  observedUrl = setup.pageUrl,
  targetIds = [setup.fixture.commentId, setup.fixture.decoyId],
  rootOverrides = {},
} = {}) {
  const calls = [];
  const attributes = {
    "data-fixture-origin": "local-only",
    "data-fixture-runtime-state": "ready",
    "data-authentication-state": "authenticated",
    "data-platform": platform,
    "data-account-key": "fixture-account",
    "data-post-key": setup.fixture.postKey,
    ...rootOverrides,
  };
  const targetLocator = {
    count: async () => targetIds.length,
    nth: (index) => ({
      waitFor: async (options) => { calls.push(["target.waitFor", index, options]); },
      isVisible: async () => true,
      evaluateAll: async (_fn, attribute) => (
        attribute === setup.fixture.idAttribute ? [targetIds[index] ?? null] : [null]
      ),
      getAttribute: async (attribute) => (
        attribute === setup.fixture.idAttribute ? targetIds[index] ?? null : null
      ),
    }),
  };
  const rootLocator = {
    count: async () => 1,
    getAttribute: async (attribute) => attributes[attribute] ?? null,
  };
  const readyLocator = {
    waitFor: async (options) => { calls.push(["ready.waitFor", options]); },
    count: async () => 1,
  };
  return {
    calls,
    tab: {
      url: async () => observedUrl,
      playwright: {
        waitForURL: async (url, options) => { calls.push(["waitForURL", url, options]); },
        waitForLoadState: async (options) => { calls.push(["waitForLoadState", options]); },
        locator: (selector) => {
          if (selector === "html") return rootLocator;
          if (selector === setup.fixture.target) return targetLocator;
          if (selector.startsWith("html[data-fixture-origin=")) return readyLocator;
          throw new Error(`unexpected readiness locator ${selector}`);
        },
      },
    },
  };
}

export async function testFixtureNavigationReadiness() {
  for (const candidatePlatform of FIXTURE_PLATFORM_ORDER) {
    const candidate = values(
      candidatePlatform, "http://127.0.0.1:8765", `adapter-contract-${candidatePlatform}`,
    );
    assert.equal(
      candidate.scanPlan.comments.selector, candidate.fixture.target,
      `${candidatePlatform} fixture scan collection selector drifted from its served DOM`,
    );
    assert.equal(
      candidate.scanPlan.commentId.attribute, candidate.fixture.idAttribute,
      `${candidatePlatform} fixture scan identity attribute drifted from its served DOM`,
    );
  }
  const platform = "instagram";
  const setup = values(platform, "http://127.0.0.1:8765", "readiness-test");
  const valid = readinessFake(platform, setup);
  const evidence = await waitForFixtureDocumentReady(valid.tab, platform, setup);
  assert.deepEqual(evidence, {
    platform,
    page_url: setup.pageUrl,
    runtime_state: "ready",
    target_count: 2,
  });
  assert.deepEqual(valid.calls.slice(0, 3), [
    ["waitForURL", setup.pageUrl, { waitUntil: "load", timeoutMs: 10000 }],
    ["waitForLoadState", { state: "load", timeoutMs: 10000 }],
    ["ready.waitFor", { state: "visible", timeoutMs: 10000 }],
  ]);

  const wrongPlatform = readinessFake(platform, setup, {
    rootOverrides: { "data-platform": "facebook" },
  });
  await assert.rejects(
    waitForFixtureDocumentReady(wrongPlatform.tab, platform, setup),
    /document identity mismatch for data-platform/u,
  );
  const missingTarget = readinessFake(platform, setup, {
    targetIds: [setup.fixture.commentId],
  });
  await assert.rejects(
    waitForFixtureDocumentReady(missingTarget.tab, platform, setup),
    /exactly two comment targets/u,
  );
  const remoteRedirect = readinessFake(platform, setup, {
    observedUrl: "https://www.instagram.com/p/untrusted",
  });
  await assert.rejects(
    waitForFixtureDocumentReady(remoteRedirect.tab, platform, setup),
    /plain loopback HTTP base URL/u,
  );
  await assert.rejects(
    waitForFixtureDocumentReady(valid.tab, platform, setup, { timeoutMs: 10001 }),
    /bounded positive integer/u,
  );
  return true;
}

export function assertSnapshotsUnchanged(before, after, label) {
  assert.deepEqual(after, before, `${label} changed during the fixture run`);
  return true;
}

function requireFixtureResult(row, expectedPlatform) {
  assert.equal(row?.platform, expectedPlatform, "fixture platform order or identity changed");
  requireLoopbackBaseUrl(row.page_url);
  for (const [label, value] of [
    ["scan", row.scan], ["preflight", row.preflight],
    ["attempt", row.attempt], ["result", row.result],
  ]) {
    assert.equal(value?.test_only, true, `${expectedPlatform} ${label} must be test-only`);
  }
  assert.equal(row.dom?.submit_attempts, 1);
  assert.equal(row.dom?.accepted_count, 1);
  assert.equal(row.dom?.reply_trigger_attempts, 1);
  assert.equal(row.dom?.composer_empty, true);
  assert.equal(row.dom?.submit_disabled, true);
  assert.equal(row.dom?.decoy_reply_count, 0);
  assert.equal(row.result?.exact_reply_visible, true);
  assert.equal(row.result?.own_author_verified, true);
  assert.equal(row.result?.parent_verified, true);
  return true;
}

export function validateExactFixtureBatch(rows) {
  assert.equal(Array.isArray(rows), true, "fixture results must be an array");
  assert.equal(rows.length, FIXTURE_PLATFORM_ORDER.length, "fixture run must contain all three platforms");
  assert.deepEqual(
    rows.map((row) => row?.platform),
    FIXTURE_PLATFORM_ORDER,
    "fixture run must use the exact fixed facebook/instagram/threads order",
  );
  assert.equal(new Set(rows.map((row) => row.platform)).size, FIXTURE_PLATFORM_ORDER.length);
  rows.forEach((row, index) => requireFixtureResult(row, FIXTURE_PLATFORM_ORDER[index]));
  return true;
}

async function runFixtureBrowserE2E(tab, platform, {
  baseUrl = "http://127.0.0.1:8765", navigate = true, runNonce = "manual",
} = {}) {
  const setup = values(platform, requireLoopbackBaseUrl(baseUrl), runNonce);
  if (navigate) await tab.goto(setup.pageUrl);
  await waitForFixtureDocumentReady(tab, platform, setup);
  const claimed = new Set();
  const send = createSendOperations({ claimSubmit: async (request) => {
    if (claimed.has(request.action_id)) throw new Error("fixture durable claim already consumed");
    claimed.add(request.action_id);
    return {
      ...request, decision: "WRITE_OK", claim_id: `fixture-claim-${runNonce}-${platform}`,
      preflight_id: `fixture-preflight-${runNonce}-${platform}`,
    };
  } });
  const testOptions = { testOnly: true, receiptObservedUrl: setup.fixture.receiptUrl };
  const scanFixture = createTrustedFixtureScanPost();
  const scan = await scanFixture(tab, setup.scanRequest, setup.scanPlan, testOptions);
  assert.equal(scan.comments.length, 2);
  assert.deepEqual(
    new Set(scan.comments.map((comment) => comment.platform_comment_id)),
    new Set([setup.fixture.commentId, setup.fixture.decoyId]),
  );
  const preflight = await send.prepareReply(tab, setup.action, setup.plan, testOptions);
  const attempt = await send.submitOnce(
    tab, setup.action, setup.plan, preflight, testOptions,
  );
  const result = await send.inspectResult(
    tab, setup.action, setup.plan, attempt, preflight, testOptions,
  );
  const root = tab.playwright.locator("html");
  const target = tab.playwright.locator(setup.exactTarget);
  const decoy = tab.playwright.locator(setup.decoyTarget);
  const composer = target.locator(setup.fixture.composer);
  const submit = target.locator(setup.fixture.submit);
  const decoyReplies = decoy.locator(setup.fixture.replyItems);
  const attempts = await root.getAttribute("data-submit-attempts");
  const accepted = await root.getAttribute("data-accepted-count");
  const triggerAttempts = await root.getAttribute("data-reply-trigger-attempts");
  const parent = await root.getAttribute("data-accepted-parent-comment-id");
  const composerValue = await composer.evaluate((element) => (
    "value" in element ? element.value : element.textContent
  ));
  const submitDiagnostic = JSON.stringify({
    platform, attempts, accepted, triggerAttempts, parent,
    submission_attempted: attempt.submission_attempted,
    submission_possible: attempt.submission_possible,
    pre_click_error: attempt.pre_click_error ?? null,
    click_error: attempt.click_error ?? null,
  });
  assert.equal(attempts, "1", `fixture submit attempt mismatch: ${submitDiagnostic}`);
  assert.equal(accepted, "1", `fixture accepted-count mismatch: ${submitDiagnostic}`);
  assert.equal(triggerAttempts, "1");
  assert.equal(parent, setup.fixture.commentId);
  assert.equal(composerValue, "");
  assert.equal(await submit.isEnabled(), false);
  const decoyReplyCount = await decoyReplies.count();
  assert.equal(decoyReplyCount, 0);
  assert.equal(result.exact_reply_visible, true);
  assert.equal(result.own_author_verified, true);
  assert.equal(result.parent_verified, true);
  return { platform, page_url: setup.pageUrl, scan, preflight, attempt, result, dom: {
    submit_attempts: Number(attempts), accepted_count: Number(accepted),
    reply_trigger_attempts: Number(triggerAttempts),
    parent_comment_id: parent, composer_empty: composerValue === "", submit_disabled: true,
    decoy_reply_count: decoyReplyCount,
  } };
}

function summarizedResult(row) {
  return Object.freeze({
    platform: row.platform,
    page_url: row.page_url,
    scanned_comment_count: row.scan.comments.length,
    action_id: row.result.action_id,
    parent_comment_id: row.dom.parent_comment_id,
    submit_attempts: row.dom.submit_attempts,
    accepted_count: row.dom.accepted_count,
    reply_trigger_attempts: row.dom.reply_trigger_attempts,
    decoy_reply_count: row.dom.decoy_reply_count,
    exact_reply_visible: row.result.exact_reply_visible,
    own_author_verified: row.result.own_author_verified,
    parent_verified: row.result.parent_verified,
    test_only: row.result.test_only,
    phase_sha256: Object.freeze({
      scan: canonicalDigest(row.scan),
      preflight: canonicalDigest(row.preflight),
      attempt: canonicalDigest(row.attempt),
      result: canonicalDigest(row.result),
    }),
  });
}

export async function runAllFixtureBrowserE2E(tab) {
  if (!tab || typeof tab.goto !== "function" || !tab.playwright) {
    throw new Error("three-platform fixture requires one controlled Browser tab");
  }
  const integrityBefore = await snapshotFixtureIntegrity();
  const architectureGate = await requireFreshFixtureArchitectureGate(integrityBefore.sources);
  let ownedServer = null;
  let failure = null;
  const rows = [];
  const runNonce = randomUUID();
  try {
    ownedServer = await startCanonicalFixtureServer();
    for (const platform of FIXTURE_PLATFORM_ORDER) {
      try {
        rows.push(await runFixtureBrowserE2E(tab, platform, {
          baseUrl: ownedServer.baseUrl,
          navigate: true,
          runNonce,
        }));
      } catch (error) {
        throw new Error(`fixture ${platform} failed: ${error?.message || String(error)}`, {
          cause: error,
        });
      }
    }
    validateExactFixtureBatch(rows);
    requireCanonicalServerCoverage(ownedServer);
  } catch (error) {
    failure = error;
  } finally {
    if (ownedServer) {
      try {
        await ownedServer.close();
      } catch (error) {
        failure = failure
          ? new AggregateError([failure, error], "fixture run and server cleanup both failed")
          : error;
      }
    }
    try {
      const integrityAfter = await snapshotFixtureIntegrity();
      assertFixtureIntegrityUnchanged(integrityBefore, integrityAfter);
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], "fixture run and integrity verification both failed")
        : error;
    }
  }
  if (failure) throw failure;
  const receipt = Object.freeze({
    schema_version: 1,
    gate: "social-post-three-platform-browser-fixture",
    status: "PASS",
    hash_algorithm: "sha256",
    run_id: runNonce,
    evidence_scope: "localhost_test_only_candidate",
    capability_promotion_eligible: false,
    live_browser_actuation_enabled: false,
    claim_authority: "in_memory_test_only",
    trusted_host_verified: false,
    stable_node_frame_mapping_verified: false,
    does_not_prove: Object.freeze([
      "authenticated Meta host authority",
      "live Meta draft or send",
      "stable tab/frame/document mapping",
      "automatic reply eligibility",
    ]),
    platform_order: FIXTURE_PLATFORM_ORDER,
    observed_at: new Date().toISOString(),
    browser_surface: Object.freeze({
      goto: typeof tab.goto === "function",
      playwright: Boolean(tab.playwright),
      dom_cua: Boolean(tab.dom_cua),
    }),
    architecture_gate: architectureGate,
    owned_ephemeral_loopback_server: true,
    served_sources: Object.freeze([...ownedServer.routes.entries()].map(([route, item]) => (
      Object.freeze({ route, path: item.relative, size: item.body.byteLength, sha256: item.sha256 })
    ))),
    request_log: Object.freeze([...ownedServer.requests]),
    active_state_unchanged: true,
    policy_sha256: integrityBefore.policy.sha256,
    active_state_snapshot_sha256: canonicalDigest(integrityBefore.active),
    source_snapshot_sha256: canonicalDigest(integrityBefore.sources),
    sources: integrityBefore.sources,
    results: Object.freeze(rows.map(summarizedResult)),
  });
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  await persistVerifiedFixtureReceipt(serialized, integrityBefore, architectureGate);
  return receipt;
}

export function fixturePlatforms() { return FIXTURE_PLATFORM_ORDER; }

function isDirectNodeExecution() {
  const entry = typeof process === "undefined" ? undefined : process.argv?.[1];
  if (typeof entry !== "string" || !entry) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectNodeExecution()) {
  throw new Error(
    "NOT_RUN: comment_fixture_browser_e2e.mjs requires a controlled Browser tab; "
    + "import runAllFixtureBrowserE2E(tab) from the Browser Node session instead of running this file directly",
  );
}

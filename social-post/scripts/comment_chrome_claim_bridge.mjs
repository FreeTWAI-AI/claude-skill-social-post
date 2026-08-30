/** Durable, shell-free bridge from the Chrome actuator to the Python comment ledger. */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { digestObject, fail, requiredString } from "./comment_chrome_common.mjs";
import { createScanPost } from "./comment_chrome_scan.mjs";
import { createSendOperations } from "./comment_chrome_send.mjs";


const DEFAULT_SCRIPT = fileURLToPath(new URL("./comment_assistant.py", import.meta.url));
const MAX_OUTPUT_BYTES = 1024 * 1024;
const pythonLedgerClaimSubmits = new WeakSet();
const pythonLedgerReceiptCommitters = new WeakMap();
const pythonLedgerRecoveryStarters = new WeakMap();
const RECEIPT_OPERATIONS = new Set(["browser-finish", "browser-reconcile"]);
const SCAN_OPERATION = "browser-scan";

export function isPythonLedgerClaimSubmit(value) {
  return typeof value === "function" && pythonLedgerClaimSubmits.has(value);
}

function collect(stream, child, label) {
  return new Promise((resolve, reject) => {
    let value = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      value += chunk;
      if (Buffer.byteLength(value, "utf8") > MAX_OUTPUT_BYTES) {
        child.kill();
        reject(new Error(`${label} exceeded ${MAX_OUTPUT_BYTES} bytes`));
      }
    });
    stream.on("end", () => resolve(value));
    stream.on("error", reject);
  });
}

async function runPythonClaim({
  pythonCommand = "python", scriptPath = DEFAULT_SCRIPT, root, intentId, sessionId,
  preparation, spawnImpl = spawn, timeoutMs = 15000,
}) {
  const args = [
    requiredString(scriptPath, "claim bridge scriptPath"),
    "browser-begin", "-", "--intent-id", requiredString(intentId, "claim bridge intentId"),
    "--session-id", requiredString(sessionId, "claim bridge sessionId"),
  ];
  if (root !== undefined) args.push("--root", requiredString(root, "claim bridge root"));
  args.push("--write");
  const child = spawnImpl(requiredString(pythonCommand, "claim bridge pythonCommand"), args, {
    shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutPromise = collect(child.stdout, child, "claim bridge stdout");
  const stderrPromise = collect(child.stderr, child, "claim bridge stderr");
  child.stdin.end(`${JSON.stringify(preparation)}\n`, "utf8");
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`durable ledger claim timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (code !== 0) {
    const detail = stderr.trim().slice(0, 1000) || `exit code ${code}`;
    fail(`durable ledger claim failed: ${detail}`);
  }
  const lines = stdout.split(/\r?\n/u)
    .filter((line) => line.startsWith("SUBMIT_CLAIM "));
  if (lines.length !== 1) fail("durable ledger claim returned no unique SUBMIT_CLAIM receipt");
  try {
    return JSON.parse(lines[0].slice("SUBMIT_CLAIM ".length));
  } catch {
    fail("durable ledger claim returned malformed JSON");
  }
}

async function runPythonScanRequest({
  pythonCommand = "python", scriptPath = DEFAULT_SCRIPT, root, target,
  spawnImpl = spawn, timeoutMs = 15000,
}) {
  const ttlMinutes = target.ttl_minutes ?? 10;
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1) {
    fail("scan bridge ttl_minutes must be a positive integer");
  }
  const args = [
    requiredString(scriptPath, "scan bridge scriptPath"), "browser-scan-request",
    "--platform", requiredString(target.platform, "scan target.platform"),
    "--account-key", requiredString(target.account_key, "scan target.account_key"),
    "--post-key", requiredString(target.post_key, "scan target.post_key"),
    "--post-permalink", requiredString(target.post_permalink, "scan target.post_permalink"),
    "--session-id", requiredString(target.session_id, "scan target.session_id"),
    "--ttl-minutes", String(ttlMinutes), "--internal-fused",
  ];
  if (root !== undefined) args.push("--root", requiredString(root, "scan bridge root"));
  args.push("--write");
  const child = spawnImpl(requiredString(pythonCommand, "scan bridge pythonCommand"), args, {
    shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutPromise = collect(child.stdout, child, "scan request bridge stdout");
  const stderrPromise = collect(child.stderr, child, "scan request bridge stderr");
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`durable scan request timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (code !== 0) {
    const detail = stderr.trim().slice(0, 1000) || `exit code ${code}`;
    fail(`durable scan request failed: ${detail}`);
  }
  const lines = stdout.split(/\r?\n/u)
    .filter((line) => line.startsWith("INTERNAL_SCAN_CAPABILITY "));
  if (lines.length !== 1) {
    fail("durable scan request returned no unique internal capability");
  }
  try {
    return JSON.parse(lines[0].slice("INTERNAL_SCAN_CAPABILITY ".length));
  } catch {
    fail("durable scan request returned malformed JSON");
  }
}

async function runPythonScanCommit({
  pythonCommand = "python", scriptPath = DEFAULT_SCRIPT, root, request, envelope,
  spawnImpl = spawn, timeoutMs = 15000,
}) {
  const args = [
    requiredString(scriptPath, "scan commit bridge scriptPath"), "browser-scan", "-",
    "--scan-request-id", requiredString(
      request.scan_request_id, "scan request.scan_request_id",
    ),
    "--session-id", requiredString(request.session_id, "scan request.session_id"),
  ];
  if (root !== undefined) args.push("--root", requiredString(root, "scan commit bridge root"));
  args.push("--write");
  const child = spawnImpl(
    requiredString(pythonCommand, "scan commit bridge pythonCommand"), args,
    { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const stdoutPromise = collect(child.stdout, child, "scan commit bridge stdout");
  const stderrPromise = collect(child.stderr, child, "scan commit bridge stderr");
  child.stdin.end(`${JSON.stringify(envelope)}\n`, "utf8");
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`durable scan commit timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (code !== 0) {
    const detail = stderr.trim().slice(0, 1000) || `exit code ${code}`;
    fail(`durable scan commit failed: ${detail}`);
  }
  const lines = stdout.split(/\r?\n/u)
    .filter((line) => line.startsWith("SCAN_COMMIT "));
  if (lines.length !== 1) fail("durable scan commit returned no unique receipt");
  try {
    return JSON.parse(lines[0].slice("SCAN_COMMIT ".length));
  } catch {
    fail("durable scan commit returned malformed JSON");
  }
}

async function runPythonReceipt({
  operation, pythonCommand = "python", scriptPath = DEFAULT_SCRIPT, root,
  intentId, sessionId, envelope, spawnImpl = spawn, timeoutMs = 15000,
}) {
  if (!RECEIPT_OPERATIONS.has(operation)) fail("receipt bridge operation is unsupported");
  const args = [
    requiredString(scriptPath, "receipt bridge scriptPath"), operation, "-",
    "--intent-id", requiredString(intentId, "receipt bridge intentId"),
    "--session-id", requiredString(sessionId, "receipt bridge sessionId"),
  ];
  if (root !== undefined) args.push("--root", requiredString(root, "receipt bridge root"));
  args.push("--write");
  const child = spawnImpl(requiredString(pythonCommand, "receipt bridge pythonCommand"), args, {
    shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutPromise = collect(child.stdout, child, "receipt bridge stdout");
  const stderrPromise = collect(child.stderr, child, "receipt bridge stderr");
  child.stdin.end(`${JSON.stringify(envelope)}\n`, "utf8");
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`durable receipt commit timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (code !== 0) {
    const detail = stderr.trim().slice(0, 1000) || `exit code ${code}`;
    fail(`durable receipt commit failed: ${detail}`);
  }
  const lines = stdout.split(/\r?\n/u)
    .filter((line) => line.startsWith("RECEIPT_COMMIT "));
  if (lines.length !== 1) fail("durable receipt commit returned no unique receipt");
  try {
    return JSON.parse(lines[0].slice("RECEIPT_COMMIT ".length));
  } catch {
    fail("durable receipt commit returned malformed JSON");
  }
}

async function runPythonRecovery({
  pythonCommand = "python", scriptPath = DEFAULT_SCRIPT, root,
  intentId, sessionId, reason, spawnImpl = spawn, timeoutMs = 15000,
}) {
  const args = [
    requiredString(scriptPath, "recovery bridge scriptPath"),
    "browser-recover-reconcile",
    "--intent-id", requiredString(intentId, "recovery bridge intentId"),
    "--session-id", requiredString(sessionId, "recovery bridge sessionId"),
    "--reason", requiredString(reason, "recovery bridge reason"),
  ];
  if (root !== undefined) args.push("--root", requiredString(root, "recovery bridge root"));
  args.push("--write");
  const child = spawnImpl(requiredString(pythonCommand, "recovery bridge pythonCommand"), args, {
    shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutPromise = collect(child.stdout, child, "recovery bridge stdout");
  const stderrPromise = collect(child.stderr, child, "recovery bridge stderr");
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`durable reconcile recovery timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (code !== 0) {
    const detail = stderr.trim().slice(0, 1000) || `exit code ${code}`;
    fail(`durable reconcile recovery failed: ${detail}`);
  }
  const lines = stdout.split(/\r?\n/u)
    .filter((line) => line.startsWith("INTERNAL_RECOVERY_CAPABILITY "));
  if (lines.length !== 1) {
    fail("durable reconcile recovery returned no unique internal capability");
  }
  try {
    return JSON.parse(lines[0].slice("INTERNAL_RECOVERY_CAPABILITY ".length));
  } catch {
    fail("durable reconcile recovery returned malformed JSON");
  }
}

function assertRequestMatchesPreparation(request, preparation) {
  if (!request || typeof request !== "object") fail("claim request must be an object");
  if (!preparation || typeof preparation !== "object" || preparation.test_only !== false) {
    fail("claim bridge accepts only an explicit live preparation receipt");
  }
  for (const key of [
    "action_id", "intent_id", "session_id", "permit_id", "reply_hash",
    "action_digest", "plan_digest", "preparation_id",
  ]) {
    if (requiredString(request[key], `claim request.${key}`)
        !== requiredString(preparation[key], `preparation.${key}`)) {
      fail(`claim request.${key} differs from the live preparation`);
    }
  }
}

function validateReceiptCapability(raw, operation) {
  if (!raw || typeof raw !== "object" || raw.schema_version !== 1) {
    fail(`${operation} capability has an invalid schema`);
  }
  if (raw.operation !== operation) fail(`${operation} capability operation differs`);
  requiredString(raw.capability_id, `${operation} capability.capability_id`);
  requiredString(raw.nonce, `${operation} capability.nonce`);
  return Object.freeze({
    schema_version: 1,
    operation,
    capability_id: raw.capability_id,
    nonce: raw.nonce,
  });
}

function validateRecoveryDecision(raw, preparation, intentId, sessionId) {
  if (!raw || typeof raw !== "object" || raw.schema_version !== 1) {
    fail("reconcile recovery decision has an invalid schema");
  }
  if (raw.decision !== "RECONCILE_ONLY" || raw.operation !== "browser-reconcile") {
    fail("reconcile recovery did not return a reconcile-only decision");
  }
  const expected = {
    action_id: requiredString(preparation.action_id, "preparation.action_id"),
    intent_id: requiredString(intentId, "recovery intentId"),
    preparation_id: requiredString(preparation.preparation_id, "preparation.preparation_id"),
    recovery_session_id: requiredString(sessionId, "recovery sessionId"),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (requiredString(raw[key], `recovery decision.${key}`) !== value) {
      fail(`recovery decision.${key} is not bound`);
    }
  }
  const claim = Object.freeze({
    decision: "RECONCILE_ONLY",
    action_id: expected.action_id,
    intent_id: expected.intent_id,
    session_id: requiredString(
      raw.attempt_session_id, "recovery decision.attempt_session_id",
    ),
    permit_id: requiredString(preparation.permit_id, "preparation.permit_id"),
    reply_hash: requiredString(preparation.reply_hash, "preparation.reply_hash"),
    action_digest: requiredString(preparation.action_digest, "preparation.action_digest"),
    plan_digest: requiredString(preparation.plan_digest, "preparation.plan_digest"),
    preparation_id: expected.preparation_id,
    claim_id: requiredString(raw.claim_id, "recovery decision.claim_id"),
    preflight_id: requiredString(raw.preflight_id, "recovery decision.preflight_id"),
  });
  return {
    claim,
    capability: validateReceiptCapability(
      raw.receipt_capability, "browser-reconcile",
    ),
    summary: Object.freeze({
      schema_version: 1,
      decision: "RECONCILE_ONLY",
      intent_id: expected.intent_id,
      attempt_session_id: claim.session_id,
      recovery_session_id: expected.recovery_session_id,
    }),
  };
}

function assertReceiptMatchesClaim(receipt, claim, preparation, operation) {
  if (!receipt || typeof receipt !== "object" || receipt.test_only !== false) {
    fail(`${operation} accepts only an explicit live browser receipt`);
  }
  for (const key of [
    "action_id", "intent_id", "reply_hash", "preparation_id", "claim_id", "preflight_id",
  ]) {
    const expectedKey = key === "claim_id" || key === "preflight_id" ? key : key;
    if (requiredString(receipt[key], `${operation} receipt.${key}`)
        !== requiredString(claim[expectedKey], `claim.${expectedKey}`)) {
      fail(`${operation} receipt.${key} differs from the durable claim`);
    }
  }
  if (operation === "browser-finish") {
    if (receipt.session_id !== claim.session_id) {
      fail("browser-finish receipt session differs from the durable claim");
    }
  } else {
    requiredString(receipt.session_id, "browser-reconcile receipt.session_id");
    if (receipt.attempt_session_id !== claim.session_id) {
      fail("browser-reconcile attempt session differs from the durable claim");
    }
  }
  if (digestObject(receipt.scope, `${operation} receipt.scope`)
      !== digestObject(preparation.scope, "preparation.scope")) {
    fail(`${operation} receipt scope differs from the live preparation`);
  }
}

function validateReceiptCommit(raw, operation, receipt) {
  if (!raw || typeof raw !== "object" || raw.schema_version !== 1) {
    fail(`${operation} commit has an invalid schema`);
  }
  if (raw.operation !== operation) fail(`${operation} commit operation differs`);
  if (raw.receipt_digest !== digestObject(receipt, `${operation} receipt`)) {
    fail(`${operation} commit receipt digest is not bound`);
  }
  if (typeof raw.outcome !== "string" || !raw.outcome) {
    fail(`${operation} commit outcome is missing`);
  }
  return raw;
}

async function commitPythonLedgerBrowserReceipt(claimSubmit, operation, receipt) {
  if (!RECEIPT_OPERATIONS.has(operation)) fail("receipt bridge operation is unsupported");
  const committer = pythonLedgerReceiptCommitters.get(claimSubmit);
  if (!committer) fail(`${operation} requires a claim created by the Python ledger bridge`);
  return committer(operation, receipt);
}

async function recoverPythonLedgerReconcile(claimSubmit, request) {
  const starter = pythonLedgerRecoveryStarters.get(claimSubmit);
  if (!starter) fail("reconcile recovery requires the default Python ledger bridge");
  return starter(request);
}

export function createPythonLedgerClaimSubmit({
  preparation, pythonCommand = "python", scriptPath = DEFAULT_SCRIPT, root,
  runner = runPythonClaim, receiptRunner = runPythonReceipt,
  recoveryRunner = runPythonRecovery, timeoutMs = 15000,
} = {}) {
  let durableClaim;
  let finishCapability;
  let reconcileCapability;
  let receiptInFlight = false;
  let recoveryMode = false;
  const claimSubmit = async function claimSubmit(request) {
    if (recoveryMode) fail("reconcile recovery cannot issue a new submit claim");
    assertRequestMatchesPreparation(request, preparation);
    const decision = await runner({
      pythonCommand, scriptPath, root, intentId: request.intent_id,
      sessionId: request.session_id, preparation, timeoutMs,
    });
    if (!decision || typeof decision !== "object") fail("claim bridge decision must be an object");
    for (const key of [
      "action_id", "intent_id", "session_id", "permit_id", "reply_hash",
      "action_digest", "plan_digest", "preparation_id",
    ]) {
      if (decision[key] !== request[key]) fail(`claim bridge decision.${key} is not bound`);
    }
    finishCapability = validateReceiptCapability(
      decision.receipt_capability, "browser-finish",
    );
    const { receipt_capability: _privateCapability, ...publicDecision } = decision;
    durableClaim = Object.freeze({ ...publicDecision });
    return durableClaim;
  };

  async function submitReceipt(operation, receipt) {
    if (!durableClaim) fail(`${operation} requires a successful durable claim first`);
    if (receiptInFlight) fail("a browser receipt commit is already in flight");
    const capability = operation === "browser-finish" ? finishCapability : reconcileCapability;
    if (!capability) fail(`${operation} has no unconsumed receipt capability`);
    assertReceiptMatchesClaim(receipt, durableClaim, preparation, operation);
    receiptInFlight = true;
    try {
      const committed = validateReceiptCommit(await receiptRunner({
        operation, pythonCommand, scriptPath, root,
        intentId: durableClaim.intent_id, sessionId: receipt.session_id,
        envelope: { provenance: capability, receipt }, timeoutMs,
      }), operation, receipt);
      if (operation === "browser-finish") finishCapability = undefined;
      else reconcileCapability = undefined;
      const hasNextCapability = (
        committed.next_capability !== null && committed.next_capability !== undefined
      );
      if (hasNextCapability) {
        reconcileCapability = validateReceiptCapability(
          committed.next_capability, "browser-reconcile",
        );
      }
      const { next_capability: _privateNextCapability, ...publicCommit } = committed;
      return Object.freeze({
        ...publicCommit,
        reconcile_required: hasNextCapability,
      });
    } finally {
      receiptInFlight = false;
    }
  }

  async function startRecovery({ intentId, sessionId, reason } = {}) {
    if (receiptInFlight) fail("a browser receipt commit is already in flight");
    const recoveryIntentId = requiredString(intentId, "recovery intentId");
    const recoverySessionId = requiredString(sessionId, "recovery sessionId");
    const recoveryReason = requiredString(reason, "recovery reason");
    if (!new Set(["browser_process_restarted", "receipt_capability_expired"])
      .has(recoveryReason)) {
      fail("recovery reason is unsupported");
    }
    receiptInFlight = true;
    try {
      const recovered = validateRecoveryDecision(await recoveryRunner({
        pythonCommand, scriptPath, root, intentId: recoveryIntentId,
        sessionId: recoverySessionId, reason: recoveryReason, timeoutMs,
      }), preparation, recoveryIntentId, recoverySessionId);
      if (durableClaim) {
        for (const key of [
          "action_id", "intent_id", "session_id", "reply_hash",
          "preparation_id", "claim_id", "preflight_id",
        ]) {
          if (durableClaim[key] !== recovered.claim[key]) {
            fail(`recovery decision.${key} differs from the existing durable claim`);
          }
        }
      }
      durableClaim = recovered.claim;
      finishCapability = undefined;
      reconcileCapability = recovered.capability;
      recoveryMode = true;
      return recovered.summary;
    } finally {
      receiptInFlight = false;
    }
  }

  pythonLedgerReceiptCommitters.set(claimSubmit, submitReceipt);
  pythonLedgerRecoveryStarters.set(claimSubmit, startRecovery);
  if (runner === runPythonClaim && receiptRunner === runPythonReceipt
      && recoveryRunner === runPythonRecovery
      && pythonCommand === "python"
      && scriptPath === DEFAULT_SCRIPT
      && root === undefined) {
    pythonLedgerClaimSubmits.add(claimSubmit);
  }
  return Object.freeze(claimSubmit);
}

function normalizeScanTarget(raw) {
  if (!raw || typeof raw !== "object") fail("scan target must be an object");
  const target = Object.freeze({
    platform: requiredString(raw.platform, "scan target.platform"),
    account_key: requiredString(raw.account_key, "scan target.account_key"),
    post_key: requiredString(raw.post_key, "scan target.post_key"),
    post_permalink: requiredString(raw.post_permalink, "scan target.post_permalink"),
    session_id: requiredString(raw.session_id, "scan target.session_id"),
    ttl_minutes: raw.ttl_minutes ?? 10,
  });
  if (!Number.isInteger(target.ttl_minutes) || target.ttl_minutes < 1) {
    fail("scan target.ttl_minutes must be a positive integer");
  }
  return target;
}

function validateScanAuthorization(raw, target) {
  if (!raw || typeof raw !== "object" || raw.schema_version !== 1) {
    fail("scan authorization has an invalid schema");
  }
  if (raw.decision !== "SCAN_AUTHORIZED") {
    fail("scan authorization decision is invalid");
  }
  const request = raw.scan_request;
  if (!request || typeof request !== "object") {
    fail("scan authorization request is missing");
  }
  for (const key of [
    "platform", "account_key", "post_key", "post_permalink", "session_id",
  ]) {
    if (requiredString(request[key], `scan authorization request.${key}`) !== target[key]) {
      fail(`scan authorization request.${key} differs from the requested target`);
    }
  }
  for (const key of ["scan_request_id", "requested_at", "expires_at"]) {
    requiredString(request[key], `scan authorization request.${key}`);
  }
  if (Object.hasOwn(request, "nonce") || JSON.stringify(request).includes('"nonce"')) {
    fail("scan bearer leaked into the public request object");
  }
  const capability = validateReceiptCapability(
    raw.receipt_capability, SCAN_OPERATION,
  );
  return {
    request: Object.freeze({ ...request }),
    capability,
  };
}

function validateScanCommit(raw, request, receipt) {
  if (!raw || typeof raw !== "object" || raw.schema_version !== 1) {
    fail("browser-scan commit has an invalid schema");
  }
  if (raw.operation !== SCAN_OPERATION) fail("browser-scan commit operation differs");
  if (raw.scan_request_id !== request.scan_request_id) {
    fail("browser-scan commit request id is not bound");
  }
  const expectedDigest = digestObject(receipt, "browser-scan receipt");
  if (raw.receipt_digest !== expectedDigest) {
    fail("browser-scan commit receipt digest is not bound");
  }
  const commentCount = Array.isArray(receipt.comments) ? receipt.comments.length : -1;
  for (const key of ["comment_count", "added_count", "unchanged_count"]) {
    if (!Number.isInteger(raw[key]) || raw[key] < 0) {
      fail(`browser-scan commit ${key} must be a non-negative integer`);
    }
  }
  if (raw.comment_count !== commentCount) {
    fail("browser-scan commit comment_count differs from the receipt");
  }
  if (raw.added_count + raw.unchanged_count !== commentCount) {
    fail("browser-scan commit result cardinality is incomplete");
  }
  if (raw.zero_result !== (commentCount === 0)) {
    fail("browser-scan commit zero_result differs from the receipt");
  }
  requiredString(raw.scan_id, "browser-scan commit.scan_id");
  return Object.freeze({
    schema_version: 1,
    operation: SCAN_OPERATION,
    scan_request_id: request.scan_request_id,
    scan_id: raw.scan_id,
    receipt_digest: raw.receipt_digest,
    comment_count: raw.comment_count,
    added_count: raw.added_count,
    unchanged_count: raw.unchanged_count,
    zero_result: raw.zero_result,
  });
}

function createScanAndCommit(scanPost, {
  pythonCommand = "python", scriptPath = DEFAULT_SCRIPT, root,
  scanRequestRunner = runPythonScanRequest, scanCommitRunner = runPythonScanCommit,
  timeoutMs = 15000,
} = {}) {
  let inFlight = false;
  const defaultProductionBridge = (
    pythonCommand === "python" && scriptPath === DEFAULT_SCRIPT && root === undefined
      && scanRequestRunner === runPythonScanRequest
      && scanCommitRunner === runPythonScanCommit
  );
  return async function scanAndCommit(tab, rawTarget, locatorPlan, options = {}) {
    if (inFlight) fail("a browser scan commit is already in flight");
    if (!defaultProductionBridge && options?.testOnly !== true) {
      fail("live scan commit requires the default shell-free Python ledger bridge");
    }
    const target = normalizeScanTarget(rawTarget);
    inFlight = true;
    let capability;
    try {
      const authorized = validateScanAuthorization(await scanRequestRunner({
        pythonCommand, scriptPath, root, target, timeoutMs,
      }), target);
      capability = authorized.capability;
      const receipt = await scanPost(tab, authorized.request, locatorPlan, options);
      if (!defaultProductionBridge && receipt.test_only !== true) {
        fail("non-default scan bridge emitted non-test evidence");
      }
      const commit = await scanCommitRunner({
        pythonCommand, scriptPath, root, request: authorized.request,
        envelope: { provenance: capability, receipt }, timeoutMs,
      });
      capability = undefined;
      return validateScanCommit(commit, authorized.request, receipt);
    } finally {
      capability = undefined;
      inFlight = false;
    }
  };
}

export function createCommentChromeActuator(options = {}) {
  const claimSubmit = options.claimSubmit;
  const rawScanPost = createScanPost(options);
  const scanAndCommit = createScanAndCommit(rawScanPost, options);
  const send = createSendOperations({
    ...options,
    claimSubmit,
  });

  async function inspectResult(...args) {
    const receipt = await send.inspectResult(...args);
    if (receipt.test_only !== true) {
      fail("live post-submit evidence must use inspectAndFinish");
    }
    return receipt;
  }

  async function scanPost(...args) {
    const scanOptions = args[3];
    if (!scanOptions || scanOptions.testOnly !== true) {
      fail("raw scanPost is test-only; live scan must use scanAndCommit");
    }
    const receipt = await rawScanPost(...args);
    if (receipt.test_only !== true) {
      fail("live scan evidence must use scanAndCommit");
    }
    return receipt;
  }

  async function reinspect(...args) {
    const receipt = await send.reinspect(...args);
    if (receipt.test_only !== true) {
      fail("live reinspection evidence must use reinspectAndReconcile");
    }
    return receipt;
  }

  async function inspectAndFinish(...args) {
    void args;
    fail("live finish is unavailable until a trusted Chrome host resolver exists");
  }

  async function reinspectAndReconcile(...args) {
    void args;
    fail("live reconcile is unavailable until a trusted Chrome host resolver exists");
  }

  async function recoverAndReconcile(
    tab, action, locatorPlan, attempt, attemptSessionId, currentSessionId,
    preparation, options = {}, reason = "browser_process_restarted",
  ) {
    void tab;
    void action;
    void locatorPlan;
    void attempt;
    void attemptSessionId;
    void currentSessionId;
    void preparation;
    void options;
    void reason;
    fail("live recovery is unavailable until a trusted Chrome host resolver exists");
  }

  return Object.freeze({
    scanPost,
    scanAndCommit,
    prepareReply: send.prepareReply,
    submitOnce: send.submitOnce,
    inspectResult,
    reinspect,
    inspectAndFinish,
    reinspectAndReconcile,
    recoverAndReconcile,
  });
}

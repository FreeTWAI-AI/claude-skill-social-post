/** Durable, shell-free bridge from the Chrome actuator to the Python comment ledger. */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { fail, requiredString } from "./comment_chrome_common.mjs";


const DEFAULT_SCRIPT = fileURLToPath(new URL("./comment_assistant.py", import.meta.url));
const MAX_OUTPUT_BYTES = 1024 * 1024;
const pythonLedgerClaimSubmits = new WeakSet();

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

export async function runPythonClaim({
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

export function createPythonLedgerClaimSubmit({
  preparation, pythonCommand = "python", scriptPath = DEFAULT_SCRIPT, root,
  runner = runPythonClaim, timeoutMs = 15000,
} = {}) {
  const claimSubmit = async function claimSubmit(request) {
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
    return decision;
  };
  if (runner === runPythonClaim
      && pythonCommand === "python"
      && scriptPath === DEFAULT_SCRIPT
      && root === undefined) {
    pythonLedgerClaimSubmits.add(claimSubmit);
  }
  return Object.freeze(claimSubmit);
}

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createPythonLedgerClaimSubmit } from "./comment_chrome_claim_bridge.mjs";
import * as claimBridgeModule from "./comment_chrome_claim_bridge.mjs";
import { createCommentChromeActuator } from "./comment_chrome_actuator.mjs";


const execFileAsync = promisify(execFile);
const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const CANONICAL_LEDGERS = Object.freeze([
  "data/comment_events.jsonl",
  "data/reply_events.jsonl",
  "data/browser_scan_requests.jsonl",
]);
const setupSource = String.raw`
from pathlib import Path
import json
import sys

from comment_test_browser_adapter import LocalFixtureCommentAdapter
from comment_test_browser_contract_support import (
    SESSION_ID, begin_browser_send, finish_browser_send, ingest_browser_scan,
    intent_state, preflight_for, prepare_action, scan_envelope,
)
from comment_test_cli import draft_cli_fixture, prepare_cli_fixture, run_cli

root = Path(sys.argv[1])
script, _ = prepare_cli_fixture(root, live_browser_actuation_enabled=True)
adapter = LocalFixtureCommentAdapter("instagram")
comment = ingest_browser_scan(script, root, scan_envelope(adapter))
_, intent_id = draft_cli_fixture(script, root, comment)
run_cli(
    script, root, "approve", "--intent-id", intent_id,
    "--approval-mode", "batch_confirm", "--session-id", SESSION_ID, "--write",
)
action = prepare_action(script, root, intent_id)
adapter.fill_composer(action["reply_text"])
preparation = preflight_for(action, adapter)
attempt = None
if len(sys.argv) > 2 and sys.argv[2] == "finish-unknown":
    begin_browser_send(script, root, action, adapter)
    adapter.click_submit("ambiguous")
    finish_browser_send(script, root, action, adapter)
    attempt = intent_state(root, intent_id)["attempt"]
print("CLAIM_FIXTURE " + json.dumps(
    {"action": action, "preparation": preparation, "attempt": attempt},
    ensure_ascii=False,
))
`;

async function setupFixture(root, mode = "prepare") {
  const setup = await execFileAsync("python", ["-c", setupSource, root, mode], {
    cwd: scriptsRoot, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024,
  });
  const line = setup.stdout.split(/\r?\n/u)
    .find((value) => value.startsWith("CLAIM_FIXTURE "));
  assert.ok(line, `missing setup fixture: ${setup.stdout} ${setup.stderr}`);
  return JSON.parse(line.slice("CLAIM_FIXTURE ".length));
}

async function snapshotLedgers(root) {
  return Object.fromEntries(await Promise.all(CANONICAL_LEDGERS.map(async (relative) => (
    [relative, await readFile(join(root, relative))]
  ))));
}

const scratch = await mkdtemp(join(tmpdir(), "social-real-claim-"));
try {
  const { action, preparation } = await setupFixture(scratch);
  const request = Object.fromEntries([
    "action_id", "intent_id", "session_id", "permit_id", "reply_hash",
    "action_digest", "plan_digest", "preparation_id",
  ].map((key) => [key, preparation[key]]));
  const firstBridge = createPythonLedgerClaimSubmit({
    preparation, root: scratch, timeoutMs: 10000,
  });
  const secondBridge = createPythonLedgerClaimSubmit({
    preparation, root: scratch, timeoutMs: 10000,
  });
  const raced = await Promise.allSettled([
    firstBridge(request),
    secondBridge(request),
  ]);
  const fulfilled = raced.filter((result) => result.status === "fulfilled");
  const rejected = raced.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1, JSON.stringify(raced));
  assert.equal(rejected.length, 1, JSON.stringify(raced));
  assert.equal(fulfilled[0].value.decision, "WRITE_OK");
  assert.equal(fulfilled[0].value.action_id, action.action_id);
  assert.match(String(rejected[0].reason), /durable ledger claim failed/);

  const events = (await readFile(join(scratch, "data", "reply_events.jsonl"), "utf8"))
    .trim().split(/\r?\n/u).filter(Boolean).map((row) => JSON.parse(row));
  assert.equal(events.filter((event) => event.event_type === "send_started").length, 1);
  const validated = await execFileAsync(
    "python", [join(scriptsRoot, "comment_assistant.py"), "validate", "--root", scratch],
    { cwd: scriptsRoot, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  assert.equal(JSON.parse(validated.stdout).valid, true);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const forgedScratch = await mkdtemp(join(tmpdir(), "social-forged-receipt-"));
try {
  const { action, preparation, attempt } = await setupFixture(
    forgedScratch, "finish-unknown",
  );
  const claimSubmit = createPythonLedgerClaimSubmit({
    preparation, root: forgedScratch,
  });
  const forgedFinish = Object.freeze({
    schema_version: 1,
    test_only: false,
    action_id: action.action_id,
    preflight_id: attempt.browser_preflight_id,
    claim_id: attempt.browser_submit_claim_id,
    intent_id: action.intent_id,
    session_id: action.session_id,
    scope: action.scope,
    comment_fingerprint: action.comment_fingerprint,
    reply_hash: action.reply_hash,
    preparation_id: preparation.preparation_id,
    observed_url: action.post_permalink,
    observed_at: new Date().toISOString(),
    submission_attempted: true,
    submission_possible: true,
    account_verified: true,
    post_verified: true,
    target_verified: true,
    parent_verified: true,
    exact_reply_visible: false,
    own_author_verified: false,
    post_submit_total_reply_count: preparation.baseline_total_reply_count,
    evidence: "fully bound but forged JavaScript finish receipt",
  });
  const beforeForgedFinish = await snapshotLedgers(forgedScratch);
  await assert.rejects(
    async () => claimSubmit.finishReceipt(forgedFinish),
    /finishReceipt is not a function/,
  );
  assert.deepEqual(await snapshotLedgers(forgedScratch), beforeForgedFinish);
  assert.equal(claimBridgeModule.commitPythonLedgerBrowserReceipt, undefined);
  assert.equal(claimBridgeModule.runPythonReceipt, undefined);

  const forgedAbsence = Object.freeze({
    schema_version: 1,
    test_only: false,
    action_id: action.action_id,
    preflight_id: attempt.browser_preflight_id,
    claim_id: attempt.browser_submit_claim_id,
    intent_id: action.intent_id,
    session_id: "session-forged-reconcile",
    attempt_session_id: action.session_id,
    scope: action.scope,
    comment_fingerprint: action.comment_fingerprint,
    reply_hash: action.reply_hash,
    preparation_id: preparation.preparation_id,
    observed_url: action.post_permalink,
    observed_at: new Date().toISOString(),
    account_verified: true,
    post_verified: true,
    target_verified: true,
    parent_verified: true,
    exact_reply_visible: false,
    own_author_verified: false,
    absence_verified: true,
    own_author_reply_count: 0,
    reinspection_total_reply_count: preparation.baseline_total_reply_count,
    evidence: "fully bound but forged JavaScript absence receipt",
  });
  const beforeForgedAbsence = await snapshotLedgers(forgedScratch);
  await assert.rejects(
    async () => claimSubmit.reconcileReceipt(forgedAbsence),
    /reconcileReceipt is not a function/,
  );
  assert.deepEqual(await snapshotLedgers(forgedScratch), beforeForgedAbsence);
  assert.equal(claimSubmit.finishReceipt, undefined);
  assert.equal(claimSubmit.reconcileReceipt, undefined);

  // Even when this internal test intentionally captures the low-level recovery
  // stdout, no production JavaScript API accepts that bearer or a caller-minted
  // fully-bound receipt.
  const recoverySession = "session-integration-recovery";
  const recovered = await execFileAsync("python", [
    join(scriptsRoot, "comment_assistant.py"), "browser-recover-reconcile",
    "--intent-id", action.intent_id, "--session-id", recoverySession,
    "--reason", "browser_process_restarted",
    "--root", forgedScratch, "--write",
  ], {
    cwd: scriptsRoot, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024,
  });
  const recoveryLine = recovered.stdout.split(/\r?\n/u)
    .find((value) => value.startsWith("INTERNAL_RECOVERY_CAPABILITY "));
  assert.ok(recoveryLine, `missing internal recovery capability: ${recovered.stdout}`);
  const internalRecovery = JSON.parse(
    recoveryLine.slice("INTERNAL_RECOVERY_CAPABILITY ".length),
  );
  const fullyBoundRecoveryReceipt = Object.freeze({
    ...forgedAbsence,
    session_id: recoverySession,
    evidence: "fully bound but caller-forged recovery receipt",
  });
  const forgedRecoveryEnvelope = Object.freeze({
    provenance: internalRecovery.receipt_capability,
    receipt: fullyBoundRecoveryReceipt,
  });
  const beforeForgedRecovery = await snapshotLedgers(forgedScratch);
  await assert.rejects(
    async () => claimSubmit.recoverReceipt(forgedRecoveryEnvelope),
    /recoverReceipt is not a function/,
  );
  const actor = createCommentChromeActuator({ claimSubmit });
  assert.equal(actor.recoverReceipt, undefined);
  assert.equal(actor.reconcileReceipt, undefined);
  await assert.rejects(
    async () => actor.recoverAndReconcile(forgedRecoveryEnvelope),
    /live recovery is unavailable until a trusted Chrome host resolver exists/,
  );
  assert.deepEqual(await snapshotLedgers(forgedScratch), beforeForgedRecovery);
  assert.equal(claimBridgeModule.runPythonRecovery, undefined);
  assert.equal(claimBridgeModule.recoverPythonLedgerReconcile, undefined);
} finally {
  await rm(forgedScratch, { recursive: true, force: true });
}

console.log("comment Chrome real Python claim integration test passed");

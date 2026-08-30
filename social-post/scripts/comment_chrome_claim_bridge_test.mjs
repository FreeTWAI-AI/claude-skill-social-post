import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPythonLedgerClaimSubmit, isPythonLedgerClaimSubmit,
} from "./comment_chrome_claim_bridge.mjs";
import * as claimBridgeModule from "./comment_chrome_claim_bridge.mjs";
import * as actuatorFacadeModule from "./comment_chrome_actuator.mjs";
import { digestObject } from "./comment_chrome_common.mjs";
import {
  actionFor, fixedClock, fixture, optionsFor, scanPlan,
} from "./comment_chrome_actuator_fixture_test.mjs";


const digest = (digit) => digit.repeat(64);
const sendSource = await readFile(
  new URL("./comment_chrome_send.mjs", import.meta.url), "utf8",
);
assert.doesNotMatch(
  sendSource, /comment_chrome_claim_bridge\.mjs/u,
  "send operations must not import the claim bridge",
);
const preparation = {
  test_only: false,
  action_id: "action-1", intent_id: "intent-1", session_id: "session-1",
  permit_id: "permit-1", reply_hash: digest("a"), action_digest: digest("b"),
  plan_digest: digest("c"), preparation_id: digest("d"),
  scope: {
    platform: "instagram", account_key: "account-1",
    post_key: "post-1", comment_key: "comment-1",
  },
};
const request = { ...preparation };
delete request.test_only;
delete request.scope;
const finishCapability = {
  schema_version: 1, operation: "browser-finish",
  capability_id: "1".repeat(32), nonce: "a".repeat(43),
};
const reconcileCapability = {
  schema_version: 1, operation: "browser-reconcile",
  capability_id: "2".repeat(32), nonce: "b".repeat(43),
};
let calls = 0;
let receiptCalls = 0;
const claimSubmit = createPythonLedgerClaimSubmit({
  preparation,
  runner: async (options) => {
    calls += 1;
    assert.equal(options.preparation, preparation);
    return {
      ...request, decision: "WRITE_OK", claim_id: "claim-1", preflight_id: "preflight-1",
      receipt_capability: finishCapability,
    };
  },
  receiptRunner: async (options) => {
    receiptCalls += 1;
    assert.equal(options.envelope.provenance.operation, options.operation);
    return {
      schema_version: 1,
      operation: options.operation,
      outcome: options.operation === "browser-finish" ? "unknown" : "not-sent",
      receipt_digest: digestObject(options.envelope.receipt),
      next_capability: options.operation === "browser-finish" ? reconcileCapability : null,
    };
  },
});
assert.equal(isPythonLedgerClaimSubmit(claimSubmit), false);
assert.equal(isPythonLedgerClaimSubmit(async () => ({})), false);
const liveClaimSubmit = createPythonLedgerClaimSubmit({ preparation });
assert.equal(isPythonLedgerClaimSubmit(liveClaimSubmit), true);
assert.equal(Object.isFrozen(liveClaimSubmit), true);
assert.equal(liveClaimSubmit.finishReceipt, undefined);
assert.equal(liveClaimSubmit.reconcileReceipt, undefined);
assert.equal(claimSubmit.finishReceipt, undefined);
assert.equal(claimSubmit.reconcileReceipt, undefined);
assert.equal(isPythonLedgerClaimSubmit(createPythonLedgerClaimSubmit({
  preparation, pythonCommand: "python3",
})), false);
assert.equal(isPythonLedgerClaimSubmit(createPythonLedgerClaimSubmit({
  preparation, scriptPath: "untrusted-ledger.py",
})), false);
assert.equal(isPythonLedgerClaimSubmit(createPythonLedgerClaimSubmit({
  preparation, root: "untrusted-ledger-root",
})), false);
const decision = await claimSubmit(request);
assert.equal(decision.claim_id, "claim-1");
assert.equal(calls, 1);
assert.equal(decision.receipt_capability, undefined);
assert.equal(Object.hasOwn(decision, "receipt_capability"), false);
assert.equal(claimBridgeModule.commitPythonLedgerBrowserReceipt, undefined);
assert.equal(claimBridgeModule.runPythonClaim, undefined);
assert.equal(claimBridgeModule.runPythonReceipt, undefined);
assert.equal(claimBridgeModule.runPythonRecovery, undefined);
assert.equal(claimBridgeModule.recoverPythonLedgerReconcile, undefined);
assert.deepEqual(Object.keys(claimBridgeModule).sort(), [
  "createCommentChromeActuator",
  "createPythonLedgerClaimSubmit",
  "isPythonLedgerClaimSubmit",
]);
assert.deepEqual(Object.keys(actuatorFacadeModule), ["createCommentChromeActuator"]);
assert.equal(receiptCalls, 0);
for (const value of [claimSubmit, liveClaimSubmit]) {
  assert.equal(value.recoverReceipt, undefined);
  assert.equal(value.recoverReconcile, undefined);
  assert.equal(value.receiptCapability, undefined);
}
const productionActor = actuatorFacadeModule.createCommentChromeActuator({
  claimSubmit: liveClaimSubmit,
});
assert.equal(productionActor.recoverReceipt, undefined);
assert.equal(productionActor.receiptCapability, undefined);
assert.equal(JSON.stringify(productionActor).includes("nonce"), false);
const forgedRecovery = Object.freeze({
  schema_version: 1, decision: "RECONCILE_ONLY", operation: "browser-reconcile",
  intent_id: preparation.intent_id, action_id: preparation.action_id,
  claim_id: "claim-forged", preflight_id: "preflight-forged",
  preparation_id: preparation.preparation_id,
  attempt_session_id: preparation.session_id,
  recovery_session_id: "session-recovery-forged",
  receipt_capability: reconcileCapability,
});
await assert.rejects(
  async () => claimSubmit.recoverReceipt(forgedRecovery),
  /recoverReceipt is not a function/,
);
await assert.rejects(
  () => claimSubmit({ ...request, plan_digest: digest("e") }),
  /differs from the live preparation/,
);
await assert.rejects(
  () => createPythonLedgerClaimSubmit({
    preparation: { ...preparation, test_only: true }, runner: async () => decision,
  })(request),
  /explicit live preparation/,
);
await assert.rejects(
  () => createPythonLedgerClaimSubmit({
    preparation, runner: async () => ({ ...decision, action_digest: digest("f") }),
  })(request),
  /decision.action_digest is not bound/,
);

const scratch = await mkdtemp(join(tmpdir(), "social-claim-bridge-"));
try {
  const fakeLedger = join(scratch, "fake-ledger.mjs");
  await writeFile(fakeLedger, `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const prep = JSON.parse(input);
const claim = {
  decision: "WRITE_OK", claim_id: "spawn-claim", preflight_id: "spawn-preflight",
  action_id: prep.action_id, intent_id: prep.intent_id, session_id: prep.session_id,
  permit_id: prep.permit_id, reply_hash: prep.reply_hash,
  action_digest: prep.action_digest, plan_digest: prep.plan_digest,
  preparation_id: prep.preparation_id,
  receipt_capability: {
    schema_version: 1, operation: "browser-finish",
    capability_id: "33333333333333333333333333333333",
    nonce: "ccccccccccccccccccccccccccccccccccccccccccc",
  },
};
process.stdout.write("SUBMIT_CLAIM " + JSON.stringify(claim) + "\\n");
`, "utf8");
  const spawnedBridge = createPythonLedgerClaimSubmit({
    preparation, pythonCommand: process.execPath, scriptPath: fakeLedger,
    timeoutMs: 5000,
  });
  const spawned = await spawnedBridge(request);
  assert.equal(spawned.claim_id, "spawn-claim");
  assert.equal(spawned.receipt_capability, undefined);
  assert.equal(Object.hasOwn(spawned, "receipt_capability"), false);

  const fakeScanLedger = join(scratch, "fake-scan-ledger.mjs");
  await writeFile(fakeScanLedger, `
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
const operation = args[0];
const flag = (name) => args[args.indexOf(name) + 1];
const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : (value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value);
const digest = (value) => createHash("sha256")
  .update(JSON.stringify(canonical(value)), "utf8").digest("hex");
if (operation === "browser-scan-request") {
  const request = {
    schema_version: 1, scan_request_id: "scan-spawn-request",
    platform: flag("--platform"), account_key: flag("--account-key"),
    post_key: flag("--post-key"), post_permalink: flag("--post-permalink"),
    session_id: flag("--session-id"), requested_at: "2030-01-02T12:00:00+00:00",
    expires_at: "2030-01-02T12:05:00+00:00",
  };
  process.stdout.write("INTERNAL_SCAN_CAPABILITY " + JSON.stringify({
    schema_version: 1, decision: "SCAN_AUTHORIZED", scan_request: request,
    receipt_capability: {
      schema_version: 1, operation: "browser-scan",
      capability_id: "5".repeat(32), nonce: "e".repeat(43),
    },
  }) + "\\n");
} else if (operation === "browser-scan") {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const envelope = JSON.parse(input);
  const count = envelope.receipt.comments.length;
  process.stdout.write("SCAN_COMMIT " + JSON.stringify({
    schema_version: 1, operation: "browser-scan",
    scan_request_id: flag("--scan-request-id"), scan_id: "scan-spawn-result",
    receipt_digest: digest(envelope.receipt), comment_count: count,
    added_count: count, unchanged_count: 0, zero_result: count === 0,
  }) + "\\n");
} else {
  process.stderr.write("unsupported operation");
  process.exitCode = 2;
}
`, "utf8");
  const scanAction = actionFor("claim-bridge-fused-scan");
  const scanTarget = {
    platform: "instagram", account_key: "account-a", post_key: "post-a",
    post_permalink: scanAction.post_permalink, session_id: scanAction.session_id,
    ttl_minutes: 5,
  };
  const scanActor = actuatorFacadeModule.createCommentChromeActuator({
    clock: fixedClock, pythonCommand: process.execPath, scriptPath: fakeScanLedger,
    timeoutMs: 5000,
  });
  const scanCommit = await scanActor.scanAndCommit(
    fixture().tab, scanTarget, await scanPlan(),
    { ...optionsFor(scanAction), threadExpansionComplete: true },
  );
  assert.equal(scanCommit.operation, "browser-scan");
  assert.equal(scanCommit.comment_count, 1);
  assert.equal(JSON.stringify(scanCommit).includes("nonce"), false);

} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log("comment Chrome claim bridge test passed");

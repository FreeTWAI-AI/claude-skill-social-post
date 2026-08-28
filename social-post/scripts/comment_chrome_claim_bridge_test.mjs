import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPythonLedgerClaimSubmit, isPythonLedgerClaimSubmit, runPythonClaim,
} from "./comment_chrome_claim_bridge.mjs";


const digest = (digit) => digit.repeat(64);
const preparation = {
  test_only: false,
  action_id: "action-1", intent_id: "intent-1", session_id: "session-1",
  permit_id: "permit-1", reply_hash: digest("a"), action_digest: digest("b"),
  plan_digest: digest("c"), preparation_id: digest("d"),
};
const request = { ...preparation };
delete request.test_only;
let calls = 0;
const claimSubmit = createPythonLedgerClaimSubmit({
  preparation,
  runner: async (options) => {
    calls += 1;
    assert.equal(options.preparation, preparation);
    return {
      ...request, decision: "WRITE_OK", claim_id: "claim-1", preflight_id: "preflight-1",
    };
  },
});
assert.equal(isPythonLedgerClaimSubmit(claimSubmit), false);
assert.equal(isPythonLedgerClaimSubmit(async () => ({})), false);
const liveClaimSubmit = createPythonLedgerClaimSubmit({ preparation });
assert.equal(isPythonLedgerClaimSubmit(liveClaimSubmit), true);
assert.equal(Object.isFrozen(liveClaimSubmit), true);
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
};
process.stdout.write("SUBMIT_CLAIM " + JSON.stringify(claim) + "\\n");
`, "utf8");
  const spawned = await runPythonClaim({
    pythonCommand: process.execPath, scriptPath: fakeLedger,
    intentId: preparation.intent_id, sessionId: preparation.session_id,
    preparation, timeoutMs: 5000,
  });
  assert.equal(spawned.claim_id, "spawn-claim");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log("comment Chrome claim bridge test passed");

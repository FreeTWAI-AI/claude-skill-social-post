/** Rejection-only public-boundary smoke test. Never enables or executes live sends. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createCommentChromeActuator } from "./comment_chrome_actuator.mjs";

const policyUrl = new URL("../references/comment-policy.json", import.meta.url);
const policy = JSON.parse(await readFile(policyUrl, "utf8"));
assert.equal(
  policy.live_browser_actuation_enabled, false,
  "rejection-only live bridge test requires the existing policy switch to remain disabled",
);

const observedPaths = [
  "../references/comment-policy.json",
  "../data/comment_events.jsonl",
  "../data/reply_events.jsonl",
  "../data/browser_scan_requests.jsonl",
];

async function observedDigests() {
  return Promise.all(observedPaths.map(async (relative) => {
    try {
      const bytes = await readFile(new URL(relative, import.meta.url));
      return { path: relative, sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { path: relative, missing: true };
    }
  }));
}

const before = await observedDigests();
const actor = createCommentChromeActuator();
assert.equal(Object.isFrozen(actor), true);
assert.equal(typeof actor.executeApprovedReply, "function");
const inertRequest = Object.freeze({
  intentId: "rejection-only-no-approved-intent",
  sessionId: "rejection-only-no-browser-session",
});

for (const request of [
  undefined, null, [], {}, { intentId: inertRequest.intentId },
  { intentId: "", sessionId: inertRequest.sessionId },
  { intentId: inertRequest.intentId, sessionId: " " },
  { ...inertRequest, testOnly: true },
  { ...inertRequest, tab: {} },
  { ...inertRequest, action: {} },
  { ...inertRequest, locatorPlan: {} },
]) {
  await assert.rejects(
    actor.executeApprovedReply(request),
    /only JSON-compatible values|accepts only intentId and sessionId|must be a non-empty string/u,
  );
}

// Deliberately pass no fake browser/transport/submit function. Non-default
// configuration itself must make the public fused entry unavailable.
for (const options of [{ testOnly: true }, { root: "unused" }, { claimSubmit: null }]) {
  const customActor = createCommentChromeActuator(options);
  await assert.rejects(
    customActor.executeApprovedReply(inertRequest),
    /rejects custom actuator options and callbacks/u,
  );
}

// The disabled-policy error must happen before a nonexistent intent is read
// from the ledger or the unavailable standalone-Node browser runtime is used.
await assert.rejects(
  actor.executeApprovedReply(inertRequest), /live reply execution is disabled by policy/u,
);
assert.deepEqual(await observedDigests(), before, "rejection-only checks changed policy or ledgers");

console.log("PASS rejection-only live bridge: invalid inputs, custom options, disabled policy; policy and ledgers unchanged");

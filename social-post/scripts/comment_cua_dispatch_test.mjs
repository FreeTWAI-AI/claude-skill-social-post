/** Actual private bridge orchestration in an isolated VM; no browser or ledger. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import * as cuaRuntime from "./comment_cua_runtime.mjs";

const source = await readFile(new URL("./comment_chrome_claim_bridge.mjs", import.meta.url), "utf8");
const names = ["requireLiveSubmitTransport", "requireCurrentReplyPermit", "readExactLiveComposer", "isEmptyThreadsComposer",
  "requireCanaryThread", "inspectReadyLiveComposer", "prepareLiveCanaryReply",
  "nativeMentionPreparation", "prepareInstagramCuaLiveReply",
  "prepareThreadsLiveReply", "inspectLiveFinishReceipt", "submitLiveReplyAndFinish"];
function functionSource(name) {
  const declaration = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "mu");
  const start = source.search(declaration);
  assert.ok(start >= 0, `actual private function ${name} must exist`);
  const tail = source.slice(start);
  const next = tail.slice(1).search(/^(?:export )?(?:async )?function /mu);
  return (next < 0 ? tail : tail.slice(0, next + 1)).replace(/^export /u, "");
}
const functions = names.map(functionSource).join("\n");

function isolatedCase(options = {}) {
  const events = [];
  const targetUrl = "https://www.threads.com/@example.reader/post/Comment456";
  const action = { action_id: "test-action", intent_id: "test-intent", session_id: "test-session",
    permit_id: "test-permit", reply_hash: "test-hash", author_key: "example.reader",
    expected_body: "Useful update", reply_text: "Thanks for sharing!", expires_at: "2999-01-01T00:00:00.000Z",
    scope: { platform: options.platform ?? "threads", account_key: "example.owner", post_key: "Root123", comment_key: "Comment456" },
    comment_anchor: { platform_comment_id: "Comment456", comment_permalink: targetUrl },
    comment_fingerprint: "test-fingerprint" };
  const state = { url: targetUrl, text: "", clicks: 0, fills: 0, claims: 0, receipts: [], ...options };
  const fail = (message) => { throw new Error(message); };
  const json = (value) => JSON.stringify(value);
  const documentBinding = { kind: "source_owned_ui_continuity", tab_id: "test-tab", observed_url: targetUrl };
  const canary = { intentId: action.intent_id, sessionId: action.session_id, leaseId: "test-lease", action };
  const composer = {
    evaluate: async (callback) => callback({
      getAttribute: (name) => ({ contenteditable: "true", role: "textbox" })[name] ?? null,
      hasAttribute: (name) => ["contenteditable", "role"].includes(name),
      ...(state.fills === 0 && state.initialDom ? state.initialDom
        : { isContentEditable: true, innerText: state.text, textContent: state.text,
          childNodes: state.text === "" ? [] : [{ nodeType: 3, textContent: state.text }] }),
    }),
    fill: async (text) => {
      events.push("fill"); state.fills += 1; state.text = state.filledText ?? text;
    },
  };
  const submit = { click: async () => {
    events.push("click"); state.clicks += 1;
    if (state.clickThrows) fail("ambiguous click transport failure");
  } };
  const tab = { id: "test-tab", playwright: {}, url: async () => state.url,
    close: async () => { events.push("close"); } };
  const surface = () => ({
    observedUrl: state.url, complete: false, exhaustiveThread: true,
    totalReplies: state.totalReplies ?? 0, ownReplyCount: 0, exactOwnCount: 0,
    replyExhaustionCandidate: { candidate_only: true, stable_reads: 2, kind: "threads_explicit_zero",
      action_digest: json(action), observed_count: state.totalReplies ?? 0, observed_url: state.url,
      document_binding: documentBinding },
    selectedParentCandidate: true, selection_digest: "test-source-selected-modal", composer, submit,
  });
  const environment = {
    console, Date, Object, JSON, Set, Map, WeakMap, WeakSet,
    fail, digestObject: json, actionDigest: json, immutableJsonSnapshot: (value) => value,
    nowIso: () => "2026-09-05T00:00:00.000Z", requiredString: (value) => {
      if (typeof value !== "string" || !value.trim()) fail("missing required string");
      return value;
    },
    liveReplyUrl: (value) => value.comment_anchor.comment_permalink,
    unique: async (locator) => { if (!locator) fail("missing unique locator"); return locator; },
    isCommentCuaTab: (value) => value === tab && state.cua !== false,
    requireCommentCuaTab: async (value, url) => {
      events.push("tab-check");
      if (value !== tab || state.url !== url) fail("CUA target URL changed");
    },
    requireLiveReplyPolicy: async () => {
      events.push("lease"); state.onLease?.(state, events);
      return { lease_id: "test-lease", lease_digest: "test-lease-digest" };
    },
    prepareLiveReplyThread: async () => { events.push("select"); return surface(); },
    inspectLiveCanarySurface: async () => { events.push("surface-read"); return surface(); },
    inspectLiveReplySurface: async () => fail("non-canary path must not execute"),
    revalidateThreadsSelection: async () => { events.push("selection-read"); return surface(); },
    bindLiveSubmitNode: async () => fail("CUA must not use the retired node binder"),
    preparationCore: (receipt) => receipt.action_digest + receipt.plan_digest + receipt.observed_url,
    createPythonLedgerClaimSubmit: () => async () => {
      events.push("claim"); state.claims += 1;
      if (state.claimThrows) fail("durable claim rejected");
      state.onClaim?.(state, events);
      return { claim_id: "test-claim", preflight_id: "test-preflight" };
    },
    isPythonLedgerClaimSubmit: () => true,
    claimRequest: () => ({ test_only: true }), validateWriteDecision: (decision) => decision,
    inspectLiveCanaryResult: async () => {
      events.push("result-read");
      if (state.clicks !== 1 || state.clickThrows) fail("native result remains unknown");
      return { verifiedNewReply: true, observedUrl: targetUrl, exactOwnCount: 1, ownReplyCount: 1,
        totalReplies: 1, replyPermalink: "https://www.threads.com/@example.owner/post/OwnReply789" };
    },
    commitPythonLedgerBrowserReceipt: async (_claim, operation, receipt) => {
      assert.equal(operation, "browser-finish"); events.push("finish"); state.receipts.push(receipt);
      return { status: receipt.exact_reply_visible ? "sent" : "needs_reconcile", reconcile_required: !receipt.exact_reply_visible };
    },
    liveCanarySelections: new WeakMap(), liveCanaryContexts: new WeakSet(),
    liveReplyExecutionReservations: new Set(), liveReplyRecoveryContexts: new Map(),
  };
  let orchestration = functions;
  if (options.actualRuntime) {
    Object.assign(environment, {
      getCommentCuaBrowser: cuaRuntime.getCommentCuaBrowser,
      hasCommentCuaRuntime: cuaRuntime.hasCommentCuaRuntime,
      installCommentCuaRuntime: cuaRuntime.installCommentCuaRuntime,
      isCommentCuaTab: cuaRuntime.isCommentCuaTab,
      requireCommentCuaTab: cuaRuntime.requireCommentCuaTab,
      getSourceOwnedChromeBrowser: async () => { events.push("legacy-runtime"); fail("legacy runtime used"); },
      readApprovedReplyAction: async () => { events.push("action-read"); return action; },
      waitForNativeParent: async (actualTab) => { assert.equal(actualTab, tab); events.push("parent-ready"); },
      bindLiveReplyBrowser: (actualTab, browser) => {
        assert.equal(actualTab, tab); assert.equal(browser, cuaRuntime.getCommentCuaBrowser());
        assert.equal(cuaRuntime.isCommentCuaTab(actualTab), true);
        events.push("same-runtime-binding");
      },
      createScanPost: () => { events.push("actor-scan-created"); return () => {}; },
      createScanAndCommit: () => () => {}, createSendOperations: () => ({}),
      LIVE_REPLY_ADAPTER_VERSION: "test-adapter-revision",
      setTimeout: () => 0,
    });
    orchestration += "\n" + ["getLiveCommentBrowser", "createLiveCommentTab", "executeLiveCanaryReply",
      "createCommentChromeActuator", "createCommentCuaActuator"].map(functionSource).join("\n");
  }
  const selectedApi = options.actualRuntime ? ", createCommentCuaActuator" : "";
  const api = runInNewContext(`${orchestration}\n({ prepareLiveCanaryReply, submitLiveReplyAndFinish${selectedApi} })`, environment);
  const plan = { platform: action.scope.platform, target_url: targetUrl };
  return { state, events, action, tab, plan, canary, api,
    prepare: () => api.prepareLiveCanaryReply(tab, action, plan, canary),
    send: (preparation) => api.submitLiveReplyAndFinish(tab, action, plan, preparation, canary) };
}

for (const [name, options, message] of [
  ["missing transport", { cua: false }, /supported source-bound submit transport/u],
  ["unsupported CUA platform", { platform: "facebook" }, /only for native Threads\/Instagram/u],
  ["wrong CUA target", { url: "https://www.threads.com/@another.reader/post/Other456" }, /target URL changed/u],
]) {
  const test = isolatedCase(options);
  await assert.rejects(test.prepare(), message, name);
  assert.equal(test.state.fills, 0, `${name}: reject before filling`);
  assert.equal(test.state.clicks, 0);
  assert.equal(test.events.includes("select"), false, `${name}: reject before opening a reply`);
}

const success = isolatedCase();
const successfulPreparation = await success.prepare();
const result = await success.send(successfulPreparation);
assert.equal(success.state.fills, 1);
assert.equal(success.state.claims, 1);
assert.equal(success.state.clicks, 1);
assert.equal(result.status, "sent");
assert.equal(success.state.receipts[0].submission_attempted, true);
const lastLease = success.events.lastIndexOf("lease");
const lastRead = success.events.lastIndexOf("surface-read");
const click = success.events.indexOf("click");
assert.ok(lastLease < lastRead && lastRead < click, "final lease completes before the final native selection read and one click");
await assert.rejects(success.send(successfulPreparation), /second in-process execution/u);
assert.equal(success.state.clicks, 1, "successful action cannot dispatch again");
assert.equal(success.state.claims, 1);

const claimFailure = isolatedCase({ claimThrows: true });
const rejectedPreparation = await claimFailure.prepare();
await assert.rejects(claimFailure.send(rejectedPreparation), /durable claim rejected/u);
await assert.rejects(claimFailure.send(rejectedPreparation), /second in-process execution/u);
assert.equal(claimFailure.state.claims, 1, "uncertain/rejected durable claim does not reset the execution reservation");
assert.equal(claimFailure.state.clicks, 0);

for (const [name, options] of [
  ["postclaim draft drift", { onClaim: (state) => { state.text = "Changed by someone else"; } }],
  ["postclaim target drift", { onClaim: (state) => { state.url = "https://www.threads.com/@another.reader/post/Other456"; } }],
  ["final lease draft drift", { onLease: (state, events) => { if (events.includes("claim")) state.text = "Changed during lease I/O"; } }],
  ["final lease target drift", { onLease: (state, events) => { if (events.includes("claim")) state.url = "https://www.threads.com/@another.reader/post/Other456"; } }],
]) {
  const test = isolatedCase(options);
  const preparation = await test.prepare();
  const outcome = await test.send(preparation);
  assert.equal(test.state.claims, 1, name);
  assert.equal(test.state.clicks, 0, `${name}: no submit click`);
  assert.equal(outcome.status, "needs_reconcile", name);
  assert.equal(test.state.receipts[0].submission_attempted, false, name);
  assert.equal(test.state.receipts[0].exact_reply_visible, false, name);
}

const ambiguous = isolatedCase({ clickThrows: true });
const ambiguousPreparation = await ambiguous.prepare();
const uncertain = await ambiguous.send(ambiguousPreparation);
assert.equal(uncertain.status, "needs_reconcile");
assert.equal(ambiguous.state.receipts[0].submission_attempted, true);
assert.equal(ambiguous.state.receipts[0].submission_possible, true);
assert.equal(ambiguous.state.receipts[0].exact_reply_visible, false);
await assert.rejects(ambiguous.send(ambiguousPreparation), /second in-process execution/u);
assert.equal(ambiguous.state.clicks, 1, "a throwing click is never retried");
assert.equal(ambiguous.state.claims, 1);

function emptyThreadsScaffold() {
  const linebreak = { nodeType: 1, tagName: "BR", childNodes: [],
    getAttribute: (name) => name === "data-lexical-managed-linebreak" ? "true" : null };
  const paragraph = { nodeType: 1, tagName: "P", childNodes: [linebreak],
    getAttribute: (name) => name === "dir" ? "auto" : null };
  return { innerText: "\n", textContent: "", childNodes: [paragraph] };
}

const scaffold = isolatedCase({ initialDom: emptyThreadsScaffold() });
assert.equal(scaffold.state.initialDom.isContentEditable, undefined,
  "CUA readonly DOM omits isContentEditable; native attributes remain authoritative");
const scaffoldPreparation = await scaffold.prepare();
assert.equal(scaffoldPreparation.composer_empty_before_fill, true);
assert.equal(scaffold.state.fills, 1, "the observed empty P/BR scaffold accepts one approved fill");
assert.equal(scaffold.state.claims, 0, "preparation itself never consumes a claim");
assert.equal((await scaffold.send(scaffoldPreparation)).status, "sent");
assert.equal(scaffold.state.clicks, 1);

for (const [name, initialDom] of [
  ["space draft", { isContentEditable: true, innerText: " ", textContent: " ", childNodes: [{ nodeType: 3 }] }],
  ["newline text node", { isContentEditable: true, innerText: "\n", textContent: "\n", childNodes: [{ nodeType: 3 }] }],
  ["hidden text", { ...emptyThreadsScaffold(), innerText: "", textContent: "existing hidden draft" }],
  ["media", { ...emptyThreadsScaffold(), childNodes: [{ nodeType: 1, tagName: "IMG", childNodes: [] }] }],
  ["hidden empty element", { ...emptyThreadsScaffold(), childNodes: [{ nodeType: 1, tagName: "SPAN", childNodes: [] }] }],
  ["unmarked linebreak", { ...emptyThreadsScaffold(), childNodes: [{ nodeType: 1, tagName: "P",
    getAttribute: () => "auto", childNodes: [{ nodeType: 1, tagName: "BR", childNodes: [], getAttribute: () => null }] }] }],
  ["not editable", { ...emptyThreadsScaffold(),
    getAttribute: (name) => ({ contenteditable: "false", role: "textbox" })[name] ?? null }],
  ["wrong role", { ...emptyThreadsScaffold(),
    getAttribute: (name) => ({ contenteditable: "true", role: "button" })[name] ?? null }],
  ["missing editable attribute", { ...emptyThreadsScaffold(),
    getAttribute: (name) => name === "role" ? "textbox" : null }],
]) {
  const test = isolatedCase({ initialDom });
  await assert.rejects(test.prepare(), /source-selected composer is not empty/u, name);
  assert.equal(test.state.fills, 0, name);
  assert.equal(test.state.claims, 0, name);
  assert.equal(test.state.clicks, 0, name);
}

const changedEmptyScaffold = isolatedCase({ initialDom: emptyThreadsScaffold(),
  onLease: (state, events) => {
    if (events.includes("select")) state.initialDom.textContent = "new hidden draft";
  } });
await assert.rejects(changedEmptyScaffold.prepare(), /draft changed before fill/u);
assert.equal(changedEmptyScaffold.state.fills, 0);
assert.equal(changedEmptyScaffold.state.claims, 0);

const wrongScaffoldFill = isolatedCase({ initialDom: emptyThreadsScaffold(), filledText: " Thanks for sharing!" });
await assert.rejects(wrongScaffoldFill.prepare(), /immutable approved text/u);
assert.equal(wrongScaffoldFill.state.fills, 1);
assert.equal(wrongScaffoldFill.state.claims, 0);
assert.equal(wrongScaffoldFill.state.clicks, 0);

// The actual source bootstrap returns an actor whose canary uses the same real
// runtime singleton. CUA I/O and ledger I/O here are isolated test substitutes.
const bound = isolatedCase({ actualRuntime: true });
const browserId = "example-browser";
const suppliedCua = {
  async getState() {
    return { browsers: [{ id: browserId, family: "chrome", type: "extension",
      metadata: { extensionInstanceId: "example-extension" },
      tabs: [{ id: bound.tab.id, url: bound.state.url }] }] };
  },
  async getTab() { return bound.tab; },
  async createBrowserTab(family, url, options) {
    assert.equal(family, "chrome"); assert.equal(url, bound.state.url);
    assert.equal(options.sessionName, "💬 Social Post");
    bound.events.push("cua-create"); return bound.tab;
  },
};
assert.equal(cuaRuntime.hasCommentCuaRuntime(), false);
const returnedActor = await bound.api.createCommentCuaActuator(suppliedCua, { browserId });
assert.equal(cuaRuntime.hasCommentCuaRuntime(), true);
assert.equal(Object.isFrozen(returnedActor), true);
const boundOutcome = await returnedActor.executeCanaryReply({
  intentId: bound.action.intent_id, sessionId: bound.action.session_id, leaseId: "test-lease",
});
assert.equal(boundOutcome.status, "sent");
assert.equal(bound.state.clicks, 1);
assert.equal(bound.state.claims, 1);
assert.equal(bound.events.filter((event) => event === "same-runtime-binding").length, 1);
assert.equal(bound.events.includes("legacy-runtime"), false);
assert.equal(bound.events.filter((event) => event === "cua-create").length, 1);
const actorsBeforeRetry = bound.events.filter((event) => event === "actor-scan-created").length;
await assert.rejects(bound.api.createCommentCuaActuator(suppliedCua, { browserId }), /already attempted/u);
assert.equal(bound.events.filter((event) => event === "actor-scan-created").length, actorsBeforeRetry,
  "duplicate bootstrap cannot create another actor after installation rejection");
assert.equal(bound.events.includes("legacy-runtime"), false);

// Execute the actual private reconcile orchestration. A positive-only reader
// failure is an unresolved observation, not a fabricated zero-count receipt.
function isolatedRecoveryCase({ fresh = false, reads = ["unknown"] } = {}) {
  const state = { reads: [...reads], commits: [], rotations: 0, observations: 0 };
  const action = { action_id: "recovery-action", intent_id: "recovery-intent", session_id: "original-session",
    scope: { platform: "threads" }, comment_fingerprint: "fingerprint", reply_hash: "reply-hash" };
  const request = { intentId: action.intent_id, sessionId: "recovery-session" };
  const key = JSON.stringify([request.intentId, request.sessionId]);
  const preparation = { preparation_id: "preparation", baseline_total_reply_count: 0 };
  const attempt = { canary_lease_id: "existing-lease", attempt_session_id: action.session_id,
    claim_id: "existing-claim", preflight_id: "existing-preflight" };
  const capabilityOwner = async () => { throw new Error("recovery must never claim or send"); };
  const context = { action, preparation, attempt, claimSubmit: capabilityOwner };
  const contexts = new Map(fresh ? [] : [[key, context]]);
  const inFlight = new Set();
  const environment = {
    Object, JSON, Set, Map,
    fail: (message) => { throw new Error(message); },
    requiredString: (value) => { assert.equal(typeof value, "string"); assert.ok(value.length); return value; },
    immutableJsonSnapshot: (value) => value,
    nowIso: () => "2026-09-05T00:00:00.000Z",
    liveReplyRecoveryContexts: contexts, liveReplyRecoveryInFlight: inFlight,
    readLiveRecoveryAction: async () => ({ action, preparation, attempt }),
    createPythonLedgerClaimSubmit: () => capabilityOwner,
    isPythonLedgerClaimSubmit: (value) => value === capabilityOwner,
    withPrivateRecoveryTab: async (_context, inspect) => inspect({}),
    inspectLiveCanaryResult: async () => {
      state.observations += 1;
      const read = state.reads.shift() ?? "unknown";
      if (read === "unknown") throw new Error("native nested parent not verified");
      return { verifiedNewReply: true, exactOwnCount: 1, ownReplyCount: read === "invalid-count" ? 0 : 1,
        totalReplies: 1, observedUrl: "https://www.threads.com/@example.reader/post/Comment456" };
    },
    recoverPythonLedgerReconcile: async (owner) => {
      assert.equal(owner, capabilityOwner); state.rotations += 1;
      return { attempt_session_id: action.session_id };
    },
    commitPythonLedgerBrowserReceipt: async (owner, operation, receipt) => {
      assert.equal(owner, capabilityOwner, "the same private capability owner must be retained");
      assert.equal(operation, "browser-reconcile");
      for (const flag of ["account_verified", "post_verified", "target_verified", "parent_verified",
        "exact_reply_visible", "own_author_verified"]) assert.equal(receipt[flag], true);
      assert.equal(receipt.absence_verified, false);
      assert.equal(receipt.own_author_reply_count, 1);
      assert.equal(receipt.reinspection_total_reply_count, 1);
      state.commits.push(receipt);
      return { outcome: "sent", reconcile_required: false };
    },
  };
  const recoverySource = ["liveRecoveryRequest", "inspectLiveReinspectionReceipt", "inspectCanaryReinspectionReceipt",
    "commitLiveReinspection", "recoverLiveApprovedReply", "reconcileLiveUncertainReply"].map(functionSource).join("\n");
  const api = runInNewContext(`${recoverySource}\n({ recoverLiveApprovedReply, reconcileLiveUncertainReply })`, environment);
  return { state, contexts, inFlight, key, context,
    recover: () => api.recoverLiveApprovedReply(request),
    reconcile: () => api.reconcileLiveUncertainReply(request) };
}

function assertUnresolvedRecovery(result, test) {
  assert.equal(result.outcome, "unknown");
  assert.equal(result.committed, false);
  assert.equal(result.reconcile_required, true);
  assert.equal(result.inspection_status, "unresolved");
  assert.equal(Object.hasOwn(result, "account_verified"), false, "unresolved output is not a receipt");
  assert.equal(test.state.commits.length, 0, "unresolved reinspection must not call the ledger");
  assert.equal(test.inFlight.size, 0, "read-only failure must release the in-process reinspection lock");
}

const activeUnknown = isolatedRecoveryCase({ reads: ["unknown", "invalid-count", "positive"] });
assertUnresolvedRecovery(await activeUnknown.reconcile(), activeUnknown);
assert.equal(activeUnknown.contexts.get(activeUnknown.key), activeUnknown.context);
assertUnresolvedRecovery(await activeUnknown.reconcile(), activeUnknown);
assert.equal(activeUnknown.contexts.get(activeUnknown.key), activeUnknown.context);
assert.equal(activeUnknown.state.rotations, 0);
assert.equal((await activeUnknown.reconcile()).outcome, "sent");
assert.equal(activeUnknown.state.commits.length, 1);
assert.equal(activeUnknown.state.rotations, 0, "later positive read uses the original unconsumed capability");
assert.equal(activeUnknown.contexts.has(activeUnknown.key), false);

const freshUnknown = isolatedRecoveryCase({ fresh: true });
assertUnresolvedRecovery(await freshUnknown.recover(), freshUnknown);
assert.equal(freshUnknown.state.rotations, 0, "unresolved preinspection must not rotate recovery authority");
assert.equal(freshUnknown.contexts.size, 0);

const changedAfterRotation = isolatedRecoveryCase({ fresh: true, reads: ["positive", "unknown", "positive"] });
assertUnresolvedRecovery(await changedAfterRotation.recover(), changedAfterRotation);
assert.equal(changedAfterRotation.state.rotations, 1);
const retainedContext = changedAfterRotation.contexts.get(changedAfterRotation.key);
assert.ok(retainedContext, "a postrotation unknown must retain its active private recovery context");
assert.equal((await changedAfterRotation.reconcile()).outcome, "sent");
assert.equal(changedAfterRotation.state.rotations, 1, "do not rotate again for an existing recovery context");
assert.equal(changedAfterRotation.state.commits.length, 1);
assert.equal(changedAfterRotation.contexts.size, 0);

console.log("PASS CUA durable dispatch orchestration (isolated; no browser or canonical ledger)");

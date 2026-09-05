/** Exact-target tab ownership tests; source extraction and mocks, never a browser. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { canonicalUrl, fail, immutableJsonSnapshot, requiredString } from "./comment_chrome_common.mjs";

const source = (await readFile(new URL("./comment_chrome_claim_bridge.mjs", import.meta.url), "utf8")).replace(/\r\n/gu, "\n");
function between(startText, endText) {
  const start = source.indexOf(startText), end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `actual source boundary missing: ${startText}`);
  assert.equal(source.indexOf(startText, start + startText.length), -1);
  return source.slice(start, end);
}
const helperSource = between("async function requireExactTargetIntakeTab(", "async function observeLiveTargetComment(");
const runtimeSource = between("async function getLiveCommentBrowser(", "async function requireLiveSubmitTransport(");
const observeSource = between("async function observeLiveTargetComment(", "export function createCommentChromeActuator(");
const recoverySource = between("function liveRecoveryRequest(", "export function isPythonLedgerClaimSubmit(");
const targetUrl = "https://www.facebook.com/story.php?story_fbid=POST_A&id=ACCOUNT_A&comment_id=COMMENT_A";
const otherUrl = targetUrl.replace("COMMENT_A", "COMMENT_B");
const fixtures = [];

function mockTab(id, url) {
  const record = { href: url, calls: { url: 0, goto: [], close: 0 } };
  record.tab = { id,
    url: async () => {
      record.calls.url += 1;
      record.onUrl?.(record.calls.url, record);
      if (record.urlErrorAt === record.calls.url) throw record.error;
      return record.href;
    },
    goto: async (url) => {
      record.calls.goto.push(url);
      if (record.gotoError) throw record.gotoError;
      record.href = record.gotoUrl ?? url;
    },
    close: async () => {
      record.calls.close += 1;
      if (record.closeError) throw record.closeError;
      if (record.closePending) return new Promise(() => {});
    },
  };
  return record;
}

function fixture(options = {}) {
  const current = { targetUrl: options.targetUrl ?? targetUrl,
    existing: mockTab("existing-tab", options.targetUrl ?? targetUrl), created: mockTab("created-tab", "about:blank"),
    calls: { browser: 0, legacyBrowser: 0, cuaBrowser: 0, cuaChecks: [], list: 0, get: [], new: 0, newArgs: [],
      bind: 0, inspect: 0, timers: [], authorization: 0 }, ...options };
  current.browser = { tabs: {
    list: async () => {
      current.calls.list += 1;
      if (current.listError) throw current.listError;
      if (typeof current.listing === "function") return current.listing(current.calls.list);
      return Object.hasOwn(current, "listing") ? current.listing : [{ id: "existing-tab", url: current.targetUrl }];
    },
    get: async (id) => {
      current.calls.get.push(id);
      if (current.getError) throw current.getError;
      return current.existing.tab;
    },
    new: async (url) => {
      current.calls.new += 1;
      current.calls.newArgs.push(url);
      if (current.newError) throw current.newError;
      if (current.cua) current.created.href = current.created.gotoUrl ?? url;
      return current.created.tab;
    },
  } };
  current.environment = {
    URL, canonicalUrl, fail, immutableJsonSnapshot, requiredString,
    hasCommentCuaRuntime: () => Boolean(current.cua),
    isCommentCuaTab: (tab) => Boolean(current.cua) && (tab === current.existing.tab || tab === current.created.tab),
    getCommentCuaBrowser: async () => { current.calls.browser += 1; current.calls.cuaBrowser += 1; return current.browser; },
    getSourceOwnedChromeBrowser: async () => { current.calls.browser += 1; current.calls.legacyBrowser += 1; return current.browser; },
    requireCommentCuaTab: async (tab, url) => {
      current.calls.cuaChecks.push({ id: tab.id, url });
      const record = tab === current.existing.tab ? current.existing : current.created;
      if (canonicalUrl(record.href).toString() !== url) fail("CUA target tab URL changed");
    },
    bindLiveReplyBrowser: (tab, browser) => {
      current.calls.bind += 1;
      assert.equal(browser, current.browser);
      assert.ok(tab === current.existing.tab || tab === current.created.tab);
    },
    setTimeout: (callback, delay) => {
      current.calls.timers.push(delay);
      assert.equal(delay, 2000);
      if (current.fireCleanupTimeout) callback();
      return 0;
    },
    normalizeScanTarget: () => { throw new Error("unexpected normalization after forbidden caller authority"); },
    runPythonScanRequest: () => { current.calls.authorization += 1; throw new Error("test forbids authorization"); },
  };
  const api = runInNewContext(`${runtimeSource}\n${helperSource}\n${observeSource}\n({ withSourceOwnedTargetIntakeTab, observeLiveTargetComment })`, current.environment, { timeout: 1000 });
  current.observeRequest = api.observeLiveTargetComment;
  current.run = (inspect = async () => ({ observed: "native callback result" }), url = current.targetUrl) =>
    api.withSourceOwnedTargetIntakeTab(url, async (tab) => { current.calls.inspect += 1; return inspect(tab); });
  fixtures.push(current);
  return current;
}

function testSourceOwnershipAndCommitOrdering() {
  assert.doesNotMatch(source, /export\s+(?:async\s+)?function\s+(?:requireExactTargetIntakeTab|withSourceOwnedTargetIntakeTab)\b/u);
  assert.doesNotMatch(helperSource, /\b(?:recoverSourceOwnedChromeBrowser|claimTab|runPythonScanCommit|receipt_capability)\b|\bimport\s*\(|\.(?:fill|click|press|send|submit|reload)\s*\(/u);
  assert.match(helperSource, /const listed = await browser\.tabs\.list\(\);/u);
  assert.match(helperSource, /const result = await inspect\(tab\);\s*await requireExactTargetIntakeTab\(tab, expectedUrl, tabId\);\s*return result;/u);
  assert.match(observeSource, /const \{ first, second \} = await withSourceOwnedTargetIntakeTab\(request\.target\.comment_permalink, async \(tab\) =>/u);
  assert.equal((observeSource.match(/await readLiveTargetComment\(tab, sourceTarget\)/gu) ?? []).length, 2);
  const readReturn = observeSource.indexOf("return { first, second };");
  const commitCall = observeSource.indexOf("await runPythonScanCommit(");
  assert.ok(readReturn >= 0 && commitCall > readReturn,
    "the wrapper must complete its post-read identity/URL check before any ledger commit");
  assert.match(source, /async function observeTargetComment\(request\) \{\s*if \(!defaultLiveExecution\) fail\([^;]+;\s*return observeLiveTargetComment\(request\);\s*\}/u);
}

async function testExactExistingTabAndFreshListings() {
  const current = fixture();
  const result = { observed: "actual callback output, not listing metadata" };
  assert.equal(await current.run(async (tab) => { assert.equal(tab, current.existing.tab); return result; }), result);
  assert.deepEqual(current.calls.get, ["existing-tab"]);
  assert.equal(current.calls.new, 0);
  assert.equal(current.existing.calls.url, 2);
  assert.equal(current.calls.inspect, 1);
  const fresh = fixture({ listing: (read) => read === 1 ? [{ id: "existing-tab", url: targetUrl }] : [] });
  await fresh.run(); await fresh.run();
  assert.equal(fresh.calls.list, 2, "each intake obtains a new source-owned listing");
  assert.equal(fresh.calls.browser, 2);
  assert.deepEqual(fresh.calls.get, ["existing-tab"]);
  assert.equal(fresh.calls.new, 1);
  assert.equal(fresh.created.calls.close, 1);
}

async function testZeroMatchesCreatesAndOwnsOnlyNewTab() {
  for (const listing of [[], [{ id: "unrelated", url: otherUrl, title: targetUrl, comment_permalink: targetUrl }],
    [{ id: null, url: "about:blank" }, { id: "unrelated", url: "not a URL" }]]) {
    const current = fixture({ listing });
    await current.run(async (tab) => { assert.equal(tab, current.created.tab); return "read"; });
    assert.deepEqual(current.calls.get, []);
    assert.equal(current.calls.new, 1);
    assert.deepEqual(current.created.calls.goto, [canonicalUrl(targetUrl).toString()]);
    assert.equal(current.created.calls.url, 2);
    assert.equal(current.created.calls.close, 1);
    assert.deepEqual(current.calls.timers, [2000]);
  }
}

async function testAmbiguousAndMalformedListingsRejectBeforeOpening() {
  const duplicate = [{ id: "existing-tab", url: targetUrl }, { id: "other-tab", url: targetUrl }];
  for (const listing of [duplicate, [duplicate[0], duplicate[0]], null, {}, "[]", [null], [{}], [{ id: "x", url: null }]]) {
    const current = fixture({ listing });
    await assert.rejects(current.run(), /multiple exact URL tabs|listing is malformed|metadata is malformed/u);
    assert.deepEqual(current.calls.get, []);
    assert.equal(current.calls.new, 0);
    assert.equal(current.calls.inspect, 0);
  }
  for (const id of [undefined, null, 123, "", " existing-tab", "existing-tab "]) {
    const current = fixture({ listing: [{ id, url: targetUrl }] });
    await assert.rejects(current.run(), /listed tab id/u);
    assert.equal(current.calls.new, 0);
    assert.deepEqual(current.calls.get, []);
  }
}

async function testCanonicalUrlMatchingAndLiveVerification() {
  const alias = targetUrl.replace("www.facebook.com/story.php", "WWW.FACEBOOK.COM/story.php/");
  const equivalent = fixture({ listing: [{ id: "existing-tab", url: alias }] });
  equivalent.existing.href = alias;
  await equivalent.run();
  assert.deepEqual(equivalent.calls.get, ["existing-tab"]);
  for (const url of [otherUrl, targetUrl.replace("www.facebook.com", "m.facebook.com"),
    targetUrl.replace("story_fbid=POST_A&id=ACCOUNT_A", "id=ACCOUNT_A&story_fbid=POST_A"),
    `${targetUrl}&extra=1`, `${targetUrl}#reply`, "https://user@www.facebook.com/", "https://www.facebook.com:8443/"]) {
    const current = fixture({ listing: [{ id: "existing-tab", url }] });
    await current.run();
    assert.deepEqual(current.calls.get, [], "other hosts, queries, fragments and invalid URL metadata are not target authority");
    assert.equal(current.calls.new, 1);
  }
  const staleMetadata = fixture(); staleMetadata.existing.href = otherUrl;
  await assert.rejects(staleMetadata.run(), /tab URL changed/u);
  assert.equal(staleMetadata.calls.inspect, 0, "matching listing metadata never replaces live URL verification");
  const fragmented = fixture(); fragmented.existing.href = `${targetUrl}#reply`;
  await assert.rejects(fragmented.run(), /tab URL changed/u);
  assert.equal(fragmented.calls.inspect, 0);
}

async function testIdentityAndUrlDriftBeforeAndAfterRead() {
  for (const created of [false, true]) {
    for (const when of ["before-url", "during-first-url", "after-url", "after-id"]) {
      const current = fixture(created ? { listing: [] } : {});
      const record = created ? current.created : current.existing;
      if (when === "before-url") { record.href = otherUrl; record.gotoUrl = otherUrl; }
      if (when === "during-first-url") record.onUrl = (read) => { if (read === 1) record.tab.id = "changed-tab"; };
      await assert.rejects(current.run(async () => {
        if (when === "after-url") record.href = otherUrl;
        if (when === "after-id") record.tab.id = "changed-tab";
        return "must not escape stale source tab";
      }), /tab (?:URL|identity) changed/u);
      assert.equal(current.calls.inspect, when.startsWith("after") ? 1 : 0);
      assert.equal(record.calls.close, created ? 1 : 0);
    }
  }
  const mismatch = fixture(); mismatch.existing.tab.id = "not-the-listed-id";
  await assert.rejects(mismatch.run(), /resolved tab differs from the source listing/u);
  assert.equal(mismatch.calls.inspect, 0);
  for (const id of [undefined, null, "", " created-tab "]) {
    const invalid = fixture({ listing: [] }); invalid.created.tab.id = id;
    await assert.rejects(invalid.run(), /tab id|resolved tab differs/u);
    assert.equal(invalid.created.calls.close, 1);
  }
}

async function testFailuresNeverRetryAndRespectCleanupOwnership() {
  for (const created of [false, true]) {
    for (const stage of ["list", created ? "new" : "get", "read", "url-before", "url-after", ...(created ? ["goto"] : [])]) {
      const error = new Error(`anonymous ${stage} failure`);
      const current = fixture(created ? { listing: [] } : {});
      const record = created ? current.created : current.existing;
      if (["list", "get", "new"].includes(stage)) current[`${stage}Error`] = error;
      if (stage === "goto") record.gotoError = error;
      if (stage.startsWith("url-")) { record.error = error; record.urlErrorAt = stage === "url-before" ? 1 : 2; }
      await assert.rejects(current.run(async () => { if (stage === "read") throw error; return "observed"; }), (actual) => actual === error);
      assert.equal(current.calls.browser, 1);
      assert.equal(current.calls.list, 1);
      assert.ok(current.calls.get.length <= 1 && current.calls.new <= 1 && current.calls.inspect <= 1);
      assert.equal(record.calls.close, created && !["list", "new"].includes(stage) ? 1 : 0);
    }
  }
  for (const kind of ["rejected-close", "bounded-close"]) {
    const current = fixture({ listing: [], fireCleanupTimeout: kind === "bounded-close" });
    if (kind === "bounded-close") current.created.closePending = true;
    else current.created.closeError = new Error("anonymous cleanup failure");
    assert.equal(await current.run(async () => "observed"), "observed");
    assert.equal(current.created.calls.close, 1);
    assert.deepEqual(current.calls.timers, [2000]);
  }
}

async function testCallerCannotProvideTabOrBrowserAuthority() {
  const raw = { platform: "facebook", account_key: "ACCOUNT_A", post_key: "POST_A",
    post_permalink: "https://www.facebook.com/story.php?story_fbid=POST_A&id=ACCOUNT_A",
    session_id: "anonymous-session", ttl_minutes: 5, platform_comment_id: "COMMENT_A", comment_permalink: targetUrl };
  for (const key of ["tab", "browser", "tabId", "tab_id", "browserId", "transport", "inspect"]) {
    const current = fixture();
    await assert.rejects(current.observeRequest({ ...raw, [key]: "caller supplied" }), /accepts only exact target identity/u);
    assert.equal(current.calls.browser, 0);
    assert.equal(current.calls.list, 0);
    assert.equal(current.calls.authorization, 0, "publicly delegated request guard rejects authority before authorization or browser access");
  }
}

async function testCuaCreatesAtExactUrlAndChecksIdentityTwice() {
  for (const created of [false, true]) {
    const current = fixture({ cua: true, ...(created ? { listing: [] } : {}) });
    const record = created ? current.created : current.existing;
    assert.equal(await current.run(async (tab) => {
      assert.equal(tab, record.tab);
      assert.equal(current.calls.cuaChecks.length, 1, "CUA target is checked before native inspection");
      return "CUA native observation";
    }), "CUA native observation");
    assert.equal(current.calls.cuaBrowser, 1);
    assert.equal(current.calls.legacyBrowser, 0);
    assert.deepEqual(current.calls.newArgs, created ? [canonicalUrl(targetUrl).toString()] : []);
    assert.deepEqual(record.calls.goto, [], "CUA tabs.new(url) never causes a second goto");
    assert.deepEqual(current.calls.cuaChecks, [
      { id: record.tab.id, url: canonicalUrl(targetUrl).toString() },
      { id: record.tab.id, url: canonicalUrl(targetUrl).toString() },
    ], "same exact CUA identity/URL is checked before and after observation");
    assert.equal(record.calls.close, created ? 1 : 0);
  }
  for (const created of [false, true]) {
    for (const drift of ["id", "url"]) {
      const current = fixture({ cua: true, ...(created ? { listing: [] } : {}) });
      const record = created ? current.created : current.existing;
      await assert.rejects(current.run(async () => {
        if (drift === "id") record.tab.id = "changed-cua-tab";
        else record.href = otherUrl;
      }), /tab (?:identity|URL) changed/u);
      assert.equal(current.calls.cuaChecks.length, 2);
      assert.equal(current.calls.inspect, 1);
      assert.equal(record.calls.close, created ? 1 : 0);
    }
  }
}

function recoveryFixture({ fresh = false, reads = ["positive"], ...options } = {}) {
  const current = fixture({ cua: true,
    targetUrl: "https://www.threads.com/@example.reader/post/Comment456", ...options });
  const state = { observations: 0, waits: 0, rotations: 0, commits: [], writes: [], reads: [...reads] };
  const action = { action_id: "recovery-action", intent_id: "recovery-intent", session_id: "original-session",
    scope: { platform: "threads" }, comment_permalink: current.targetUrl,
    comment_fingerprint: "fingerprint", reply_hash: "reply-hash" };
  const request = { intentId: action.intent_id, sessionId: "recovery-session" };
  const key = JSON.stringify([request.intentId, request.sessionId]);
  const preparation = { preparation_id: "preparation", baseline_total_reply_count: 0 };
  const attempt = { canary_lease_id: "existing-lease", attempt_session_id: action.session_id,
    claim_id: "existing-claim", preflight_id: "existing-preflight" };
  const forbidden = (operation) => async () => { state.writes.push(operation); throw new Error(`recovery forbids ${operation}`); };
  const claimSubmit = forbidden("claim");
  const context = { action, preparation, attempt, claimSubmit };
  const contexts = new Map(fresh ? [] : [[key, context]]), inFlight = new Set();
  for (const record of [current.existing, current.created]) {
    for (const name of ["click", "fill", "press", "submit", "reload"]) record.tab[name] = forbidden(name);
    record.tab.dom_cua = { click: forbidden("dom_cua.click") };
  }
  const api = runInNewContext(`${runtimeSource}\n${helperSource}\n${recoverySource}\n({ recoverLiveApprovedReply, reconcileLiveUncertainReply })`, {
    ...current.environment, Object, JSON, Set, Map,
    immutableJsonSnapshot: (value, label) => immutableJsonSnapshot(JSON.parse(JSON.stringify(value)), label),
    liveReplyUrl: (value) => value.comment_permalink,
    nowIso: () => "2026-09-05T00:00:00.000Z",
    liveReplyRecoveryContexts: contexts, liveReplyRecoveryInFlight: inFlight,
    readLiveRecoveryAction: async () => ({ action, preparation, attempt }),
    createPythonLedgerClaimSubmit: () => claimSubmit,
    isPythonLedgerClaimSubmit: (value) => value === claimSubmit,
    waitForNativeParent: async (tab) => {
      assert.ok(tab === current.existing.tab || tab === current.created.tab);
      state.waits += 1;
    },
    inspectLiveCanaryResult: async (tab) => {
      state.observations += 1;
      const record = tab === current.existing.tab ? current.existing : current.created;
      const read = state.reads.shift() ?? "positive";
      if (read === "unknown") throw new Error("native parent not verified");
      if (read === "url-drift") record.href = current.targetUrl.replace("Comment456", "Other789");
      if (read === "id-drift") tab.id = "changed-tab";
      return { verifiedNewReply: true, exactOwnCount: 1, ownReplyCount: 1,
        totalReplies: 1, observedUrl: current.targetUrl };
    },
    recoverPythonLedgerReconcile: async (owner) => {
      assert.equal(owner, claimSubmit);
      state.rotations += 1;
      assert.equal(current.calls.cuaChecks.length, 2, "preinspection final ownership check precedes rotation");
      return { attempt_session_id: action.session_id };
    },
    commitPythonLedgerBrowserReceipt: async (owner, operation, receipt) => {
      assert.equal(owner, claimSubmit);
      assert.equal(operation, "browser-reconcile");
      assert.equal(receipt.absence_verified, false, "tab reuse cannot broaden positive-only recovery to absence");
      assert.equal(current.calls.cuaChecks.length, state.observations * 2,
        "every complete observation has passed both CUA identity checks before commit");
      state.commits.push(receipt);
      return { outcome: "sent", reconcile_required: false };
    },
    submitLiveReplyAndFinish: forbidden("submitLiveReplyAndFinish"),
    prepareLiveReply: forbidden("prepareLiveReply"),
  }, { timeout: 1000 });
  return { current, state, contexts, context, inFlight, key,
    recover: (raw = request) => api.recoverLiveApprovedReply(raw),
    reconcile: (raw = request) => api.reconcileLiveUncertainReply(raw), request };
}

function assertRecoveryNeverWrites(test) {
  assert.deepEqual(test.state.writes, [], "recovery cannot claim, fill, submit, reload, or click");
  assert.equal(test.inFlight.size, 0);
  assert.equal(test.current.existing.calls.close, 0);
  assert.deepEqual(test.current.existing.calls.goto, []);
}

async function testRecoveryUsesExactSourceOwnedTabAndCommitsAfterChecks() {
  const active = recoveryFixture();
  assert.equal((await active.reconcile()).outcome, "sent");
  assert.deepEqual(active.current.calls.get, ["existing-tab"]);
  assert.equal(active.current.calls.new, 0);
  assert.equal(active.state.commits.length, 1);
  assert.equal(active.state.rotations, 0);
  assertRecoveryNeverWrites(active);

  const fresh = recoveryFixture({ fresh: true, reads: ["positive", "positive"] });
  assert.equal((await fresh.recover()).outcome, "sent");
  assert.deepEqual(fresh.current.calls.get, ["existing-tab", "existing-tab"]);
  assert.equal(fresh.current.calls.list, 2, "preinspection and postrotation reinspection use fresh source inventories");
  assert.equal(fresh.current.calls.new, 0);
  assert.equal(fresh.state.observations, 2);
  assert.equal(fresh.state.rotations, 1);
  assert.equal(fresh.state.commits.length, 1);
  assertRecoveryNeverWrites(fresh);

  const created = recoveryFixture({ listing: [] });
  assert.equal((await created.reconcile()).outcome, "sent");
  assert.deepEqual(created.current.calls.get, []);
  assert.deepEqual(created.current.calls.newArgs, [created.current.targetUrl]);
  assert.equal(created.current.created.calls.close, 1, "only the new source-owned recovery tab is closed");
  assert.equal(created.state.commits.length, 1);
  assertRecoveryNeverWrites(created);
}

async function testRecoveryAmbiguityAndDriftNeverCommit() {
  const ambiguous = recoveryFixture({ fresh: true });
  ambiguous.current.listing = ["existing-tab", "other-tab"].map((id) => ({ id, url: ambiguous.current.targetUrl }));
  await assert.rejects(ambiguous.recover(), /multiple exact URL tabs/u);
  assert.equal(ambiguous.state.rotations, 0);
  assert.equal(ambiguous.state.commits.length, 0);
  assert.equal(ambiguous.state.observations, 0);
  assert.equal(ambiguous.current.calls.new, 0);
  assertRecoveryNeverWrites(ambiguous);

  for (const drift of ["url-drift", "id-drift"]) {
    for (const stage of ["preinspection", "postrotation", "continuation", "new-tab"]) {
      const fresh = ["preinspection", "postrotation"].includes(stage);
      const test = recoveryFixture({ fresh, reads: stage === "postrotation" ? ["positive", drift] : [drift],
        ...(stage === "new-tab" ? { listing: [] } : {}) });
      await assert.rejects(fresh ? test.recover() : test.reconcile(), /tab (?:identity|URL) changed/u);
      assert.equal(test.state.commits.length, 0, "a URL/identity drift cannot escape as a committed receipt");
      assert.equal(test.state.rotations, stage === "postrotation" ? 1 : 0);
      assert.equal(test.contexts.has(test.key), stage !== "preinspection",
        "postrotation and continuation failures retain the private recovery context");
      if (stage === "new-tab") assert.equal(test.current.created.calls.close, 1);
      assertRecoveryNeverWrites(test);
      if (stage === "postrotation") {
        test.current.existing.href = test.current.targetUrl;
        test.current.existing.tab.id = "existing-tab";
        assert.equal((await test.reconcile()).outcome, "sent");
        assert.equal(test.state.rotations, 1, "fresh continuation never rotates again or resends");
        assert.equal(test.state.commits.length, 1);
        assertRecoveryNeverWrites(test);
      }
    }
  }

  const unknown = recoveryFixture({ fresh: true, reads: ["unknown"] });
  const unresolved = await unknown.recover();
  assert.equal(unresolved.outcome, "unknown");
  assert.equal(unresolved.committed, false);
  assert.equal(Object.hasOwn(unresolved, "absence_verified"), false);
  assert.equal(unknown.state.rotations, 0);
  assert.equal(unknown.state.commits.length, 0);
  assertRecoveryNeverWrites(unknown);

  for (const key of ["tab", "tabId", "browser", "inspect", "reply_text"]) {
    const injected = recoveryFixture({ fresh: true });
    await assert.rejects(injected.recover({ ...injected.request, [key]: "caller supplied" }), /accepts only intentId/u);
    assert.equal(injected.current.calls.browser, 0);
    assert.equal(injected.state.rotations, 0);
    assert.equal(injected.state.commits.length, 0);
    assertRecoveryNeverWrites(injected);
  }
}

testSourceOwnershipAndCommitOrdering();
await testExactExistingTabAndFreshListings();
await testZeroMatchesCreatesAndOwnsOnlyNewTab();
await testAmbiguousAndMalformedListingsRejectBeforeOpening();
await testCanonicalUrlMatchingAndLiveVerification();
await testIdentityAndUrlDriftBeforeAndAfterRead();
await testFailuresNeverRetryAndRespectCleanupOwnership();
await testCallerCannotProvideTabOrBrowserAuthority();
await testCuaCreatesAtExactUrlAndChecksIdentityTwice();
await testRecoveryUsesExactSourceOwnedTabAndCommitsAfterChecks();
await testRecoveryAmbiguityAndDriftNeverCommit();
for (const current of fixtures) {
  assert.equal(current.existing.calls.close, 0, "borrowed tabs are never closed, including on failure");
  assert.deepEqual(current.existing.calls.goto, [], "borrowed tabs are never navigated or force-reloaded");
  assert.ok(current.created.calls.goto.length <= 1 && current.created.calls.close <= 1);
}
console.log("PASS source-owned exact target intake tab reuse tests (mocked; no browser)");

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
const observeSource = between("async function observeLiveTargetComment(", "export function createCommentChromeActuator(");
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
  const current = { existing: mockTab("existing-tab", targetUrl), created: mockTab("created-tab", "about:blank"),
    calls: { browser: 0, list: 0, get: [], new: 0, bind: 0, inspect: 0, timers: [], authorization: 0 }, ...options };
  current.browser = { tabs: {
    list: async () => {
      current.calls.list += 1;
      if (current.listError) throw current.listError;
      if (typeof current.listing === "function") return current.listing(current.calls.list);
      return Object.hasOwn(current, "listing") ? current.listing : [{ id: "existing-tab", url: targetUrl }];
    },
    get: async (id) => {
      current.calls.get.push(id);
      if (current.getError) throw current.getError;
      return current.existing.tab;
    },
    new: async () => {
      current.calls.new += 1;
      if (current.newError) throw current.newError;
      return current.created.tab;
    },
  } };
  const api = runInNewContext(`${helperSource}\n${observeSource}\n({ withSourceOwnedTargetIntakeTab, observeLiveTargetComment })`, {
    URL, canonicalUrl, fail, immutableJsonSnapshot, requiredString,
    getSourceOwnedChromeBrowser: async () => { current.calls.browser += 1; return current.browser; },
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
  }, { timeout: 1000 });
  current.observeRequest = api.observeLiveTargetComment;
  current.run = (inspect = async () => ({ observed: "native callback result" }), url = targetUrl) =>
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

testSourceOwnershipAndCommitOrdering();
await testExactExistingTabAndFreshListings();
await testZeroMatchesCreatesAndOwnsOnlyNewTab();
await testAmbiguousAndMalformedListingsRejectBeforeOpening();
await testCanonicalUrlMatchingAndLiveVerification();
await testIdentityAndUrlDriftBeforeAndAfterRead();
await testFailuresNeverRetryAndRespectCleanupOwnership();
await testCallerCannotProvideTabOrBrowserAuthority();
for (const current of fixtures) {
  assert.equal(current.existing.calls.close, 0, "borrowed tabs are never closed, including on failure");
  assert.deepEqual(current.existing.calls.goto, [], "borrowed tabs are never navigated or force-reloaded");
  assert.ok(current.created.calls.goto.length <= 1 && current.created.calls.close <= 1);
}
console.log("PASS source-owned exact target intake tab reuse tests (mocked; no browser)");

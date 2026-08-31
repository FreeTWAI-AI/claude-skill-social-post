/** Source-owned reconnect regression tests; no browser client import or browser. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { types } from "node:util";
import { runInNewContext } from "node:vm";

const runtimeSource = (await readFile(new URL("./comment_chrome_runtime_authority.mjs", import.meta.url), "utf8"))
  .replace(/\r\n/gu, "\n");

function sourceBetween(startText, endText) {
  const start = runtimeSource.indexOf(startText);
  const end = runtimeSource.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `actual source boundaries must exist: ${startText}`);
  assert.equal(runtimeSource.indexOf(startText, start + startText.length), -1, "source start boundary must be unique");
  return runtimeSource.slice(start, end);
}

const stateSource = sourceBetween("let sourceOwnedChromeAgentPromise;", "const META_POST_PATH_RULES");
const connectionSource = sourceBetween("function requireBoundedChromeSurface(browser) {", "function approvedPermalink(rawTarget) {");
const validationSource = sourceBetween("function requireBrowserSurface(agent) {", "function requireExistingChromeSurface(browser) {");
const executableSource = `${stateSource}\n${connectionSource}\n${validationSource}`
  .replace(/^export (?=(?:async )?function\b)/gmu, "");
const harnesses = [];

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function nativeBrowser(browserId = "anonymous_chrome_1", listing = []) {
  const calls = { list: 0, new: 0 };
  const browser = { browserId, tabs: {
    new: async () => { calls.new += 1; throw new Error("test forbids tab creation"); },
    list: async () => { calls.list += 1; return typeof listing === "function" ? listing() : listing; },
  } };
  return { browser, calls, setListing: (value) => { listing = value; } };
}

function harness(select, options = {}) {
  const calls = { load: 0, setup: 0, selections: [] };
  const agent = { browsers: { get: async (name) => {
    calls.selections.push(name);
    return select(calls.selections.length - 1);
  } } };
  const api = runInNewContext(`${executableSource}\n({ getSourceOwnedChromeBrowser, recoverSourceOwnedChromeBrowser })`, {
    types,
    fail: (message) => { throw new Error(message); },
    loadSetupBrowserRuntime: async () => {
      calls.load += 1;
      if (options.loadError) throw options.loadError;
      return async () => {
        calls.setup += 1;
        if (options.setupError) throw options.setupError;
        return agent;
      };
    },
  }, { timeout: 1000 });
  assert.equal(api.getSourceOwnedChromeBrowser.length, 0);
  assert.equal(api.recoverSourceOwnedChromeBrowser.length, 0);
  const result = { ...api, calls };
  harnesses.push(result);
  return result;
}

const unavailable = (browserId) => new Error(`Browser is not available: ${browserId}`);
const sameError = (expected) => (actual) => actual === expected;

function testSourceBoundaries() {
  assert.deepEqual(stateSource.trim().split("\n"), [
    "let sourceOwnedChromeAgentPromise;", "let sourceOwnedChromePromise;",
    "let sourceOwnedChromeReconnectInFlight;", "let sourceOwnedChromeReselectionAttempted = false;",
  ], "execute the exact source-owned state declarations, never copied test state logic");
  assert.match(runtimeSource, /import \{ types \} from "node:util";/u);
  assert.match(connectionSource, /types\.isNativeError\(error\)/u);
  assert.equal((connectionSource.match(/agent\.browsers\.get\("chrome"\)/gu) ?? []).length, 1,
    "initial selection and qualified recovery share one source-owned selection call site");
  assert.match(connectionSource, /if \(arguments\.length !== 0\)/u);
  for (const pattern of [
    /\bimport\s*\(/u, /\brequire\s*\(/u, /\b(?:nodeRepl|globalThis|process|module)\s*\./u,
    /\.(?:claimTab|goto|reload|close|click|fill|press|send|submit|clear|delete)\s*\(/u,
    /\.tabs\.(?:new|get)\s*\(/u, /\b(?:EXISTING_CHROME_READ_SESSIONS|READ_SESSION_INTERNAL)\b/u,
    /export\s+(?:async\s+)?function\s+(?:set|register|reset)/u,
  ]) assert.doesNotMatch(connectionSource, pattern, "recovery cannot mutate authority, reservations, modules or tabs");
  assert.doesNotMatch(executableSource, /\bimport\s/u, "the VM never imports the real browser client");
}

async function testHealthyAndEmptyTabs() {
  for (const listing of [[], [{ id: "anonymous-tab" }], runInNewContext("[]")]) {
    const cached = nativeBrowser("anonymous_chrome_1", listing);
    const runtime = harness(() => cached.browser);
    assert.equal(await runtime.getSourceOwnedChromeBrowser(), cached.browser);
    assert.equal(await runtime.getSourceOwnedChromeBrowser(), cached.browser);
    assert.equal(cached.calls.list, 0, "normal cached getter does not infer a disconnect or reconnect");
    assert.equal(await runtime.recoverSourceOwnedChromeBrowser(), cached.browser);
    assert.equal(await runtime.recoverSourceOwnedChromeBrowser(), cached.browser);
    assert.equal(cached.calls.list, 2, "successful empty listings are healthy and subsequent probes remain available");
    assert.deepEqual(runtime.calls, { load: 1, setup: 1, selections: ["chrome"] });
    assert.equal(cached.calls.new, 0);
  }
}

async function testNoCachedSelectionOrCallerAuthority() {
  const cached = nativeBrowser();
  const runtime = harness(() => cached.browser);
  await assert.rejects(runtime.recoverSourceOwnedChromeBrowser(), /requires an existing cached selection/u);
  assert.deepEqual(runtime.calls, { load: 0, setup: 0, selections: [] });
  const callerBrowser = { browserId: "caller_browser", tabs: {} };
  assert.equal(await runtime.getSourceOwnedChromeBrowser(callerBrowser), cached.browser,
    "extra getter arguments cannot supply a browser");
  for (const supplied of [undefined, null, unavailable(cached.browser.browserId), callerBrowser, () => callerBrowser]) {
    await assert.rejects(runtime.recoverSourceOwnedChromeBrowser(supplied), /accepts no caller authority/u);
  }
  assert.equal(cached.calls.list, 0);
  assert.deepEqual(runtime.calls.selections, ["chrome"]);
}

async function testOnlyExactNativeErrorsQualify() {
  const id = "anonymous_chrome_1";
  const exact = `Browser is not available: ${id}`;
  const named = new Error(exact); named.name = "TimeoutError";
  const inherited = Object.create(Error.prototype); inherited.message = exact;
  const errors = [
    new Error("Browser unavailable"), new Error("Browser is not available"), new Error("Disconnected"),
    unavailable("another_chrome"), new Error(`${exact} `), new Error(`prefix ${exact}`),
    new Error(`${exact}\n`), new Error("Permission denied"), new Error("Timeout waiting for Chrome"),
    new Error("Tab is not available: anonymous-tab"), new TypeError(exact), named,
    { name: "Error", message: exact }, inherited, exact, null,
    { name: "Error", message: exact, [Symbol.toStringTag]: "Error" },
    new Error(`browser is not available: ${id}`),
  ];
  for (const error of errors) {
    const cached = nativeBrowser(id, () => { throw error; });
    const runtime = harness(() => cached.browser);
    await runtime.getSourceOwnedChromeBrowser();
    await assert.rejects(runtime.recoverSourceOwnedChromeBrowser(), sameError(error));
    assert.deepEqual(runtime.calls.selections, ["chrome"], "nonqualifying errors cannot reselect Chrome");
    cached.setListing([]);
    assert.equal(await runtime.recoverSourceOwnedChromeBrowser(), cached.browser,
      "an unrelated probe failure must not silently replace or discard the healthy cached binding");
    assert.equal(cached.calls.new, 0);
  }
}

async function testMalformedBrowserIdsAndProbeShapes() {
  for (const id of [undefined, null, 123, "", " ", "bad id", "bad/id", "bad.id", "bad\nid", "x".repeat(201), new String("anonymous_chrome")]) {
    const error = unavailable(String(id));
    const cached = nativeBrowser("temporary_id", () => { throw error; });
    cached.browser.browserId = id;
    const runtime = harness(() => cached.browser);
    await runtime.getSourceOwnedChromeBrowser();
    await assert.rejects(runtime.recoverSourceOwnedChromeBrowser(), sameError(error));
    assert.deepEqual(runtime.calls.selections, ["chrome"], "unbounded or malformed IDs cannot qualify a disconnect");
  }
  for (const value of [null, {}, "[]", 0]) {
    const cached = nativeBrowser("anonymous_chrome", value);
    const runtime = harness(() => cached.browser);
    await runtime.getSourceOwnedChromeBrowser();
    await assert.rejects(runtime.recoverSourceOwnedChromeBrowser(), /tabs listing must be an array/u);
    assert.deepEqual(runtime.calls.selections, ["chrome"]);
  }
  const cached = nativeBrowser(); delete cached.browser.tabs.list;
  const runtime = harness(() => cached.browser);
  await runtime.getSourceOwnedChromeBrowser();
  await assert.rejects(runtime.recoverSourceOwnedChromeBrowser(), /cannot list its bounded tabs/u);
  assert.deepEqual(runtime.calls.selections, ["chrome"]);
}

async function testExactDisconnectAndForeignRealmErrors() {
  for (const id of ["A", "anonymous-Chrome_1", "-aaaa-4bbb-8ccc-dddddddddddd", "x".repeat(200)]) {
    const foreignError = runInNewContext("new Error(message)", { message: `Browser is not available: ${id}` });
    assert.equal(types.isNativeError(foreignError), true);
    assert.equal(foreignError instanceof Error, false, "a real browser-realm Error need not share the test Error prototype");
    const cached = nativeBrowser(id, () => { throw foreignError; });
    const replacement = nativeBrowser("replacement_chrome");
    const runtime = harness((index) => index === 0 ? cached.browser : replacement.browser);
    await runtime.getSourceOwnedChromeBrowser();
    assert.equal(await runtime.recoverSourceOwnedChromeBrowser(), replacement.browser);
    assert.equal(await runtime.getSourceOwnedChromeBrowser(), replacement.browser);
    assert.equal(await runtime.recoverSourceOwnedChromeBrowser(), replacement.browser);
    assert.deepEqual(runtime.calls, { load: 1, setup: 1, selections: ["chrome", "chrome"] });
    assert.equal(cached.calls.list, 1);
    assert.equal(replacement.calls.list, 2, "replacement must pass a native health probe before it is returned");
    assert.equal(cached.calls.new + replacement.calls.new, 0);
  }
}

async function testConcurrentRecoverySharesOneReplacement() {
  const cached = nativeBrowser("anonymous_chrome", () => { throw unavailable("anonymous_chrome"); });
  const replacement = nativeBrowser("replacement_chrome");
  const pending = deferred(), started = deferred();
  const runtime = harness((index) => {
    if (index === 0) return cached.browser;
    started.resolve();
    return pending.promise;
  });
  await runtime.getSourceOwnedChromeBrowser();
  const recovering = Array.from({ length: 8 }, () => runtime.recoverSourceOwnedChromeBrowser());
  await started.promise;
  assert.deepEqual(runtime.calls.selections, ["chrome", "chrome"]);
  const cachedGetter = runtime.getSourceOwnedChromeBrowser();
  const laterRecovery = runtime.recoverSourceOwnedChromeBrowser();
  pending.resolve(replacement.browser);
  for (const browser of await Promise.all([...recovering, cachedGetter, laterRecovery])) assert.equal(browser, replacement.browser);
  assert.equal(cached.calls.list, 1);
  assert.equal(replacement.calls.list, 1);
  assert.deepEqual(runtime.calls, { load: 1, setup: 1, selections: ["chrome", "chrome"] });
}

async function assertRejectedReplacementLatched(selectReplacement, expectedError) {
  const cached = nativeBrowser("anonymous_chrome", () => { throw unavailable("anonymous_chrome"); });
  const runtime = harness((index) => index === 0 ? cached.browser : selectReplacement());
  await runtime.getSourceOwnedChromeBrowser();
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => runtime.recoverSourceOwnedChromeBrowser()));
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, expectedError);
  }
  await assert.rejects(runtime.getSourceOwnedChromeBrowser(), sameError(expectedError));
  await assert.rejects(runtime.recoverSourceOwnedChromeBrowser(), sameError(expectedError));
  assert.deepEqual(runtime.calls, { load: 1, setup: 1, selections: ["chrome", "chrome"] });
  assert.equal(cached.calls.list, 1, "rejection never falls back to the known-disconnected old handle");
}

async function testReplacementFailuresStayLatched() {
  const selectionError = new Error("Replacement permission denied");
  await assertRejectedReplacementLatched(() => { throw selectionError; }, selectionError);
  for (const probeError of [new Error("Replacement probe timed out"), unavailable("replacement_chrome")]) {
    const replacement = nativeBrowser("replacement_chrome", () => { throw probeError; });
    await assertRejectedReplacementLatched(() => replacement.browser, probeError);
    assert.equal(replacement.calls.list, 1);
  }
  const replacement = nativeBrowser("replacement_chrome", {});
  const cached = nativeBrowser("anonymous_chrome", () => { throw unavailable("anonymous_chrome"); });
  const runtime = harness((index) => index === 0 ? cached.browser : replacement.browser);
  await runtime.getSourceOwnedChromeBrowser();
  for (const invoke of [() => runtime.recoverSourceOwnedChromeBrowser(), () => runtime.getSourceOwnedChromeBrowser(), () => runtime.recoverSourceOwnedChromeBrowser()]) {
    await assert.rejects(invoke(), /tabs listing must be an array/u);
  }
  assert.equal(replacement.calls.list, 1);
  assert.deepEqual(runtime.calls.selections, ["chrome", "chrome"]);
}

async function testInitialFailureAndLifetimeReselectionBudget() {
  const error = new Error("Initial selection unavailable");
  const failed = harness(() => { throw error; });
  await assert.rejects(failed.getSourceOwnedChromeBrowser(), sameError(error));
  await assert.rejects(failed.getSourceOwnedChromeBrowser(), sameError(error));
  await assert.rejects(failed.recoverSourceOwnedChromeBrowser(), sameError(error));
  assert.deepEqual(failed.calls, { load: 1, setup: 1, selections: ["chrome"] });
  const setupFailed = harness(() => { throw new Error("selection must not run"); }, { setupError: error });
  await assert.rejects(setupFailed.getSourceOwnedChromeBrowser(), sameError(error));
  await assert.rejects(setupFailed.recoverSourceOwnedChromeBrowser(), sameError(error));
  assert.deepEqual(setupFailed.calls, { load: 1, setup: 1, selections: [] });
  const cached = nativeBrowser("anonymous_chrome", () => { throw unavailable("anonymous_chrome"); });
  const replacement = nativeBrowser("replacement_chrome");
  const runtime = harness((index) => index === 0 ? cached.browser : replacement.browser);
  await runtime.getSourceOwnedChromeBrowser();
  await runtime.recoverSourceOwnedChromeBrowser();
  replacement.setListing(() => { throw unavailable("replacement_chrome"); });
  await assert.rejects(runtime.recoverSourceOwnedChromeBrowser(), /reselection was already attempted/u);
  await assert.rejects(runtime.recoverSourceOwnedChromeBrowser(), /reselection was already attempted/u);
  assert.deepEqual(runtime.calls, { load: 1, setup: 1, selections: ["chrome", "chrome"] });
}

testSourceBoundaries();
await testHealthyAndEmptyTabs();
await testNoCachedSelectionOrCallerAuthority();
await testOnlyExactNativeErrorsQualify();
await testMalformedBrowserIdsAndProbeShapes();
await testExactDisconnectAndForeignRealmErrors();
await testConcurrentRecoverySharesOneReplacement();
await testReplacementFailuresStayLatched();
await testInitialFailureAndLifetimeReselectionBudget();
assert.ok(harnesses.length >= 40, "each scenario starts with fresh, actual source-owned VM state");
for (const fixture of harnesses) assert.ok(fixture.calls.load <= 1 && fixture.calls.setup <= 1 && fixture.calls.selections.length <= 2);
console.log("PASS source-owned Chrome explicit disconnect reconnection tests (mocked; no browser)");

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as testedRuntime from "./comment_cua_runtime.mjs";
import { bindLiveReplyBrowser, verifyFacebookAccount } from "./comment_chrome_facebook_surface.mjs";

const cases = [];
const freshModule = () => testedRuntime;
const target = "https://www.threads.com/@example/post/Example1";
const facebook = "https://www.facebook.com/example/posts/example1?comment_id=123";
const instagram = "https://www.instagram.com/p/Example1/c/123/r/456/";

function hostFixture() {
  const browser = {
    id: "chrome-example", family: "chrome", type: "extension",
    metadata: { extensionInstanceId: "extension-example" },
    tabs: [{ id: "tab-example", url: target, title: "Example post" }],
  };
  const state = { apps: [], browsers: [browser] };
  const handles = new Map();
  const calls = [];
  let created = 0;
  function makeHandle(entry) {
    return { id: entry.id, playwright: {}, async url() { return entry.url; } };
  }
  handles.set("tab-example", makeHandle(browser.tabs[0]));
  const cua = {
    async getState(options) {
      assert.deepEqual(options, { emit: false }, "fresh inventory must not emit the full browser listing");
      calls.push(["state"]);
      return structuredClone(state);
    },
    async getTab(id, options) {
      calls.push(["get", id, options]);
      return handles.get(id);
    },
    async createBrowserTab(family, url, options) {
      calls.push(["new", family, url, options]);
      const entry = { id: `created-${created += 1}`, url };
      browser.tabs.push(entry);
      const handle = makeHandle(entry);
      handles.set(entry.id, handle);
      return handle;
    },
  };
  return { cua, state, browser, handles, calls };
}

async function installed() {
  const module = await freshModule();
  const fixture = hostFixture();
  const descriptor = await module.installCommentCuaRuntime(fixture.cua, {
    browserId: fixture.browser.id,
  });
  return { module, ...fixture, descriptor, facade: module.getCommentCuaBrowser() };
}

cases.push(async () => {
  const module = await freshModule();
  assert.equal(module.hasCommentCuaRuntime(), false);
  assert.throws(() => module.getCommentCuaBrowser(), /not installed/u);
  await assert.rejects(module.requireCommentCuaTab({}, target), /not retained/u);
});

cases.push(async () => {
  const { module, descriptor, facade, calls, cua, browser } = await installed();
  assert.equal(module.hasCommentCuaRuntime(), true);
  assert.equal(descriptor.object_anti_forgery, false);
  assert.equal(descriptor.cryptographic_attestation, false);
  assert.equal(descriptor.owns_send_operation, false);
  assert.equal(Object.isFrozen(descriptor.browser_identity), true);
  assert.equal(Object.isFrozen(facade.tabs), true);
  const listing = await facade.tabs.list();
  assert.equal(Object.isFrozen(listing[0]), true);
  const tab = await facade.tabs.get("tab-example");
  assert.equal(module.isCommentCuaTab(tab), true);
  assert.equal(await module.requireCommentCuaTab(tab, target), tab);
  assert.equal(await facade.tabs.get("tab-example"), tab);
  assert.equal(calls.filter(([kind]) => kind === "get").length, 1);
  for (const url of [facebook, instagram, target]) {
    const created = await facade.tabs.new(url);
    assert.equal(await module.requireCommentCuaTab(created, url), created);
  }
  assert.deepEqual(calls.find(([kind]) => kind === "new"), [
    "new", "chrome", facebook, { sessionName: "💬 Social Post" },
  ]);
  await assert.rejects(module.installCommentCuaRuntime(cua, { browserId: browser.id }),
    /already attempted/u);
  await assert.rejects(module.requireCommentCuaTab({ ...tab }, target), /not retained/u);
});

for (const mutate of [
  (fixture) => { fixture.state.browsers = []; },
  (fixture) => { fixture.browser.family = "edge"; },
  (fixture) => { fixture.browser.type = "cdp"; },
  (fixture) => { delete fixture.browser.metadata.extensionInstanceId; },
  (fixture) => { fixture.state.browsers.push(structuredClone(fixture.browser)); },
]) {
  cases.push(async () => {
  const module = await freshModule();
  const fixture = hostFixture();
  mutate(fixture);
  await assert.rejects(module.installCommentCuaRuntime(fixture.cua, {
    browserId: "chrome-example",
  }));
  assert.equal(module.hasCommentCuaRuntime(), true);
  const repaired = hostFixture();
  await assert.rejects(module.installCommentCuaRuntime(repaired.cua, {
    browserId: "chrome-example",
  }), /already attempted/u);
  });
}

cases.push(async () => {
  const module = await freshModule();
  const fixture = hostFixture();
  let finishState;
  fixture.cua.getState = (options) => {
    assert.deepEqual(options, { emit: false });
    return new Promise((resolve) => { finishState = resolve; });
  };
  const pending = module.installCommentCuaRuntime(fixture.cua, { browserId: fixture.browser.id });
  assert.equal(module.hasCommentCuaRuntime(), true);
  assert.throws(() => module.getCommentCuaBrowser(), /not installed/u);
  finishState(fixture.state);
  await pending;
});

cases.push(async () => {
  const module = await freshModule();
  const fixture = hostFixture();
  fixture.cua.getTab = async (id) => ({ id, playwright: {}, async url() { return target; } });
  await module.installCommentCuaRuntime(fixture.cua, { browserId: fixture.browser.id });
  const facade = module.getCommentCuaBrowser();
  const results = await Promise.allSettled([
    facade.tabs.get("tab-example"), facade.tabs.get("tab-example"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

for (const mutate of [
  (fixture) => { fixture.browser.id = "different-browser"; },
  (fixture) => { fixture.browser.family = "edge"; },
  (fixture) => { fixture.browser.metadata.extensionInstanceId = "different-extension"; },
  (fixture) => { fixture.browser.tabs.push({ ...fixture.browser.tabs[0] }); },
  (fixture) => { fixture.browser.tabs = []; },
]) {
  cases.push(async () => {
  const fixture = await installed();
  const tab = await fixture.facade.tabs.get("tab-example");
  mutate(fixture);
  await assert.rejects(fixture.module.requireCommentCuaTab(tab, target));
  await assert.rejects(fixture.facade.tabs.get("tab-example"));
  });
}

for (const invalid of [
  undefined, "about:blank", "http://www.threads.com/@example/post/Example1",
  "https://example.com/@example/post/Example1", "https://www.facebook.com/me",
  "https://www.facebook.com/", "https://www.instagram.com/example/",
  "https://www.threads.com/@example/post/Example1#other",
  "https://username@www.threads.com/@example/post/Example1",
  "https://www.threads.com:444/@example/post/Example1",
  "https://www.threads.com/@example/post/../post/Example1",
  "https://www.threads.com/@example/post/Example1?a=1&a=2",
]) {
  cases.push(async () => {
  const fixture = await installed();
  await assert.rejects(fixture.facade.tabs.new(invalid));
  assert.equal(fixture.calls.some(([kind]) => kind === "new"), false);
  });
}

for (const mutation of [
  (tab) => { tab.id = "changed-id"; },
  (tab) => { tab.url = async () => target; },
  (tab) => { tab.playwright = {}; },
]) {
  cases.push(async () => {
  const fixture = await installed();
  const tab = await fixture.facade.tabs.get("tab-example");
  mutation(tab);
  await assert.rejects(fixture.module.requireCommentCuaTab(tab, target), /handle changed/u);
  });
}

cases.push(async () => {
  const fixture = await installed();
  const tab = await fixture.facade.tabs.get("tab-example");
  fixture.browser.tabs[0].url = facebook;
  await assert.rejects(fixture.module.requireCommentCuaTab(tab, target), /listed tab URL/u);
  await assert.rejects(fixture.module.requireCommentCuaTab(tab, instagram), /listed tab URL/u);
});

cases.push(async () => {
  const fixture = hostFixture();
  fixture.handles.get("tab-example").url = async () => facebook;
  const module = await freshModule();
  await module.installCommentCuaRuntime(fixture.cua, { browserId: fixture.browser.id });
  await assert.rejects(module.getCommentCuaBrowser().tabs.get("tab-example"), /actual tab URL/u);
});

cases.push(async () => {
  const fixture = hostFixture();
  fixture.cua.createBrowserTab = async () => ({
    id: "other-profile-tab", playwright: {}, async url() { return target; },
  });
  const module = await freshModule();
  await module.installCommentCuaRuntime(fixture.cua, { browserId: fixture.browser.id });
  await assert.rejects(module.getCommentCuaBrowser().tabs.new(target), /fresh selected Chrome/u);
});

cases.push(async () => {
  const fixture = hostFixture();
  const originalUrl = fixture.handles.get("tab-example").url;
  fixture.handles.get("tab-example").url = async function changedWhileReading() {
    const result = await originalUrl.call(this);
    fixture.browser.metadata.extensionInstanceId = "changed-during-read";
    return result;
  };
  const module = await freshModule();
  await module.installCommentCuaRuntime(fixture.cua, { browserId: fixture.browser.id });
  await assert.rejects(module.getCommentCuaBrowser().tabs.get("tab-example"), /extensionInstanceId changed/u);
});

const facebookMe = "https://www.facebook.com/me/";
const approvedProfile = "https://www.facebook.com/example.owner/";

async function installedFacebookProbe({ redirect = approvedProfile, account = "example.owner" } = {}) {
  const fixture = hostFixture();
  fixture.browser.tabs[0].url = facebook;
  const source = fixture.handles.get("tab-example");
  source.goto = async () => { fixture.calls.push(["source-goto"]); throw new Error("target must not navigate"); };
  source.close = async () => { fixture.calls.push(["source-close"]); throw new Error("target must not close"); };
  fixture.hooks = {};
  fixture.probes = [];
  fixture.cua.createBrowserTab = async (browserId, url, options) => {
    fixture.calls.push(["new", browserId, url, options]);
    if (fixture.hooks.create) return fixture.hooks.create();
    const entry = { id: "probe-example", url: redirect };
    const banner = {
      async waitFor(options) {
        fixture.calls.push(["banner-wait", options]);
        await fixture.hooks.wait?.();
      },
      async count() {
        fixture.calls.push(["banner-count"]);
        return await fixture.hooks.count?.() ?? 1;
      },
    };
    const probe = {
      id: entry.id,
      playwright: { getByRole(role) { assert.equal(role, "banner"); return banner; } },
      async url() {
        fixture.calls.push(["probe-url"]);
        await fixture.hooks.url?.();
        return entry.url;
      },
      async close() {
        fixture.calls.push(["probe-close", probe.id]);
        await fixture.hooks.close?.();
        fixture.browser.tabs = fixture.browser.tabs.filter((row) => row !== entry);
      },
    };
    fixture.browser.tabs.push(entry);
    fixture.probes.push(probe);
    await fixture.hooks.created?.();
    return probe;
  };
  const module = await freshModule();
  await module.installCommentCuaRuntime(fixture.cua, { browserId: fixture.browser.id });
  const facade = module.getCommentCuaBrowser();
  assert.equal(await facade.tabs.get(source.id), source);
  return { ...fixture, module, facade, source, account };
}

function probeCalls(fixture, kind) {
  return fixture.calls.filter(([name]) => name === kind);
}

function assertRetainedTargetUntouched(fixture) {
  assert.equal(probeCalls(fixture, "source-goto").length, 0);
  assert.equal(probeCalls(fixture, "source-close").length, 0);
}

// Exercise the real Facebook consumer as well as the runtime contract. The
// previous consumer's URL-less tabs.new() fails this valid CUA control.
cases.push(async () => {
  const fixture = await installedFacebookProbe();
  bindLiveReplyBrowser(fixture.source, fixture.facade);
  assert.equal(await verifyFacebookAccount(fixture.source, { scope: { account_key: fixture.account } }), undefined);
  assert.deepEqual(probeCalls(fixture, "new"), [[
    "new", fixture.browser.id, facebookMe, { sessionName: "🔎 Social Post account" },
  ]]);
  assert.deepEqual(probeCalls(fixture, "probe-close"), [["probe-close", "probe-example"]]);
  assertRetainedTargetUntouched(fixture);
  assert.equal(await fixture.module.requireCommentCuaTab(fixture.source, facebook), fixture.source);
  assert.equal(fixture.module.isCommentCuaTab(fixture.probes[0]), false);
  await assert.rejects(fixture.facade.tabs.new(facebookMe), /not a supported Meta/u);
  await assert.rejects(fixture.facade.tabs.new(approvedProfile), /not a supported Meta/u);
});

for (const [account, redirect] of [
  ["example.owner", "https://www.facebook.com/example.owner"],
  ["123456789", "https://www.facebook.com/profile.php?id=123456789"],
  ["123456789", "https://www.facebook.com/123456789/"],
]) {
  cases.push(async () => {
    const fixture = await installedFacebookProbe({ account, redirect });
    assert.equal(await fixture.module.verifyCommentCuaFacebookAccount(fixture.source, account), undefined);
    assert.equal(probeCalls(fixture, "new").length, 1);
    assert.equal(probeCalls(fixture, "probe-close").length, 1);
    assertRetainedTargetUntouched(fixture);
  });
}

for (const redirect of [
  "https://www.facebook.com/another.owner/",
  "https://www.facebook.com/example.owner/?tracking=1",
  "https://www.facebook.com/example.owner/#bio",
  "https://www.facebook.com/example.owner//",
  "https://m.facebook.com/example.owner/",
  "https://www.facebook.com.evil.test/example.owner/",
  "https://www.facebook.com:443/example.owner/",
  "https://www.facebook.com/%65xample.owner/",
  "https://www.facebook.com/login/",
  "https://www.facebook.com/checkpoint/",
  "https://www.facebook.com/profile.php?id=123456789",
]) {
  cases.push(async () => {
    const fixture = await installedFacebookProbe({ redirect });
    await assert.rejects(fixture.module.verifyCommentCuaFacebookAccount(fixture.source, fixture.account));
    assert.equal(probeCalls(fixture, "new").length, 1);
    assert.equal(probeCalls(fixture, "probe-close").length, 1);
    assertRetainedTargetUntouched(fixture);
  });
}

cases.push(async () => {
  const fixture = await installedFacebookProbe({ redirect: facebookMe });
  fixture.hooks.count = () => { fixture.browser.tabs.find((row) => row.id === "probe-example").url = approvedProfile; };
  await fixture.module.verifyCommentCuaFacebookAccount(fixture.source, fixture.account);
  assert.equal(probeCalls(fixture, "new").length, 1);
  assert.equal(probeCalls(fixture, "probe-close").length, 1);
  assertRetainedTargetUntouched(fixture);
});

cases.push(async () => {
  const fixture = await installedFacebookProbe({ redirect: facebookMe });
  await assert.rejects(fixture.module.verifyCommentCuaFacebookAccount(fixture.source, fixture.account), /redirect/u);
  assert.equal(probeCalls(fixture, "new").length, 1);
  assert.equal(probeCalls(fixture, "probe-close").length, 1);
  assert.ok(probeCalls(fixture, "banner-count").length <= 4);
  assertRetainedTargetUntouched(fixture);
});

for (const account of [undefined, "", " example.owner", "../example.owner", "example.owner?x=1", "https://www.facebook.com/example.owner", "me", "login", "checkpoint", {}, () => {}]) {
  cases.push(async () => {
    const fixture = await installedFacebookProbe();
    await assert.rejects(fixture.module.verifyCommentCuaFacebookAccount(fixture.source, account));
    assert.equal(probeCalls(fixture, "new").length, 0);
    assertRetainedTargetUntouched(fixture);
  });
}

cases.push(async () => {
  const fixture = await installedFacebookProbe();
  await assert.rejects(fixture.module.verifyCommentCuaFacebookAccount(fixture.source, fixture.account, () => {}));
  await assert.rejects(fixture.module.verifyCommentCuaFacebookAccount({ ...fixture.source }, fixture.account));
  assert.equal(probeCalls(fixture, "new").length, 0);
});

cases.push(async () => {
  const fixture = await installed();
  const source = await fixture.facade.tabs.get("tab-example");
  await assert.rejects(fixture.module.verifyCommentCuaFacebookAccount(source, "example.owner"), /Facebook/u);
  assert.equal(probeCalls(fixture, "new").length, 0);
});

for (const defect of ["reused", "foreign-browser", "not-listed", "extension", "handle"]) {
  cases.push(async () => {
    const fixture = await installedFacebookProbe();
    fixture.hooks.create = () => {
      if (defect === "reused") return fixture.source;
      const entry = { id: "foreign-probe", url: approvedProfile };
      const probe = { id: entry.id, playwright: {}, async url() { return entry.url; },
        async close() { fixture.calls.push(["unowned-close"]); } };
      if (defect === "foreign-browser") fixture.state.browsers.push({
        ...structuredClone(fixture.browser), id: "other-chrome", tabs: [entry],
      });
      if (defect === "extension") {
        fixture.browser.tabs.push(entry);
        fixture.browser.metadata.extensionInstanceId = "changed-extension";
      }
      if (defect === "handle") { fixture.browser.tabs.push(entry); delete probe.close; }
      return probe;
    };
    await assert.rejects(fixture.module.verifyCommentCuaFacebookAccount(fixture.source, fixture.account));
    assert.equal(probeCalls(fixture, "unowned-close").length, 0);
    assertRetainedTargetUntouched(fixture);
  });
}

for (const defect of ["banner", "read", "source-drift", "source-after-close", "close", "unstable-profile", "wrong-profile-after-read"]) {
  cases.push(async () => {
    const fixture = await installedFacebookProbe();
    if (defect === "banner") fixture.hooks.count = () => 2;
    if (defect === "read") fixture.hooks.wait = () => { throw new Error("native read failed"); };
    if (defect === "source-drift") fixture.hooks.count = () => { fixture.browser.tabs[0].url = facebook + "&changed=1"; };
    if (defect === "source-after-close") fixture.hooks.close = () => { fixture.browser.tabs[0].url = facebook + "&changed=1"; };
    if (defect === "close") fixture.hooks.close = () => { throw new Error("probe close failed"); };
    if (defect === "unstable-profile") fixture.hooks.url = () => {
      const entry = fixture.browser.tabs.find((row) => row.id === "probe-example");
      entry.url = entry.url.endsWith("/") ? approvedProfile.slice(0, -1) : approvedProfile;
    };
    if (defect === "wrong-profile-after-read") fixture.hooks.count = () => { fixture.browser.tabs.find((row) => row.id === "probe-example").url = "https://www.facebook.com/another.owner/"; };
    await assert.rejects(fixture.module.verifyCommentCuaFacebookAccount(fixture.source, fixture.account));
    assert.equal(probeCalls(fixture, "probe-close").length, 1);
    assertRetainedTargetUntouched(fixture);
  });
}

for (const mutate of [
  (probe) => { probe.id = "tab-example"; },
  (probe) => { probe.playwright = {}; },
  (probe) => { probe.url = async () => approvedProfile; },
  (probe) => { probe.close = async () => { throw new Error("must not call replacement close"); }; },
]) {
  cases.push(async () => {
    const fixture = await installedFacebookProbe();
    fixture.hooks.count = () => { mutate(fixture.probes[0]); };
    await assert.rejects(fixture.module.verifyCommentCuaFacebookAccount(fixture.source, fixture.account), /probe handle changed/u);
    assert.equal(probeCalls(fixture, "probe-close").length, 0);
    assertRetainedTargetUntouched(fixture);
  });
}

if (process.argv[2] === "--case") {
  const index = Number(process.argv[3]);
  assert.ok(Number.isInteger(index) && index >= 0 && index < cases.length);
  await cases[index]();
} else {
  // Each process owns one real singleton instance; no reset or dynamic-import
  // escape hatch is added to production solely for the test harness.
  for (let index = 0; index < cases.length; index += 1) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--case", String(index)], {
      shell: false, windowsHide: true, encoding: "utf8", timeout: 15000,
    });
    assert.equal(result.status, 0, `case ${index}: ${result.error ?? result.stderr}`);
  }
  console.log("comment CUA runtime ownership tests passed");
}

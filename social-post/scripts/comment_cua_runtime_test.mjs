import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as testedRuntime from "./comment_cua_runtime.mjs";

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
    async getState() { calls.push(["state"]); return structuredClone(state); },
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
  fixture.cua.getState = () => new Promise((resolve) => { finishState = resolve; });
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

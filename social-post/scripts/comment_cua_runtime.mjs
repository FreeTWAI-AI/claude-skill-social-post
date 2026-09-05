/**
 * One-session adapter for the documented, host-supplied CUA browser API.
 *
 * The caller at installation is trusted tool-runtime code. JavaScript objects
 * cannot prove their origin: these checks are ownership/continuity checks, not
 * cryptographic attestation or protection against a forged installation object.
 * This module does not create an SDK transport and has no reply/send operation.
 */

export const COMMENT_CUA_RUNTIME_VERSION = "2026-09-05.1";

let installationAttempted = false;
let runtime;
const ownedTabs = new WeakSet();
const tabRecords = new WeakMap();
const handlesById = new Map();

function fail(message) {
  throw new Error(`comment CUA runtime: ${message}`);
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required`);
  return value.trim();
}

function exactMetaUrl(value) {
  const input = text(value, "exact Meta post/comment URL");
  let url;
  try { url = new URL(input); } catch { fail("invalid Meta post/comment URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
      || /\\|%(?:2f|5c|2e)/iu.test(input)) {
    fail("exact HTTPS Meta post/comment URL is required");
  }
  const rawPath = input.match(/^https:\/\/[^/?#]+([^?#]*)/iu)?.[1];
  if (rawPath !== url.pathname) fail("ambiguous Meta URL path");
  const path = url.pathname.replace(/\/$/u, "");
  const host = url.hostname;
  let supported = false;
  if (/^(?:www\.|m\.)?facebook\.com$/u.test(host)) {
    supported = /^\/(?:[^/]+\/)?(?:posts|videos)\/[^/]+$/u.test(path)
      || /^\/groups\/[^/]+\/(?:posts|permalink)\/[^/]+$/u.test(path)
      || /^\/reel\/[^/]+$/u.test(path)
      || (/^\/(?:permalink|story)\.php$/u.test(path)
        && Boolean(url.searchParams.get("story_fbid") && url.searchParams.get("id")))
      || (path === "/watch" && Boolean(url.searchParams.get("v")))
      || (path === "/photo" && Boolean(url.searchParams.get("fbid")));
  } else if (/^(?:www\.)?instagram\.com$/u.test(host)) {
    supported = /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+$/u.test(path)
      || /^\/p\/[A-Za-z0-9_-]+\/c\/[A-Za-z0-9_-]+(?:\/r\/[A-Za-z0-9_-]+)?$/u.test(path);
  } else if (/^(?:www\.)?threads\.(?:com|net)$/u.test(host)) {
    supported = /^\/@[A-Za-z0-9._]+\/post\/[A-Za-z0-9_-]+$/u.test(path);
  }
  if (!supported) fail("URL is not a supported Meta post/comment permalink");
  const keys = new Set();
  for (const key of url.searchParams.keys()) {
    if (keys.has(key.toLowerCase())) fail("duplicate Meta URL query key");
    keys.add(key.toLowerCase());
  }
  return url.href;
}

function selectedBrowser(state, browserId) {
  if (!Array.isArray(state?.browsers)) fail("CUA browser inventory is unavailable");
  const matches = state.browsers.filter((browser) => browser?.id === browserId);
  if (matches.length !== 1) fail("selected browser must occur exactly once in fresh inventory");
  const browser = matches[0];
  if (browser.family !== "chrome" || browser.type !== "extension") {
    fail("selected browser must be extension-backed Chrome");
  }
  text(browser.metadata?.extensionInstanceId, "Chrome extension instance identity");
  if (!Array.isArray(browser.tabs)) fail("selected Chrome tab inventory is unavailable");
  const ids = browser.tabs.map((tab) => text(tab?.id, "listed Chrome tab ID"));
  if (new Set(ids).size !== ids.length) fail("selected Chrome contains duplicate tab IDs");
  return browser;
}

function identityOf(browser) {
  return Object.freeze({
    id: browser.id, family: browser.family, type: browser.type,
    extensionInstanceId: browser.metadata.extensionInstanceId,
  });
}

async function freshBrowser() {
  if (!runtime) fail("runtime is not installed");
  const browser = selectedBrowser(await runtime.getState(), runtime.identity.id);
  const observed = identityOf(browser);
  for (const key of Object.keys(runtime.identity)) {
    if (observed[key] !== runtime.identity[key]) fail(`selected Chrome ${key} changed`);
  }
  return browser;
}

function listedTab(browser, id) {
  const matches = browser.tabs.filter((tab) => tab.id === id);
  if (matches.length !== 1) fail("tab does not belong to fresh selected Chrome inventory");
  return matches[0];
}

function handleRecord(tab, id) {
  if (!tab || typeof tab !== "object" || tab.id !== id
      || typeof tab.url !== "function" || !tab.playwright) {
    fail("CUA returned an invalid or changed Tab handle");
  }
  return { id, urlMethod: tab.url, playwright: tab.playwright };
}

async function inspectHandle(tab, record, expectedUrl) {
  if (tab.id !== record.id || tab.url !== record.urlMethod
      || tab.playwright !== record.playwright) fail("retained CUA Tab handle changed");
  const browser = await freshBrowser();
  const entry = listedTab(browser, record.id);
  if (exactMetaUrl(entry.url) !== expectedUrl) fail("listed tab URL differs from expected URL");
  if (exactMetaUrl(await record.urlMethod.call(tab)) !== expectedUrl) {
    fail("actual tab URL differs from expected URL");
  }
  // Re-read ownership after the asynchronous Tab call as well.
  const finalEntry = listedTab(await freshBrowser(), record.id);
  if (exactMetaUrl(finalEntry.url) !== expectedUrl) fail("tab URL changed during ownership check");
  if (tab.id !== record.id || tab.url !== record.urlMethod
      || tab.playwright !== record.playwright) fail("retained CUA Tab handle changed");
  return tab;
}

async function retain(tab, id, expectedUrl) {
  const prior = handlesById.get(id);
  if (prior && prior !== tab) fail("a different CUA Tab handle already owns this tab ID");
  const record = tabRecords.get(tab) ?? handleRecord(tab, id);
  await inspectHandle(tab, record, expectedUrl);
  const winner = handlesById.get(id);
  if (winner && winner !== tab) fail("a different CUA Tab handle already owns this tab ID");
  ownedTabs.add(tab);
  tabRecords.set(tab, record);
  handlesById.set(id, tab);
  return tab;
}

function createBrowserFacade(identity) {
  return Object.freeze({
    browserId: identity.id,
    tabs: Object.freeze({
      async list() {
        const browser = await freshBrowser();
        return Object.freeze(browser.tabs.map((tab) => Object.freeze({
          id: tab.id, url: tab.url, title: typeof tab.title === "string" ? tab.title : "",
        })));
      },
      async get(rawId) {
        const id = text(rawId, "Chrome tab ID");
        const entry = listedTab(await freshBrowser(), id);
        const expectedUrl = exactMetaUrl(entry.url);
        const tab = handlesById.get(id) ?? await runtime.getTab(id, { browser: identity.id });
        return retain(tab, id, expectedUrl);
      },
      async new(rawUrl) {
        const expectedUrl = exactMetaUrl(rawUrl);
        await freshBrowser();
        const tab = await runtime.createBrowserTab("chrome", expectedUrl, {
          sessionName: "💬 Social Post",
        });
        const id = text(tab?.id, "created Chrome tab ID");
        return retain(tab, id, expectedUrl);
      },
    }),
  });
}

/** Install only the CUA object supplied by the trusted current tool runtime. */
export async function installCommentCuaRuntime(cua, options) {
  if (installationAttempted) fail("runtime installation was already attempted");
  installationAttempted = true;
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).length !== 1 || !Object.hasOwn(options, "browserId")) {
    fail("installation accepts only browserId");
  }
  const browserId = text(options.browserId, "selected Chrome browser ID");
  for (const method of ["getState", "getTab", "createBrowserTab"]) {
    if (typeof cua?.[method] !== "function") fail(`documented CUA ${method} is unavailable`);
  }
  const calls = Object.freeze({
    getState: cua.getState.bind(cua), getTab: cua.getTab.bind(cua),
    createBrowserTab: cua.createBrowserTab.bind(cua),
  });
  const identity = identityOf(selectedBrowser(await calls.getState(), browserId));
  const descriptor = Object.freeze({
    runtime_version: COMMENT_CUA_RUNTIME_VERSION,
    transport: "documented host-supplied CUA API",
    installation_trust: "trusted tool-runtime injection; caller must supply the real CUA object",
    cryptographic_attestation: false, object_anti_forgery: false,
    browser_identity: identity, one_installation_attempt: true,
    raw_tab_exposed: true, owns_send_operation: false,
  });
  runtime = Object.freeze({ ...calls, identity, descriptor, browser: createBrowserFacade(identity) });
  return descriptor;
}

export function hasCommentCuaRuntime() {
  // Routing must stay on CUA after even a failed/pending install. Returning
  // false here would silently fall back to a different browser transport.
  return installationAttempted;
}

export function getCommentCuaBrowser() {
  if (!runtime) fail("runtime is not installed");
  return runtime.browser;
}

export function isCommentCuaTab(tab) {
  return Boolean(tab && typeof tab === "object" && ownedTabs.has(tab));
}

export async function requireCommentCuaTab(tab, expectedUrl) {
  if (!isCommentCuaTab(tab)) fail("Tab is not retained by this CUA runtime");
  return inspectHandle(tab, tabRecords.get(tab), exactMetaUrl(expectedUrl));
}

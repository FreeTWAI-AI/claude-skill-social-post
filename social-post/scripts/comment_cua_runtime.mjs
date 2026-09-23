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
  const browser = selectedBrowser(await runtime.getState({ emit: false }), runtime.identity.id);
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
  const identity = identityOf(selectedBrowser(await calls.getState({ emit: false }), browserId));
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

const FACEBOOK_ME_URL = "https://www.facebook.com/me/";

function facebookAccountKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
      || /^(?:me|login(?:\.php)?|checkpoint|recover|logout|settings)$/iu.test(value)) {
    fail("an exact approved Facebook account key is required");
  }
  return value;
}

function facebookProbeUrl(value, account) {
  // Fixed string forms deliberately do not normalize a foreign host, port,
  // escaped path, dot segment, fragment or extra query into an approved URL.
  if (value === FACEBOOK_ME_URL) return value;
  const profile = `https://www.facebook.com/${account}`;
  if (value === profile || value === `${profile}/`
      || (/^[0-9]+$/u.test(account)
        && value === `https://www.facebook.com/profile.php?id=${account}`)) return value;
  fail("Facebook /me profile differs from the approved account");
}

function requireFacebookProbeHandle(probe, record) {
  if (probe.id !== record.id || probe.url !== record.urlMethod
      || probe.playwright !== record.playwright || probe.close !== record.closeMethod) {
    fail("Facebook account probe handle changed");
  }
}

async function readFacebookProbeUrl(probe, record, account) {
  requireFacebookProbeHandle(probe, record);
  const before = facebookProbeUrl(listedTab(await freshBrowser(), record.id).url, account);
  const actual = facebookProbeUrl(await record.urlMethod.call(probe), account);
  const after = facebookProbeUrl(listedTab(await freshBrowser(), record.id).url, account);
  requireFacebookProbeHandle(probe, record);
  // Only natural /me navigation may still be pending. No alternative URL is
  // navigated and no rejected identity/challenge is retried.
  if ([before, actual, after].includes(FACEBOOK_ME_URL)) return null;
  if (before !== actual || after !== actual) fail("Facebook account probe URL is unstable");
  return actual;
}

async function closeFacebookProbe(probe, record) {
  requireFacebookProbeHandle(probe, record);
  listedTab(await freshBrowser(), record.id);
  await record.closeMethod.call(probe);
  if ((await freshBrowser()).tabs.some((tab) => tab.id === record.id)) {
    fail("Facebook account probe did not close");
  }
}

/**
 * Verify login identity through one fixed /me probe, not composer-actor proof.
 * The profile handle is never retained by the general post/comment facade or
 * returned to the caller. The retained source tab is never navigated/closed.
 */
export async function verifyCommentCuaFacebookAccount(retainedSourceTab, expectedAccount) {
  if (arguments.length !== 2) fail("Facebook account probe accepts only a retained tab and account key");
  const account = facebookAccountKey(expectedAccount);
  if (!isCommentCuaTab(retainedSourceTab)) fail("Facebook source Tab is not retained by this CUA runtime");
  const sourceRecord = tabRecords.get(retainedSourceTab);
  const sourceUrl = exactMetaUrl(listedTab(await freshBrowser(), sourceRecord.id).url);
  if (!/^(?:www\.|m\.)?facebook\.com$/u.test(new URL(sourceUrl).hostname)) {
    fail("Facebook account probe requires a retained Facebook target");
  }
  await inspectHandle(retainedSourceTab, sourceRecord, sourceUrl);
  const before = await freshBrowser();
  if (exactMetaUrl(listedTab(before, sourceRecord.id).url) !== sourceUrl) fail("Facebook source URL changed");
  const existingIds = new Set(before.tabs.map((tab) => tab.id));
  let probe;
  let record;
  let ownsProbe = false;
  try {
    probe = await runtime.createBrowserTab(runtime.identity.id, FACEBOOK_ME_URL, {
      sessionName: "🔎 Social Post account",
    });
    const id = text(probe?.id, "Facebook account probe tab ID");
    if (existingIds.has(id) || handlesById.has(id) || ownedTabs.has(probe)) {
      fail("Facebook account probe must be a newly created tab");
    }
    record = { ...handleRecord(probe, id), closeMethod: probe.close };
    if (typeof record.closeMethod !== "function") fail("Facebook account probe cannot be safely closed");
    const entry = listedTab(await freshBrowser(), id);
    ownsProbe = true;
    facebookProbeUrl(entry.url, account);
    const banner = record.playwright.getByRole("banner");
    await banner.waitFor({ state: "visible", timeoutMs: 10000 });
    for (let pass = 0; pass < 3; pass += 1) {
      if (await banner.count() !== 1) fail("Facebook account probe banner is not unique");
      const observed = await readFacebookProbeUrl(probe, record, account);
      if (observed === null) continue;
      if (await readFacebookProbeUrl(probe, record, account) !== observed) {
        fail("Facebook account probe URL is unstable");
      }
      return;
    }
    fail("Facebook /me redirect is not complete");
  } finally {
    try {
      // A reused ID or foreign-browser handle is never cleanup authority.
      if (ownsProbe) await closeFacebookProbe(probe, record);
    } finally {
      await inspectHandle(retainedSourceTab, sourceRecord, sourceUrl);
    }
  }
}

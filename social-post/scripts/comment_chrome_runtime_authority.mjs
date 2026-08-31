/**
 * Source-wired, existing-session-only Chrome read authority.
 *
 * The browser client import is fixed in source. Callers may provide only the
 * approved post target; they cannot provide an agent, browser, tab, resolver,
 * transport, browser-client path, or serialized authority. The claimed Tab is
 * retained in this module and is never returned.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { types } from "node:util";

import {
  LIVE_HOSTS,
  SUPPORTED_PLATFORMS,
  canonicalUrl,
  fail,
  immutableJsonSnapshot,
  instagramUrlIdentity,
  requiredString,
} from "./comment_chrome_common.mjs";
import {
  canonicalString, sameUrl, sameApprovedPostUrl, inspectStableHost,
} from "./comment_chrome_runtime_document.mjs";

export const CHROME_RUNTIME_AUTHORITY_VERSION = "2026-08-31.2";
export const CHROME_BROWSER_CLIENT_REVISION = "openai-bundled/chrome/26.825.51511";
export const CHROME_BROWSER_CLIENT_SHA256 =
  "c52ba09202f0e82caa6f6d2a6463a8635c1b1316567975d9b91c1a05fb5af501";
export const CHROME_BROWSER_CLIENT_BYTES = 149210;

const EXISTING_CHROME_READ_SESSIONS = new WeakSet();
const READ_SESSION_INTERNAL = new WeakMap();
let sourceOwnedChromeAgentPromise;
let sourceOwnedChromePromise;
let sourceOwnedChromeReconnectInFlight;
let sourceOwnedChromeReselectionAttempted = false;
const META_POST_PATH_RULES = Object.freeze({
  facebook: /(?:\/posts\/|\/videos\/|^\/reel\/|^\/watch\/|^\/(?:permalink|story)\.php$|^\/photo\/)/u,
  instagram: /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+$/u,
  threads: /^\/@[^/]+\/post\/[^/]+$/u,
});

export function verifyPinnedBrowserClientBytes(rawBytes) {
  // The Chrome bridge executes inside the persistent Node REPL VM. Buffers
  // returned by node:fs belong to that VM realm, so an `instanceof
  // Uint8Array` check performed by this module can be false even though the
  // value is a genuine byte view. ArrayBuffer.isView is realm-safe.
  if (!ArrayBuffer.isView(rawBytes)
      || rawBytes.BYTES_PER_ELEMENT !== 1
      || !Number.isInteger(rawBytes.byteLength)) {
    fail("pinned browser-client bytes are unavailable");
  }
  const observedSha256 = createHash("sha256").update(rawBytes).digest("hex");
  if (rawBytes.byteLength !== CHROME_BROWSER_CLIENT_BYTES
      || observedSha256 !== CHROME_BROWSER_CLIENT_SHA256) {
    fail("pinned browser-client integrity check failed");
  }
  return immutableJsonSnapshot({
    revision: CHROME_BROWSER_CLIENT_REVISION,
    bytes: rawBytes.byteLength,
    sha256: observedSha256,
  }, "pinned browser-client integrity");
}

export async function loadSetupBrowserRuntime() {
  let browserClientBytes;
  try {
    browserClientBytes = await readFile(new URL(
      "../../../plugins/cache/openai-bundled/chrome/26.825.51511/scripts/browser-client.mjs",
      import.meta.url,
    ));
  } catch {
    fail("pinned browser-client bytes are unavailable");
  }
  verifyPinnedBrowserClientBytes(browserClientBytes);
  try {
    const client = await import(
      "../../../plugins/cache/openai-bundled/chrome/26.825.51511/scripts/browser-client.mjs"
    );
    if (typeof client?.setupBrowserRuntime !== "function") {
      fail("trusted Node REPL browser service has no supported runtime factory");
    }
    return client.setupBrowserRuntime;
  } catch (error) {
    if (String(error?.message ?? error).includes("no supported runtime factory")) throw error;
    fail("trusted Node REPL browser service is unavailable");
  }
}

function requireBoundedChromeSurface(browser) {
  if (!browser?.tabs || typeof browser.tabs.new !== "function") {
    fail("trusted Chrome session cannot create a bounded tab");
  }
  return browser;
}

async function getSourceOwnedChromeAgent() {
  if (!sourceOwnedChromeAgentPromise) {
    sourceOwnedChromeAgentPromise = (async () => {
      const setupBrowserRuntime = await loadSetupBrowserRuntime();
      return requireBrowserSurface(await setupBrowserRuntime());
    })();
  }
  return sourceOwnedChromeAgentPromise;
}

async function selectSourceOwnedChromeBrowser() {
  const agent = await getSourceOwnedChromeAgent();
  return requireBoundedChromeSurface(await agent.browsers.get("chrome"));
}

/** Cached source selection; only explicit qualified recovery can replace it. */
export async function getSourceOwnedChromeBrowser() {
  if (!sourceOwnedChromePromise) {
    sourceOwnedChromePromise = selectSourceOwnedChromeBrowser();
  }
  // A rejected selection stays rejected: callers cannot silently reset a
  // browser connection to evade an uncertain send or lose its reservations.
  return sourceOwnedChromePromise;
}

function exactSourceBrowserDisconnection(error, browser) {
  const browserId = browser?.browserId;
  return types.isNativeError(error) && error.name === "Error"
    && typeof browserId === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(browserId)
    && error.message === `Browser is not available: ${browserId}`;
}

async function probeSourceOwnedChromeBrowser(browser) {
  if (!browser?.tabs || typeof browser.tabs.list !== "function") {
    fail("trusted Chrome session cannot list its bounded tabs");
  }
  const tabs = await browser.tabs.list();
  if (!Array.isArray(tabs)) fail("trusted Chrome tabs listing must be an array");
  return browser;
}

async function recoverSourceOwnedChromeBrowserOnce() {
  if (!sourceOwnedChromePromise) {
    fail("source-owned Chrome recovery requires an existing cached selection");
  }
  const cachedPromise = sourceOwnedChromePromise;
  const cachedBrowser = await cachedPromise;
  try {
    return await probeSourceOwnedChromeBrowser(cachedBrowser);
  } catch (error) {
    if (!exactSourceBrowserDisconnection(error, cachedBrowser)) throw error;
    if (sourceOwnedChromeReselectionAttempted) {
      fail("source-owned Chrome reselection was already attempted");
    }
    if (sourceOwnedChromePromise !== cachedPromise) {
      fail("source-owned Chrome binding changed during recovery");
    }
    sourceOwnedChromeReselectionAttempted = true;
    // Cache the complete replacement selection and health probe. A rejected
    // replacement stays rejected, just like an initial selection, and never
    // falls back to the known-disconnected handle.
    sourceOwnedChromePromise = (async () => {
      const replacement = await selectSourceOwnedChromeBrowser();
      return probeSourceOwnedChromeBrowser(replacement);
    })();
    return sourceOwnedChromePromise;
  }
}

/**
 * Re-select Chrome once, only after the cached browser proves disconnected.
 *
 * This accepts no error, browser, agent, transport or action from the caller.
 * It does not reload this module, clear reservations, retry a tab operation or
 * perform any navigation, claim, page mutation or send.
 */
export async function recoverSourceOwnedChromeBrowser() {
  if (arguments.length !== 0) fail("source-owned Chrome recovery accepts no caller authority");
  if (!sourceOwnedChromeReconnectInFlight) {
    const attempt = recoverSourceOwnedChromeBrowserOnce();
    sourceOwnedChromeReconnectInFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (sourceOwnedChromeReconnectInFlight === attempt) {
        sourceOwnedChromeReconnectInFlight = undefined;
      }
    }
  }
  return sourceOwnedChromeReconnectInFlight;
}

function approvedPermalink(rawTarget) {
  if (!rawTarget || typeof rawTarget !== "object") {
    fail("existing Chrome read authority target must be an object");
  }
  const platform = requiredString(
    rawTarget.platform,
    "existing Chrome read authority target.platform",
  );
  if (!SUPPORTED_PLATFORMS.has(platform)) fail(`unsupported platform ${platform}`);
  const url = canonicalUrl(requiredString(
    rawTarget.post_permalink,
    "existing Chrome read authority target.post_permalink",
  ));
  if (url.protocol !== "https:" || !LIVE_HOSTS[platform]?.has(url.hostname)
      || !META_POST_PATH_RULES[platform]?.test(url.pathname)) {
    fail(`approved ${platform} target is not a trusted post permalink`);
  }
  if (platform === "instagram") instagramUrlIdentity(rawTarget.post_permalink);
  return url.toString();
}

/**
 * Capture two stable accessibility snapshots in a process-owned Chrome tab.
 *
 * User-tab claiming is intentionally avoided: extension claim locks can
 * outlive a reset and make a read-only scan hang. This path opens one exact,
 * trusted permalink inside the already-authenticated Chrome browser, never
 * accepts a tab/browser/transport from the caller, and closes the tab in the
 * same operation.
 */
export async function captureChromeAccessibleSnapshotPair(rawTarget, options = {}) {
  const expectedUrl = approvedPermalink(rawTarget);
  const defaultSettleMs = rawTarget.platform === "facebook" ? 9000 : 2500;
  const settleMs = options.settleMs === undefined ? defaultSettleMs : options.settleMs;
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 10000) {
    fail("Chrome snapshot settleMs must be an integer from 0 to 10000");
  }
  const browser = await getSourceOwnedChromeBrowser();
  if (!browser?.tabs || typeof browser.tabs.new !== "function") {
    fail("trusted Chrome session cannot create a bounded scan tab");
  }
  const tab = await browser.tabs.new();
  try {
    await tab.goto(expectedUrl);
    if (settleMs > 0) await tab.playwright.waitForTimeout(settleMs);
    const beforeUrl = canonicalString(await tab.url());
    if (!sameApprovedPostUrl(beforeUrl, expectedUrl)) {
      fail("bounded Chrome scan tab differs from the approved post permalink");
    }
    let viewportScrollCount = 0;
    if (rawTarget.platform === "facebook") {
      if (!tab.dom_cua || typeof tab.dom_cua.scroll !== "function") {
        fail("Facebook bounded scan requires the supported viewport scroll surface");
      }
      // Facebook lazily materializes the comment thread only after the post's
      // lower viewport has been visited. Scrolling is read-only and bounded;
      // the exact URL is rechecked before evidence is accepted.
      for (let index = 0; index < 1; index += 1) {
        await tab.dom_cua.scroll({ x: 0, y: 1400 });
        viewportScrollCount += 1;
        await tab.playwright.waitForTimeout(750);
      }
    }
    const firstSnapshot = await tab.playwright.domSnapshot();
    await tab.playwright.waitForTimeout(250);
    const secondSnapshot = await tab.playwright.domSnapshot();
    const afterUrl = canonicalString(await tab.url());
    if (!sameApprovedPostUrl(afterUrl, expectedUrl) || !sameUrl(afterUrl, beforeUrl)) {
      fail("bounded Chrome scan document changed URL while capturing evidence");
    }
    if (typeof firstSnapshot !== "string" || !firstSnapshot.trim()
        || typeof secondSnapshot !== "string" || !secondSnapshot.trim()) {
      fail("bounded Chrome accessibility snapshot is missing or empty");
    }
    const visibleIframeMarkers = `${firstSnapshot}\n${secondSnapshot}`
      .match(/(?:<iframe\b|\biframe\s*\[)/giu) ?? [];
    if (visibleIframeMarkers.length !== 0) {
      fail("bounded Chrome accessibility surface includes a nested frame");
    }
    return Object.freeze({
      observed_url: afterUrl,
      first_snapshot: firstSnapshot,
      second_snapshot: secondSnapshot,
      document_epoch: null,
      runtime: Object.freeze({
        runtime_authority_version: CHROME_RUNTIME_AUTHORITY_VERSION,
        browser_client_revision: CHROME_BROWSER_CLIENT_REVISION,
        existing_authenticated_browser: true,
        browser_launch_count: 0,
        exact_navigation_count: 1,
        page_mutation_count: 0,
        viewport_scroll_count: viewportScrollCount,
        tab_cleanup_required: true,
      }),
    });
  } finally {
    try {
      await Promise.race([
        tab.close(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // The read result is still fail-closed by URL/root/snapshot checks. A
      // cleanup failure must not trigger a second scan or duplicate action.
    }
  }
}

function requireBrowserSurface(agent) {
  if (!agent?.browsers || typeof agent.browsers.get !== "function") {
    fail("trusted Node REPL did not provide the supported browser-client surface");
  }
  return agent;
}

function requireExistingChromeSurface(browser) {
  if (!browser?.user || typeof browser.user.openTabs !== "function"
      || typeof browser.user.claimTab !== "function") {
    fail("existing Chrome session does not expose openTabs and claimTab");
  }
  return browser;
}

function exactFreshListingEntry(rawListing, expectedUrl) {
  if (!Array.isArray(rawListing)) fail("existing Chrome openTabs result must be an array");
  const matches = rawListing.filter((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.url !== "string") return false;
    try {
      return sameApprovedPostUrl(entry.url, expectedUrl);
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    fail(`existing Chrome target expected exactly one fresh open tab, found ${matches.length}`);
  }
  const listedTab = matches[0];
  if (typeof listedTab.id !== "string" || !listedTab.id.trim()) {
    fail("fresh existing Chrome tab listing has no opaque claim id");
  }
  return listedTab;
}

function createNarrowReadSession(tab, expectedUrl) {
  const session = Object.freeze({
    describeExistingSession() {
      if (!EXISTING_CHROME_READ_SESSIONS.has(session)) {
        fail("existing Chrome read session lost its process brand");
      }
      return immutableJsonSnapshot({
        runtime_authority_version: CHROME_RUNTIME_AUTHORITY_VERSION,
        browser_client_revision: CHROME_BROWSER_CLIENT_REVISION,
        source: "fresh-open-tabs-exact-object-claim",
        browser: "chrome",
        existing_session: true,
        read_only: true,
        claim_count: 1,
        browser_launch_count: 0,
        navigation_count: 0,
        page_mutation_count: 0,
      }, "existing Chrome read session descriptor");
    },
    async inspectStableHost(rawTarget) {
      if (!EXISTING_CHROME_READ_SESSIONS.has(session)) {
        fail("existing Chrome read session lost its process brand");
      }
      const requestedUrl = approvedPermalink(rawTarget);
      if (!sameUrl(requestedUrl, expectedUrl)) {
        fail("existing Chrome read session cannot change its approved post target");
      }
      const internal = READ_SESSION_INTERNAL.get(session);
      if (!internal || internal.tab !== tab) {
        fail("existing Chrome read session lost its claimed tab binding");
      }
      return inspectStableHost(tab, expectedUrl);
    },
    async readAccessibleSnapshot(rawTarget) {
      if (!EXISTING_CHROME_READ_SESSIONS.has(session)) {
        fail("existing Chrome read session lost its process brand");
      }
      const requestedUrl = approvedPermalink(rawTarget);
      if (!sameUrl(requestedUrl, expectedUrl)) {
        fail("existing Chrome read session cannot change its approved post target");
      }
      const internal = READ_SESSION_INTERNAL.get(session);
      if (!internal || internal.tab !== tab) {
        fail("existing Chrome read session lost its claimed tab binding");
      }
      const before = await inspectStableHost(tab, expectedUrl);
      const snapshot = await tab.playwright.domSnapshot();
      if (typeof snapshot !== "string" || !snapshot.trim()) {
        fail("existing Chrome accessible snapshot is missing or empty");
      }
      const after = await inspectStableHost(tab, expectedUrl);
      if (before.observed_url !== after.observed_url
          || before.document_state.document_epoch !== after.document_state.document_epoch
          || JSON.stringify(before.frame_topology) !== JSON.stringify(after.frame_topology)) {
        fail("trusted Chrome document changed while reading the accessible snapshot");
      }
      return snapshot;
    },
  });
  EXISTING_CHROME_READ_SESSIONS.add(session);
  READ_SESSION_INTERNAL.set(session, Object.freeze({ tab, expectedUrl }));
  return session;
}

export function chromeRuntimeAuthorityDescriptor() {
  return immutableJsonSnapshot({
    runtime_authority_version: CHROME_RUNTIME_AUTHORITY_VERSION,
    browser_client_revision: CHROME_BROWSER_CLIENT_REVISION,
    browser_client_sha256: CHROME_BROWSER_CLIENT_SHA256,
    browser_client_bytes: CHROME_BROWSER_CLIENT_BYTES,
    browser_client_integrity_checked_before_import: true,
    status: "source_wired_authenticated_chrome_exact_url_bounded_tab",
    trusted_node_repl_required: true,
    exact_fresh_open_tabs_object_required: false,
    bounded_process_owned_tab: true,
    existing_session_only: true,
    raw_tab_exposed: false,
    can_launch_browser: false,
    explicit_source_owned_recovery: true,
    recovery_trigger: "exact cached-browser disconnected error only",
    chrome_reselection_limit: 1,
    can_navigate: true,
    navigation_scope: "one exact trusted post permalink per read operation",
    can_mutate_page: false,
    can_read_browser_storage: false,
  }, "Chrome runtime authority descriptor");
}

export function isExistingChromeReadSession(value) {
  return Boolean(value && typeof value === "object"
    && EXISTING_CHROME_READ_SESSIONS.has(value));
}

export async function openExistingChromeReadSession(rawTarget) {
  const expectedUrl = approvedPermalink(rawTarget);
  // setupBrowserRuntime itself requires the ambient trusted Node REPL browser
  // service. No setup option, runtime object, transport, or path is accepted
  // from the caller.
  const browser = requireExistingChromeSurface(await getSourceOwnedChromeBrowser());
  const freshListing = await browser.user.openTabs();
  const listedTab = exactFreshListingEntry(freshListing, expectedUrl);
  // Pass the exact object from this fresh listing, never a caller-provided or
  // serialized id/object.
  const claimedTab = await browser.user.claimTab(listedTab);
  return createNarrowReadSession(claimedTab, expectedUrl);
}

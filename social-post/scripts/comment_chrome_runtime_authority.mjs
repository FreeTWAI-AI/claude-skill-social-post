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

import {
  canonicalUrl,
  fail,
  immutableJsonSnapshot,
  requiredString,
  unique,
} from "./comment_chrome_common.mjs";

export const CHROME_RUNTIME_AUTHORITY_VERSION = "2026-08-30.2";
export const CHROME_BROWSER_CLIENT_REVISION = "openai-bundled/chrome/26.818.41509";
export const CHROME_BROWSER_CLIENT_SHA256 =
  "53484b46feddd277e436a0c3f38820eca8aab4e32c01bb44e1b5766eb369b5e6";
export const CHROME_BROWSER_CLIENT_BYTES = 148173;

const EXISTING_CHROME_READ_SESSIONS = new WeakSet();
const READ_SESSION_INTERNAL = new WeakMap();

export function verifyPinnedBrowserClientBytes(rawBytes) {
  if (!(rawBytes instanceof Uint8Array)) {
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

async function loadSetupBrowserRuntime() {
  let browserClientBytes;
  try {
    browserClientBytes = await readFile(new URL(
      "../../../plugins/cache/openai-bundled/chrome/26.818.41509/scripts/browser-client.mjs",
      import.meta.url,
    ));
  } catch {
    fail("pinned browser-client bytes are unavailable");
  }
  verifyPinnedBrowserClientBytes(browserClientBytes);
  try {
    const client = await import(
      "../../../plugins/cache/openai-bundled/chrome/26.818.41509/scripts/browser-client.mjs"
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

function canonicalString(raw) {
  return canonicalUrl(raw).toString();
}

function sameUrl(left, right) {
  return canonicalString(left) === canonicalString(right);
}

function approvedPermalink(rawTarget) {
  if (!rawTarget || typeof rawTarget !== "object") {
    fail("existing Chrome read authority target must be an object");
  }
  return canonicalString(requiredString(
    rawTarget.post_permalink,
    "existing Chrome read authority target.post_permalink",
  ));
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
      return sameUrl(entry.url, expectedUrl);
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

async function requireMainFrameTopology(tab) {
  if (!tab?.playwright || typeof tab.playwright.domSnapshot !== "function") {
    fail("existing Chrome read authority requires frame-aware DOM snapshots");
  }
  const raw = await tab.playwright.domSnapshot();
  if (typeof raw !== "string" || !raw.trim()) {
    fail("frame-aware DOM snapshot is missing or empty");
  }
  // DOM-CUA does not expose stable native frame ownership. Keep the current
  // main-frame-only policy until authenticated Meta canaries prove a versioned
  // frame mapping. This check reads the snapshot and never mutates the page.
  const iframeMarkers = raw.match(/(?:<iframe\b|\biframe\s*\[)/giu) ?? [];
  if (iframeMarkers.length !== 0) {
    fail("trusted host is main-frame-only; iframe presence blocks live actuation");
  }
  return immutableJsonSnapshot({
    policy: "main-frame-only",
    iframe_count: 0,
  }, "existing Chrome frame topology");
}

async function inspectDocumentRoot(tab) {
  if (!tab?.playwright || typeof tab.playwright.locator !== "function") {
    fail("existing Chrome read authority requires a Playwright root locator");
  }
  const root = await unique(tab.playwright.locator("html", {}), "top-level document root");
  const value = await root.evaluate((element) => {
    const document = element?.ownerDocument;
    const view = document?.defaultView;
    let topLevel = false;
    let locationHref = "";
    let origin = "";
    let documentEpoch = null;
    try {
      topLevel = Boolean(view && view.top === view && view.frameElement === null);
      locationHref = String(view?.location?.href ?? "");
      origin = String(view?.location?.origin ?? "");
      const observedTimeOrigin = Number(view?.performance?.timeOrigin);
      documentEpoch = Number.isFinite(observedTimeOrigin) && observedTimeOrigin > 0
        ? observedTimeOrigin : null;
    } catch {
      topLevel = false;
    }
    return {
      connected: element?.isConnected === true,
      is_root: Boolean(document && document.documentElement === element),
      top_level: topLevel,
      tag: String(element?.tagName ?? "").toLowerCase(),
      location_href: locationHref,
      origin,
      document_epoch: documentEpoch,
    };
  });
  const state = immutableJsonSnapshot(value, "existing Chrome document root state");
  if (state.connected !== true || state.is_root !== true || state.top_level !== true
      || state.tag !== "html") {
    fail("trusted host requires one connected top-level HTML document root");
  }
  if (typeof state.document_epoch !== "number" || !Number.isFinite(state.document_epoch)
      || state.document_epoch <= 0) {
    fail("trusted document has no readonly performance time origin");
  }
  return state;
}

async function inspectStableHost(tab, expectedUrl) {
  if (!tab || typeof tab.url !== "function") {
    fail("existing Chrome read authority requires a browser tab URL surface");
  }
  const before = canonicalString(await tab.url());
  if (!sameUrl(before, expectedUrl)) {
    fail("current URL differs from the approved post permalink");
  }
  const firstTopology = await requireMainFrameTopology(tab);
  const root = await inspectDocumentRoot(tab);
  const secondTopology = await requireMainFrameTopology(tab);
  const after = canonicalString(await tab.url());
  if (!sameUrl(before, after) || !sameUrl(after, root.location_href)
      || !sameUrl(after, expectedUrl)) {
    fail("trusted host URL changed during document verification");
  }
  if (JSON.stringify(firstTopology) !== JSON.stringify(secondTopology)) {
    fail("frame topology changed during trusted host verification");
  }
  if (root.origin !== new URL(expectedUrl).origin) {
    fail("document origin differs from the approved post");
  }
  return immutableJsonSnapshot({
    observed_url: after,
    frame_topology: firstTopology,
    document_state: root,
  }, "existing Chrome stable host observation");
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
    status: "source_wired_existing_session_only_pending_authenticated_browser_canary",
    trusted_node_repl_required: true,
    exact_fresh_open_tabs_object_required: true,
    existing_session_only: true,
    raw_tab_exposed: false,
    can_launch_browser: false,
    can_navigate: false,
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
  const setupBrowserRuntime = await loadSetupBrowserRuntime();
  const agent = requireBrowserSurface(await setupBrowserRuntime());
  const browser = requireExistingChromeSurface(await agent.browsers.get("chrome"));
  const freshListing = await browser.user.openTabs();
  const listedTab = exactFreshListingEntry(freshListing, expectedUrl);
  // Pass the exact object from this fresh listing, never a caller-provided or
  // serialized id/object.
  const claimedTab = await browser.user.claimTab(listedTab);
  return createNarrowReadSession(claimedTab, expectedUrl);
}

/** Pure read-only document checks; no browser selection, session brands or authority. */
import {
  LIVE_HOSTS, canonicalUrl, fail, immutableJsonSnapshot, sameInstagramPostUrl, unique,
} from "./comment_chrome_common.mjs";

export function canonicalString(raw) {
  return canonicalUrl(raw).toString();
}

export function sameUrl(left, right) {
  return canonicalString(left) === canonicalString(right);
}

export function sameApprovedPostUrl(observed, expected) {
  return LIVE_HOSTS.instagram.has(canonicalUrl(expected).hostname)
    ? sameInstagramPostUrl(observed, expected) : sameUrl(observed, expected);
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

export async function inspectStableHost(tab, expectedUrl) {
  if (!tab || typeof tab.url !== "function") {
    fail("existing Chrome read authority requires a browser tab URL surface");
  }
  const before = canonicalString(await tab.url());
  if (!sameApprovedPostUrl(before, expectedUrl)) {
    fail("current URL differs from the approved post permalink");
  }
  const firstTopology = await requireMainFrameTopology(tab);
  const root = await inspectDocumentRoot(tab);
  const secondTopology = await requireMainFrameTopology(tab);
  const after = canonicalString(await tab.url());
  if (!sameUrl(before, after) || !sameUrl(after, root.location_href)
      || !sameApprovedPostUrl(after, expectedUrl)) {
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

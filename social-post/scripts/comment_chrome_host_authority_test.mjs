import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { instagramUrlIdentity, sameInstagramPostUrl } from "./comment_chrome_common.mjs";
import { inspectStableHost } from "./comment_chrome_runtime_document.mjs";

import {
  TRUSTED_CHROME_HOST_RESOLVER_VERSION,
  TRUSTED_CHROME_HOST_SCHEMA_VERSION,
  isTrustedChromeHostAttestation,
  resolveTrustedChromeHost,
  trustedChromeHostResolverDescriptor,
  verifyTrustedChromeHostStillCurrent,
} from "./comment_chrome_host_authority.mjs";
import {
  CHROME_BROWSER_CLIENT_BYTES,
  CHROME_BROWSER_CLIENT_REVISION,
  CHROME_BROWSER_CLIENT_SHA256,
  CHROME_RUNTIME_AUTHORITY_VERSION,
  captureChromeAccessibleSnapshotPair,
  chromeRuntimeAuthorityDescriptor,
  isExistingChromeReadSession,
  loadSetupBrowserRuntime,
  openExistingChromeReadSession,
  recoverSourceOwnedChromeBrowser,
  verifyPinnedBrowserClientBytes,
} from "./comment_chrome_runtime_authority.mjs";

const TARGETS = {
  facebook: {
    platform: "facebook", account_key: "creator", post_key: "fb-post",
    post_permalink: "https://www.facebook.com/example/posts/123",
  },
  instagram: {
    platform: "instagram", account_key: "creator", post_key: "ig-post",
    post_permalink: "https://www.instagram.com/reel/ABC123",
  },
  threads: {
    platform: "threads", account_key: "creator", post_key: "th-post",
    post_permalink: "https://www.threads.com/@example/post/ABC123",
  },
};

assert.equal(TRUSTED_CHROME_HOST_SCHEMA_VERSION, 2);
assert.equal(TRUSTED_CHROME_HOST_RESOLVER_VERSION, "2026-08-30.1");
assert.equal(CHROME_RUNTIME_AUTHORITY_VERSION, "2026-08-31.2");
assert.equal(CHROME_BROWSER_CLIENT_REVISION, "openai-bundled/chrome/26.825.51511");
assert.equal(
  CHROME_BROWSER_CLIENT_SHA256,
  "c52ba09202f0e82caa6f6d2a6463a8635c1b1316567975d9b91c1a05fb5af501",
);
assert.equal(CHROME_BROWSER_CLIENT_BYTES, 149210);
assert.throws(
  () => verifyPinnedBrowserClientBytes(null),
  /pinned browser-client bytes are unavailable/u,
);
assert.throws(
  () => verifyPinnedBrowserClientBytes(Uint8Array.of(0)),
  /pinned browser-client integrity check failed/u,
);

const runtimeDescriptor = chromeRuntimeAuthorityDescriptor();
assert.equal(
  runtimeDescriptor.status,
  "source_wired_authenticated_chrome_exact_url_bounded_tab",
);
assert.equal(runtimeDescriptor.existing_session_only, true);
assert.equal(runtimeDescriptor.exact_fresh_open_tabs_object_required, false);
assert.equal(runtimeDescriptor.bounded_process_owned_tab, true);
assert.equal(runtimeDescriptor.trusted_node_repl_required, true);
assert.equal(runtimeDescriptor.raw_tab_exposed, false);
assert.equal(runtimeDescriptor.can_launch_browser, false);
assert.equal(runtimeDescriptor.explicit_source_owned_recovery, true);
assert.equal(runtimeDescriptor.chrome_reselection_limit, 1);
assert.equal(runtimeDescriptor.recovery_trigger, "exact cached-browser disconnected error only");
assert.equal(runtimeDescriptor.can_navigate, true);
assert.equal(
  runtimeDescriptor.navigation_scope,
  "one exact trusted post permalink per read operation",
);
assert.equal(runtimeDescriptor.can_mutate_page, false);
assert.equal(runtimeDescriptor.can_read_browser_storage, false);
assert.equal(runtimeDescriptor.browser_client_sha256, CHROME_BROWSER_CLIENT_SHA256);
assert.equal(runtimeDescriptor.browser_client_bytes, CHROME_BROWSER_CLIENT_BYTES);
assert.equal(runtimeDescriptor.browser_client_integrity_checked_before_import, true);
assert.equal(Object.isFrozen(runtimeDescriptor), true);

const descriptor = trustedChromeHostResolverDescriptor();
assert.equal(descriptor.schema_version, 2);
assert.equal(descriptor.resolver_version, "2026-08-30.1");
assert.equal(
  descriptor.status,
  "source_wired_existing_session_only_pending_authenticated_browser_canary",
);
assert.equal(descriptor.frame_policy, "main-frame-only");
assert.equal(descriptor.document_epoch, "readonly-performance-time-origin");
assert.equal(descriptor.caller_authority_inputs, false);
assert.equal(descriptor.live_scan_plan_minting, false);
assert.equal(descriptor.live_send_enabled, false);
assert.deepEqual(descriptor.runtime, runtimeDescriptor);
assert.equal(Object.isFrozen(descriptor), true);

// The production authority API accepts scope data only. No browser object or
// resolver can be supplied through an additional positional argument.
assert.equal(resolveTrustedChromeHost.length, 1);
assert.equal(verifyTrustedChromeHostStillCurrent.length, 2);
assert.equal(openExistingChromeReadSession.length, 1);
assert.equal(captureChromeAccessibleSnapshotPair.length, 1);
assert.equal(typeof loadSetupBrowserRuntime, "function");
assert.equal(loadSetupBrowserRuntime.length, 0);
assert.equal(recoverSourceOwnedChromeBrowser.length, 0);
await assert.rejects(() => recoverSourceOwnedChromeBrowser({ browser: {} }), /accepts no caller authority/u);
await assert.rejects(() => recoverSourceOwnedChromeBrowser(), /requires an existing cached selection/u);
assert.equal(isTrustedChromeHostAttestation({}), false);
assert.equal(isExistingChromeReadSession({}), false);

for (const [label, target, pattern] of [
  [
    "wrong host",
    { ...TARGETS.instagram, post_permalink: "https://evil.example/reel/ABC123" },
    /trusted HTTPS host/u,
  ],
  [
    "unsupported IG path",
    { ...TARGETS.instagram, post_permalink: "https://www.instagram.com/example" },
    /supported post permalink/u,
  ],
  [
    "HTTP",
    { ...TARGETS.threads, post_permalink: "http://www.threads.com/@example/post/ABC123" },
    /trusted HTTPS host/u,
  ],
]) {
  await assert.rejects(() => resolveTrustedChromeHost(target), pattern, label);
  await assert.rejects(
    () => captureChromeAccessibleSnapshotPair(target, { settleMs: 0 }),
    /not a trusted post permalink/u,
    `bounded snapshot rejects ${label}`,
  );
}

for (const settleMs of [-1, 10001, 0.5, "0", null]) {
  await assert.rejects(
    () => captureChromeAccessibleSnapshotPair(TARGETS.facebook, { settleMs }),
    /settleMs must be an integer from 0 to 10000/u,
  );
}

for (const kind of ["p", "reel", "reels", "tv"]) {
  const post_permalink = `https://www.instagram.com/${kind}/ABC123/`;
  assert.equal(sameInstagramPostUrl(post_permalink, TARGETS.instagram.post_permalink), true);
  // Invalid settle options are checked after URL validation but before runtime
  // loading, proving each accepted alias without opening a browser.
  await assert.rejects(
    () => captureChromeAccessibleSnapshotPair({ ...TARGETS.instagram, post_permalink }, { settleMs: -1 }),
    /settleMs must be an integer/u,
  );
}
assert.equal(sameInstagramPostUrl("https://www.instagram.com/p/OTHER", TARGETS.instagram.post_permalink), false);
assert.equal(sameInstagramPostUrl("https://instagram.com/p/ABC123", TARGETS.instagram.post_permalink), false);
assert.equal(sameInstagramPostUrl("https://www.instagram.com/p/ABC123?igsh=other", TARGETS.instagram.post_permalink), false);
for (const path of ["/p/p/ABC123", "/p/ABC123/c/123", "/p/ABC123/../OTHER", "/p/ABC123%2FOTHER"]) {
  assert.throws(() => instagramUrlIdentity(`https://www.instagram.com${path}`));
}
for (const query of ["comment_id=123", "replyId=123", "x=1&x=1", "x=1&X=2"]) {
  assert.throws(() => sameInstagramPostUrl(
    `https://www.instagram.com/p/ABC123?${query}`, `https://www.instagram.com/reels/ABC123?${query}`,
  ));
}

await assert.rejects(
  () => verifyTrustedChromeHostStillCurrent(
    Object.freeze({ schema_version: 2 }), TARGETS.facebook,
  ),
  /process-minted attestation/u,
);

// A standalone Node process has no trusted Node REPL browser service. A valid
// target must therefore fail closed rather than launch Chrome or accept a fake.
assert.equal(Object.prototype.hasOwnProperty.call(globalThis, "nodeRepl"), false);
await assert.rejects(
  () => openExistingChromeReadSession(TARGETS.facebook),
  /pinned browser-client bytes are unavailable|trusted Node REPL browser service/u,
);
await assert.rejects(
  () => resolveTrustedChromeHost(TARGETS.instagram),
  /pinned browser-client bytes are unavailable|trusted Node REPL browser service/u,
);
await assert.rejects(
  () => captureChromeAccessibleSnapshotPair(TARGETS.threads, { settleMs: 0 }),
  /pinned browser-client bytes are unavailable|trusted Node REPL browser service/u,
);

const runtimeSource = await readFile(
  new URL("./comment_chrome_runtime_authority.mjs", import.meta.url), "utf8",
);
const hostSource = await readFile(
  new URL("./comment_chrome_host_authority.mjs", import.meta.url), "utf8",
);
const documentSource = await readFile(
  new URL("./comment_chrome_runtime_document.mjs", import.meta.url), "utf8",
);

// Ordinary document-unit values exercise the real callback, not browser authority.
function documentFixture() {
  const href = TARGETS.facebook.post_permalink;
  const view = { location: { href, origin: new URL(href).origin }, performance: { timeOrigin: 1000 }, frameElement: null };
  view.top = view;
  const document = { defaultView: view };
  const element = { ownerDocument: document, isConnected: true, tagName: "HTML" };
  document.documentElement = element;
  const current = { view, element, rootCount: 1, snapshot: "document", urls: [href, href],
    calls: { urls: 0, snapshots: 0, evaluate: 0 } };
  current.tab = {
    url: async () => current.urls[current.calls.urls++],
    playwright: {
      domSnapshot: async () => { current.calls.snapshots += 1; return current.snapshot; },
      locator: (selector, options) => {
        assert.equal(selector, "html"); assert.deepEqual(options, {});
        return {
          count: async () => current.rootCount,
          isVisible: async () => true,
          evaluate: async (callback) => { current.calls.evaluate += 1; return callback(element); },
        };
      },
    },
  };
  return current;
}

const stableDocument = documentFixture();
const stableObservation = await inspectStableHost(stableDocument.tab, TARGETS.facebook.post_permalink);
assert.equal(stableObservation.observed_url, TARGETS.facebook.post_permalink);
assert.deepEqual(stableObservation.frame_topology, { policy: "main-frame-only", iframe_count: 0 });
assert.equal(stableObservation.document_state.document_epoch, 1000);
assert.deepEqual(stableDocument.calls, { urls: 2, snapshots: 2, evaluate: 1 });
assert.equal(Object.isFrozen(stableObservation), true);
assert.equal(isExistingChromeReadSession(stableObservation), false, "pure document diagnostics never mint a session brand");
assert.equal(isTrustedChromeHostAttestation(stableObservation), false, "pure document diagnostics never mint host authority");
for (const [mutate, pattern] of [
  [(f) => { f.urls[1] = "https://www.facebook.com/example/posts/OTHER"; }, /URL changed/u],
  [(f) => { f.snapshot = "iframe [anonymous]"; }, /main-frame-only/u],
  [(f) => { delete f.view.performance; }, /no readonly performance time origin/u],
  [(f) => { f.view.location.origin = "https://another.example"; }, /document origin differs/u],
  [(f) => { f.element.isConnected = false; }, /connected top-level HTML/u],
  [(f) => { f.rootCount = 2; }, /expected exactly one match/u],
]) {
  const current = documentFixture(); mutate(current);
  await assert.rejects(inspectStableHost(current.tab, TARGETS.facebook.post_permalink), pattern);
}

const browserClientSpecifier = [
  "..", "..", "..", "plugins", "cache", "openai-bundled", "chrome",
  "26.825.51511", "scripts", "browser-client.mjs",
].join("/");
assert.equal(
  runtimeSource.includes(`"${browserClientSpecifier}"`),
  true,
);
assert.doesNotMatch(runtimeSource, new RegExp(`from\\s+["']${browserClientSpecifier}`, "u"));
assert.match(runtimeSource, /verifyPinnedBrowserClientBytes\(browserClientBytes\);[\s\S]*await import\(/u);
assert.match(runtimeSource, /await setupBrowserRuntime\(\)/u);
assert.match(runtimeSource, /browser\.user\.openTabs\(\)/u);
assert.match(runtimeSource, /browser\.user\.claimTab\(listedTab\)/u);
assert.match(documentSource, /view\?\.performance\?\.timeOrigin/u);
assert.deepEqual([...documentSource.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/gu)].map((match) => match[1]).sort(),
  ["canonicalString", "inspectStableHost", "sameApprovedPostUrl", "sameUrl"]);
assert.deepEqual([...documentSource.matchAll(/\bfrom\s+"([^"]+)"/gu)].map((match) => match[1]), ["./comment_chrome_common.mjs"]);
assert.doesNotMatch(documentSource, /\bnew\s+(?:WeakMap|WeakSet|Map|Set)\s*\(|\b(?:EXISTING_CHROME_READ_SESSIONS|READ_SESSION_INTERNAL|sourceOwnedChrome\w*|getSourceOwnedChromeBrowser|recoverSourceOwnedChromeBrowser)\b/u,
  "document helpers cannot own browser caches, reconnection or session brands");
assert.doesNotMatch(documentSource, /\.browsers\s*\.|\.user\s*\.|\bimport\s*\(/u);
assert.match(runtimeSource, /openExistingChromeReadSession\(rawTarget\)/u);
assert.match(hostSource, /resolveTrustedChromeHost\(rawTarget\)/u);
assert.match(
  hostSource,
  /verifyTrustedChromeHostStillCurrent\(attestation, rawTarget\)/u,
);

// Navigation is allowed only in the source-wired bounded capture operation.
// Keep the claimed-tab host resolver read-only and reject any added navigation
// call, even if the descriptor still claims a single exact target.
const captureStart = runtimeSource.indexOf(
  "export async function captureChromeAccessibleSnapshotPair(rawTarget, options = {}) {",
);
const captureEnd = runtimeSource.indexOf("\nfunction requireBrowserSurface(agent) {", captureStart);
assert.ok(captureStart >= 0 && captureEnd > captureStart);
const captureSource = runtimeSource.slice(captureStart, captureEnd);
const otherRuntimeSource = runtimeSource.slice(0, captureStart) + runtimeSource.slice(captureEnd);
assert.match(captureSource, /const expectedUrl = approvedPermalink\(rawTarget\);/u);
assert.match(captureSource, /const browser = await getSourceOwnedChromeBrowser\(\);/u);
assert.equal((runtimeSource.match(/agent\.browsers\.get\("chrome"\)/gu) ?? []).length, 1,
  "initial selection and explicit recovery use one source-owned Chrome-family call site");
assert.match(captureSource, /const tab = await browser\.tabs\.new\(\);\s*try\s*\{\s*await tab\.goto\(expectedUrl\);/u);
assert.deepEqual(
  runtimeSource.match(/\.(?:goto|reload|back|forward)\s*\([^)]*\)/gu),
  [".goto(expectedUrl)"],
);
assert.deepEqual(runtimeSource.match(/\.tabs\.new\s*\([^)]*\)/gu), [".tabs.new()"]);
assert.match(captureSource, /if \(!sameApprovedPostUrl\(beforeUrl, expectedUrl\)\)/u);
assert.match(captureSource, /if \(!sameApprovedPostUrl\(afterUrl, expectedUrl\) \|\| !sameUrl\(afterUrl, beforeUrl\)\)/u);
assert.match(captureSource, /exact_navigation_count: 1/u);
assert.match(captureSource, /page_mutation_count: 0/u);
assert.match(captureSource, /tab_cleanup_required: true/u);
assert.match(captureSource, /finally\s*\{[\s\S]*tab\.close\(\)/u);
for (const source of [otherRuntimeSource, hostSource, documentSource]) {
  assert.doesNotMatch(source, /\.(?:goto|reload|back|forward)\s*\(/u);
  assert.doesNotMatch(source, /\.tabs\.new\s*\(/u);
}

for (const [label, pattern] of [
  ["DOM property installation", /Object\.definePropert(?:y|ies)\s*\(/u],
  ["page click", /\.click\s*\(/u],
  ["page fill", /\.fill\s*\(/u],
  ["page key press", /\.press\s*\(/u],
  ["DOM node removal or insertion", /\.(?:remove|replaceWith|append|appendChild|prepend|insertBefore)\s*\(/u],
  ["DOM attribute mutation", /\.(?:setAttribute|removeAttribute|toggleAttribute)\s*\(/u],
  ["DOM event dispatch", /\.dispatchEvent\s*\(/u],
  ["DOM content assignment", /\.(?:textContent|innerHTML|outerHTML)\s*=/u],
  ["form value assignment", /\.value\s*=/u],
  ["location assignment", /\b(?:window\.)?location(?:\.href)?\s*=/u],
  ["history mutation", /\bhistory\.(?:pushState|replaceState)\s*\(/u],
  ["document write", /\bdocument\.(?:write|writeln)\s*\(/u],
  ["cookie read", /\.cookies?\s*\(/u],
  ["local storage read", /\blocalStorage\b/u],
  ["session storage read", /\bsessionStorage\b/u],
]) {
  assert.doesNotMatch(runtimeSource, pattern, label);
  assert.doesNotMatch(hostSource, pattern, label);
  assert.doesNotMatch(documentSource, pattern, label);
}

for (const forbiddenExport of [
  "setAgent", "setBrowser", "setTab", "setResolver", "setTransport",
  "registerAgent", "registerBrowser", "registerTab", "registerResolver",
]) {
  assert.doesNotMatch(runtimeSource, new RegExp(`export\\s+.*${forbiddenExport}`, "u"));
  assert.doesNotMatch(hostSource, new RegExp(`export\\s+.*${forbiddenExport}`, "u"));
  assert.doesNotMatch(documentSource, new RegExp(`export\\s+.*${forbiddenExport}`, "u"));
}

console.log("comment Chrome source-wired read-only host authority tests passed");

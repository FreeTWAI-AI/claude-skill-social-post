/**
 * Process-branded, read-only authority for live Meta post hosts.
 *
 * This facade accepts only an approved target. It obtains its existing Chrome
 * session from the source-wired trusted Node REPL runtime module and never
 * accepts or returns a browser agent, browser, tab, resolver, transport, path,
 * or serialized authority. It cannot mint scan plans or send capabilities.
 */

import { createHmac, randomBytes } from "node:crypto";

import {
  LIVE_HOSTS,
  SUPPORTED_PLATFORMS,
  canonicalUrl,
  fail,
  immutableJsonSnapshot,
  instagramUrlIdentity,
  requiredString,
  sameInstagramPostUrl,
} from "./comment_chrome_common.mjs";
import {
  chromeRuntimeAuthorityDescriptor,
  isExistingChromeReadSession,
  openExistingChromeReadSession,
} from "./comment_chrome_runtime_authority.mjs";

export const TRUSTED_CHROME_HOST_RESOLVER_VERSION = "2026-08-30.1";
export const TRUSTED_CHROME_HOST_SCHEMA_VERSION = 2;

const PROCESS_BINDING_KEY = randomBytes(32);
const TRUSTED_HOST_ATTESTATIONS = new WeakSet();
const HOST_INTERNAL = new WeakMap();

const POST_PATH_RULES = Object.freeze({
  facebook: /(?:\/posts\/|\/videos\/|^\/reel\/|^\/watch\/|^\/(?:permalink|story)\.php$|^\/photo\/)/u,
  instagram: /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+$/u,
  threads: /^\/@[^/]+\/post\/[^/]+$/u,
});

function keyedDigest(label, value) {
  return createHmac("sha256", PROCESS_BINDING_KEY)
    .update(`${label}\0${JSON.stringify(value)}`, "utf8")
    .digest("hex");
}

function canonicalString(raw) {
  return canonicalUrl(raw).toString();
}

function sameUrl(left, right) {
  return canonicalString(left) === canonicalString(right);
}

function sameApprovedPostUrl(observed, expected) {
  return LIVE_HOSTS.instagram.has(canonicalUrl(expected).hostname)
    ? sameInstagramPostUrl(observed, expected) : sameUrl(observed, expected);
}

function assertTrustedPostPermalink(platform, raw) {
  const url = canonicalUrl(raw);
  if (url.protocol !== "https:" || !LIVE_HOSTS[platform]?.has(url.hostname)) {
    fail(`approved ${platform} post permalink is not on a trusted HTTPS host`);
  }
  if (!POST_PATH_RULES[platform].test(url.pathname)) {
    fail(`approved ${platform} URL is not a supported post permalink`);
  }
  if (platform === "instagram") instagramUrlIdentity(raw);
  return url.toString();
}

function assertHostTarget(raw) {
  if (!raw || typeof raw !== "object") fail("trusted host target must be an object");
  const platform = requiredString(raw.platform, "trusted host target.platform");
  if (!SUPPORTED_PLATFORMS.has(platform)) fail(`unsupported platform ${platform}`);
  return immutableJsonSnapshot({
    platform,
    account_key: requiredString(raw.account_key, "trusted host target.account_key"),
    post_key: requiredString(raw.post_key, "trusted host target.post_key"),
    post_permalink: assertTrustedPostPermalink(platform, raw.post_permalink),
  }, "trusted host target");
}

function scopeDigest(target) {
  return keyedDigest("trusted-host-scope-v2", target);
}

function topologyDigest(observed) {
  return keyedDigest("frame-topology-v2", observed.frame_topology);
}

function epochDigest(observed) {
  return keyedDigest("readonly-document-epoch-v2", {
    observed_url: observed.observed_url,
    origin: observed.document_state.origin,
    document_epoch: observed.document_state.document_epoch,
  });
}

async function observeStablePair(session, target) {
  if (!isExistingChromeReadSession(session)) {
    fail("trusted host requires a process-minted existing Chrome read session");
  }
  const sessionDescriptor = session.describeExistingSession();
  const first = await session.inspectStableHost(target);
  const second = await session.inspectStableHost(target);
  if (!sameApprovedPostUrl(first.observed_url, target.post_permalink)
      || !sameApprovedPostUrl(second.observed_url, target.post_permalink)) {
    fail("trusted host observation differs from the approved post permalink");
  }
  const firstTopology = topologyDigest(first);
  const secondTopology = topologyDigest(second);
  if (firstTopology !== secondTopology) {
    fail("frame topology changed between trusted host reads");
  }
  const firstEpoch = epochDigest(first);
  const secondEpoch = epochDigest(second);
  if (firstEpoch !== secondEpoch) {
    fail("readonly document epoch changed between trusted host reads");
  }
  return {
    observed_url: first.observed_url,
    frame_topology_digest: firstTopology,
    document_epoch_digest: firstEpoch,
    document_state: first.document_state,
    runtime_session: sessionDescriptor,
  };
}

function documentBindingDigest(bindingId, target, observed) {
  return keyedDigest("trusted-document-binding-v2", {
    schema_version: TRUSTED_CHROME_HOST_SCHEMA_VERSION,
    resolver_version: TRUSTED_CHROME_HOST_RESOLVER_VERSION,
    binding_id: bindingId,
    scope_digest: scopeDigest(target),
    observed_url: observed.observed_url,
    frame_topology_digest: observed.frame_topology_digest,
    document_epoch_digest: observed.document_epoch_digest,
    root_tag: observed.document_state.tag,
    root_origin: observed.document_state.origin,
    top_level: observed.document_state.top_level,
    runtime_authority_version: observed.runtime_session.runtime_authority_version,
    browser_client_revision: observed.runtime_session.browser_client_revision,
    existing_session: observed.runtime_session.existing_session,
    read_only: observed.runtime_session.read_only,
    claim_count: observed.runtime_session.claim_count,
    browser_launch_count: observed.runtime_session.browser_launch_count,
    navigation_count: observed.runtime_session.navigation_count,
    page_mutation_count: observed.runtime_session.page_mutation_count,
  });
}

export function trustedChromeHostResolverDescriptor() {
  return immutableJsonSnapshot({
    schema_version: TRUSTED_CHROME_HOST_SCHEMA_VERSION,
    resolver_version: TRUSTED_CHROME_HOST_RESOLVER_VERSION,
    status: "source_wired_existing_session_only_pending_authenticated_browser_canary",
    frame_policy: "main-frame-only",
    document_epoch: "readonly-performance-time-origin",
    caller_authority_inputs: false,
    runtime: chromeRuntimeAuthorityDescriptor(),
    live_scan_plan_minting: false,
    live_send_enabled: false,
  }, "trusted Chrome host resolver descriptor");
}

export function isTrustedChromeHostAttestation(value) {
  return Boolean(value && typeof value === "object" && TRUSTED_HOST_ATTESTATIONS.has(value));
}

export async function resolveTrustedChromeHost(rawTarget) {
  const target = assertHostTarget(rawTarget);
  const session = await openExistingChromeReadSession(target);
  if (!isExistingChromeReadSession(session)) {
    fail("source-wired Chrome runtime returned an untrusted read session");
  }
  const observed = await observeStablePair(session, target);
  const bindingId = keyedDigest("existing-chrome-document-binding-v2", {
    nonce: randomBytes(32).toString("hex"),
    scope_digest: scopeDigest(target),
    document_epoch_digest: observed.document_epoch_digest,
  });
  const bindingDigest = documentBindingDigest(bindingId, target, observed);
  const attestation = immutableJsonSnapshot({
    schema_version: TRUSTED_CHROME_HOST_SCHEMA_VERSION,
    resolver_version: TRUSTED_CHROME_HOST_RESOLVER_VERSION,
    platform: target.platform,
    observed_url: observed.observed_url,
    scope_digest: scopeDigest(target),
    frame_policy: "main-frame-only",
    frame_topology_digest: observed.frame_topology_digest,
    document_epoch_digest: observed.document_epoch_digest,
    document_binding_digest: bindingDigest,
    existing_session: true,
    read_only: true,
    claim_count: 1,
    browser_launch_count: 0,
    navigation_count: 0,
    page_mutation_count: 0,
  }, "trusted Chrome host attestation");
  TRUSTED_HOST_ATTESTATIONS.add(attestation);
  HOST_INTERNAL.set(attestation, Object.freeze({
    session, target, bindingId, bindingDigest,
  }));
  return attestation;
}

export async function verifyTrustedChromeHostStillCurrent(attestation, rawTarget) {
  if (!isTrustedChromeHostAttestation(attestation)) {
    fail("trusted host verification requires a process-minted attestation");
  }
  const internal = HOST_INTERNAL.get(attestation);
  if (!internal || !isExistingChromeReadSession(internal.session)) {
    fail("trusted host attestation lost its existing Chrome session binding");
  }
  const target = assertHostTarget(rawTarget);
  if (scopeDigest(target) !== attestation.scope_digest
      || scopeDigest(target) !== scopeDigest(internal.target)) {
    fail("trusted host scope changed after attestation");
  }
  const observed = await observeStablePair(internal.session, target);
  const bindingDigest = documentBindingDigest(internal.bindingId, target, observed);
  if (bindingDigest !== internal.bindingDigest
      || bindingDigest !== attestation.document_binding_digest) {
    fail("trusted document, epoch, frame, or runtime binding changed after attestation");
  }
  return attestation;
}

export async function readTrustedChromeAccessibleSnapshot(attestation, rawTarget) {
  await verifyTrustedChromeHostStillCurrent(attestation, rawTarget);
  const internal = HOST_INTERNAL.get(attestation);
  if (!internal || !isExistingChromeReadSession(internal.session)) {
    fail("trusted host snapshot read lost its existing Chrome session binding");
  }
  if (typeof internal.session.readAccessibleSnapshot !== "function") {
    fail("trusted Chrome read session has no accessible snapshot surface");
  }
  const snapshot = await internal.session.readAccessibleSnapshot(rawTarget);
  await verifyTrustedChromeHostStillCurrent(attestation, rawTarget);
  return snapshot;
}

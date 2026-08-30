/**
 * Production-only registry for versioned FB / IG / Threads scan adapters.
 *
 * This module intentionally contains no fixture selectors, fixture factory, or
 * caller-injectable adapter registration hook. A live plan can only exist
 * after a trusted host resolver and an authenticated canary revision are wired
 * here in source. Until then every production factory call fails closed.
 */

import {
  fail,
  immutableJsonSnapshot,
  requiredString,
} from "./comment_chrome_common.mjs";
import {
  resolveTrustedChromeHost,
  trustedChromeHostResolverDescriptor,
  verifyTrustedChromeHostStillCurrent,
} from "./comment_chrome_host_authority.mjs";
import {
  stableNodeFrameMappingContractDescriptor,
} from "./comment_chrome_node_frame_mapping.mjs";

export const SCAN_ADAPTER_SCHEMA_VERSION = 1;
export const EXPANSION_EXHAUSTION_SCHEMA_VERSION = 1;

const TRUSTED_LIVE_SCAN_PLANS = new WeakSet();
const TRUSTED_LIVE_EXPANSION_ATTESTATIONS = new WeakSet();

// No selector or resolver is registered by default. Fixture data deliberately
// lives in comment_chrome_scan_fixture_testonly.mjs and is absent from this
// production import graph.
const LIVE_ADAPTERS = immutableJsonSnapshot({
  facebook: {
    status: "unavailable_pending_authenticated_canary_and_live_locator_revision",
    adapter: null,
  },
  instagram: {
    status: "unavailable_pending_authenticated_canary_and_live_locator_revision",
    adapter: null,
  },
  threads: {
    status: "unavailable_pending_authenticated_canary_and_live_locator_revision",
    adapter: null,
  },
}, "live scan adapter registry");

function knownPlatform(platform) {
  const key = requiredString(platform, "scan adapter platform");
  if (!Object.prototype.hasOwnProperty.call(LIVE_ADAPTERS, key)) {
    fail(`no registered scan adapter platform ${key}`);
  }
  return key;
}

export function trustedPlatformAdapterVersions() {
  return immutableJsonSnapshot(Object.fromEntries(
    Object.keys(LIVE_ADAPTERS).map((platform) => [
      platform, {
        live_status: LIVE_ADAPTERS[platform].status,
        live: null,
        trusted_host_resolver: trustedChromeHostResolverDescriptor(),
        stable_node_frame_mapping: stableNodeFrameMappingContractDescriptor(platform),
      },
    ]),
  ), "production scan adapter versions");
}

/**
 * Resolve and immediately re-verify a source-wired host/document authority.
 *
 * This is deliberately only a read-only probe. The returned process-branded
 * attestation cannot scan, expand, fill, click, or mint a live scan plan.
 */
export async function probeTrustedPlatformHost(rawRequest) {
  knownPlatform(rawRequest?.platform);
  const attestation = await resolveTrustedChromeHost(rawRequest);
  await verifyTrustedChromeHostStillCurrent(attestation, rawRequest);
  return attestation;
}

export function createTrustedPlatformScanPlan(platform, { adapterVersion } = {}) {
  const key = knownPlatform(platform);
  if (adapterVersion !== undefined) {
    requiredString(adapterVersion, "scan adapter version");
  }
  // Deliberately do not accept a tab, resolver, selector plan, or caller
  // callback here. That prevents an untrusted fake tab from minting the plan
  // or the later exhaustion attestation.
  fail(`no authenticated-canary-verified live ${key} locator revision is available`);
}

export function isTrustedPlatformScanPlan(plan) {
  return Boolean(plan && typeof plan === "object"
    && TRUSTED_LIVE_SCAN_PLANS.has(plan));
}

export function requireTrustedPlatformScanPlan(plan, platform, { testOnly = false } = {}) {
  knownPlatform(platform);
  if (testOnly === true) {
    fail("production scan plans cannot mint test-only fixture receipts");
  }
  if (!isTrustedPlatformScanPlan(plan)) {
    fail("live scan requires a source-registered trusted-host-resolved platform plan");
  }
  // Unreachable while all registrations are unavailable. A future live adapter
  // must add exact revision and resolver-binding checks here in source.
  fail("live scan plan verification is unavailable pending authenticated canary integration");
}

export async function attestTrustedPlatformExpansion(
  _tab, plan, platform, options = {},
) {
  requireTrustedPlatformScanPlan(plan, platform, options);
  fail("live expansion attestation is unavailable pending authenticated canary integration");
}

export async function verifyTrustedExpansionStillComplete(
  _tab, plan, platform, attestation, options = {},
) {
  requireTrustedPlatformScanPlan(plan, platform, options);
  if (!attestation || typeof attestation !== "object"
      || !TRUSTED_LIVE_EXPANSION_ATTESTATIONS.has(attestation)) {
    fail("live expansion verification requires a production-minted attestation");
  }
  fail("live expansion verification is unavailable pending authenticated canary integration");
}

export function isTrustedExpansionAttestation(attestation) {
  return Boolean(attestation && typeof attestation === "object"
    && TRUSTED_LIVE_EXPANSION_ATTESTATIONS.has(attestation));
}

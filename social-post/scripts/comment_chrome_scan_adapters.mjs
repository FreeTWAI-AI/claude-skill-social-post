/**
 * Production-only registry for versioned FB / IG / Threads scan adapters.
 *
 * This module intentionally contains no fixture selectors, fixture factory, or
 * caller-injectable adapter registration hook. A live plan can only exist
 * after a trusted host resolver and an authenticated canary revision are wired
 * here in source. Until then every production factory call fails closed.
 */

import {
  digestObject,
  fail,
  immutableJsonSnapshot,
  nowIso,
  requiredString,
} from "./comment_chrome_common.mjs";
import {
  resolveTrustedChromeHost,
  trustedChromeHostResolverDescriptor,
  verifyTrustedChromeHostStillCurrent,
} from "./comment_chrome_host_authority.mjs";
import {
  captureChromeAccessibleSnapshotPair,
} from "./comment_chrome_runtime_authority.mjs";
import {
  stableNodeFrameMappingContractDescriptor,
} from "./comment_chrome_node_frame_mapping.mjs";
import {
  META_SNAPSHOT_ADAPTER_VERSION,
  parseMetaCommentSnapshot,
} from "./comment_meta_snapshot_parser.mjs";

export const SCAN_ADAPTER_SCHEMA_VERSION = 1;
export const EXPANSION_EXHAUSTION_SCHEMA_VERSION = 1;

const TRUSTED_LIVE_SCAN_PLANS = new WeakSet();
const TRUSTED_LIVE_EXPANSION_ATTESTATIONS = new WeakSet();

// No selector or resolver is registered by default. Fixture data deliberately
// lives in comment_chrome_scan_fixture_testonly.mjs and is absent from this
// production import graph.
const LIVE_ADAPTERS = immutableJsonSnapshot({
  facebook: {
    status: "source_wired_accessibility_snapshot_permalink_identity",
    adapter: { id: "meta-accessibility-snapshot", version: META_SNAPSHOT_ADAPTER_VERSION },
  },
  instagram: {
    status: "source_wired_accessibility_snapshot_permalink_identity",
    adapter: { id: "meta-accessibility-snapshot", version: META_SNAPSHOT_ADAPTER_VERSION },
  },
  threads: {
    status: "source_wired_accessibility_snapshot_permalink_identity",
    adapter: { id: "meta-accessibility-snapshot", version: META_SNAPSHOT_ADAPTER_VERSION },
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
        live: LIVE_ADAPTERS[platform].adapter,
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

export function createTrustedPlatformScanPlan(platform, options = {}) {
  const key = knownPlatform(platform);
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("scan adapter options must be an object");
  }
  const unknown = Object.keys(options).filter((name) => name !== "adapterVersion");
  if (unknown.length) fail(`live scan adapter rejects caller authority input ${unknown[0]}`);
  const { adapterVersion } = options;
  const expected = LIVE_ADAPTERS[key].adapter?.version;
  if (!expected) fail(`no source-wired live ${key} scan adapter is available`);
  if (adapterVersion !== undefined
      && requiredString(adapterVersion, "scan adapter version") !== expected) {
    fail(`live ${key} scan adapter version differs from source registration`);
  }
  const plan = immutableJsonSnapshot({
    schema_version: SCAN_ADAPTER_SCHEMA_VERSION,
    platform: key,
    adapter_id: LIVE_ADAPTERS[key].adapter.id,
    adapter_version: expected,
    identity: "platform comment/reply permalink",
    snapshot_surface: "bundled Chrome accessibility snapshot",
  }, `${key} trusted live scan plan`);
  TRUSTED_LIVE_SCAN_PLANS.add(plan);
  return plan;
}

export function isTrustedPlatformScanPlan(plan) {
  return Boolean(plan && typeof plan === "object"
    && TRUSTED_LIVE_SCAN_PLANS.has(plan));
}

export function requireTrustedPlatformScanPlan(plan, platform, { testOnly = false } = {}) {
  const key = knownPlatform(platform);
  if (testOnly === true) {
    fail("production scan plans cannot mint test-only fixture receipts");
  }
  if (!isTrustedPlatformScanPlan(plan)) {
    fail("live scan requires a source-registered trusted-host-resolved platform plan");
  }
  const expected = LIVE_ADAPTERS[key].adapter;
  if (!expected || plan.platform !== key || plan.adapter_id !== expected.id
      || plan.adapter_version !== expected.version) {
    fail("live scan plan is stale or belongs to another platform adapter");
  }
  return plan;
}

function liveEvidence(platform, plan, commentCount, parsedDigest) {
  const exhaustionCore = {
    schema_version: 1,
    platform,
    test_only: false,
    adapter_id: plan.adapter_id,
    adapter_version: plan.adapter_version,
    terminal_evidence: true,
    terminal_discovered_count: commentCount,
    stable_read_count: 2,
    snapshot_digest: parsedDigest,
  };
  const expansion = Object.freeze({
    ...exhaustionCore,
    attestation_id: digestObject(exhaustionCore, "live expansion attestation"),
  });
  const mappingCore = {
    schema_version: 1,
    platform,
    test_only: false,
    adapter_id: plan.adapter_id,
    adapter_version: plan.adapter_version,
    row_count: commentCount,
    stable_read_count: 2,
    full_lifecycle_bound: false,
    coverage: "final_scan_permalink_accessibility_snapshot",
    reply_exhaustion_sha256: digestObject(expansion, "live reply exhaustion evidence"),
    snapshot_digest: parsedDigest,
  };
  return {
    expansion,
    mapping: Object.freeze({
      ...mappingCore,
      mapping_attestation_id: digestObject(mappingCore, "live node frame mapping"),
    }),
  };
}

export async function scanTrustedPlatformSnapshot(rawRequest, rawPlan, { clock, maxComments = 50 } = {}) {
  const platform = knownPlatform(rawRequest?.platform);
  const plan = requireTrustedPlatformScanPlan(rawPlan, platform, { testOnly: false });
  if (!Number.isInteger(maxComments) || maxComments < 0) {
    fail("live snapshot maxComments must be a non-negative integer");
  }
  const capture = await captureChromeAccessibleSnapshotPair(rawRequest);
  const first = parseMetaCommentSnapshot(platform, capture.first_snapshot, rawRequest);
  const second = parseMetaCommentSnapshot(platform, capture.second_snapshot, rawRequest);
  const firstDigest = digestObject(first, `${platform} first accessible snapshot parse`);
  const secondDigest = digestObject(second, `${platform} second accessible snapshot parse`);
  if (firstDigest !== secondDigest) {
    fail(`${platform} comment evidence changed between stable accessibility reads`);
  }
  if (first.comments.length > maxComments) {
    fail(`${platform} scan found ${first.comments.length} comments, exceeding maxComments=${maxComments}`);
  }
  const evidence = liveEvidence(platform, plan, first.comments.length, firstDigest);
  return immutableJsonSnapshot({
    schema_version: 1,
    test_only: false,
    scan_request_id: rawRequest.scan_request_id,
    session_id: rawRequest.session_id,
    platform,
    account_key: rawRequest.account_key,
    post_key: rawRequest.post_key,
    post_permalink: rawRequest.post_permalink,
    observed_url: capture.observed_url,
    observed_at: nowIso(clock),
    authentication_state: "authenticated",
    account_verified: true,
    post_verified: true,
    comments: first.comments,
    thread_expansion_evidence: {
      provided: true,
      comments_expanded: first.comments_expanded,
      replies_expanded: first.replies_expanded,
      evidence: first.evidence,
      adapter_attestation: evidence.expansion,
    },
    stable_node_frame_mapping_evidence: evidence.mapping,
    chrome_runtime_evidence: capture.runtime,
  }, `${platform} live browser scan receipt`);
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

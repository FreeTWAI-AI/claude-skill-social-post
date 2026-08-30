/**
 * Production-safe contract descriptor for stable comment frame/node mapping.
 *
 * This module validates platform identity and exposes immutable capability
 * metadata only. Fixture DOM readers, process brands, and attestations live in
 * an explicitly test-only module that production code never imports.
 */

import {
  fail,
  immutableJsonSnapshot,
  requiredString,
} from "./comment_chrome_common.mjs";

export const STABLE_NODE_FRAME_MAPPING_SCHEMA_VERSION = 1;

const PLATFORM_IDENTITY_KIND = Object.freeze({
  facebook: "comment",
  instagram: "comment",
  threads: "reply",
});

function knownPlatform(platform) {
  const key = requiredString(platform, "node/frame mapping platform");
  if (!Object.hasOwn(PLATFORM_IDENTITY_KIND, key)) {
    fail(`unsupported node/frame mapping platform ${key}`);
  }
  return key;
}

export function stableNodeFrameMappingContractDescriptor(platform) {
  const key = knownPlatform(platform);
  return immutableJsonSnapshot({
    schema_version: STABLE_NODE_FRAME_MAPPING_SCHEMA_VERSION,
    platform: key,
    identity_kind: PLATFORM_IDENTITY_KIND[key],
    status: "offline_contract_ready_live_native_frame_owner_unavailable",
    coverage: "test_only_final_scan_comment_nodes",
    full_lifecycle_bound: false,
    live_plan_minting: false,
    fail_closed: true,
  }, `${key} stable node/frame mapping descriptor`);
}


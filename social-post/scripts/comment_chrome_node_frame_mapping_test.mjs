import assert from "node:assert/strict";

import {
  captureTestOnlyNodeFrameMapping,
  isTrustedTestOnlyNodeFrameMapping,
  verifyTestOnlyNodeFrameMappingStillCurrent,
} from "./comment_chrome_node_frame_mapping_testonly.mjs";
import {
  deepFreeze,
  fixture,
  TEST_OPTIONS,
} from "./comment_chrome_node_frame_mapping_fixture_testonly.mjs";
async function assertPositivePlatform(platform) {
  const sample = fixture(platform);
  const mapping = await captureTestOnlyNodeFrameMapping(
    sample.tab, sample.plan, platform, TEST_OPTIONS,
  );
  assert.equal(isTrustedTestOnlyNodeFrameMapping(mapping), true);
  assert.equal(mapping.platform, platform);
  assert.equal(mapping.row_count, 2);
  assert.equal(mapping.stable_read_count, 2);
  assert.equal(await verifyTestOnlyNodeFrameMappingStillCurrent(
    sample.tab, sample.plan, platform, mapping, TEST_OPTIONS,
  ), true);
  await assert.rejects(
    () => verifyTestOnlyNodeFrameMappingStillCurrent(
      sample.tab, sample.plan, platform, structuredClone(mapping), TEST_OPTIONS,
    ),
    /process-branded test-only attestation/u,
  );
}

async function assertReorderFailsClosed() {
  const sample = fixture("facebook");
  const mapping = await captureTestOnlyNodeFrameMapping(
    sample.tab, sample.plan, "facebook", TEST_OPTIONS,
  );
  sample.page.selectors[sample.plan.comments.selector].reverse();
  await assert.rejects(
    () => verifyTestOnlyNodeFrameMappingStillCurrent(
      sample.tab, sample.plan, "facebook", mapping, TEST_OPTIONS,
    ),
    /stale, reordered, rerendered, or cross-platform/u,
  );
}

async function assertRerenderFailsClosed() {
  const sample = fixture("instagram");
  const mapping = await captureTestOnlyNodeFrameMapping(
    sample.tab, sample.plan, "instagram", TEST_OPTIONS,
  );
  sample.page.nodes[sample.first.key].attributes["data-fixture-node-id"] = "replacement-node";
  sample.page.nodes[sample.first.body].attributes["data-fixture-node-id"] = "replacement-body";
  await assert.rejects(
    () => verifyTestOnlyNodeFrameMappingStillCurrent(
      sample.tab, sample.plan, "instagram", mapping, TEST_OPTIONS,
    ),
    /stale, reordered, rerendered, or cross-platform/u,
  );
}

async function assertDuplicateAndReplyExhaustionFailClosed() {
  const duplicate = fixture("threads", { duplicate: true });
  await assert.rejects(
    () => captureTestOnlyNodeFrameMapping(
      duplicate.tab, duplicate.plan, "threads", TEST_OPTIONS,
    ),
    /duplicate comment identity/u,
  );
  const partial = fixture("threads");
  partial.page.nodes[partial.first.exhaustion].attributes["data-reply-terminal"] = "false";
  await assert.rejects(
    () => captureTestOnlyNodeFrameMapping(
      partial.tab, partial.plan, "threads", TEST_OPTIONS,
    ),
    /must be terminal/u,
  );
  partial.page.nodes[partial.first.exhaustion].attributes["data-reply-terminal"] = "true";
  partial.page.nodes[partial.first.exhaustion].attributes["data-reply-discovered-count"] = "1";
  await assert.rejects(
    () => captureTestOnlyNodeFrameMapping(
      partial.tab, partial.plan, "threads", TEST_OPTIONS,
    ),
    /does not match inspectable replies/u,
  );
  const collision = fixture("threads");
  collision.page.nodes[collision.first.author].attributes["data-fixture-node-id"] =
    collision.page.nodes[collision.first.key].attributes["data-fixture-node-id"];
  await assert.rejects(
    () => captureTestOnlyNodeFrameMapping(
      collision.tab, collision.plan, "threads", TEST_OPTIONS,
    ),
    /node id role collision/u,
  );
}

async function assertFrameAndCrossPlatformFailClosed() {
  const sample = fixture("facebook");
  const mapping = await captureTestOnlyNodeFrameMapping(
    sample.tab, sample.plan, "facebook", TEST_OPTIONS,
  );
  sample.page.nodes.root.attributes["data-fixture-document-epoch"] = "facebook-epoch-2";
  await assert.rejects(
    () => verifyTestOnlyNodeFrameMappingStillCurrent(
      sample.tab, sample.plan, "facebook", mapping, TEST_OPTIONS,
    ),
    /stale, reordered, rerendered, or cross-platform/u,
  );
  const instagram = fixture("instagram");
  await assert.rejects(
    () => verifyTestOnlyNodeFrameMappingStillCurrent(
      instagram.tab, instagram.plan, "instagram", mapping, TEST_OPTIONS,
    ),
    /stale, reordered, rerendered, or cross-platform/u,
  );
  await assert.rejects(
    () => captureTestOnlyNodeFrameMapping(
      instagram.tab, instagram.plan, "instagram", {},
    ),
    /requires testOnly=true/u,
  );
  const forged = structuredClone(instagram.plan);
  forged.nodeFrameMapping.stableReadDelayMs = 60_000;
  deepFreeze(forged);
  await assert.rejects(
    () => captureTestOnlyNodeFrameMapping(
      instagram.tab, forged, "instagram", TEST_OPTIONS,
    ),
    /stableReadDelayMs must be an integer from 0 to 1000/u,
  );
}

export async function testStableNodeFrameMapping() {
  for (const platform of ["facebook", "instagram", "threads"]) {
    await assertPositivePlatform(platform);
  }
  await assertReorderFailsClosed();
  await assertRerenderFailsClosed();
  await assertDuplicateAndReplyExhaustionFailClosed();
  await assertFrameAndCrossPlatformFailClosed();
}

import assert from "node:assert/strict";

import { testScan } from "./comment_chrome_actuator_scan_test.mjs";
import {
  testClaimCannotMutateActionOrPlan,
  testClickTimeoutKeepsProcessReservation,
  testContentEditableComposerWithInjectedValueProperty,
  testComposerMutationDuringFinalScanIsBlocked,
  testFreshClickContextAfterFinalScan,
  testMissingStableNodeSurfaceFailsBeforeClaim,
  testOptionsCannotEscalateAcrossClaim,
  testPrepareSnapshotsInputs,
  testReplyAppendDuringFinalScanIsBlocked,
  testReplyAppearsBetweenPreparationAndClaim,
  testSafeSend,
  testStableNodeReplacementAtClickCannotRetarget,
  testStableNodeReplacementBetweenSnapshotsIsBlocked,
} from "./comment_chrome_actuator_send_test.mjs";
import { testGuards } from "./comment_chrome_actuator_guards_test.mjs";
import {
  testDelayedReplyRequiresFreshReinspection,
  testLiveReceiptsUseFusedCommitClosure,
} from "./comment_chrome_actuator_receipts_test.mjs";
import {
  testReplyThreadExhaustionAuthority,
} from "./comment_chrome_actuator_reply_exhaustion_test.mjs";
import {
  testReinspectionCompleteness,
} from "./comment_chrome_actuator_reinspection_test.mjs";
import {
  testThreePlatformFixtureContract,
} from "./comment_chrome_fixture_contract_test.mjs";
import {
  testStableNodeFrameMapping,
} from "./comment_chrome_node_frame_mapping_test.mjs";
import {
  testTestOnlyFullLifecycleNodeFrameMapping,
} from "./comment_chrome_node_frame_lifecycle_test.mjs";

const EXPECTED_TEST_ORDER = Object.freeze([
  "testScan",
  "testPrepareSnapshotsInputs",
  "testSafeSend",
  "testContentEditableComposerWithInjectedValueProperty",
  "testLiveReceiptsUseFusedCommitClosure",
  "testReplyThreadExhaustionAuthority",
  "testReplyAppearsBetweenPreparationAndClaim",
  "testClaimCannotMutateActionOrPlan",
  "testOptionsCannotEscalateAcrossClaim",
  "testReplyAppendDuringFinalScanIsBlocked",
  "testComposerMutationDuringFinalScanIsBlocked",
  "testFreshClickContextAfterFinalScan",
  "testStableNodeReplacementBetweenSnapshotsIsBlocked",
  "testStableNodeReplacementAtClickCannotRetarget",
  "testClickTimeoutKeepsProcessReservation",
  "testMissingStableNodeSurfaceFailsBeforeClaim",
  "testGuards",
  "testDelayedReplyRequiresFreshReinspection",
  "testReinspectionCompleteness",
  "testThreePlatformFixtureContract",
  "testStableNodeFrameMapping",
  "testTestOnlyFullLifecycleNodeFrameMapping",
]);

const TEST_MANIFEST = Object.freeze([
  Object.freeze(["testScan", testScan]),
  Object.freeze(["testPrepareSnapshotsInputs", testPrepareSnapshotsInputs]),
  Object.freeze(["testSafeSend", testSafeSend]),
  Object.freeze([
    "testContentEditableComposerWithInjectedValueProperty",
    testContentEditableComposerWithInjectedValueProperty,
  ]),
  Object.freeze(["testLiveReceiptsUseFusedCommitClosure", testLiveReceiptsUseFusedCommitClosure]),
  Object.freeze(["testReplyThreadExhaustionAuthority", testReplyThreadExhaustionAuthority]),
  Object.freeze(["testReplyAppearsBetweenPreparationAndClaim", testReplyAppearsBetweenPreparationAndClaim]),
  Object.freeze(["testClaimCannotMutateActionOrPlan", testClaimCannotMutateActionOrPlan]),
  Object.freeze(["testOptionsCannotEscalateAcrossClaim", testOptionsCannotEscalateAcrossClaim]),
  Object.freeze(["testReplyAppendDuringFinalScanIsBlocked", testReplyAppendDuringFinalScanIsBlocked]),
  Object.freeze(["testComposerMutationDuringFinalScanIsBlocked", testComposerMutationDuringFinalScanIsBlocked]),
  Object.freeze(["testFreshClickContextAfterFinalScan", testFreshClickContextAfterFinalScan]),
  Object.freeze(["testStableNodeReplacementBetweenSnapshotsIsBlocked", testStableNodeReplacementBetweenSnapshotsIsBlocked]),
  Object.freeze(["testStableNodeReplacementAtClickCannotRetarget", testStableNodeReplacementAtClickCannotRetarget]),
  Object.freeze(["testClickTimeoutKeepsProcessReservation", testClickTimeoutKeepsProcessReservation]),
  Object.freeze(["testMissingStableNodeSurfaceFailsBeforeClaim", testMissingStableNodeSurfaceFailsBeforeClaim]),
  Object.freeze(["testGuards", testGuards]),
  Object.freeze(["testDelayedReplyRequiresFreshReinspection", testDelayedReplyRequiresFreshReinspection]),
  Object.freeze(["testReinspectionCompleteness", testReinspectionCompleteness]),
  Object.freeze(["testThreePlatformFixtureContract", testThreePlatformFixtureContract]),
  Object.freeze(["testStableNodeFrameMapping", testStableNodeFrameMapping]),
  Object.freeze([
    "testTestOnlyFullLifecycleNodeFrameMapping",
    testTestOnlyFullLifecycleNodeFrameMapping,
  ]),
]);

assert.equal(EXPECTED_TEST_ORDER.length, 22, "actuator test order must contain 22 entries");
assert.equal(TEST_MANIFEST.length, 22, "actuator test manifest must contain 22 entries");
assert.equal(Object.isFrozen(TEST_MANIFEST), true, "actuator test manifest must be frozen");
assert.deepEqual(
  TEST_MANIFEST.map(([name]) => name),
  EXPECTED_TEST_ORDER,
  "actuator test manifest names or order changed",
);
for (const entry of TEST_MANIFEST) {
  const [name, test] = entry;
  assert.equal(Object.isFrozen(entry), true, `actuator test entry ${name} must be frozen`);
  assert.equal(typeof test, "function", `actuator test ${name} must be callable`);
  assert.equal(test.name, name, `actuator test binding ${name} points to the wrong function`);
}

for (const [, test] of TEST_MANIFEST) await test();
console.log("comment Chrome actuator test passed");

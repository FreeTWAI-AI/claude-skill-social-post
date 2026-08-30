import assert from "node:assert/strict";

import { createCommentChromeActuator } from "./comment_chrome_actuator.mjs";
import { sha256Text } from "./comment_chrome_common.mjs";
import {
  actionFor, addReply, createClaimStore, fixedClock, fixture, mustReject,
  optionsFor, plan,
} from "./comment_chrome_actuator_fixture_test.mjs";

export async function testPrepareSnapshotsInputs() {
  const mutableAction = actionFor("prepare-snapshot");
  const approvedReplyHash = mutableAction.reply_hash;
  const mutablePlan = structuredClone(plan);
  const mutableOptions = optionsFor(mutableAction);
  const { page, tab } = fixture();
  const approvedLiveUrl = mutableAction.post_permalink;
  const openComposer = page.nodes["reply-trigger"].onClick;
  page.nodes["reply-trigger"].onClick = () => {
    openComposer();
    mutableAction.reply_text = "準備期間遭竄改";
    mutablePlan.submit.selector = ".mutated-submit";
    mutableOptions.testOnly = false;
    mutableOptions.receiptObservedUrl = "https://evil.example/post";
    page.url = approvedLiveUrl;
  };
  const preparation = await createCommentChromeActuator({ clock: fixedClock }).prepareReply(
    tab, mutableAction, mutablePlan, mutableOptions,
  );
  assert.equal(mutableAction.reply_text, "準備期間遭竄改");
  assert.equal(mutablePlan.submit.selector, ".mutated-submit");
  assert.equal(preparation.reply_hash, approvedReplyHash);
  assert.equal(preparation.test_only, true);
  assert.equal(preparation.observed_url, approvedLiveUrl);
}

export async function testSafeSend() {
  const action = actionFor("safe");
  const { page, tab } = fixture();
  const store = createClaimStore();
  const actor = createCommentChromeActuator({ clock: fixedClock, claimSubmit: store.claimSubmit });
  const options = optionsFor(action);
  const preparation = await actor.prepareReply(tab, action, plan, options);
  assert.equal(preparation.baseline_exact_reply_count, 0);
  const [first, second] = await Promise.allSettled([
    actor.submitOnce(tab, action, plan, preparation, options),
    actor.submitOnce(tab, action, plan, preparation, options),
  ]);
  assert.equal([first, second].filter((row) => row.status === "fulfilled").length, 1);
  assert.equal(page.nodes.submit.clicks, 1);
  assert.equal(typeof page.lastDomCuaClickNodeId, "string");
  const attempt = [first, second].find((row) => row.status === "fulfilled").value;
  assert.equal(attempt.test_only, true);
  const result = await actor.inspectResult(
    tab, action, plan, attempt, preparation, options,
  );
  assert.equal(result.exact_reply_visible, true);
  addReply(page);
  const duplicate = await actor.inspectResult(
    tab, action, plan, attempt, preparation, options,
  );
  assert.equal(duplicate.exact_reply_visible, false);
  await mustReject(
    () => createCommentChromeActuator({ claimSubmit: store.claimSubmit })
      .submitOnce(tab, action, plan, preparation, options),
    /second in-process|durable claim already consumed|composer changed before the durable claim/,
  );
}

export async function testContentEditableComposerWithInjectedValueProperty() {
  const action = actionFor("contenteditable-composer");
  const { page, tab } = fixture({
    contentEditableComposer: true,
    crossRealmEvaluate: true,
  });
  const store = createClaimStore();
  const actor = createCommentChromeActuator({
    clock: fixedClock, claimSubmit: store.claimSubmit,
  });
  const options = optionsFor(action);
  const preparation = await actor.prepareReply(tab, action, plan, options);
  assert.equal(preparation.composer_matches_reply, true);
  assert.equal(page.nodes.composer.value, "");
  assert.equal(page.nodes.composer.text, action.reply_text);
  const attempt = await actor.submitOnce(tab, action, plan, preparation, options);
  const result = await actor.inspectResult(
    tab, action, plan, attempt, preparation, options,
  );
  assert.equal(result.exact_reply_visible, true);
  assert.equal(page.nodes.submit.clicks, 1);
}

export async function testReplyAppearsBetweenPreparationAndClaim() {
  const action = actionFor("claim-race");
  const { page, tab } = fixture();
  const actor = createCommentChromeActuator({
    clock: fixedClock,
    claimSubmit: async (request) => {
      await Promise.resolve();
      addReply(page);
      return {
        ...request, decision: "WRITE_OK", claim_id: "claim-race",
        preflight_id: "preflight-race",
      };
    },
  });
  const options = optionsFor(action);
  const preparation = await actor.prepareReply(tab, action, plan, options);
  const attempt = await actor.submitOnce(tab, action, plan, preparation, options);
  assert.equal(attempt.test_only, true);
  assert.equal(attempt.submission_attempted, false);
  assert.equal(attempt.submission_possible, false);
  assert.match(attempt.pre_click_error, /reply appeared after preparation/);
  assert.equal(page.nodes.submit.clicks ?? 0, 0);
  assert.equal(page.nodes.target.children[".reply"].length, 1);
}

export async function testClaimCannotMutateActionOrPlan() {
  const mutableAction = actionFor("claim-mutation");
  const mutablePlan = structuredClone(plan);
  const { page, tab } = fixture();
  page.nodes.target.children[".evil-submit"] = ["evil-submit"];
  page.nodes["evil-submit"] = { visible: true, enabled: true };
  const actor = createCommentChromeActuator({
    clock: fixedClock,
    claimSubmit: async (request) => {
      await Promise.resolve();
      mutableAction.reply_text = "被竄改的回覆";
      mutableAction.reply_hash = sha256Text(mutableAction.reply_text);
      mutablePlan.submit.selector = ".evil-submit";
      return {
        ...request, decision: "WRITE_OK", claim_id: "claim-mutation",
        preflight_id: "preflight-mutation",
      };
    },
  });
  const options = optionsFor(mutableAction);
  const preparation = await actor.prepareReply(
    tab, mutableAction, mutablePlan, options,
  );
  const attempt = await actor.submitOnce(
    tab, mutableAction, mutablePlan, preparation, options,
  );
  assert.equal(attempt.submission_attempted, true);
  assert.equal(mutableAction.reply_text, "被竄改的回覆");
  assert.equal(mutablePlan.submit.selector, ".evil-submit");
  assert.equal(page.nodes.submit.clicks, 1);
  assert.equal(page.nodes["evil-submit"].clicks ?? 0, 0);
  assert.equal(page.nodes.target.children[".reply"].length, 1);
}

export async function testOptionsCannotEscalateAcrossClaim() {
  const action = actionFor("options-escalation");
  const { page, tab } = fixture();
  const mutableOptions = optionsFor(action);
  const actor = createCommentChromeActuator({
    clock: fixedClock,
    claimSubmit: async (request) => {
      await Promise.resolve();
      mutableOptions.testOnly = false;
      mutableOptions.receiptObservedUrl = "https://evil.example/post";
      page.url = action.post_permalink;
      return {
        ...request, decision: "WRITE_OK", claim_id: "claim-options-escalation",
        preflight_id: "preflight-options-escalation",
      };
    },
  });
  const preparation = await actor.prepareReply(
    tab, action, plan, optionsFor(action),
  );
  const attempt = await actor.submitOnce(
    tab, action, plan, preparation, mutableOptions,
  );
  assert.equal(mutableOptions.testOnly, false);
  assert.equal(attempt.submission_attempted, false);
  assert.equal(attempt.submission_possible, false);
  assert.match(attempt.pre_click_error, /testOnly URL mapping is restricted to loopback hosts/);
  assert.equal(page.nodes.submit.clicks ?? 0, 0);
  assert.equal(page.nodes.target.children[".reply"].length, 0);
}

export async function testReplyAppendDuringFinalScanIsBlocked() {
  const action = actionFor("reply-scan-append");
  const { page, tab } = fixture();
  addReply(page, { body: "先前不同的回覆" });
  let armed = false;
  let appended = false;
  page.nodes["reply-body-1"].onTextContent = () => {
    if (!armed || appended) return;
    appended = true;
    addReply(page);
  };
  const actor = createCommentChromeActuator({
    clock: fixedClock,
    claimSubmit: async (request) => {
      armed = true;
      return {
        ...request, decision: "WRITE_OK", claim_id: "claim-reply-scan-append",
        preflight_id: "preflight-reply-scan-append",
      };
    },
  });
  const options = optionsFor(action);
  const preparation = await actor.prepareReply(tab, action, plan, options);
  assert.equal(preparation.baseline_total_reply_count, 1);
  const attempt = await actor.submitOnce(tab, action, plan, preparation, options);
  assert.equal(appended, true);
  assert.equal(attempt.submission_attempted, false);
  assert.equal(attempt.submission_possible, false);
  assert.match(
    attempt.pre_click_error,
    /reply evidence (?:count drifted|changed during stability verification)|reply exhaustion no longer has terminal complete coverage/,
  );
  assert.equal(page.nodes.submit.clicks ?? 0, 0);
  assert.equal(page.nodes.target.children[".reply"].length, 2);
}

export async function testComposerMutationDuringFinalScanIsBlocked() {
  const action = actionFor("composer-scan-mutation");
  const { page, tab } = fixture();
  addReply(page, { body: "先前不同的回覆" });
  let armed = false;
  page.nodes["reply-body-1"].onTextContent = () => {
    if (armed) page.nodes.composer.value = "掃描期間遭竄改";
  };
  const actor = createCommentChromeActuator({
    clock: fixedClock,
    claimSubmit: async (request) => {
      armed = true;
      return {
        ...request, decision: "WRITE_OK", claim_id: "claim-composer-scan-mutation",
        preflight_id: "preflight-composer-scan-mutation",
      };
    },
  });
  const options = optionsFor(action);
  const preparation = await actor.prepareReply(tab, action, plan, options);
  const attempt = await actor.submitOnce(tab, action, plan, preparation, options);
  assert.equal(attempt.submission_attempted, false);
  assert.equal(attempt.submission_possible, false);
  assert.match(attempt.pre_click_error, /composer changed during final reply verification/);
  assert.equal(page.nodes.submit.clicks ?? 0, 0);
  assert.equal(page.nodes.target.children[".reply"].length, 1);
}

export async function testFreshClickContextAfterFinalScan() {
  const scenarios = [
    {
      suffix: "url",
      mutate: (page) => { page.url = "https://evil.example/post"; },
      error: /testOnly URL mapping is restricted to loopback hosts/,
    },
    {
      suffix: "context",
      mutate: (page) => { page.nodes.body.text = "掃描期間遭竄改"; },
      error: /comment body evidence mismatch/,
    },
    {
      suffix: "submit",
      mutate: (page) => {
        page.nodes["replacement-submit"] = {
          visible: true, enabled: true, parent: "target",
          attributes: { "data-id": "comment-b" },
        };
        page.nodes.target.children[".submit"] = ["replacement-submit"];
      },
      error: /reply submit control belongs to anchored target "comment-b", not approved target "comment-a"/,
    },
  ];
  for (const scenario of scenarios) {
    const action = actionFor(`final-click-${scenario.suffix}`);
    const { page, tab } = fixture();
    const actor = createCommentChromeActuator({
      clock: fixedClock,
      claimSubmit: async (request) => {
        addReply(page, { body: "另一則回覆", author: "other-account" });
        page.nodes["reply-body-1"].onTextContent = () => {
          delete page.nodes["reply-body-1"].onTextContent;
          scenario.mutate(page);
        };
        return {
          ...request, decision: "WRITE_OK",
          claim_id: `claim-final-click-${scenario.suffix}`,
          preflight_id: `preflight-final-click-${scenario.suffix}`,
        };
      },
    });
    const options = optionsFor(action);
    const preparation = await actor.prepareReply(tab, action, plan, options);
    const attempt = await actor.submitOnce(tab, action, plan, preparation, options);
    assert.equal(attempt.submission_attempted, false);
    assert.equal(attempt.submission_possible, false);
    assert.match(attempt.pre_click_error, scenario.error);
    assert.equal(page.nodes.submit.clicks ?? 0, 0);
    assert.equal(page.nodes["replacement-submit"]?.clicks ?? 0, 0);
  }
}

function replaceSubmitWithSameVisibleIdentity(page) {
  const previous = page.nodes.submit;
  previous.connected = false;
  const replacement = {
    visible: true,
    enabled: true,
    parent: "target",
    tagName: previous.tagName,
    text: previous.text,
    attributes: structuredClone(previous.attributes ?? {}),
    onClick: previous.onClick,
  };
  page.nodes.submit = replacement;
  return { previous, replacement };
}

export async function testStableNodeReplacementBetweenSnapshotsIsBlocked() {
  const action = actionFor("stable-node-snapshot-replacement");
  const { page, tab } = fixture();
  const store = createClaimStore();
  let claimCalls = 0;
  const claimSubmit = async (request) => {
    claimCalls += 1;
    return store.claimSubmit(request);
  };
  const actor = createCommentChromeActuator({
    clock: fixedClock, claimSubmit,
  });
  const options = optionsFor(action);
  const preparation = await actor.prepareReply(tab, action, plan, options);
  let rows;
  page.onDomCuaSnapshot = (call) => {
    if (call === 2) rows = replaceSubmitWithSameVisibleIdentity(page);
  };
  const attempt = await actor.submitOnce(tab, action, plan, preparation, options);
  assert.equal(attempt.submission_attempted, false);
  assert.equal(attempt.submission_possible, false);
  assert.match(attempt.pre_click_error, /stable submit node_id changed/);
  assert.equal(page.domCuaClickCalls, 0);
  assert.equal(rows.previous.clicks ?? 0, 0);
  assert.equal(rows.replacement.clicks ?? 0, 0);
  assert.equal(page.nodes.target.children[".reply"].length, 0);
  await mustReject(
    () => createCommentChromeActuator({
      clock: fixedClock, claimSubmit,
    }).submitOnce(tab, action, plan, preparation, options),
    /durable claim already consumed/,
  );
  assert.equal(claimCalls, 2);
  assert.equal(page.nodes.target.children[".reply"].length, 0);
}

export async function testStableNodeReplacementAtClickCannotRetarget() {
  const action = actionFor("stable-node-click-replacement");
  const { page, tab } = fixture();
  const store = createClaimStore();
  const actor = createCommentChromeActuator({
    clock: fixedClock, claimSubmit: store.claimSubmit,
  });
  const options = optionsFor(action);
  const preparation = await actor.prepareReply(tab, action, plan, options);
  let rows;
  page.onDomCuaBeforeClick = () => {
    rows = replaceSubmitWithSameVisibleIdentity(page);
  };
  const attempt = await actor.submitOnce(tab, action, plan, preparation, options);
  assert.equal(attempt.submission_attempted, true);
  assert.equal(attempt.submission_possible, true);
  assert.match(attempt.click_error, /DOM node \S+ is stale or missing/);
  assert.equal(page.domCuaClickCalls, 1);
  assert.equal(rows.previous.clicks ?? 0, 0);
  assert.equal(rows.replacement.clicks ?? 0, 0);
  assert.equal(page.nodes.target.children[".reply"].length, 0);
  await mustReject(
    () => createCommentChromeActuator({
      clock: fixedClock, claimSubmit: store.claimSubmit,
    }).submitOnce(tab, action, plan, preparation, options),
    /second in-process submit attempt/,
  );
}

export async function testClickTimeoutKeepsProcessReservation() {
  const action = actionFor("stable-node-click-timeout");
  const { page, tab } = fixture();
  const store = createClaimStore();
  const actor = createCommentChromeActuator({
    clock: fixedClock, claimSubmit: store.claimSubmit,
  });
  const options = optionsFor(action);
  const preparation = await actor.prepareReply(tab, action, plan, options);
  page.onDomCuaBeforeClick = () => {
    throw new Error("synthetic click dispatch timeout");
  };
  const attempt = await actor.submitOnce(tab, action, plan, preparation, options);
  assert.equal(attempt.submission_attempted, true);
  assert.equal(attempt.submission_possible, true);
  assert.match(attempt.click_error, /synthetic click dispatch timeout/);
  assert.equal(page.domCuaClickCalls, 1);
  await mustReject(
    () => createCommentChromeActuator({
      clock: fixedClock, claimSubmit: store.claimSubmit,
    }).submitOnce(tab, action, plan, preparation, options),
    /second in-process submit attempt/,
  );
}

export async function testMissingStableNodeSurfaceFailsBeforeClaim() {
  const action = actionFor("missing-stable-node-surface");
  const { page, tab } = fixture();
  const store = createClaimStore();
  const actor = createCommentChromeActuator({
    clock: fixedClock, claimSubmit: store.claimSubmit,
  });
  const options = optionsFor(action);
  const preparation = await actor.prepareReply(tab, action, plan, options);
  delete tab.dom_cua;
  await mustReject(
    () => actor.submitOnce(tab, action, plan, preparation, options),
    /requires the Browser DOM-CUA stable-node surface/,
  );
  assert.equal(store.claimed.size, 0);
  assert.equal(page.nodes.submit.clicks ?? 0, 0);
}

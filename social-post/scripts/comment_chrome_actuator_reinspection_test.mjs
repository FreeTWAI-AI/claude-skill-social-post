import assert from "node:assert/strict";

import { createCommentChromeActuator } from "./comment_chrome_actuator.mjs";
import {
  actionFor, addReply, fixture, mustReject, optionsFor, plan,
} from "./comment_chrome_actuator_fixture_test.mjs";

export async function testReinspectionCompleteness() {
  const action = actionFor("reinspect");
  const options = optionsFor(action);
  const empty = fixture();
  const actor = createCommentChromeActuator();
  const preparation = await actor.prepareReply(empty.tab, action, plan, options);
  const attempt = {
    action_id: action.action_id, claim_id: "claim-reinspect",
    preflight_id: "preflight-reinspect", preparation_id: preparation.preparation_id,
  };
  const absent = await actor.reinspect(
    empty.tab, action, plan, attempt, action.session_id, "session-r2",
    preparation, options,
  );
  assert.equal(absent.absence_verified, true);
  assert.equal(absent.reinspection_total_reply_count, 0);
  addReply(empty.page, { body: "下一集就會揭曉" });
  const normalizedByPlatform = await actor.reinspect(
    empty.tab, action, plan, attempt, action.session_id, "session-r3",
    preparation, options,
  );
  assert.equal(normalizedByPlatform.exact_reply_visible, false);
  assert.equal(normalizedByPlatform.absence_verified, false);
  assert.equal(normalizedByPlatform.own_author_reply_count, 1);
  assert.equal(normalizedByPlatform.reinspection_total_reply_count, 1);
  assert.match(
    normalizedByPlatform.evidence,
    /own-account replies but no exact approved text/,
  );
  const virtualizedAction = actionFor("virtualized-reinspection");
  const virtualizedOptions = optionsFor(virtualizedAction);
  const virtualized = fixture();
  addReply(virtualized.page, { body: "先前不同的回覆" });
  const virtualizedActor = createCommentChromeActuator();
  const virtualizedPreparation = await virtualizedActor.prepareReply(
    virtualized.tab, virtualizedAction, plan, virtualizedOptions,
  );
  assert.equal(virtualizedPreparation.baseline_total_reply_count, 1);
  const virtualizedAttempt = {
    action_id: virtualizedAction.action_id, claim_id: "claim-virtualized",
    preflight_id: "preflight-virtualized",
    preparation_id: virtualizedPreparation.preparation_id,
  };
  virtualized.page.nodes.target.children[".reply"] = [];
  await mustReject(
    () => virtualizedActor.reinspect(
      virtualized.tab, virtualizedAction, plan, virtualizedAttempt,
      virtualizedAction.session_id, "session-virtualized-reinspect",
      virtualizedPreparation, virtualizedOptions,
    ),
    /virtualized or partial coverage is forbidden/,
  );
  const equalTotalAction = actionFor("equal-total-exact");
  const equalTotalOptions = optionsFor(equalTotalAction);
  const equalTotal = fixture();
  addReply(equalTotal.page, { body: "先前不同的回覆" });
  const equalTotalActor = createCommentChromeActuator();
  const equalTotalPreparation = await equalTotalActor.prepareReply(
    equalTotal.tab, equalTotalAction, plan, equalTotalOptions,
  );
  assert.equal(equalTotalPreparation.baseline_total_reply_count, 1);
  equalTotal.page.nodes["reply-body-1"].text = equalTotalAction.reply_text;
  const equalTotalAttempt = {
    action_id: equalTotalAction.action_id, claim_id: "claim-equal-total",
    preflight_id: "preflight-equal-total",
    preparation_id: equalTotalPreparation.preparation_id,
    submission_attempted: true, submission_possible: true,
  };
  const equalTotalResult = await equalTotalActor.inspectResult(
    equalTotal.tab, equalTotalAction, plan, equalTotalAttempt,
    equalTotalPreparation, equalTotalOptions,
  );
  assert.equal(equalTotalResult.post_submit_total_reply_count, 1);
  assert.equal(equalTotalResult.exact_reply_visible, false);
  assert.equal(equalTotalResult.own_author_verified, false);
  assert.match(equalTotalResult.evidence, /does not exceed preparation baseline/);
  const equalTotalReinspection = await equalTotalActor.reinspect(
    equalTotal.tab, equalTotalAction, plan, equalTotalAttempt,
    equalTotalAction.session_id, "session-equal-total-reinspect",
    equalTotalPreparation, equalTotalOptions,
  );
  assert.equal(equalTotalReinspection.reinspection_total_reply_count, 1);
  assert.equal(equalTotalReinspection.exact_reply_visible, false);
  assert.equal(equalTotalReinspection.own_author_verified, false);
  assert.equal(equalTotalReinspection.absence_verified, false);
  assert.match(equalTotalReinspection.evidence, /does not exceed preparation baseline/);
  empty.page.nodes.expander = {
    visible: true,
    attributes: { "data-reply-control-instance": "expander-stuck-1" },
  };
  empty.page.nodes.target.children[".remaining-reply-expansion"] = ["expander"];
  await mustReject(
    () => actor.reinspect(
      empty.tab, action, plan, attempt, action.session_id, "session-r2",
      preparation, options,
    ),
    /reply exhaustion exceeded its click bound/,
  );
  const malformed = fixture();
  const malformedPrep = await createCommentChromeActuator().prepareReply(
    malformed.tab, actionFor("malformed"), plan, optionsFor(actionFor("malformed")),
  );
  addReply(malformed.page, { malformed: true });
  const malformedAction = actionFor("malformed");
  const malformedAttempt = {
    action_id: malformedAction.action_id, claim_id: "claim-malformed",
    preflight_id: "preflight-malformed", preparation_id: malformedPrep.preparation_id,
  };
  await mustReject(
    () => createCommentChromeActuator().reinspect(
      malformed.tab, malformedAction, plan, malformedAttempt, "session-m", "session-m2",
      malformedPrep, optionsFor(actionFor("malformed")),
    ),
    /evidence is incomplete/,
  );
}


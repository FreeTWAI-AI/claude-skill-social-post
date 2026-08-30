import assert from "node:assert/strict";

import { createCommentChromeActuator } from "./comment_chrome_actuator.mjs";
import {
  actionFor, addReply, fixture, mustReject, optionsFor, plan,
} from "./comment_chrome_actuator_fixture_test.mjs";

export async function testReplyThreadExhaustionAuthority() {
  const incompleteAction = actionFor("reply-exhaustion-incomplete");
  const incompleteOptions = optionsFor(incompleteAction);
  const incomplete = fixture();
  incomplete.page.nodes["reply-exhaustion-state"].attributes = {
    "data-reply-cursor": "page-0",
    "data-reply-discovered-count": "0",
    "data-reply-terminal": "false",
  };
  let incompleteClaims = 0;
  const incompleteActor = createCommentChromeActuator({
    claimSubmit: async (request) => {
      incompleteClaims += 1;
      return {
        ...request, decision: "WRITE_OK", claim_id: "claim-incomplete",
        preflight_id: "preflight-incomplete",
      };
    },
  });
  await mustReject(
    () => incompleteActor.prepareReply(
      incomplete.tab, incompleteAction, plan, incompleteOptions,
    ),
    /non-terminal reply cursor page-0 has no trusted traversal control/,
  );
  assert.equal(incompleteClaims, 0);
  assert.equal(incomplete.page.nodes["reply-trigger"].clicks ?? 0, 0);
  assert.equal(incomplete.page.nodes.submit.clicks ?? 0, 0);

  const laterExactAction = actionFor("reply-exhaustion-later-exact");
  const laterExactOptions = optionsFor(laterExactAction);
  const laterExact = fixture();
  const laterExactState = laterExact.page.nodes["reply-exhaustion-state"];
  laterExactState.attributes = {
    "data-reply-cursor": "page-0",
    "data-reply-discovered-count": "0",
    "data-reply-terminal": "false",
  };
  laterExact.page.nodes["reply-next"] = {
    visible: true, enabled: true, parent: "target", text: "Next replies",
    attributes: {
      "aria-label": "Next replies",
      "data-reply-control-instance": "reply-next-page-0",
    },
  };
  laterExact.page.nodes.target.children[".reply-next-viewport"] = ["reply-next"];
  laterExact.page.nodes["reply-next"].onClick = () => {
    laterExact.page.nodes.target.children[".reply-next-viewport"] = [];
    addReply(laterExact.page, { body: laterExactAction.reply_text });
  };
  let laterExactClaims = 0;
  const laterExactActor = createCommentChromeActuator({
    claimSubmit: async (request) => {
      laterExactClaims += 1;
      return {
        ...request, decision: "WRITE_OK", claim_id: "claim-later-exact",
        preflight_id: "preflight-later-exact",
      };
    },
  });
  await mustReject(
    () => laterExactActor.prepareReply(
      laterExact.tab, laterExactAction, plan, laterExactOptions,
    ),
    /exact own-account reply already exists/,
  );
  assert.equal(laterExact.page.nodes["reply-next"].clicks, 1);
  assert.equal(laterExactClaims, 0);
  assert.equal(laterExact.page.nodes["reply-trigger"].clicks ?? 0, 0);
  assert.equal(laterExact.page.nodes.submit.clicks ?? 0, 0);

  const laterExpanderAction = actionFor("reply-exhaustion-later-expander");
  const laterExpanderOptions = optionsFor(laterExpanderAction);
  const laterExpander = fixture();
  const laterExpanderState = laterExpander.page.nodes["reply-exhaustion-state"];
  laterExpanderState.attributes = {
    "data-reply-cursor": "page-0",
    "data-reply-discovered-count": "0",
    "data-reply-terminal": "false",
  };
  laterExpander.page.nodes["reply-next"] = {
    visible: true, enabled: true, parent: "target", text: "Next replies",
    attributes: {
      "aria-label": "Next replies",
      "data-reply-control-instance": "reply-next-expander-page-0",
    },
  };
  laterExpander.page.nodes.target.children[".reply-next-viewport"] = ["reply-next"];
  laterExpander.page.nodes["reply-next"].onClick = () => {
    laterExpander.page.nodes.target.children[".reply-next-viewport"] = [];
    laterExpanderState.attributes["data-reply-cursor"] = "page-1";
    laterExpanderState.attributes["data-reply-terminal"] = "false";
    laterExpander.page.nodes["lazy-expander"] = {
      visible: true, enabled: true, parent: "target", text: "View replies",
      attributes: {
        "aria-label": "View replies",
        "data-reply-control-instance": "reply-expander-page-1",
      },
    };
    laterExpander.page.nodes.target.children[".remaining-reply-expansion"] = [
      "lazy-expander",
    ];
    laterExpander.page.nodes["lazy-expander"].onClick = () => {
      laterExpander.page.nodes.target.children[".remaining-reply-expansion"] = [];
      addReply(laterExpander.page, { body: laterExpanderAction.reply_text });
      laterExpanderState.attributes["data-reply-cursor"] = "page-1";
      laterExpanderState.attributes["data-reply-terminal"] = "true";
    };
  };
  let laterExpanderClaims = 0;
  const laterExpanderActor = createCommentChromeActuator({
    claimSubmit: async (request) => {
      laterExpanderClaims += 1;
      return {
        ...request, decision: "WRITE_OK", claim_id: "claim-later-expander",
        preflight_id: "preflight-later-expander",
      };
    },
  });
  await mustReject(
    () => laterExpanderActor.prepareReply(
      laterExpander.tab, laterExpanderAction, plan, laterExpanderOptions,
    ),
    /exact own-account reply already exists/,
  );
  assert.equal(laterExpander.page.nodes["reply-next"].clicks, 1);
  assert.equal(laterExpander.page.nodes["lazy-expander"].clicks, 1);
  assert.equal(laterExpanderClaims, 0);
  assert.equal(laterExpander.page.nodes["reply-trigger"].clicks ?? 0, 0);
  assert.equal(laterExpander.page.nodes.submit.clicks ?? 0, 0);

  const replacementAction = actionFor("reply-exhaustion-replacement");
  const replacementOptions = optionsFor(replacementAction);
  const replacement = fixture();
  const originalExpander = {
    visible: true, enabled: true, parent: "target", text: "View replies",
    attributes: {
      "aria-label": "View replies",
      "data-reply-control-instance": "same-fingerprint-instance",
    },
  };
  let visibilityReads = 0;
  originalExpander.onVisible = () => {
    visibilityReads += 1;
    if (visibilityReads !== 2) return;
    replacement.page.nodes["replacement-expander"] = {
      visible: true, enabled: true, parent: "target", text: "View replies",
      attributes: { ...originalExpander.attributes },
    };
  };
  replacement.page.nodes["replacement-expander"] = originalExpander;
  replacement.page.nodes.target.children[".remaining-reply-expansion"] = [
    "replacement-expander",
  ];
  await mustReject(
    () => createCommentChromeActuator().prepareReply(
      replacement.tab, replacementAction, plan, replacementOptions,
    ),
    /DOM node changed before click; replacement receives zero clicks/,
  );
  assert.equal(originalExpander.clicks ?? 0, 0);
  assert.equal(replacement.page.nodes["replacement-expander"].clicks ?? 0, 0);
  assert.equal(replacement.page.nodes["reply-trigger"].clicks ?? 0, 0);

  const preclaimAction = actionFor("reply-exhaustion-preclaim");
  const preclaimOptions = optionsFor(preclaimAction);
  const preclaim = fixture();
  let preclaimCalls = 0;
  const preclaimActor = createCommentChromeActuator({
    claimSubmit: async (request) => {
      preclaimCalls += 1;
      return {
        ...request, decision: "WRITE_OK", claim_id: "claim-preclaim",
        preflight_id: "preflight-preclaim",
      };
    },
  });
  const preclaimPreparation = await preclaimActor.prepareReply(
    preclaim.tab, preclaimAction, plan, preclaimOptions,
  );
  preclaim.page.nodes["reply-exhaustion-state"].attributes = {
    "data-reply-cursor": "page-lazy",
    "data-reply-discovered-count": "0",
    "data-reply-terminal": "false",
  };
  await mustReject(
    () => preclaimActor.submitOnce(
      preclaim.tab, preclaimAction, plan, preclaimPreparation, preclaimOptions,
    ),
    /non-terminal reply cursor page-lazy has no trusted traversal control/,
  );
  assert.equal(preclaimCalls, 0);
  assert.equal(preclaim.page.nodes.submit.clicks ?? 0, 0);
  let recoveryReceipt = null;
  await mustReject(
    async () => {
      recoveryReceipt = await preclaimActor.reinspect(
        preclaim.tab, preclaimAction, plan, {
          action_id: preclaimAction.action_id,
          claim_id: "claim-never-sent",
          preflight_id: "preflight-never-sent",
          preparation_id: preclaimPreparation.preparation_id,
        }, preclaimAction.session_id, "session-recovery-incomplete",
        preclaimPreparation, preclaimOptions,
      );
    },
    /non-terminal reply cursor page-lazy has no trusted traversal control/,
  );
  assert.equal(recoveryReceipt, null);
}


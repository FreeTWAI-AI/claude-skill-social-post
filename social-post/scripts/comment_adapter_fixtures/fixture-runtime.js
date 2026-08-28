"use strict";

(() => {
  const root = document.documentElement;
  const specs = {
    facebook: {
      target: "[data-fb-comment-id]", id: "data-fb-comment-id",
      trigger: "[data-fb-reply-trigger]", composer: "[data-fb-composer]",
      submit: "[data-fb-submit]", replies: "[data-fb-own-replies]",
      replyTag: "div", replyAttribute: "data-fb-own-reply",
    },
    instagram: {
      target: "[data-ig-comment-id]", id: "data-ig-comment-id",
      trigger: "[data-ig-reply-trigger]", composer: "[data-ig-composer]",
      submit: "[data-ig-submit]", replies: "[data-ig-own-replies]",
      replyTag: "li", replyAttribute: "data-ig-own-reply",
    },
    threads: {
      target: "[data-threads-reply-id]", id: "data-threads-reply-id",
      trigger: "[data-threads-reply-trigger]", composer: "[data-threads-composer]",
      submit: "[data-threads-submit]", replies: "[data-threads-own-replies]",
      replyTag: "article", replyAttribute: "data-threads-own-reply",
    },
  };

  const fail = (reason) => {
    root.dataset.fixtureRuntimeState = "invalid";
    root.dataset.fixtureRuntimeError = reason;
  };
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (root.dataset.fixtureOrigin !== "local-only" || !loopbackHosts.has(location.hostname)) {
    fail("origin-marker");
    return;
  }
  const spec = specs[root.dataset.platform];
  if (!spec) {
    fail("platform");
    return;
  }
  const exactlyOne = (scope, selector) => {
    const matches = scope.querySelectorAll(selector);
    return matches.length === 1 ? matches[0] : null;
  };
  const targets = [...document.querySelectorAll(spec.target)];
  if (targets.length < 2) {
    fail("target-shape");
    return;
  }
  const accountKey = root.dataset.accountKey;
  const ids = targets.map((target) => target.getAttribute(spec.id));
  if (!accountKey || ids.some((id) => !id) || new Set(ids).size !== ids.length
      || targets.some((target) => !target.dataset.parentPostPermalink)) {
    fail("fixture-identity");
    return;
  }
  const controls = targets.map((target) => {
    const trigger = exactlyOne(target, spec.trigger);
    const composer = exactlyOne(target, spec.composer);
    const submit = exactlyOne(target, spec.submit);
    const replies = exactlyOne(target, spec.replies);
    if (!trigger || !composer || !submit || !replies) return null;
    return {
      target, trigger, composer, submit, replies,
      commentId: target.getAttribute(spec.id),
    };
  });
  if (controls.some((entry) => entry === null)) {
    fail("parent-scoped-control-shape");
    return;
  }
  const composerText = (composer) => (
    "value" in composer ? composer.value : (composer.textContent || "")
  );
  const clearComposer = (composer) => {
    if ("value" in composer) composer.value = "";
    else composer.textContent = "";
  };
  const closeAllComposers = () => {
    for (const entry of controls) {
      entry.composer.hidden = true;
      entry.submit.hidden = true;
      entry.submit.disabled = true;
    }
  };
  closeAllComposers();
  root.dataset.authenticationState = "authenticated";
  root.dataset.fixtureRuntimeState = "ready";

  for (const entry of controls) {
    const { trigger, composer, submit, replies, commentId } = entry;
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      const count = Number.parseInt(root.dataset.replyTriggerAttempts || "0", 10);
      root.dataset.replyTriggerAttempts = String(count + 1);
      closeAllComposers();
      root.dataset.activeParentCommentId = commentId;
      composer.hidden = false;
      submit.hidden = false;
      submit.disabled = false;
    });

    submit.addEventListener("click", (event) => {
      event.preventDefault();
      const attempts = Number.parseInt(root.dataset.submitAttempts || "0", 10);
      root.dataset.submitAttempts = String(attempts + 1);
      if (root.dataset.activeParentCommentId !== commentId) {
        root.dataset.fixtureLastRejection = "wrong-active-parent";
        return;
      }
      const replyText = composerText(composer);
      if (!replyText.trim() || /[\r\n]/u.test(replyText)) {
        root.dataset.fixtureLastRejection = "invalid-reply-text";
        return;
      }
      const appendReply = () => {
        const reply = document.createElement(spec.replyTag);
        reply.setAttribute(spec.replyAttribute, "");
        reply.setAttribute("data-is-own", "true");
        reply.setAttribute("data-author-key", accountKey);
        reply.setAttribute("data-parent-comment-id", commentId);
        const author = document.createElement("span");
        author.setAttribute("data-fixture-own-author", "");
        author.textContent = accountKey;
        const body = document.createElement("span");
        body.setAttribute("data-fixture-own-body", "");
        body.textContent = replyText;
        reply.append(author, body);
        replies.append(reply);
        const accepted = Number.parseInt(root.dataset.acceptedCount || "0", 10);
        root.dataset.acceptedCount = String(accepted + 1);
        root.dataset.acceptedParentCommentId = commentId;
      };
      const delay = Number.parseInt(new URLSearchParams(location.search).get("reply_delay_ms") || "0", 10);
      if (Number.isInteger(delay) && delay > 0 && delay <= 2000) setTimeout(appendReply, delay);
      else appendReply();
      clearComposer(composer);
      submit.disabled = true;
    });
  }
})();

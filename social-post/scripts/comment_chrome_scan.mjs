import {
  SUPPORTED_PLATFORMS,
  canonicalUrl,
  digestObject,
  fail,
  immutableJsonSnapshot,
  locate,
  mappedObservedUrl,
  nowIso,
  readValue,
  receiptTestOnly,
  requireBoolean,
  requiredString,
  unique,
  verifyEvidence,
  verifyExpansionComplete,
  verifyNearestAnchorOwner,
} from "./comment_chrome_common.mjs";

function assertScanRequest(request) {
  if (!request || typeof request !== "object") fail("scan request must be an object");
  for (const key of ["scan_request_id", "session_id", "platform", "account_key", "post_key", "post_permalink"]) {
    requiredString(request[key], `scan request.${key}`);
  }
  if (!SUPPORTED_PLATFORMS.has(request.platform)) fail(`unsupported platform ${request.platform}`);
  return request;
}

function assertScanPlan(plan) {
  if (!plan || typeof plan !== "object") fail("scan locator plan must be an object");
  const required = [
    "authentication", "account", "post", "comments", "commentId", "author", "body", "parentPost",
    "isOwn", "ownReplyItems", "ownReplyAuthor", "expansionControls",
  ];
  for (const key of required) {
    if (!plan[key] || typeof plan[key] !== "object") fail(`scan locator plan.${key} is required`);
    requiredString(plan[key].selector, `scan locator plan.${key}.selector`);
  }
  requireBoolean(plan.bodyComplete, "scan locator plan.bodyComplete");
  if (plan.commentId.self !== true || !plan.commentId.attribute) {
    fail("scan locator plan.commentId must be an attribute on each comment item itself");
  }
  return plan;
}

async function optionalRead(parent, spec, ownership = null, label = null) {
  if (!spec) return null;
  const locator = spec.self === true ? parent : parent.locator(spec.selector, {});
  const count = await locator.count();
  if (count === 0 && spec.optional === true) return null;
  const evidenceLabel = label || spec.label || spec.selector;
  await unique(locator, evidenceLabel, { visible: spec.visible !== false });
  if (ownership) {
    await verifyNearestAnchorOwner(
      locator, { ...ownership, fromParent: false }, evidenceLabel,
    );
  }
  return readValue(locator, spec);
}

async function visibleOwnReply(item, plan, accountKey, commentOwnership) {
  const replies = item.locator(plan.ownReplyItems.selector, {});
  const count = await replies.count();
  let own = false;
  for (let index = 0; index < count; index += 1) {
    const reply = replies.nth(index);
    if (!(await reply.isVisible())) fail("scan own-reply evidence contains a hidden item");
    await verifyNearestAnchorOwner(
      reply, { ...commentOwnership, fromParent: true }, "scan reply item",
    );
    const replyAnchor = String(
      await reply.getAttribute(commentOwnership.attribute) ?? "",
    ).normalize("NFC").trim() || commentOwnership.expected;
    const author = plan.ownReplyAuthor.self === true
      ? reply
      : reply.locator(plan.ownReplyAuthor.selector, {});
    await unique(author, "scan own-reply author");
    await verifyNearestAnchorOwner(author, {
      attribute: commentOwnership.attribute, expected: replyAnchor,
      fromParent: false,
    }, "scan own-reply author");
    if ((await readValue(author, plan.ownReplyAuthor)) === accountKey) own = true;
  }
  return own;
}

async function scanCommentItem(item, plan, request, completion) {
  const id = await optionalRead(item, plan.commentId);
  const ownership = { attribute: plan.commentId.attribute, expected: id };
  const author = await optionalRead(item, plan.author, ownership, "scan comment author");
  const display = plan.authorDisplay
    ? await optionalRead(item, plan.authorDisplay, ownership, "scan comment author display")
    : author;
  const body = await optionalRead(item, plan.body, ownership, "scan comment body");
  const permalink = plan.permalink
    ? await optionalRead(item, plan.permalink, ownership, "scan comment permalink")
    : null;
  const parentPost = await optionalRead(
    item, plan.parentPost, ownership, "scan comment parent post",
  );
  const expectedParent = canonicalUrl(request.post_permalink).toString();
  const observedParent = canonicalUrl(parentPost).toString();
  if (observedParent !== expectedParent) {
    fail("scanned comment parent post differs from the approved post permalink");
  }
  const isOwn = parseBooleanEvidence(
    await optionalRead(item, plan.isOwn, ownership, "scan comment isOwn"),
    "comment isOwn",
  );
  const visibleOwn = await visibleOwnReply(
    item, plan, request.account_key, ownership,
  );
  return {
    platform_comment_id: id,
    ...(permalink ? { comment_permalink: permalink } : {}),
    observed_parent_post_permalink: observedParent,
    author_key: author,
    author_display: display,
    body,
    body_complete: plan.bodyComplete && completion.commentsExpanded,
    is_own: isOwn,
    has_own_reply: completion.repliesExpanded ? visibleOwn : (visibleOwn ? true : null),
    language: plan.language || "und",
  };
}

async function scanCollection(tab, plan, request, completion, maximum) {
  const items = locate(tab, null, plan.comments);
  const total = await items.count();
  if (total > maximum) fail(`scan found ${total} comments, exceeding maxComments=${maximum}`);
  const comments = [];
  for (let index = 0; index < total; index += 1) {
    const item = items.nth(index);
    if (!(await item.isVisible())) fail("scan comment collection contains a hidden item");
    comments.push(await scanCommentItem(item, plan, request, completion));
  }
  const endTotal = await locate(tab, null, plan.comments).count();
  return {
    total, end_total: endTotal, comments,
    snapshot_digest: digestObject({ total, comments }, "scan comment snapshot"),
  };
}

async function expansionControlCount(tab, plan) {
  return locate(tab, null, plan.expansionControls).count();
}

function parseBooleanEvidence(value, label) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  fail(`${label} is not explicit boolean evidence`);
}

export function createScanPost({ clock } = {}) {
  return async function scanPost(tab, rawRequest, rawPlan, rawOptions = {}) {
    const request = assertScanRequest(immutableJsonSnapshot(rawRequest, "scan request"));
    const plan = assertScanPlan(immutableJsonSnapshot(rawPlan, "scan locator plan"));
    const options = immutableJsonSnapshot(rawOptions, "scan options");
    const actionShape = { scope: request, post_permalink: request.post_permalink };
    const observedUrl = mappedObservedUrl(await tab.url(), actionShape, options);
    await verifyEvidence(
      locate(tab, null, plan.authentication), plan.authentication,
      "authenticated", "authentication",
    );
    await verifyEvidence(
      locate(tab, null, plan.account), plan.account, request.account_key, "account",
    );
    await verifyEvidence(
      locate(tab, null, plan.post), plan.post, request.post_key, "post",
    );
    const maximum = options.maxComments ?? 100;
    if (!Number.isInteger(maximum) || maximum < 0) fail("maxComments must be a non-negative integer");
    const expansionComplete = options.threadExpansionComplete === true;
    const testOnly = receiptTestOnly(options);
    if (!testOnly && !expansionComplete) {
      fail("live scan requires verified comment and reply expansion");
    }
    const completion = {
      commentsExpanded: expansionComplete,
      repliesExpanded: expansionComplete,
    };
    const initialExpansionCount = await expansionControlCount(tab, plan);
    if (expansionComplete) {
      await verifyExpansionComplete(tab, null, plan.expansionControls, "comment thread expansion");
    }
    const first = await scanCollection(tab, plan, request, completion, maximum);
    if (first.end_total !== first.total) {
      fail(`scan comment count drifted during inspection: ${first.total} to ${first.end_total}`);
    }
    const middleExpansionCount = await expansionControlCount(tab, plan);
    if (middleExpansionCount !== initialExpansionCount) {
      fail(`scan expansion-control count drifted: ${initialExpansionCount} to ${middleExpansionCount}`);
    }
    if (expansionComplete) {
      await verifyExpansionComplete(tab, null, plan.expansionControls, "comment thread expansion");
    }
    const found = await scanCollection(tab, plan, request, completion, maximum);
    if (found.end_total !== found.total) {
      fail(`scan comment count drifted during stability scan: ${found.total} to ${found.end_total}`);
    }
    const finalExpansionCount = await expansionControlCount(tab, plan);
    if (finalExpansionCount !== initialExpansionCount) {
      fail(`scan expansion-control count drifted: ${initialExpansionCount} to ${finalExpansionCount}`);
    }
    if (expansionComplete) {
      await verifyExpansionComplete(tab, null, plan.expansionControls, "comment thread expansion");
    }
    const finalCount = await locate(tab, null, plan.comments).count();
    if (finalCount !== found.total) {
      fail(`scan comment count drifted after inspection: ${found.total} to ${finalCount}`);
    }
    const terminalExpansionCount = await expansionControlCount(tab, plan);
    if (terminalExpansionCount !== initialExpansionCount) {
      fail(`scan expansion-control count drifted: ${initialExpansionCount} to ${terminalExpansionCount}`);
    }
    if (expansionComplete) {
      await verifyExpansionComplete(tab, null, plan.expansionControls, "comment thread expansion");
    }
    if (first.total !== found.total || first.snapshot_digest !== found.snapshot_digest) {
      fail("scan comment evidence changed during stability verification");
    }
    return {
      schema_version: 1,
      test_only: testOnly,
      scan_request_id: request.scan_request_id,
      session_id: request.session_id,
      platform: request.platform,
      account_key: request.account_key,
      post_key: request.post_key,
      post_permalink: request.post_permalink,
      observed_url: observedUrl,
      observed_at: nowIso(clock),
      authentication_state: "authenticated",
      account_verified: true,
      post_verified: true,
      comments: found.comments,
      thread_expansion_evidence: {
        provided: expansionComplete,
        comments_expanded: expansionComplete,
        replies_expanded: expansionComplete,
        evidence: expansionComplete
          ? "all visible comment and reply expansion controls were exhausted"
          : "thread expansion was not proven by the actuator caller",
      },
    };
  };
}

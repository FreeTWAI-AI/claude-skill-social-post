/** Source-owned Instagram reply evidence and one-action positive readback. */
import {
  digestObject, fail, immutableJsonSnapshot, unique,
} from "./comment_chrome_common.mjs";
import { assertAction } from "./comment_chrome_send_support.mjs";
import { liveReplyUrl, normalize } from "./comment_chrome_live_common.mjs";
import {
  instagramNativeTarget, readInstagramNativeComment,
} from "./comment_chrome_instagram_reader.mjs";

const instagramReplyEvidence = new WeakMap();
const instagramExpansionAttempts = new WeakMap();
const instagramReadGenerations = new WeakMap();
const instagramPreparations = new WeakSet();
const MAX_INSTAGRAM_ONE_PAGE_REPLIES = 100;

function recordInstagramReplyEvidence(tab, action, observedUrl, target, evidence) {
  const binding = digestObject({ action, observedUrl }, "Instagram reply evidence binding");
  const documentBinding = evidence.documentBinding;
  const documentKey = digestObject(documentBinding, "Instagram native UI binding");
  let state = instagramReplyEvidence.get(tab);
  if (!state || state.binding !== binding || state.documentKey !== documentKey) {
    state = { binding, documentBinding, documentKey, declaredCount: null,
      expandAttempted: instagramExpansionAttempts.get(tab)?.has(binding) ?? false,
      invalidated: false, stableReads: 0, terminalFingerprint: null };
    instagramReplyEvidence.set(tab, state);
  }
  state.target = target;
  state.current = evidence;
  const count = evidence.expandCount;
  const initialCount = Number.isSafeInteger(count) && count > 0
    && count <= MAX_INSTAGRAM_ONE_PAGE_REPLIES && evidence.expandControlCount === 1
    && evidence.pendingControlCount === 1 && evidence.hideControlCount === 0
    && evidence.totalReplies === 0 && !evidence.loading;
  if (initialCount && !state.expandAttempted) {
    if (state.declaredCount !== null && state.declaredCount !== count) state.invalidated = true;
    else state.declaredCount = count;
  }
  const terminal = !state.invalidated && state.expandAttempted && state.declaredCount !== null
    && evidence.totalReplies === state.declaredCount && evidence.hideControlCount === 1
    && !evidence.expansionPending && !evidence.loading;
  if (terminal) {
    const fingerprint = digestObject(evidence.rows, "Instagram native reply rows");
    if (state.terminalFingerprint !== null && state.terminalFingerprint !== fingerprint) {
      state.invalidated = true;
      state.stableReads = 0;
    } else {
      state.terminalFingerprint = fingerprint;
      state.stableReads = Math.min(2, state.stableReads + 1);
    }
  } else {
    if (state.terminalFingerprint !== null) state.invalidated = true;
    state.stableReads = 0;
  }
  const exhaustiveThread = !state.invalidated && terminal && state.stableReads === 2;
  return immutableJsonSnapshot({
    schema_version: 1, candidate_only: true, exhaustiveThread,
    scope: "instagram_native_one_page_parent_bound_replies",
    action_digest: digestObject(action, "Instagram reply action"), binding_digest: binding,
    document_binding: documentBinding, observed_url: observedUrl,
    declared_count: state.declaredCount, observed_count: evidence.totalReplies,
    expansion_attempted: state.expandAttempted, stable_reads: state.stableReads,
    rows_digest: state.terminalFingerprint,
    reason: exhaustiveThread ? "observed_count_and_two_native_reads_agree"
      : state.invalidated ? "reply_evidence_changed"
        : state.declaredCount === null ? "pre_expansion_count_not_observed"
          : "native_reply_expansion_not_stably_exhausted",
  }, "Instagram reply exhaustion candidate");
}

export async function inspectInstagram(tab, action, phase) {
  const generation = (instagramReadGenerations.get(tab) ?? 0) + 1;
  instagramReadGenerations.set(tab, generation);
  try {
    return await readInstagramReplySurface(tab, action, phase, generation);
  } catch (error) {
    const state = instagramReplyEvidence.get(tab);
    if (state) { state.invalidated = true; state.stableReads = 0; }
    throw error;
  }
}

async function readInstagramReplySurface(tab, action, phase, generation) {
  const native = instagramNativeTarget({
    platform: action.scope.platform, account_key: action.scope.account_key,
    post_key: action.scope.post_key, post_permalink: action.post_permalink,
    comment_permalink: liveReplyUrl(action),
    platform_comment_id: action.comment_anchor.platform_comment_id,
  });
  const { observedUrl, article, target, evidence } = await readInstagramNativeComment(tab, native);
  if (evidence.parent.author !== action.author_key || evidence.parent.body !== normalize(action.expected_body)) {
    fail("Instagram native parent, author or complete body changed");
  }
  evidence.exactOwnCount = evidence.rows.filter(
    (row) => row.author === native.account && row.body === normalize(action.reply_text),
  ).length;
  if (instagramReadGenerations.get(tab) !== generation) {
    fail("Instagram reply inspections overlapped");
  }
  const replyExhaustionCandidate = recordInstagramReplyEvidence(tab, action, observedUrl, target, evidence);
  // Native /c/P/r/R anchors prove observed child ownership, not exhaustive
  // pagination or the selected reply state of the shared post-level textarea.
  // In particular, an @author prefill is not sufficient parent-state evidence.
  const base = { observedUrl, complete: false, totalReplies: evidence.totalReplies,
    ownReplyCount: evidence.ownReplyCount, exactOwnCount: evidence.exactOwnCount,
    expansionPending: evidence.expansionPending,
    exhaustiveThread: replyExhaustionCandidate.exhaustiveThread, replyExhaustionCandidate,
    blockedReason: "instagram_reply_exhaustion_and_selected_parent_not_verified" };
  if (phase === "after") return base;
  const composer = article.getByRole("textbox", { name: "留言⋯⋯", exact: true });
  await unique(composer, "Instagram shared comment editor");
  const form = article.locator("form").filter({
    has: tab.playwright.getByRole("textbox", { name: "留言⋯⋯", exact: true }),
  });
  await unique(form, "Instagram comment form");
  return { ...base, trigger: target.getByRole("button", { name: "回覆", exact: true }),
    composer, submit: form.getByRole("button", { name: "發佈", exact: true }) };
}

/** One source-owned expansion of the observed native IG shape; never compose or submit. */
export async function prepareLiveReplyThread(tab, action) {
  assertAction(action);
  if (action.scope.platform !== "instagram") fail("native reply preparation is only verified for Instagram");
  if (instagramPreparations.has(tab)) fail("Instagram reply preparation is already running");
  instagramPreparations.add(tab);
  try {
    await inspectInstagram(tab, action, "after");
    const state = instagramReplyEvidence.get(tab);
    if (!state || state.invalidated || state.declaredCount === null) {
      fail("Instagram requires a positive observed pre-expansion reply count");
    }
    if (!state.expandAttempted) {
      const current = state.current;
      if (current.expandControlCount !== 1 || !current.expandLabel || current.loading
          || current.pendingControlCount !== 1 || current.totalReplies !== 0 || current.hideControlCount !== 0) {
        fail("Instagram initial reply expansion is not uniquely bound");
      }
      const thread = await unique(state.target.locator("xpath=ancestor::ul[1]"), "Instagram native parent thread");
      const expand = await unique(thread.getByRole("button", { name: current.expandLabel, exact: true }),
        "Instagram native count-bound reply expansion");
      // Latch before awaiting click: an ambiguous expansion never causes a second click.
      state.expandAttempted = true;
      let attempts = instagramExpansionAttempts.get(tab);
      if (!attempts) { attempts = new Set(); instagramExpansionAttempts.set(tab, attempts); }
      attempts.add(state.binding);
      await expand.click();
      // Wait only for the count-bound native child anchors to become visible.
      // This is UI readiness, not terminal/absence evidence; the two complete
      // parent-bound row reads below still decide whether the candidate holds.
      await thread.locator(`a[href^=${JSON.stringify(`${current.parent.path}r/`)}]`)
        .filter({ has: tab.playwright.locator("time") }).nth(state.declaredCount - 1)
        .waitFor({ state: "visible", timeoutMs: 10000 });
    }
    await inspectInstagram(tab, action, "after");
    const final = await inspectInstagram(tab, action, "after");
    if (!final.exhaustiveThread) fail("Instagram native reply expansion is not stably exhausted");
    const verified = instagramReplyEvidence.get(tab);
    if (final.ownReplyCount === 0 && final.exactOwnCount === 0 && !verified.preflightBaseline) {
      verified.preflightBaseline = immutableJsonSnapshot({
        binding: verified.binding, documentBinding: verified.documentBinding,
        documentKey: verified.documentKey, rows: verified.current.rows,
      }, "Instagram private preflight reply baseline");
    }
    return final;
  } finally {
    instagramPreparations.delete(tab);
  }
}

function newInstagramCanaryReply(state, baseline, action) {
  const current = state.current;
  if (state.binding !== baseline.binding || state.documentKey !== baseline.documentKey
      || current.loading || current.expansionPending || current.hideControlCount !== 1
      || current.ownReplyCount !== 1 || current.exactOwnCount !== 1
      || current.rows.length !== baseline.rows.length + 1) {
    fail("Instagram positive canary readback is not complete and parent-bound");
  }
  const original = new Map(baseline.rows.map((row) => [row.path, row]));
  const added = [];
  for (const row of current.rows) {
    const previous = original.get(row.path);
    if (previous) {
      if (digestObject(row) !== digestObject(previous)) fail("Instagram original reply changed during canary readback");
      original.delete(row.path);
    } else added.push(row);
  }
  const account = action.scope.account_key.replace(/^@/u, "");
  if (original.size || added.length !== 1 || added[0].author !== account
      || added[0].body !== normalize(action.reply_text)) {
    fail("Instagram canary readback requires exactly one new approved own reply");
  }
  return added[0];
}

/** Positive sent evidence only. No caller baseline, absence result, or submit retry. */
export async function inspectLiveCanaryResult(tab, action) {
  assertAction(action);
  if (action.scope.platform !== "instagram") fail("native canary readback is only verified for Instagram");
  if (instagramPreparations.has(tab)) fail("Instagram reply preparation or canary readback is already running");
  const state = instagramReplyEvidence.get(tab);
  const baseline = state?.preflightBaseline;
  const expectedBinding = digestObject({ action, observedUrl: liveReplyUrl(action) });
  if (!baseline || baseline.binding !== expectedBinding) {
    fail("Instagram positive canary readback requires its private zero-own preflight baseline");
  }
  instagramPreparations.add(tab);
  try {
    let firstDigest = null;
    let reply = null;
    let inspection = null;
    for (let read = 0; read < 2; read += 1) {
      inspection = await inspectInstagram(tab, action, "after");
      if (instagramReplyEvidence.get(tab) !== state) fail("Instagram canary UI or action binding changed");
      reply = newInstagramCanaryReply(state, baseline, action);
      const digest = digestObject(state.current.rows, "Instagram positive canary reply rows");
      if (firstDigest !== null && firstDigest !== digest) fail("Instagram positive canary rows are not stable");
      firstDigest = digest;
    }
    return immutableJsonSnapshot({
      observedUrl: inspection.observedUrl, complete: false, exhaustiveThread: false,
      verifiedNewReply: true, positive_only: true, absence_proven: false,
      replyPermalink: new URL(reply.path, inspection.observedUrl).toString(),
      totalReplies: state.current.totalReplies, ownReplyCount: 1, exactOwnCount: 1,
      action_digest: digestObject(action), binding_digest: baseline.binding,
      documentBinding: baseline.documentBinding, baseline_rows_digest: digestObject(baseline.rows),
      rows_digest: firstDigest, stable_reads: 2,
      blockedReason: "instagram_selected_parent_proof_is_separate_from_positive_readback",
    }, "Instagram positive canary result");
  } finally {
    instagramPreparations.delete(tab);
  }
}

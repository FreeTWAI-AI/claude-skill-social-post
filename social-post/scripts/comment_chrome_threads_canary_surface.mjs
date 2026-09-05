/** Threads explicit-zero baseline and source-selected reply composer; no submission. */
import { digestObject, fail, immutableJsonSnapshot, requiredString, unique } from "./comment_chrome_common.mjs";
import { assertAction } from "./comment_chrome_send_support.mjs";
import { liveReplyUrl, normalize } from "./comment_chrome_live_common.mjs";
import { threadsNativeTarget, readThreadsNativeComment } from "./comment_chrome_threads_reader.mjs";
import { readThreadsSelectedDialog } from "./comment_chrome_threads_modal_reader.mjs";
import { inspectThreadsPositiveResult } from "./comment_chrome_threads_result_reader.mjs";

export { readThreadsSelectedDialog };

const preparations = new WeakMap();
const running = new WeakSet();

/** Read the observed zero-thread shape; never infer terminal from an empty viewport. */
export function readThreadsZeroTerminal(root, expected) {
  const norm = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
  const visible = (node) => node?.getClientRects().length > 0;
  const pending = '[role="progressbar"],[role="status"],[aria-busy="true"]';
  const interactive = 'a[href],time,button,[role="button"],[role="textbox"],img,svg';
  const empty = (node) => !norm(node.textContent) && !node.querySelector(interactive);
  if (root.getAttribute("aria-busy") === "true" || root.querySelector(pending)) return null;
  const controls = [...root.querySelectorAll('button,[role="button"],span,div,p')];
  if (controls.some((node) => visible(node) && /^(?:載入中[.。…]*|Loading[.\s…]*|顯示更多回覆|查看更多回覆|載入更多|更多回覆|See more replies|View more replies|Load more)$/iu.test(norm(node.innerText)))) return null;
  const pagelets = [...root.querySelectorAll('[data-pagelet]')];
  const originals = pagelets.filter((node) => node.getAttribute("data-pagelet") === "threads_post_page_0");
  const focuses = pagelets.filter((node) => node.getAttribute("data-pagelet") === "threads_post_page_1");
  if (originals.length !== 1 || focuses.length !== 1) return null;
  const [original] = originals, [focus] = focuses;
  const context = focus.parentElement;
  if (!context || original.parentElement !== context || original.nextElementSibling !== focus) return null;
  const children = [...context.children];
  if (children.length !== 4 || children[0] !== original || children[1] !== focus || pagelets.length !== 3
      || context.parentElement?.children.length !== 1
      || children[2].getAttribute("data-pagelet") !== "threads_post_page_{n}"
      || !pagelets.includes(children[2]) || !empty(children[2]) || children[3].tagName !== "DIV"
      || children[3].getAttribute("data-pagelet") !== null || !empty(children[3])) return null;
  const nativeLinks = [...root.querySelectorAll('a[href]')].filter((link) => link.getAttribute("href").includes("/post/"));
  const parsed = [];
  for (const link of nativeLinks) {
    const raw = link.getAttribute("href");
    let url;
    try { url = new URL(raw, expected.commentUrl); } catch { return null; }
    if (!visible(link) || url.origin !== new URL(expected.commentUrl).origin || url.search || url.hash
        || url.username || url.password || raw.includes("\\") || /%|\/\.\.?\//u.test(raw)) return null;
    const times = [...link.querySelectorAll("time")];
    if (times.length !== 1 || !visible(times[0])) return null;
    parsed.push({ link, time: times[0], path: url.pathname.replace(/\/+$/u, "") });
  }
  if (parsed.length !== 2 || parsed[0].path !== expected.postPath || parsed[1].path !== expected.targetPath
      || !original.contains(parsed[0].link) || !focus.contains(parsed[1].link)) return null;
  const owner = parsed[1].link.closest('[data-pressable-container="true"]');
  const shell = owner?.firstElementChild;
  if (!owner || !focus.contains(owner) || !visible(owner) || !shell || shell.children.length !== 5) return null;
  const marker = shell.children[3];
  if (!visible(marker) || norm(marker.innerText) !== "尚無回覆" || marker.querySelector(interactive)) return null;
  const inlineEditors = [...shell.children[4].querySelectorAll('[role="textbox"]')];
  if (inlineEditors.length !== 1 || !visible(inlineEditors[0]) || inlineEditors[0].getAttribute("contenteditable") !== "true"
      || norm(inlineEditors[0].textContent) || norm(inlineEditors[0].innerText)
      || inlineEditors[0].getAttribute("aria-placeholder")?.match(/^回覆\s*([A-Za-z0-9._-]+)(?:…{2}|⋯{2})$/u)?.[1] !== expected.author) return null;
  const markers = [...root.querySelectorAll('span,div,p')].filter((node) => visible(node)
    && norm(node.innerText) === "尚無回覆" && ![...node.children].some((child) => norm(child.innerText) === "尚無回覆"));
  if (markers.length !== 1 || !marker.contains(markers[0])) return null;
  const targetDatetime = parsed[1].time.getAttribute("datetime");
  if (!targetDatetime || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(targetDatetime)
      || norm(parsed[1].time.innerText) !== expected.displayedAt) return null;
  return { terminal: true, targetDatetime, marker: "尚無回覆",
    parentPath: parsed[0].path, targetPath: parsed[1].path,
    pageletNames: pagelets.map((node) => node.getAttribute("data-pagelet")), unlabelledTailEmpty: true, observedChildCount: 0 };
}


function actionInput(rawAction) {
  const action = immutableJsonSnapshot(rawAction, "Threads canary action");
  assertAction(action);
  if (action.scope.platform !== "threads") fail("Threads canary candidate requires a Threads action");
  const native = threadsNativeTarget({ platform: "threads", account_key: action.scope.account_key,
    post_key: action.scope.post_key, post_permalink: action.post_permalink,
    comment_permalink: liveReplyUrl(action), platform_comment_id: action.comment_anchor.platform_comment_id });
  return { action, native, actionDigest: digestObject(action) };
}

function localTerminal(raw) {
  if (!raw || raw.terminal !== true || raw.observedChildCount !== 0 || raw.unlabelledTailEmpty !== true || !Array.isArray(raw.pageletNames)) {
    fail("Threads explicit zero-thread terminal shape is not verified");
  }
  const pageletNames = [];
  for (const name of raw.pageletNames) pageletNames.push(requiredString(name, "Threads terminal pagelet"));
  return immutableJsonSnapshot({ terminal: true, observedChildCount: 0, unlabelledTailEmpty: true, pageletNames,
    marker: requiredString(raw.marker, "Threads zero marker"),
    parentPath: requiredString(raw.parentPath, "Threads terminal parent"),
    targetPath: requiredString(raw.targetPath, "Threads terminal target"),
    targetDatetime: requiredString(raw.targetDatetime, "Threads target timestamp") }, "Threads zero terminal candidate");
}

async function readZero(tab, input) {
  const read = await readThreadsNativeComment(tab, input.native);
  if (read.evidence.author !== input.action.author_key || read.evidence.body !== normalize(input.action.expected_body)
      || read.evidence.replyCount !== 0 || !read.evidence.zeroReplyCandidate) {
    fail("Threads canary needs its exact native parent and explicit zero-reply candidate");
  }
  const expected = { ...input.native, ...read.evidence };
  const terminal = localTerminal(await read.region.evaluate(readThreadsZeroTerminal, expected));
  const confirmed = await readThreadsNativeComment(tab, input.native);
  if (digestObject(confirmed.documentBinding) !== digestObject(read.documentBinding)
      || digestObject(confirmed.evidence) !== digestObject(read.evidence)) {
    fail("Threads target changed during zero-thread terminal reading");
  }
  return { ...read, terminal, expected: { ...expected, targetDatetime: terminal.targetDatetime } };
}

function recordZero(tab, input, read) {
  const binding = digestObject({ action_digest: input.actionDigest, document_binding: read.documentBinding });
  const terminalDigest = digestObject(read.terminal);
  let state = preparations.get(tab);
  if (!state) {
    state = { binding, terminalDigest, stableReads: 0, attempted: false, invalidated: false,
      documentBinding: read.documentBinding, actionDigest: input.actionDigest };
    preparations.set(tab, state);
  }
  if (state.invalidated || state.binding !== binding || state.terminalDigest !== terminalDigest) {
    state.invalidated = true;
    fail("Threads canary action, UI binding or zero-thread evidence changed");
  }
  state.stableReads = Math.min(2, state.stableReads + 1);
  return state;
}

async function inspectCandidate(tab, input) {
  const read = await readZero(tab, input);
  const state = recordZero(tab, input, read);
  const target = await unique(read.region.locator(read.evidence.selector), "Threads exact native target");
  const trigger = await unique(target.locator('[role="button"]').filter({
    has: tab.playwright.locator('svg[aria-label="回覆"]'),
  }), "Threads target-scoped reply trigger", { enabled: true });
  const exhaustiveThread = state.stableReads === 2;
  const replyExhaustionCandidate = immutableJsonSnapshot({
    schema_version: 1, candidate_only: true, kind: "threads_explicit_zero",
    stable_reads: state.stableReads, observed_count: 0,
    action_digest: input.actionDigest, observed_url: read.observedUrl,
    document_binding: read.documentBinding, terminal_digest: state.terminalDigest,
  }, "Threads explicit-zero baseline");
  const base = { observedUrl: read.observedUrl, complete: false, exhaustiveThread,
    zeroThreadTerminalCandidate: exhaustiveThread, stable_reads: state.stableReads,
    totalReplies: 0, ownReplyCount: 0, exactOwnCount: 0, absence_proven: false,
    documentBinding: read.documentBinding, action_digest: input.actionDigest,
    terminal_digest: state.terminalDigest, replyExhaustionCandidate, trigger };
  const dialogs = tab.playwright.getByRole("dialog");
  if (await dialogs.count() === 0) {
    if (state.attempted) fail("Threads selected reply dialog disappeared");
    return base;
  }
  if (!state.attempted || !state.triggerBinding) fail("Threads pre-existing reply dialog has no source selection");
  const dialog = await unique(dialogs, "Threads selected reply dialog");
  const raw = await dialog.evaluate(readThreadsSelectedDialog, read.expected);
  if (!raw) fail("Threads selected dialog differs from the source target or account");
  if (typeof raw.composerText !== "string" || typeof raw.composerEmpty !== "boolean"
      || (!raw.composerEmpty && raw.composerText !== input.action.reply_text)) fail("Threads composer differs from the approved reply");
  const composer = await unique(dialog.getByRole("textbox"), "Threads selected composer");
  // The current browser API binds semantic locators, not persistent DOM IDs.
  // Revalidate the exact target, selected modal and unique editor on every use.
  const submit = await unique(dialog.getByRole("button", { name: "發佈", exact: true }), "Threads submit");
  // Close the race between the native target/account read, modal binding and
  // return to the caller. This remains read-only and never mints send proof.
  const finalNative = await readZero(tab, input);
  if (digestObject(finalNative.documentBinding) !== digestObject(read.documentBinding)
      || digestObject(finalNative.terminal) !== digestObject(read.terminal)) {
    fail("Threads URL, account or native target changed after composer binding");
  }
  const finalRaw = await dialog.evaluate(readThreadsSelectedDialog, finalNative.expected);
  // This callback's reviewed schema is flat (strings and booleans). Rebuild
  // that result in this realm, without relaxing the shared object guard.
  if (!finalRaw || digestObject({ ...finalRaw }) !== digestObject({ ...raw })
      || await composer.count() !== 1 || !(await composer.isVisible())) {
    fail("Threads selected dialog or composer changed after final native recheck");
  }
  const selection = immutableJsonSnapshot({ schema_version: 1, candidate_only: true,
    kind: "source_clicked_threads_native_reply", document_binding: read.documentBinding,
    action_digest: input.actionDigest, trigger_binding: state.triggerBinding,
    author_key: raw.author, body: raw.body, displayed_at: raw.displayedAt,
    native_datetime: raw.targetDatetime, ancestor_author: raw.ancestorAuthor,
    composer_placeholder: raw.placeholder, account_key: raw.account,
  }, "Threads selected-parent candidate");
  const selectionDigest = digestObject(selection);
  if (state.selectionDigest && state.selectionDigest !== selectionDigest) {
    fail("Threads selected modal or composer identity changed");
  }
  state.selectionDigest = selectionDigest;
  return { ...base, composer, submit, selectedParentCandidate: true,
    composer_initial_state: "empty", composerText: raw.composerText,
    composerEmpty: raw.composerEmpty, selection, selection_digest: selectionDigest };
}

export async function inspectThreadsCanarySurface(tab, rawAction) {
  if (running.has(tab)) fail("Threads canary candidate inspection is already running");
  running.add(tab);
  try { return await inspectCandidate(tab, actionInput(rawAction)); }
  catch (error) { const state = preparations.get(tab); if (state) state.invalidated = true; throw error; }
  finally { running.delete(tab); }
}

/** At most one target reply-opening click. Never fill, submit, claim or mint a receipt. */
export async function prepareThreadsCanaryReply(tab, rawAction) {
  if (running.has(tab)) fail("Threads canary preparation is already running");
  running.add(tab);
  try {
    const input = actionInput(rawAction);
    await inspectCandidate(tab, input);
    const before = await inspectCandidate(tab, input);
    const state = preparations.get(tab);
    if (state.attempted || !before.zeroThreadTerminalCandidate) fail("Threads source reply selection is unavailable or already attempted");
    const rechecked = await inspectCandidate(tab, input);
    if (digestObject(rechecked.replyExhaustionCandidate) !== digestObject(before.replyExhaustionCandidate)) {
      fail("Threads target or zero-thread baseline changed before reply selection");
    }
    state.triggerBinding = immutableJsonSnapshot({
      platform_comment_id: input.native.commentId, comment_permalink: input.native.commentUrl,
      author_key: input.native.author, role: "button", icon_label: "回覆",
    }, "Threads source reply trigger");
    state.attempted = true;
    await rechecked.trigger.click({ timeoutMs: 5000 });
    await tab.playwright.getByRole("dialog").waitFor({ state: "visible", timeoutMs: 10000 });
    const selected = await inspectCandidate(tab, input);
    if (!selected.composerEmpty) fail("Threads newly selected composer is not empty");
    const stable = await inspectCandidate(tab, input);
    if (!stable.composerEmpty || digestObject(stable.selection) !== digestObject(selected.selection)) {
      fail("Threads selected reply dialog is not stable");
    }
    return stable;
  } catch (error) { const state = preparations.get(tab); if (state) state.invalidated = true; throw error; }
  finally { running.delete(tab); }
}

/** Freshly resolve the same source-selected parent/modal before fill or submit. */
export async function revalidateThreadsSelection(tab, rawAction) {
  const selected = await inspectThreadsCanarySurface(tab, rawAction);
  if (!selected.selectedParentCandidate || !selected.selection_digest) {
    fail("Threads reply composer has no source-owned parent selection");
  }
  return selected;
}

/** Positive confirmation must visit and verify the discovered native own child. */
export async function inspectThreadsCanaryResult(tab, rawAction) {
  const input = actionInput(rawAction);
  return inspectThreadsPositiveResult(tab, input.action);
}

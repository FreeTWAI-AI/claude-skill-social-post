/** CUA IG source-clicked semantic selection candidate; never fill, claim or submit. */
import { digestObject, fail, immutableJsonSnapshot, unique } from "./comment_chrome_common.mjs";
import { assertAction } from "./comment_chrome_send_support.mjs";
import { liveReplyUrl } from "./comment_chrome_live_common.mjs";
import { inspectInstagram, prepareLiveReplyThread } from "./comment_chrome_instagram_surface.mjs";
import { requireCommentCuaTab } from "./comment_cua_runtime.mjs";

const selections = new WeakMap();
const running = new WeakSet();

function selectionInput(rawAction) {
  const action = immutableJsonSnapshot(rawAction, "Instagram semantic selection action");
  assertAction(action);
  if (action.scope.platform !== "instagram" || !/^[A-Za-z0-9._]+$/u.test(action.author_key ?? "")) {
    fail("Instagram semantic selection requires an exact native Instagram author");
  }
  const prefix = `@${action.author_key} `;
  if (!action.reply_text.startsWith(prefix) || action.reply_text.length <= prefix.length) {
    fail("Instagram approved reply must preserve its native target mention");
  }
  return { action, prefix, url: liveReplyUrl(action), actionDigest: digestObject(action) };
}

function requireBaseline(surface, input) {
  const proof = surface?.replyExhaustionCandidate;
  if (surface?.exhaustiveThread !== true || !proof || proof.candidate_only !== true
      || proof.stable_reads !== 2 || proof.action_digest !== input.actionDigest
      || proof.observed_url !== input.url || surface.observedUrl !== input.url
      || !Number.isSafeInteger(surface.totalReplies) || surface.totalReplies < 1
      || proof.declared_count !== surface.totalReplies || proof.observed_count !== surface.totalReplies
      || surface.ownReplyCount !== 0 || surface.exactOwnCount !== 0
      || surface.expansionPending !== false || !proof.document_binding || !proof.rows_digest) {
    fail("Instagram semantic selection requires the native positive-count zero-own baseline");
  }
  return surface;
}

// Current native page: one textarea in one post form. This describes a semantic
// form, not persistent node identity or an independent selected-parent hint.
function readNativeForm(form) {
  const visible = (node) => node.getClientRects().length > 0;
  const norm = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
  if (form.tagName !== "FORM" || !visible(form) || form.getAttribute("aria-busy") === "true"
      || form.querySelector('[role="progressbar"],[role="status"],[aria-busy="true"]')) return null;
  const editors = [...form.querySelectorAll('textarea,[role="textbox"]')];
  if (editors.length !== 1) return null;
  const [editor] = editors;
  if (editor.tagName !== "TEXTAREA" || !visible(editor)
      || editor.getAttribute("aria-label") !== "留言⋯⋯" || editor.getAttribute("placeholder") !== "留言⋯⋯"
      || editor.getAttribute("disabled") !== null || editor.getAttribute("readonly") !== null
      || typeof editor.value !== "string") return null;
  const submits = [...form.querySelectorAll('button,[role="button"]')]
    .filter((node) => visible(node) && norm(node.innerText) === "發佈");
  if (submits.length !== 1 || norm(form.innerText) !== "發佈") return null;
  return { formTag: "FORM", editorTag: "TEXTAREA", editorLabel: "留言⋯⋯",
    editorPlaceholder: "留言⋯⋯", submitLabel: "發佈", composerText: editor.value.normalize("NFC") };
}

async function readSelectionSurface(tab, input) {
  await requireCommentCuaTab(tab, input.url);
  const surface = requireBaseline(await inspectInstagram(tab, input.action, "before"), input);
  const composer = await unique(surface.composer, "Instagram semantic editor", { enabled: true });
  const article = await unique(tab.playwright.locator("article"), "Instagram semantic native article");
  const form = await unique(article.locator("form").filter({ has: composer }), "Instagram semantic native form");
  const raw = await form.evaluate(readNativeForm);
  if (!raw) fail("Instagram native unique form changed");
  const formEvidence = immutableJsonSnapshot({ ...raw }, "Instagram semantic form observation");
  await unique(surface.trigger, "Instagram exact-parent reply trigger", { enabled: true });
  await requireCommentCuaTab(tab, input.url);
  return { ...surface, composer, formEvidence };
}

function surfaceBinding(surface, input) {
  const { composerText: _text, ...form } = surface.formEvidence;
  return digestObject({ action_digest: input.actionDigest,
    native_thread: surface.replyExhaustionCandidate, form });
}

async function inspectSelected(tab, input, state) {
  if (!state?.attempted || state.invalidated || state.actionDigest !== input.actionDigest) {
    fail("Instagram semantic parent has no valid source-click selection");
  }
  const first = await readSelectionSurface(tab, input);
  const second = await readSelectionSurface(tab, input);
  if (surfaceBinding(first, input) !== state.binding || surfaceBinding(second, input) !== state.binding
      || first.formEvidence.composerText !== second.formEvidence.composerText
      || ![input.prefix, input.action.reply_text].includes(second.formEvidence.composerText)) {
    fail("Instagram source-selected parent, native form or draft changed");
  }
  const action = input.action;
  const triggerBinding = { platform_comment_id: action.comment_anchor.platform_comment_id,
    comment_permalink: action.comment_anchor.comment_permalink, author_key: action.author_key,
    expected_body: action.expected_body, role: "button", name: "回覆" };
  const selection = immutableJsonSnapshot({
    schema_version: 2, action_digest: input.actionDigest, observed_url: input.url,
    comment_key: action.scope.comment_key, platform_comment_id: action.comment_anchor.platform_comment_id,
    author_key: action.author_key, document_binding: second.replyExhaustionCandidate.document_binding,
    trigger_locator_digest: digestObject(triggerBinding), initial_text: input.prefix,
    selection_kind: "source_clicked_instagram_native_reply", composer_scope: "unique_native_post_form", stable_reads: 2,
  }, "Instagram source-clicked semantic selection");
  const selectionDigest = digestObject(selection);
  if (state.selectionDigest && state.selectionDigest !== selectionDigest) {
    fail("Instagram source-selected semantic evidence changed");
  }
  state.selectionDigest = selectionDigest;
  return { ...second, selectedParentCandidate: true, selection, selection_digest: selectionDigest,
    composer_initial_state: "native_target_mention", composer_initial_text: input.prefix,
    composerText: second.formEvidence.composerText, semantic_continuity_only: true };
}

/** Expand the existing bounded native thread, then source-click its reply once. */
export async function prepareInstagramCanarySelection(tab, rawAction) {
  if (running.has(tab)) fail("Instagram semantic selection is already running");
  running.add(tab);
  let state = selections.get(tab);
  try {
    const input = selectionInput(rawAction);
    if (state) fail("Instagram semantic selection was already attempted for this tab");
    state = { actionDigest: input.actionDigest, attempted: false, invalidated: false };
    selections.set(tab, state);
    await requireCommentCuaTab(tab, input.url);
    requireBaseline(await prepareLiveReplyThread(tab, input.action), input);
    const first = await readSelectionSurface(tab, input);
    const second = await readSelectionSurface(tab, input);
    if (first.formEvidence.composerText !== "" || second.formEvidence.composerText !== ""
        || surfaceBinding(first, input) !== surfaceBinding(second, input)) {
      fail("Instagram semantic selection will not overwrite a draft or changed parent");
    }
    state.binding = surfaceBinding(second, input);
    // The private latch proves this module invoked the exact target trigger;
    // the resulting @mention alone is never accepted as selection provenance.
    state.attempted = true;
    await second.trigger.click({ timeoutMs: 5000 });
    const selected = await inspectSelected(tab, input, state);
    if (selected.composerText !== input.prefix) fail("Instagram source click did not produce the exact native mention");
    return selected;
  } catch (error) {
    if (state) state.invalidated = true;
    throw error;
  } finally { running.delete(tab); }
}

/** Fresh positive-count parent/form/draft read before fill or a guarded submit. */
export async function revalidateInstagramCanarySelection(tab, rawAction) {
  if (running.has(tab)) fail("Instagram semantic selection is already running");
  running.add(tab);
  const state = selections.get(tab);
  try { return await inspectSelected(tab, selectionInput(rawAction), state); }
  catch (error) { if (state) state.invalidated = true; throw error; }
  finally { running.delete(tab); }
}

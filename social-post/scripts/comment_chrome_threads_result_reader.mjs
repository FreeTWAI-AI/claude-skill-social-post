/** Positive-only Threads readback through a native child permalink. No submit. */
import { digestObject, fail, unique } from "./comment_chrome_common.mjs";
import { liveReplyUrl, normalize } from "./comment_chrome_live_common.mjs";
import { threadsNativeTarget, readThreadsNativeComment } from "./comment_chrome_threads_reader.mjs";
import { getCommentCuaBrowser, isCommentCuaTab, requireCommentCuaTab } from "./comment_cua_runtime.mjs";

/** Discovery is not parent evidence. The candidate must be opened and verified. */
export function discoverThreadsOwnChildLinks(root, expected) {
  const links = [];
  for (const anchor of root.querySelectorAll("a[href]")) {
    if (!anchor.getClientRects().length) continue;
    const raw = anchor.getAttribute("href");
    let url;
    try { url = new URL(raw, expected.commentUrl); } catch { continue; }
    if (url.origin !== new URL(expected.commentUrl).origin || url.search || url.hash
        || url.username || url.password || raw.includes("\\") || raw.includes("%")) continue;
    const parts = url.pathname.match(/^\/@([A-Za-z0-9._-]+)\/post\/([A-Za-z0-9_-]+)\/?$/u);
    if (!parts || parts[1] !== expected.account || parts[2] === expected.postId
        || parts[2] === expected.commentId) continue;
    const times = [...anchor.querySelectorAll("time")].filter((node) => node.getClientRects().length);
    if (times.length !== 1 || !times[0].getAttribute("datetime")) continue;
    const permalink = `${url.origin}/@${parts[1]}/post/${parts[2]}`;
    if (!links.some((link) => link.permalink === permalink)) links.push({ permalink, id: parts[2] });
  }
  return links;
}

function targetForAction(action) {
  return threadsNativeTarget({ platform: "threads", account_key: action.scope.account_key,
    post_key: action.scope.post_key, post_permalink: action.post_permalink,
    comment_permalink: liveReplyUrl(action), platform_comment_id: action.comment_anchor.platform_comment_id });
}

function requireParent(read, action) {
  if (read.evidence.author !== action.author_key || read.evidence.body !== normalize(action.expected_body)
      || !Number.isSafeInteger(read.evidence.replyCount) || read.evidence.replyCount < 1) {
    fail("Threads result has no verified parent with a positive native reply count");
  }
}

async function waitForFocus(tab, native) {
  const column = tab.playwright.getByRole("region", { name: "直欄內文", exact: true });
  await column.waitFor({ state: "visible", timeoutMs: 10000 });
  await unique(column, "Threads result column");
  await column
    .locator(`a[href=${JSON.stringify(native.targetPath)}]`).filter({ has: tab.playwright.locator("time") })
    .waitFor({ state: "visible", timeoutMs: 10000 });
}

async function verifyNativeChild(tab, child, native, action) {
  await waitForFocus(tab, child);
  const first = await readThreadsNativeComment(tab, child);
  const second = await readThreadsNativeComment(tab, child);
  if (first.evidence.author !== native.account || second.evidence.author !== native.account
      || first.evidence.body !== normalize(action.reply_text)
      || second.evidence.body !== normalize(action.reply_text)
      || digestObject(first.documentBinding) !== digestObject(second.documentBinding)
      || digestObject(first.evidence) !== digestObject(second.evidence)) {
    fail("Threads native child does not prove the approved text and immediate parent");
  }
}

async function verifyCuaNativeChild(parentTab, child, native, action) {
  await requireCommentCuaTab(parentTab, native.commentUrl);
  // Direct creation preserves CUA DOM control. Never borrow an existing child
  // tab or navigate the original parent merely to inspect this observed link.
  const childTab = await getCommentCuaBrowser().tabs.new(child.commentUrl);
  try {
    await requireCommentCuaTab(childTab, child.commentUrl);
    await verifyNativeChild(childTab, child, native, action);
    await requireCommentCuaTab(childTab, child.commentUrl);
  } finally {
    let timer;
    try {
      await Promise.race([childTab.close(), new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]);
    } catch { /* owned-tab cleanup never retries or submits */ }
    finally { clearTimeout(timer); }
  }
  await requireCommentCuaTab(parentTab, native.commentUrl);
}

export async function inspectThreadsPositiveResult(tab, action) {
  const native = targetForAction(action);
  const cua = isCommentCuaTab(tab);
  if (cua) await requireCommentCuaTab(tab, native.commentUrl);
  const parent = await readThreadsNativeComment(tab, native);
  requireParent(parent, action);
  const raw = await parent.region.evaluate(discoverThreadsOwnChildLinks, native);
  if (!Array.isArray(raw) || raw.length !== 1) fail("Threads result has no unique own child candidate");
  if (await tab.url() !== parent.observedUrl) fail("Threads target changed during child discovery");
  const candidate = { permalink: String(raw[0].permalink), id: String(raw[0].id) };
  const child = { ...threadsNativeTarget({ platform: "threads", account_key: native.account,
    post_key: native.commentId, post_permalink: native.commentUrl,
    comment_permalink: candidate.permalink, platform_comment_id: candidate.id }),
    // Child pages show the original post and immediate parent as two native
    // context rows. This positive-only chain is never passed to zero intake.
    resultAncestorPaths: [native.postPath, native.targetPath],
  };
  if (cua) {
    await verifyCuaNativeChild(tab, child, native, action);
  } else try {
    // Only the observed own-account candidate is visited. Row ordering or a
    // count match alone never establishes which comment received the reply.
    await tab.goto(child.commentUrl);
    await verifyNativeChild(tab, child, native, action);
  } finally {
    // Restore the action URL for the existing finish/recovery receipt contract.
    // A failed restore remains unknown and must never trigger another submit.
    await tab.goto(native.commentUrl);
    await waitForFocus(tab, native);
  }
  const restored = await readThreadsNativeComment(tab, native);
  requireParent(restored, action);
  const finalRaw = await restored.region.evaluate(discoverThreadsOwnChildLinks, native);
  if (!Array.isArray(finalRaw) || finalRaw.length !== 1 || finalRaw[0].permalink !== candidate.permalink
      || restored.evidence.replyCount < parent.evidence.replyCount) {
    fail("Threads parent or own child changed during result verification");
  }
  const finalParent = await readThreadsNativeComment(tab, native);
  requireParent(finalParent, action);
  if (digestObject(finalParent.documentBinding) !== digestObject(restored.documentBinding)
      || digestObject(finalParent.evidence) !== digestObject(restored.evidence)
      || await tab.url() !== finalParent.observedUrl) {
    fail("Threads target changed after final child discovery");
  }
  if (cua) await requireCommentCuaTab(tab, native.commentUrl);
  return { observedUrl: restored.observedUrl, complete: false,
    verifiedNewReply: true, exactOwnCount: 1, ownReplyCount: 1,
    totalReplies: restored.evidence.replyCount, replyPermalink: candidate.permalink,
    absence_verified: false, evidence_kind: "native_child_immediate_parent_and_exact_body" };
}

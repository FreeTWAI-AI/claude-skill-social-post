/** Read-only Instagram native target rows; no reply lifecycle authority. */
import {
  digestObject, fail, immutableJsonSnapshot, instagramUrlIdentity, requiredString, unique,
} from "./comment_chrome_common.mjs";
import { trustedUrl } from "./comment_chrome_live_common.mjs";

const instagramTabIds = new WeakMap();

export function instagramNativeTarget(rawTarget) {
  const target = immutableJsonSnapshot(rawTarget, "Instagram native target identity");
  if (target?.platform !== "instagram") fail("native target reading is only verified for Instagram");
  const post = trustedUrl("instagram", target.post_permalink);
  const comment = trustedUrl("instagram", target.comment_permalink);
  const postIdentity = instagramUrlIdentity(target.post_permalink);
  const identity = instagramUrlIdentity(target.comment_permalink, { allowComment: true });
  const account = requiredString(target.account_key, "Instagram account").replace(/^@/u, "");
  if (!/^[A-Za-z0-9._]+$/u.test(account) || !identity.commentId
      || comment.hostname !== post.hostname || identity.shortcode !== postIdentity.shortcode
      || identity.query !== postIdentity.query || identity.shortcode !== target.post_key
      || identity.commentId !== target.platform_comment_id) {
    fail("Instagram native target differs from its approved account, post or comment identity");
  }
  return { account, commentUrl: comment.toString(),
    anchorPath: `/p/${identity.shortcode}/c/${identity.commentId}/`, commentId: identity.commentId };
}

function rehydrateInstagramRow(raw) {
  const keys = ["author", "authorDisplay", "body", "path"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || Object.keys(raw).length !== keys.length
      || keys.some((key) => !Object.hasOwn(raw, key) || typeof raw[key] !== "string" || !raw[key])) {
    fail("Instagram native reply row has an unexpected string schema");
  }
  return { author: raw.author, authorDisplay: raw.authorDisplay, body: raw.body, path: raw.path };
}

export async function readInstagramNativeComment(tab, native) {
  const tabId = requiredString(tab.id, "Instagram source-owned tab id");
  const previousTabId = instagramTabIds.get(tab);
  if (previousTabId !== undefined && previousTabId !== tabId) fail("Instagram source-owned tab id changed");
  instagramTabIds.set(tab, tabId);
  const observedUrl = trustedUrl("instagram", await tab.url()).toString();
  if (observedUrl !== native.commentUrl) fail("live reply left its approved comment URL");
  const { account, anchorPath } = native;
  const readAccount = (expected) => {
    const links = [...document.querySelectorAll('a[href]')].filter((a) => {
      if (a.closest('main,[role="dialog"]') || !a.querySelector('img[alt$="的大頭貼照"]')) return false;
      for (let p = a.parentElement, depth = 0; p && depth < 7; p = p.parentElement, depth += 1) {
        if (p.querySelector('main,article,[role="dialog"]')) break;
        if (['首頁', '搜尋', '新貼文'].every((label) => p.querySelector(`svg[aria-label="${label}"]`))) return true;
      }
      return false;
    });
    const valid = links.length > 0 && links.length <= 4 && links.every((a) =>
      a.getAttribute("href") === `/${expected}/`
      && a.querySelector('img')?.getAttribute("alt") === `${expected}的大頭貼照`)
      && links.some((a) => a.getClientRects().length > 0);
    return valid;
  };
  const accountEvidence = await tab.playwright.evaluate(readAccount, account);
  if (!accountEvidence) fail("Instagram active account navigation changed");
  const article = await unique(tab.playwright.locator("article"), "Instagram native post article");
  const target = article.locator("li").filter({ has: tab.playwright.locator(`a[href=${JSON.stringify(anchorPath)}]`) });
  await unique(target, "Instagram native parent comment");
  const evidence = await target.evaluate((li, expected) => {
    const norm = (s) => String(s ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
    // Native comment-page layout: H3 author, whole body sibling, controls sibling.
    // Never accept an exact descendant fragment from a longer comment.
    const read = (item) => {
      const headings = [...item.querySelectorAll("h3")].filter((h) => h.closest("li") === item);
      if (headings.length !== 1) return null;
      const heading = headings[0];
      const body = heading.nextElementSibling;
      const controls = body?.nextElementSibling;
      const links = [...heading.querySelectorAll('a[href]')];
      if (!body || !controls || links.length !== 1 || body.tagName !== "DIV"
          || !controls.querySelector('a[href] time')
          || body.querySelector('button,[role="button"]')) return null;
      const handle = links[0].getAttribute("href").match(/^\/([A-Za-z0-9._]+)\/$/u)?.[1];
      const anchors = [...controls.querySelectorAll('a[href]')].filter((a) => a.querySelector("time"));
      const bodyText = norm(body.innerText);
      if (!handle || anchors.length !== 1 || !body.getClientRects().length || !bodyText) return null;
      return { author: handle, authorDisplay: norm(links[0].innerText) || handle,
        body: bodyText, path: anchors[0].getAttribute("href") };
    };
    const parent = read(li);
    if (!parent || parent.path !== expected.path) return { valid: false };
    const thread = li.closest("ul");
    if (!thread) return { valid: false };
    const children = [...thread.querySelectorAll("li")].filter((item) => item !== li);
    const replies = [];
    for (const item of children) {
      if (![...item.querySelectorAll("h3")].some((h) => h.closest("li") === item)) continue;
      const row = read(item);
      if (!row || !row.path.startsWith(`${expected.path}r/`)
          || !/^\d+\/$/u.test(row.path.slice(`${expected.path}r/`.length))) return { valid: false };
      replies.push(row);
    }
    if (new Set(replies.map((row) => row.path)).size !== replies.length) return { valid: false };
    const visible = (node) => node.getClientRects().length > 0;
    const controls = [...thread.querySelectorAll('button,[role="button"]')].filter(visible);
    const rootControls = controls.filter((node) => {
      // Native disclosure wrappers may nest LI > UL > LI without owning an
      // author H3. Never cross a real child comment's LI-owned author heading.
      let ancestor = node.parentElement;
      for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
        if (ancestor === thread) return true;
        if (ancestor.tagName === "LI" && ancestor !== li
            && [...ancestor.querySelectorAll("h3")].some((heading) => heading.closest("li") === ancestor)) {
          return false;
        }
      }
      return false;
    });
    const label = (node) => norm(node.getAttribute("aria-label") || node.innerText);
    const expandControls = rootControls.filter((node) => /^查看回覆/u.test(label(node)));
    const expandLabel = expandControls.length === 1 ? label(expandControls[0]) : null;
    const countMatch = expandLabel?.match(/^查看回覆（([1-9]\d*)）$/u);
    const hideControlCount = rootControls.filter((node) => label(node) === "隱藏回覆").length;
    const loading = thread.getAttribute("aria-busy") === "true"
      || [...thread.querySelectorAll('[role="progressbar"],[role="status"],[aria-busy="true"]')]
        .some((node) => visible(node) && (node.getAttribute("role") === "progressbar"
          || node.getAttribute("aria-busy") === "true" || /載入中/u.test(label(node))));
    const pendingControlCount = controls.filter(
      (node) => /查看.*回覆|顯示.*回覆|載入中|載入更多/u.test(label(node)),
    ).length;
    const expansionPending = loading || pendingControlCount > 0;
    const own = replies.filter((row) => row.author === expected.account);
    return { valid: true, parent, totalReplies: replies.length, ownReplyCount: own.length,
      rows: replies.sort((a, b) => a.path.localeCompare(b.path)),
      loading, expansionPending,
      expandControlCount: expandControls.length, expandLabel, pendingControlCount,
      expandCount: countMatch ? Number(countMatch[1]) : null, hideControlCount };
  }, { path: anchorPath, account });
  if (!evidence.valid) fail("Instagram native parent, author or complete body changed");
  // Browser evaluation may return another realm's plain objects/array. Rebuild
  // only this reviewed row schema; retain the global immutable-JSON guard.
  if (!Array.isArray(evidence.rows)) fail("Instagram native reply rows are not an array");
  const rows = [];
  for (const row of evidence.rows) rows.push(rehydrateInstagramRow(row));
  evidence.rows = rows;
  evidence.parent = rehydrateInstagramRow(evidence.parent);
  const endAccount = await tab.playwright.evaluate(readAccount, account);
  if (trustedUrl("instagram", await tab.url()).toString() !== observedUrl
      || tab.id !== tabId || !endAccount) {
    fail("Instagram native tab, account or URL changed while reading its target");
  }
  // This is observed UI continuity, not a physical document epoch or node ID.
  // A same-URL reload with identical UI is deliberately not claimed detectable.
  evidence.documentBinding = immutableJsonSnapshot({
    schema_version: 1, kind: "source_owned_ui_continuity", tab_id: tabId,
    observed_url: observedUrl,
    target_digest: digestObject({ account_key: native.account, comment_permalink: native.commentUrl,
      author_key: evidence.parent.author, body: evidence.parent.body }),
  }, "Instagram source-owned UI continuity");
  return { observedUrl, article, target, evidence };
}

/** Read one native comment from its approved identity; no caller body or author is used. */
export async function readLiveTargetComment(tab, target) {
  const native = instagramNativeTarget(target);
  const { observedUrl, evidence } = await readInstagramNativeComment(tab, native);
  return immutableJsonSnapshot({
    comment: {
      platform_comment_id: native.commentId, comment_permalink: native.commentUrl,
      observed_parent_post_permalink: new URL(
        evidence.parent.path.replace(/\/c\/[^/]+\/$/u, ""), observedUrl,
      ).toString(),
      author_key: evidence.parent.author, author_display: evidence.parent.authorDisplay,
      body: evidence.parent.body, body_complete: true,
      is_own: evidence.parent.author === native.account,
      // This is observed presence only; the raw intake never certifies absence.
      has_own_reply: evidence.ownReplyCount > 0, language: null,
    },
    documentBinding: evidence.documentBinding, observedUrl,
  }, "Instagram native target comment observation");
}

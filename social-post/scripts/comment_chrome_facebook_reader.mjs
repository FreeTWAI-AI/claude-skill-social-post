/** Source-owned, read-only Facebook native target intake. No send authority. */
import { digestObject, fail, immutableJsonSnapshot, requiredString, unique } from "./comment_chrome_common.mjs";
import { trustedUrl } from "./comment_chrome_live_common.mjs";
import { verifyFacebookAccount } from "./comment_chrome_facebook_surface.mjs";

export function facebookNativeTarget(rawTarget) {
  const target = immutableJsonSnapshot(rawTarget, "Facebook native target identity");
  if (target?.platform !== "facebook") fail("Facebook native target platform differs");
  const post = trustedUrl("facebook", target.post_permalink);
  const comment = trustedUrl("facebook", target.comment_permalink);
  const account = requiredString(target.account_key, "Facebook account");
  const id = requiredString(target.platform_comment_id, "Facebook comment id");
  const match = post.pathname.match(/^\/([A-Za-z0-9.]+)\/posts\/([A-Za-z0-9]+)$/u);
  if (!/^[A-Za-z0-9.]+$/u.test(account) || !/^\d+$/u.test(id) || !match
      || match[2] !== target.post_key || post.search
      || comment.hostname !== post.hostname || comment.pathname !== post.pathname
      || [...comment.searchParams].length !== 1 || comment.searchParams.get("comment_id") !== id) {
    fail("Facebook target requires an exact native post and one parent comment id");
  }
  return { account, commentId: id, postUrl: post.toString(), commentUrl: comment.toString(),
    postPath: post.pathname, host: post.hostname };
}

/** Whole native language container, never an arbitrary matching descendant. */
export function readFacebookNativeRow(article, expected) {
  const norm = (s) => String(s ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
  const visible = (el) => el.getClientRects().length > 0;
  const rich = (node) => {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return "";
    if (node.tagName === "IMG") return node.getAttribute("alt") || "";
    if (node.tagName === "BR") return "\n";
    return [...node.childNodes].map(rich).join("");
  };
  const owned = (el) => el.closest('[role="article"]') === article;
  const bodies = [...article.querySelectorAll('[dir="auto"][lang]')].filter((el) =>
    visible(el) && owned(el) && !el.closest('a,[role="button"]')
    && !el.parentElement.closest('[dir="auto"][lang]'));
  if (bodies.length !== 1) return null;
  const body = bodies[0];
  if (body.querySelector('button,[role="button"],[aria-expanded="false"]')
      || body.getAttribute("aria-expanded") === "false") return null;
  const bodyText = norm(rich(body));
  if (!bodyText) return null;
  const links = [...article.querySelectorAll('a[href]')].filter((a) => owned(a) && !body.contains(a));
  const native = [];
  const authors = [];
  for (const link of links) {
    let url;
    try { url = new URL(link.getAttribute("href"), expected.origin); } catch { return null; }
    if (url.protocol !== "https:" || url.hostname !== expected.host) continue;
    if (url.pathname.replace(/\/$/u, "") === expected.postPath) {
      if (url.searchParams.getAll("comment_id").length !== 1) return null;
      native.push({ id: url.searchParams.get("comment_id"),
        child: url.searchParams.has("reply_comment_id") || url.searchParams.has("reply_id") });
      continue;
    }
    const handle = url.pathname.match(/^\/([A-Za-z0-9.]+)\/?$/u)?.[1];
    if (url.pathname === "/profile.php" && url.searchParams.getAll("id").length !== 1) return null;
    const profileId = url.pathname === "/profile.php" ? url.searchParams.get("id") : null;
    const key = profileId && /^\d+$/u.test(profileId) ? profileId : handle;
    const display = norm(link.innerText);
    if (key && visible(link) && display && !link.querySelector('img') && key !== "profile.php") {
      authors.push({ key, display });
    }
  }
  if (!native.length || native.some((a) => a.id !== expected.commentId || a.child)
      || new Set(authors.map((a) => a.key)).size !== 1) return null;
  const label = article.getAttribute("aria-label") || "";
  // Avatar links may contain an online-status label instead of the name.
  const named = authors.filter((author) => label.startsWith(`${author.display}的留言`));
  if (new Set(named.map((author) => author.display)).size !== 1) return null;
  const author = named[0];
  // Expander controls elsewhere in the row can truncate the language container.
  if ([...article.querySelectorAll('button,[role="button"]')].some((button) =>
    owned(button) && visible(button) && /^(查看更多|顯示更多|See more)$/u.test(norm(button.innerText)))) return null;
  return { author: author.key, authorDisplay: author.display, body: bodyText };
}

/** Positive own-child presence only; never infer an exhaustive empty thread. */
export function readFacebookOwnReplyPresence(article, expected) {
  const links = (item) => [...item.querySelectorAll('a[href]')].filter((a) =>
    a.closest('[role="article"]') === item && !a.closest('[dir="auto"][lang]'));
  const urlOf = (a) => { try { return new URL(a.getAttribute("href"), expected.origin); } catch { return null; } };
  const nativeChild = (item) => links(item).some((a) => {
    const url = urlOf(a);
    return url?.protocol === "https:" && url.hostname === expected.host
      && url.pathname.replace(/\/$/u, "") === expected.postPath
      && url.searchParams.getAll("comment_id").length === 1
      && url.searchParams.get("comment_id") === expected.commentId
      && url.searchParams.getAll("reply_comment_id").length === 1
      && /^\d+$/u.test(url.searchParams.get("reply_comment_id"));
  });
  let children = [];
  for (let wrapper = article.parentElement, depth = 0; wrapper && depth < 8; wrapper = wrapper.parentElement, depth += 1) {
    if (wrapper.getAttribute("role") === "dialog") break;
    const rows = [...wrapper.querySelectorAll('[role="article"]')].filter((item) => item !== article);
    if (rows.some((row) => !nativeChild(row))) break;
    children = rows;
  }
  return children.some((child) => links(child).some((link) => {
    const url = urlOf(link);
    if (!url || url.protocol !== "https:" || url.hostname !== expected.host) return false;
    return url.pathname.replace(/\/$/u, "") === `/${expected.account}`
      || (url.pathname === "/profile.php" && url.searchParams.getAll("id").length === 1
        && url.searchParams.get("id") === expected.account);
  }));
}

function targetLocator(tab, native) {
  const anchor = tab.playwright.locator(
    `a[href*=${JSON.stringify(`${native.postPath}?comment_id=${native.commentId}`)}]`
    + ':not([href*="reply_comment_id="]):not([href*="reply_id="])',
  );
  return tab.playwright.getByRole("article").filter({ has: anchor });
}

export async function readFacebookTargetComment(tab, rawTarget) {
  const native = facebookNativeTarget(rawTarget);
  const tabId = requiredString(tab.id, "Facebook source-owned tab id");
  const observedUrl = trustedUrl("facebook", await tab.url()).toString();
  if (observedUrl !== native.commentUrl) fail("Facebook target URL changed");
  await verifyFacebookAccount(tab, { scope: { account_key: native.account } });
  const locator = targetLocator(tab, native);
  await locator.waitFor({ state: "visible", timeoutMs: 15000 });
  const article = await unique(locator, "Facebook native parent comment");
  const raw = await article.evaluate(readFacebookNativeRow, { ...native, origin: observedUrl });
  if (!raw || !["author", "authorDisplay", "body"].every((key) => typeof raw[key] === "string" && raw[key])) {
    fail("Facebook whole native body, author or parent anchor is ambiguous");
  }
  // Rebuild the reviewed cross-realm schema. This target-only read does not
  // certify child coverage or absence; sending still needs independent proof.
  const hasOwnReply = await article.evaluate(readFacebookOwnReplyPresence, { ...native, origin: observedUrl });
  if (typeof hasOwnReply !== "boolean") fail("Facebook own-reply presence evidence is invalid");
  const comment = { platform_comment_id: native.commentId, comment_permalink: native.commentUrl,
    observed_parent_post_permalink: native.postUrl, author_key: raw.author,
    author_display: raw.authorDisplay, body: raw.body, body_complete: true,
    is_own: raw.author === native.account, has_own_reply: hasOwnReply, language: null };
  if (tab.id !== tabId || trustedUrl("facebook", await tab.url()).toString() !== observedUrl) {
    fail("Facebook native tab or URL changed during target reading");
  }
  await verifyFacebookAccount(tab, { scope: { account_key: native.account } });
  if (tab.id !== tabId || trustedUrl("facebook", await tab.url()).toString() !== observedUrl) {
    fail("Facebook native tab or URL changed during account verification");
  }
  return immutableJsonSnapshot({ comment, observedUrl, documentBinding: {
    schema_version: 1, kind: "source_owned_ui_continuity", tab_id: tabId,
    observed_url: observedUrl, target_digest: digestObject({ account_key: native.account,
      comment_permalink: native.commentUrl, author_key: comment.author_key, body: comment.body }),
  } }, "Facebook native target comment observation");
}

/** Shared pure URL and text guards for source-owned live platform readers. */
import {
  canonicalUrl, fail, instagramUrlIdentity, LIVE_HOSTS, requiredString,
} from "./comment_chrome_common.mjs";
import { assertAction } from "./comment_chrome_send_support.mjs";

export function trustedUrl(platform, raw) {
  const url = canonicalUrl(raw);
  if (url.protocol !== "https:" || !LIVE_HOSTS[platform]?.has(url.hostname)) {
    fail("live reply URL is not a trusted platform URL");
  }
  return url;
}

export function liveReplyUrl(action) {
  assertAction(action);
  const platform = action.scope.platform;
  const post = trustedUrl(platform, action.post_permalink);
  const raw = action.comment_anchor.comment_permalink;
  const target = raw ? trustedUrl(platform, raw) : new URL(post);
  if (target.hostname !== post.hostname) fail("reply and post hosts differ");
  if (platform === "threads") {
    if (!raw || !/^\/@[^/]+\/post\/[^/]+$/u.test(target.pathname) || target.search) {
      fail("Threads reply requires its exact stored comment permalink");
    }
    if (action.comment_anchor.platform_comment_id
        && target.pathname.split("/").at(-1) !== action.comment_anchor.platform_comment_id) {
      fail("Threads comment id and permalink differ");
    }
  } else if (platform === "instagram") {
    const parent = instagramUrlIdentity(action.post_permalink);
    const comment = instagramUrlIdentity(raw || action.post_permalink, { allowComment: true });
    if (comment.shortcode !== parent.shortcode || comment.query !== parent.query) {
      fail("Instagram reply URL differs from the approved post identity");
    }
    if (raw && !comment.commentId) fail("Instagram reply requires a native comment permalink");
    if (comment.commentId && comment.commentId !== requiredString(
      action.comment_anchor.platform_comment_id, "Instagram comment id",
    )) fail("Instagram comment id and permalink differ");
  } else {
    if (target.pathname !== post.pathname && !target.pathname.startsWith(`${post.pathname}/`)) {
      fail("reply URL is outside the approved post path");
    }
    for (const [key, value] of post.searchParams) {
      if (!target.searchParams.getAll(key).includes(value)) fail("reply URL lost an approved query");
    }
    if (platform === "facebook") {
      const id = requiredString(action.comment_anchor.platform_comment_id, "Facebook comment id");
      if (raw && target.searchParams.get("comment_id") !== id) fail("Facebook comment id differs");
      target.searchParams.set("comment_id", id);
    }
  }
  return target.toString();
}

export function normalize(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
}

export async function currentUrl(tab, action) {
  const observed = trustedUrl(action.scope.platform, await tab.url());
  const expected = trustedUrl(action.scope.platform, liveReplyUrl(action));
  if (observed.toString() !== expected.toString()) fail("live reply left its approved comment URL");
  return observed.toString();
}

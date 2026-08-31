/** Pure URL/guard tests; never claims a permit or opens a browser. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspectLiveReplySurface, liveReplyUrl } from "./comment_chrome_live_surface.mjs";

function action(platform, post, comment, id) {
  const reply = "Thanks!";
  return {
    action_id: "test", intent_id: "test", session_id: "test", permit_id: "test",
    comment_fingerprint: "test", expected_body: "Useful update", reply_text: reply,
    reply_hash: createHash("sha256").update(reply).digest("hex"),
    scope: { platform, account_key: "example", post_key: "abc", comment_key: "c1" },
    post_permalink: post, comment_anchor: { comment_permalink: comment, platform_comment_id: id },
  };
}
const threads = action("threads", "https://www.threads.com/@example/post/abc",
  "https://www.threads.com/@reader/post/c1", "c1");
const facebook = action("facebook", "https://www.facebook.com/example/posts/abc",
  "https://www.facebook.com/example/posts/abc?comment_id=123", "123");
const instagram = action("instagram", "https://www.instagram.com/p/abc",
  "https://www.instagram.com/p/abc/c/123", "123");
assert.equal(liveReplyUrl(threads), threads.comment_anchor.comment_permalink);
assert.equal(liveReplyUrl(facebook), facebook.comment_anchor.comment_permalink);
assert.equal(liveReplyUrl(instagram), instagram.comment_anchor.comment_permalink);
for (const kind of ["p", "reel", "reels", "tv"]) {
  const aliased = { ...instagram, post_permalink: `https://www.instagram.com/${kind}/abc/` };
  assert.equal(liveReplyUrl(aliased), instagram.comment_anchor.comment_permalink);
}
for (const url of [
  "https://www.instagram.com/p/wrong/c/123", "https://www.instagram.com/p/abc/c/other",
  "https://www.instagram.com/p/abc/c/123/c/other", "https://www.instagram.com/p/abc/c/123%2Fother",
  "https://www.instagram.com/p/abc/c/123?comment_id=other", "https://www.instagram.com/p/abc/c/123?x=1&x=1",
  "https://www.instagram.com/p/abc/c/123?x=1", "https://instagram.com/p/abc/c/123",
  "https://user@www.instagram.com/p/abc/c/123", "https://www.instagram.com:444/p/abc/c/123",
  "https://www.instagram.com/p/abc/c/other/../123", "https://www.instagram.com/p/abc",
]) {
  assert.throws(() => liveReplyUrl({ ...instagram, comment_anchor: {
    ...instagram.comment_anchor, comment_permalink: url,
  } }));
}
assert.equal(liveReplyUrl({ ...facebook, comment_anchor: { platform_comment_id: "123" } }), facebook.comment_anchor.comment_permalink);
for (const url of [
  "https://evil.example/@reader/post/c1", "http://www.threads.com/@reader/post/c1",
  "https://www.threads.com:444/@reader/post/c1", "https://user@www.threads.com/@reader/post/c1",
  "https://www.threads.com/@reader/post/other", "https://www.threads.com/@reader/post/c1?fake=1",
  "https://www.threads.com/@reader", "https://threads.net/@reader/post/c1",
]) {
  assert.throws(() => liveReplyUrl({ ...threads, comment_anchor: { ...threads.comment_anchor, comment_permalink: url } }));
}
for (const original of [facebook, instagram]) {
  assert.throws(() => liveReplyUrl({ ...original, comment_anchor: {
    ...original.comment_anchor, comment_permalink: original.comment_anchor.comment_permalink.replace("/abc", "/wrong"),
  } }));
}
assert.throws(() => liveReplyUrl({ ...facebook, comment_anchor: { ...facebook.comment_anchor, platform_comment_id: "wrong" } }));
assert.throws(() => liveReplyUrl({ ...threads, reply_text: "Changed approval" }));
await assert.rejects(inspectLiveReplySurface(null, threads, "invented-phase"), /unknown live reply inspection phase/u);
console.log("PASS live surface URL guards (pure tests; no browser submission)");

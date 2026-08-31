/** Pure URL and synthetic-DOM guards; never claims a permit or opens a browser. */
import assert from "node:assert/strict";
import { inspectLiveReplySurface, liveReplyUrl } from "./comment_chrome_live_surface.mjs";
import { action, instagram, nativeFixtures } from "./comment_chrome_live_surface_fixture_testonly.mjs";
import { nativeInstagramCandidateTests } from "./comment_chrome_live_surface_candidate_cases_test.mjs";
import {
  nativeInstagramCanaryTests, nativeInstagramCrossRealmSchemaTests, nativeInstagramTargetTests,
} from "./comment_chrome_live_surface_observation_cases_test.mjs";

const threads = action("threads", "https://www.threads.com/@example/post/abc",
  "https://www.threads.com/@reader/post/c1", "c1");
const facebook = action("facebook", "https://www.facebook.com/example/posts/abc",
  "https://www.facebook.com/example/posts/abc?comment_id=123", "123");
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

await nativeInstagramCandidateTests();
await nativeInstagramTargetTests();
await nativeInstagramCanaryTests();
await nativeInstagramCrossRealmSchemaTests();
for (const fixture of nativeFixtures) {
  assert.equal(fixture.counters.submit, 0);
  assert.equal(fixture.counters.fill, 0);
  assert.equal(fixture.counters.otherClick, 0);
  assert.ok(fixture.counters.expand <= 1);
  assert.ok(fixture.counters.readinessWait <= 1);
}
console.log("PASS live surface URL guards (pure tests; no browser submission)");

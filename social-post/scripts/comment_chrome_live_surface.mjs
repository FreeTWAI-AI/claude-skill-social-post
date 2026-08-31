/** Source-owned live Meta surface routing; no caller-supplied adapter authority. */
import { fail } from "./comment_chrome_common.mjs";
import { assertAction, bindObservedSubmitNode } from "./comment_chrome_send_support.mjs";
import { inspectFacebook } from "./comment_chrome_facebook_surface.mjs";
import { inspectThreads } from "./comment_chrome_threads_surface.mjs";
import { inspectInstagram } from "./comment_chrome_instagram_surface.mjs";
import { readLiveTargetComment as readInstagramTargetComment } from "./comment_chrome_instagram_reader.mjs";
import { readFacebookTargetComment } from "./comment_chrome_facebook_reader.mjs";
import { readThreadsTargetComment } from "./comment_chrome_threads_reader.mjs";

export { bindLiveReplyBrowser } from "./comment_chrome_facebook_surface.mjs";
export { liveReplyUrl } from "./comment_chrome_live_common.mjs";
export {
  prepareLiveReplyThread, inspectLiveCanaryResult,
} from "./comment_chrome_instagram_surface.mjs";

export const LIVE_REPLY_ADAPTER_VERSION = "2026-08-31.6";

export async function readLiveTargetComment(tab, target) {
  if (target?.platform === "instagram") return readInstagramTargetComment(tab, target);
  if (target?.platform === "facebook") return readFacebookTargetComment(tab, target);
  if (target?.platform === "threads") return readThreadsTargetComment(tab, target);
  fail("native target reader has not been verified for this platform");
}

export async function inspectLiveReplySurface(tab, action, phase = "before") {
  assertAction(action);
  if (!["before", "after"].includes(phase)) fail("unknown live reply inspection phase");
  if (action.scope.platform === "threads") return inspectThreads(tab, action, phase);
  if (action.scope.platform === "facebook") return inspectFacebook(tab, action, phase);
  if (action.scope.platform === "instagram") return inspectInstagram(tab, action, phase);
  fail(`${action.scope.platform} live reply surface has not been verified`);
}

export const bindLiveSubmitNode = bindObservedSubmitNode;

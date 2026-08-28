/** Thin, fail-closed live-Chrome actuator facade for Social Post comments. */

import { createScanPost } from "./comment_chrome_scan.mjs";
import { createSendOperations } from "./comment_chrome_send.mjs";


export function createCommentChromeActuator(options = {}) {
  const scanPost = createScanPost(options);
  const send = createSendOperations(options);
  return Object.freeze({ scanPost, ...send });
}

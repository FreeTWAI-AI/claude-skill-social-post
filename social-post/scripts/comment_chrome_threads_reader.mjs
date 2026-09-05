/** Source-owned, read-only Threads native target intake. No send authority. */
import { digestObject, fail, immutableJsonSnapshot, requiredString, unique } from "./comment_chrome_common.mjs";
import { trustedUrl } from "./comment_chrome_live_common.mjs";

export function threadsNativeTarget(rawTarget) {
  const target = immutableJsonSnapshot(rawTarget, "Threads native target identity");
  if (target?.platform !== "threads") fail("Threads native target platform differs");
  const nativeUrl = (raw) => {
    const url = trustedUrl("threads", raw);
    const original = new URL(raw);
    const rawPath = raw.match(/^https:\/\/[^/?#]+([^?#]*)/iu)?.[1]?.replace(/\/+$/u, "");
    const match = url.pathname.match(/^\/@([A-Za-z0-9._-]+)\/post\/([A-Za-z0-9_-]+)$/u);
    if (!match || url.search || original.hash || rawPath !== url.pathname) {
      fail("Threads target requires query-free native post permalinks");
    }
    return { url, author: match[1], id: match[2] };
  };
  const post = nativeUrl(requiredString(target.post_permalink, "Threads post permalink"));
  const comment = nativeUrl(requiredString(target.comment_permalink, "Threads comment permalink"));
  const account = requiredString(target.account_key, "Threads account").replace(/^@/u, "");
  if (!/^[A-Za-z0-9._-]+$/u.test(account) || post.url.origin !== comment.url.origin
      || post.id !== target.post_key || comment.id !== target.platform_comment_id
      || post.id === comment.id) fail("Threads target differs from its native post or comment identity");
  return { account, postUrl: post.url.toString(), commentUrl: comment.url.toString(),
    postPath: post.url.pathname, targetPath: comment.url.pathname, host: post.url.hostname,
    postId: post.id, commentId: comment.id, author: comment.author };
}

/** Read the observed pagelet context chain, not arbitrary whole-column row order. */
export function readThreadsNativeColumn(root, expected) {
  const norm = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
  const visible = (node) => node?.getClientRects().length > 0;
  const rich = (node) => {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1 || !visible(node)) return "";
    if (node.tagName === "IMG") return node.getAttribute("alt") || "";
    if (node.tagName === "BR") return "\n";
    const text = [...node.childNodes].map(rich).join("");
    return /^(?:DIV|P|LI|BLOCKQUOTE)$/u.test(node.tagName) ? ` ${text} ` : text;
  };
  const urlOf = (link) => {
    try {
      const raw = link.getAttribute("href");
      const url = new URL(raw, expected.commentUrl);
      if (url.protocol !== "https:" || url.hostname !== expected.host || url.port
          || url.username || url.password || url.search || url.hash || raw.includes("\\")) return null;
      const rawPath = raw.startsWith("/") ? raw : raw.match(/^https:\/\/[^/?#]+([^?#]*)/iu)?.[1];
      if (rawPath?.replace(/\/+$/u, "") !== url.pathname.replace(/\/+$/u, "")) return null;
      return url;
    } catch { return null; }
  };
  const nativeAnchor = (pagelet, wantedPath) => {
    const anchors = [];
    for (const link of pagelet.querySelectorAll('a[href]')) {
      const raw = link.getAttribute("href");
      if (!raw.includes("/post/")) continue;
      const url = urlOf(link);
      if (!url || !/^\/@[A-Za-z0-9._-]+\/post\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname)) return null;
      anchors.push({ link, path: url.pathname.replace(/\/$/u, "") });
    }
    if (anchors.length !== 1 || anchors[0].path !== wantedPath || !visible(anchors[0].link)) return null;
    const times = [...anchors[0].link.querySelectorAll("time")];
    if (times.length !== 1 || !visible(times[0]) || !norm(times[0].innerText)) return null;
    return { ...anchors[0], displayedAt: norm(times[0].innerText) };
  };
  const pendingSelector = '[role="progressbar"],[role="status"],[aria-busy="true"]';
  if (root.getAttribute("aria-busy") === "true"
      || [...root.querySelectorAll(pendingSelector)].some(visible)
      || [...root.querySelectorAll('button,[role="button"],span,div,p')].some((node) =>
        visible(node) && /^(?:載入中[.。…]*|Loading[.\s…]*)$/iu.test(norm(node.innerText)))) return null;
  const pagelets = [...root.querySelectorAll('[data-pagelet]')].filter((node) =>
    /^threads_post_page_\d+$/u.test(node.getAttribute("data-pagelet")));
  const originals = pagelets.filter((node) => node.getAttribute("data-pagelet") === "threads_post_page_0");
  const focuses = pagelets.filter((node) => node.getAttribute("data-pagelet") === "threads_post_page_1");
  if (originals.length !== 1 || focuses.length !== 1) return null;
  const [original] = originals;
  const [focus] = focuses;
  if (!visible(original) || !visible(focus) || original.parentElement !== focus.parentElement
      || original.nextElementSibling !== focus) return null;
  let parent;
  let resultAncestorPaths;
  if (expected.resultAncestorPaths === undefined) {
    parent = nativeAnchor(original, expected.postPath);
  } else {
    const paths = expected.resultAncestorPaths;
    if (!Array.isArray(paths) || paths.length !== 2 || paths[1] !== expected.postPath
        || new Set([...paths, expected.targetPath]).size !== 3
        || paths.some((path) => typeof path !== "string"
          || !/^\/@[A-Za-z0-9._-]+\/post\/[A-Za-z0-9_-]+$/u.test(path))) return null;
    const rows = [...original.children];
    if (rows.length !== paths.length) return null;
    resultAncestorPaths = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const rowOwner = row.firstElementChild;
      const owned = [...row.querySelectorAll('[data-pressable-container="true"]')];
      if (row.tagName !== "DIV" || !visible(row) || row.children.length !== 1
          || rowOwner?.tagName !== "DIV" || !visible(rowOwner)
          || rowOwner.getAttribute("data-pressable-container") !== "true"
          || owned.length !== 1 || owned[0] !== rowOwner) return null;
      const anchor = nativeAnchor(row, paths[index]);
      const times = [...row.querySelectorAll("time")];
      if (!anchor || anchor.link.closest('[data-pressable-container="true"]') !== rowOwner
          || times.length !== 1 || !visible(times[0]) || !anchor.link.contains(times[0])) return null;
      resultAncestorPaths.push(anchor.path);
      parent = anchor;
    }
  }
  const target = nativeAnchor(focus, expected.targetPath);
  if (!parent || !target || parent.path === target.path) return null;
  const owner = target.link.closest('[data-pressable-container="true"]');
  if (!owner || !focus.contains(owner) || !visible(owner)) return null;
  const shell = owner.firstElementChild;
  const header = shell?.children[1];
  const bodyControls = shell?.children[2];
  if (!header?.contains(target.link) || !bodyControls || !visible(header) || !visible(bodyControls)) return null;
  const authors = [];
  for (const link of header.querySelectorAll('a[href]')) {
    if (link === target.link || !visible(link)) continue;
    const raw = link.getAttribute("href");
    if (!raw.includes("/@")) continue;
    const url = urlOf(link);
    const author = url?.pathname.match(/^\/@([A-Za-z0-9._-]+)\/?$/u)?.[1];
    if (!author) return null;
    const display = norm(link.innerText);
    if (display) authors.push({ author, display });
  }
  if (!authors.length || new Set(authors.map((item) => item.author)).size !== 1
      || authors[0].author !== expected.author || new Set(authors.map((item) => item.display)).size !== 1) return null;
  const icons = [...bodyControls.querySelectorAll('svg[aria-label="回覆"],svg[aria-label^="已回覆"]')].filter(visible);
  if (icons.length !== 1) return null;
  const [icon] = icons;
  const button = icon.closest('[role="button"]');
  if (!button || !bodyControls.contains(button) || !visible(button)) return null;
  const countText = norm(button.innerText);
  const replyCount = countText === "" ? 0 : /^\d+$/u.test(countText) ? Number(countText) : null;
  if (replyCount === null || !Number.isSafeInteger(replyCount)) return null;
  let content = bodyControls;
  let bodyParts = [];
  while (content && content !== icon) {
    const controls = [...content.children].filter((child) => child.contains(icon));
    if (controls.length !== 1) return null;
    const siblings = [...content.children].filter((child) => child !== controls[0]);
    if (siblings.some((child) => norm(rich(child)))) { bodyParts = siblings; break; }
    content = controls[0];
  }
  const body = norm(bodyParts.map(rich).join(" "));
  if (!body || bodyParts.some((part) => !visible(part) || part.getAttribute("aria-expanded") === "false"
      || part.querySelector('button,[role="button"],[aria-expanded="false"]'))) return null;
  if ([...owner.querySelectorAll('button,[role="button"]')].some((control) => visible(control)
      && /^(?:查看更多|顯示更多|更多|See more|Read more)$/iu.test(norm(control.innerText)))) return null;
  const marker = shell.children[3];
  const emptyTail = pagelets.filter((node) => node !== original && node !== focus).every((node) =>
    node.parentElement === focus.parentElement && !node.querySelector('a[href],time,[role="button"],[role="textbox"]')
      && !norm(node.innerText));
  const zeroReplyCandidate = resultAncestorPaths === undefined && replyCount === 0
    && visible(marker) && norm(marker.innerText) === "尚無回覆"
    && !marker.querySelector('a[href],button,[role="button"]') && emptyTail;
  const parts = [];
  for (let node = owner; node && node !== root; node = node.parentElement) {
    if (!node.parentElement || !root.contains(node)) return null;
    const siblings = [...node.parentElement.children].filter((child) => child.tagName === node.tagName);
    parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
  }
  return { author: authors[0].author, authorDisplay: authors[0].display, body,
    displayedAt: target.displayedAt, parentPath: parent.path, targetPath: target.path,
    selector: `:scope > ${parts.join(" > ")}`, replyCount, zeroReplyCandidate,
    ...(resultAncestorPaths ? { resultAncestorPaths } : {}) };
}

async function verifyThreadsAccountAndTitle(tab, native) {
  const accounts = tab.playwright.locator('a[role="link"]').filter({
    has: tab.playwright.locator('svg[aria-label="個人檔案"]'),
  });
  const count = await accounts.count();
  if (count < 1 || count > 4) fail("Threads account navigation is ambiguous");
  let visible = false;
  for (let index = 0; index < count; index += 1) {
    const link = accounts.nth(index);
    if (await link.getAttribute("href") !== `/@${native.account}`) fail("Threads active account changed");
    visible ||= await link.isVisible();
  }
  if (!visible) fail("Threads account navigation is not visible");
  // Behind a reply dialog the native column header may be aria-hidden while
  // still present. Bind its one native h1 link, not arbitrary body mentions.
  const title = await unique(tab.playwright.locator('a[href]').filter({
    has: tab.playwright.locator("h1"),
  }), "Threads column title", { visible: false });
  const href = requiredString(await title.getAttribute("href"), "Threads column title href");
  const observed = new URL(href, native.commentUrl);
  if (observed.toString() !== native.commentUrl) fail("Threads column title differs from its native target");
}

export async function readThreadsNativeComment(tab, native) {
  const tabId = requiredString(tab.id, "Threads source-owned tab id");
  const observedUrl = trustedUrl("threads", await tab.url()).toString();
  if (observedUrl !== native.commentUrl) fail("Threads target URL changed");
  await verifyThreadsAccountAndTitle(tab, native);
  const column = tab.playwright.locator('[role="region"][aria-label="直欄內文"]');
  await column.waitFor({ state: "visible", timeoutMs: 15000 });
  await unique(column, "Threads native comment column", { visible: false });
  const raw = await column.evaluate(readThreadsNativeColumn, native);
  if (!raw || !["author", "authorDisplay", "body", "displayedAt", "parentPath", "targetPath", "selector"].every((key) =>
    typeof raw[key] === "string" && raw[key]) || raw.parentPath !== native.postPath
      || raw.targetPath !== native.targetPath || raw.author !== native.author
      || !Number.isSafeInteger(raw.replyCount) || raw.replyCount < 0 || typeof raw.zeroReplyCandidate !== "boolean") {
    fail("Threads native parent context, author, time or whole body is ambiguous");
  }
  if (native.resultAncestorPaths !== undefined
      && (JSON.stringify(raw.resultAncestorPaths) !== JSON.stringify(native.resultAncestorPaths)
        || raw.zeroReplyCandidate !== false)) fail("Threads result ancestor chain differs from its source target");
  const evidence = immutableJsonSnapshot({ author: raw.author, authorDisplay: raw.authorDisplay, body: raw.body,
    displayedAt: raw.displayedAt, parentPath: raw.parentPath, targetPath: raw.targetPath,
    selector: raw.selector, replyCount: raw.replyCount, zeroReplyCandidate: raw.zeroReplyCandidate,
    ...(native.resultAncestorPaths ? { resultAncestorPaths: raw.resultAncestorPaths } : {}),
  }, "Threads native target evidence");
  if (tab.id !== tabId || trustedUrl("threads", await tab.url()).toString() !== observedUrl) {
    fail("Threads native tab or URL changed during target reading");
  }
  await verifyThreadsAccountAndTitle(tab, native);
  if (tab.id !== tabId || trustedUrl("threads", await tab.url()).toString() !== observedUrl) {
    fail("Threads native tab or URL changed during account verification");
  }
  const documentBinding = immutableJsonSnapshot({
    schema_version: 1, kind: "source_owned_ui_continuity", tab_id: tabId,
    observed_url: observedUrl, target_digest: digestObject({ account_key: native.account,
      comment_permalink: native.commentUrl, author_key: evidence.author, body: evidence.body }),
  }, "Threads source-owned UI continuity");
  return { observedUrl, region: column, evidence, documentBinding };
}

export async function readThreadsTargetComment(tab, rawTarget) {
  const native = threadsNativeTarget(rawTarget);
  const { observedUrl, evidence, documentBinding } = await readThreadsNativeComment(tab, native);
  const comment = { platform_comment_id: native.commentId, comment_permalink: native.commentUrl,
    observed_parent_post_permalink: new URL(evidence.parentPath, observedUrl).toString(),
    author_key: evidence.author, author_display: evidence.authorDisplay, body: evidence.body, body_complete: true,
    displayed_at: evidence.displayedAt, is_own: evidence.author === native.account,
    // This intake does not inspect native children and cannot certify absence.
    has_own_reply: false, language: null };
  return immutableJsonSnapshot({ comment, observedUrl, documentBinding }, "Threads native target comment observation");
}

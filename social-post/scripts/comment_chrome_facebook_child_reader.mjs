/** Read-only native Facebook own-child details. No completeness or send authority. */
import { fail, immutableJsonSnapshot, requiredString, unique } from "./comment_chrome_common.mjs";

export function readFacebookNativeChildRow(article, expected) {
  const norm = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
  const fields = ["origin", "host", "postPath", "commentId", "replyId", "account", "parentDisplay"];
  if (!expected || typeof expected !== "object" || Array.isArray(expected)
      || fields.some((field) => typeof expected[field] !== "string" || !expected[field])
      || !["facebook.com", "www.facebook.com", "m.facebook.com"].includes(expected.host)
      || expected.origin !== `https://${expected.host}`
      || !/^\/[A-Za-z0-9.]+\/posts\/[A-Za-z0-9]+$/u.test(expected.postPath)
      || !/^\d+$/u.test(expected.commentId) || !/^\d+$/u.test(expected.replyId)
      || expected.commentId === expected.replyId || !/^[A-Za-z0-9.]+$/u.test(expected.account)
      || !norm(expected.parentDisplay)) return null;
  const visible = (element) => element?.getClientRects().length > 0;
  if (!article || article.getAttribute("role") !== "article" || !visible(article)) return null;
  const owned = (element) => element.closest('[role="article"]') === article;
  const rich = (node) => {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return "";
    if (node.tagName === "IMG") return node.getAttribute("alt") || "";
    if (node.tagName === "BR") return "\n";
    return [...node.childNodes].map(rich).join("");
  };
  const bodies = [...article.querySelectorAll('[dir="auto"][lang]')].filter((element) =>
    owned(element) && visible(element) && !element.closest('a,[role="button"]')
    && !element.parentElement?.closest('[dir="auto"][lang]'));
  if (bodies.length !== 1) return null;
  const body = bodies[0];
  if (body.getAttribute("aria-expanded") === "false"
      || body.querySelector('button,[role="button"],[aria-expanded="false"]')) return null;
  const visibleTextCoverage = (element) => {
    if (element.getAttribute("aria-hidden") === "true"
        || element.getAttribute("hidden") !== null) return false;
    if (!visible(element) && element.tagName !== "BR" && norm(rich(element))) {
      // Observed native mention wrapper: one zero-rect, unlabelled SPAN
      // contains exactly one SPAN whose text must have visible coverage.
      // Do not treat arbitrary hidden text or display:contents as equivalent.
      const children = [...element.childNodes];
      if (element.tagName !== "SPAN"
          || ["role", "style", "aria-hidden"].some((key) => element.getAttribute(key) !== null)
          || children.length !== 1 || children[0].nodeType !== 1
          || children[0].tagName !== "SPAN") return false;
      return visibleTextCoverage(children[0]);
    }
    return [...element.childNodes].filter((node) => node.nodeType === 1).every(visibleTextCoverage);
  };
  if (!visibleTextCoverage(body)) return null;
  const bodyText = norm(rich(body));
  if (!bodyText) return null;
  if ([...article.querySelectorAll('button,[role="button"]')].some((button) =>
    owned(button) && visible(button)
    && /^(查看更多|顯示更多|See more)$/u.test(norm(button.innerText)))) return null;

  const links = [...article.querySelectorAll('a[href]')].filter((link) => owned(link) && !body.contains(link));
  const native = [];
  const authors = [];
  const exactQuery = (url, required, optional) => {
    const allowed = new Set([...required, ...optional]);
    const entries = [...url.searchParams];
    return required.every((key) => url.searchParams.getAll(key).length === 1)
      && entries.every(([key, value]) => allowed.has(key) && value
        && url.searchParams.getAll(key).length === 1);
  };
  const trackingKeys = ["__cft__[0]", "__tn__"];
  for (const link of links) {
    let url;
    try { url = new URL(link.getAttribute("href"), expected.origin); } catch { return null; }
    const path = url.pathname.replace(/\/$/u, "");
    const handle = path.match(/^\/([A-Za-z0-9.]+)$/u)?.[1];
    const profilePath = Boolean(handle);
    const identityKeys = ["comment_id", "reply_comment_id", "reply_id"];
    // Facebook profile links carry an opaque comment_id tracking context.
    // It is not a native child permalink and never supplies parent identity.
    const looksNative = /^\/[A-Za-z0-9.]+\/posts\//u.test(path)
      || (!profilePath && identityKeys.some((key) => url.searchParams.has(key)));
    const sameOrigin = url.protocol === "https:" && url.hostname === expected.host
      && !url.username && !url.password && !url.port && !url.hash;
    if (looksNative) {
      if (!sameOrigin || path !== expected.postPath || !visible(link)
          || !exactQuery(url, ["comment_id", "reply_comment_id"], trackingKeys)
          || url.searchParams.get("comment_id") !== expected.commentId
          || url.searchParams.get("reply_comment_id") !== expected.replyId) return null;
      const timeText = norm(link.innerText);
      if (!timeText) return null;
      native.push(timeText);
      continue;
    }
    if (!sameOrigin) continue;
    let authorKey = null;
    if (path === "/profile.php") {
      if (!exactQuery(url, ["id"], ["comment_id", ...trackingKeys])
          || !/^\d+$/u.test(url.searchParams.get("id"))) return null;
      authorKey = url.searchParams.get("id");
    } else if (handle) {
      if (!exactQuery(url, [], ["comment_id", ...trackingKeys])) return null;
      authorKey = handle;
    }
    const display = norm(link.innerText);
    if (authorKey && visible(link) && display && !link.querySelector("img")) {
      authors.push({ key: authorKey, display });
    }
  }
  if (!native.length || new Set(native).size !== 1 || !authors.length
      || new Set(authors.map((author) => author.key)).size !== 1
      || authors[0].key !== expected.account) return null;
  const parentDisplay = norm(expected.parentDisplay);
  const label = norm(article.getAttribute("aria-label"));
  const named = authors.filter((author) => {
    const prefix = norm(`${author.display}回覆${parentDisplay}的留言`);
    const suffix = norm(label.slice(prefix.length));
    return label.startsWith(prefix) && (suffix === native[0] || suffix === `${native[0]}前`);
  });
  if (new Set(named.map((author) => author.display)).size !== 1) return null;
  return {
    author: named[0].key, authorDisplay: named[0].display, parentDisplay, body: bodyText,
    commentId: expected.commentId, replyId: expected.replyId,
    replyUrl: `${expected.origin}${expected.postPath}?comment_id=${expected.commentId}&reply_comment_id=${expected.replyId}`,
    timeText: native[0],
  };
}

/** Bounded native-child candidates only; [] is not an absence proof. */
export function collectFacebookNativeChildIds(article, expected) {
  const norm = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
  const visible = (element) => element.getClientRects().length > 0;
  if (!article || article.getAttribute("role") !== "article" || !visible(article)
      || !expected || typeof expected !== "object"
      || ["origin", "host", "postPath", "commentId", "account", "parentDisplay"]
        .some((field) => typeof expected[field] !== "string" || !expected[field])
      || expected.origin !== `https://${expected.host}`
      || !["facebook.com", "www.facebook.com", "m.facebook.com"].includes(expected.host)
      || !/^\/[A-Za-z0-9.]+\/posts\/[A-Za-z0-9]+$/u.test(expected.postPath)
      || !/^\d+$/u.test(expected.commentId) || !/^[A-Za-z0-9.]+$/u.test(expected.account)) return null;
  const links = (row) => [...row.querySelectorAll('a[href]')].filter((link) =>
    link.closest('[role="article"]') === row && !link.closest('[dir="auto"][lang]'));
  const urlOf = (link) => {
    try { return new URL(link.getAttribute("href"), expected.origin); } catch { return null; }
  };
  const sameOrigin = (url) => url?.origin === expected.origin && !url.username && !url.password && !url.hash;
  const identity = (row) => {
    const native = [];
    for (const link of links(row)) {
      const url = urlOf(link);
      if (!url) return null;
      const path = url.pathname.replace(/\/$/u, "");
      if (!/^\/[A-Za-z0-9.]+\/posts\//u.test(path)) continue;
      const allowed = new Set(["comment_id", "reply_comment_id", "__cft__[0]", "__tn__"]);
      if (!sameOrigin(url) || path !== expected.postPath || !visible(link)
          || url.searchParams.getAll("comment_id").length !== 1
          || url.searchParams.get("comment_id") !== expected.commentId
          || [...url.searchParams].some(([key, value]) => !allowed.has(key) || !value
            || url.searchParams.getAll(key).length !== 1)) return null;
      const child = url.searchParams.get("reply_comment_id");
      if (child !== null && (!/^\d+$/u.test(child) || child === expected.commentId)) return null;
      native.push(child);
    }
    return native.length && new Set(native).size === 1 ? { replyId: native[0] } : null;
  };
  if (identity(article)?.replyId !== null) return null;
  const ownCandidate = (row) => links(row).some((link) => {
    const url = urlOf(link);
    if (!sameOrigin(url) || !visible(link) || link.querySelector("img")) return false;
    const path = url.pathname.replace(/\/$/u, "");
    const sameAccount = path === `/${expected.account}`
      || (path === "/profile.php" && url.searchParams.getAll("id").length === 1
        && url.searchParams.get("id") === expected.account);
    const display = norm(link.innerText);
    return sameAccount && display && norm(row.getAttribute("aria-label"))
      .startsWith(norm(`${display}回覆${expected.parentDisplay}的留言`));
  });
  let candidates = [];
  for (let wrapper = article.parentElement, depth = 0; wrapper && depth < 8;
    wrapper = wrapper.parentElement, depth += 1) {
    if (wrapper.getAttribute("role") === "dialog") break;
    const rows = [...wrapper.querySelectorAll('[role="article"]')].filter((row) => row !== article);
    if (rows.length > 50) return null;
    const identities = rows.map(identity);
    if (identities.some((item) => !item || item.replyId === null)) break;
    const ids = identities.map((item) => item.replyId);
    if (new Set(ids).size !== ids.length) return null;
    candidates = rows.filter(ownCandidate).map((row) => identity(row).replyId);
  }
  return candidates;
}

function childReadContext(rawNative, parentDisplay) {
  const native = immutableJsonSnapshot(rawNative, "Facebook child parent identity");
  for (const key of ["account", "commentId", "postUrl", "commentUrl", "postPath", "host"]) {
    requiredString(native?.[key], `Facebook child parent ${key}`);
  }
  const post = new URL(native.postUrl);
  const comment = new URL(native.commentUrl);
  if (!["facebook.com", "www.facebook.com", "m.facebook.com"].includes(native.host)
      || post.protocol !== "https:" || post.hostname !== native.host
      || post.username || post.password || post.port || post.hash || post.search
      || !/^\/[A-Za-z0-9.]+\/posts\/[A-Za-z0-9]+$/u.test(native.postPath)
      || post.pathname !== native.postPath || post.toString() !== native.postUrl
      || !/^[A-Za-z0-9.]+$/u.test(native.account) || !/^\d+$/u.test(native.commentId)
      || comment.origin !== post.origin || comment.pathname !== native.postPath
      || comment.username || comment.password || comment.hash || comment.port
      || [...comment.searchParams].length !== 1
      || comment.searchParams.get("comment_id") !== native.commentId
      || comment.toString() !== native.commentUrl) {
    fail("Facebook child native parent scope is inconsistent");
  }
  return { origin: post.origin, host: native.host, postPath: native.postPath,
    commentId: native.commentId, account: native.account,
    parentDisplay: requiredString(parentDisplay, "Facebook original parent display"),
    commentUrl: native.commentUrl };
}

/** Fresh row reinspection only; this public reader cannot mint or commit receipts. */
export async function readFacebookOwnReplyDetails(tab, parentArticleLocator, native, parentDisplay) {
  const expected = childReadContext(native, parentDisplay);
  const tabId = requiredString(tab.id, "Facebook child source tab id");
  const checkTab = async () => {
    if (tab.id !== tabId || await tab.url() !== expected.commentUrl || tab.id !== tabId) {
      fail("Facebook child tab or URL changed");
    }
  };
  await checkTab();
  const parent = await unique(parentArticleLocator, "Facebook child original parent");
  await checkTab();
  const ids = await parent.evaluate(collectFacebookNativeChildIds, expected);
  await checkTab();
  if (!Array.isArray(ids) || ids.length > 50 || new Set(ids).size !== ids.length
      || ids.some((id) => typeof id !== "string" || !/^\d+$/u.test(id) || id === expected.commentId)) {
    fail("Facebook native child candidates are ambiguous");
  }
  const replies = [];
  for (const replyId of ids) {
    const anchor = tab.playwright.locator(`a[href*=${JSON.stringify(`reply_comment_id=${replyId}`)}]`);
    const child = await unique(tab.playwright.getByRole("article").filter({ has: anchor }),
      "Facebook native own-child row");
    await checkTab();
    const raw = await child.evaluate(readFacebookNativeChildRow, { ...expected, replyId });
    await checkTab();
    const fields = ["author", "authorDisplay", "parentDisplay", "body", "commentId", "replyId", "replyUrl", "timeText"];
    if (!raw || fields.some((field) => typeof raw[field] !== "string" || !raw[field])
        || Object.keys(raw).length !== fields.length || raw.author !== expected.account
        || raw.commentId !== expected.commentId || raw.replyId !== replyId) {
      fail("Facebook native own-child identity, author or whole body is ambiguous");
    }
    replies.push(Object.fromEntries(fields.map((field) => [field, raw[field]])));
  }
  await checkTab();
  return immutableJsonSnapshot({ replies, complete: false, absence_verified: false },
    "Facebook non-exhaustive own-child details");
}

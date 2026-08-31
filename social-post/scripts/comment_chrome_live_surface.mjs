/** Source-owned, read-only Meta reply inspection. No network or submit actions. */
import { canonicalUrl, fail, instagramUrlIdentity, LIVE_HOSTS, requiredString, unique } from "./comment_chrome_common.mjs";
import { assertAction, bindObservedSubmitNode } from "./comment_chrome_send_support.mjs";

export const LIVE_REPLY_ADAPTER_VERSION = "2026-08-31.2";
const inspectionBrowsers = new WeakMap();

/** Called only with the source-owned runtime browser by the fused bridge. */
export function bindLiveReplyBrowser(tab, browser) {
  if (!tab || !browser?.tabs || typeof browser.tabs.new !== "function") fail("live inspection requires a runtime browser");
  inspectionBrowsers.set(tab, browser);
}

async function verifyFacebookAccount(tab, action) {
  const key = action.scope.account_key;
  const browser = inspectionBrowsers.get(tab);
  if (!browser) fail("Facebook account verification requires the source-owned browser");
  const probe = await browser.tabs.new();
  try {
    await probe.goto("https://www.facebook.com/me/");
    let current;
    for (let pass = 0; pass < 3; pass += 1) {
      current = trustedUrl("facebook", await probe.url());
      if (current.pathname !== "/me") break;
      // Reading the banner waits for the in-flight profile navigation, not
      // a network/API request or a page-private application-state inspection.
      await probe.playwright.getByRole("banner").count();
    }
    if (current.pathname !== `/${key}` && !(current.pathname === "/profile.php" && current.searchParams.get("id") === key)) {
      fail("Facebook /me profile differs from the approved account");
    }
  } finally {
    await probe.close();
  }
}

function trustedUrl(platform, raw) {
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

function normalize(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
}

async function currentUrl(tab, action) {
  const observed = trustedUrl(action.scope.platform, await tab.url());
  const expected = trustedUrl(action.scope.platform, liveReplyUrl(action));
  if (observed.toString() !== expected.toString()) fail("live reply left its approved comment URL");
  return observed.toString();
}

async function inspectThreads(tab, action, phase) {
  const observedUrl = await currentUrl(tab, action);
  // This icon belongs to the navigation account link, not a post author link.
  // DOM inspection remains usable behind an open reply dialog without treating
  // arbitrary mentions of the account as authenticated-identity evidence.
  const account = tab.playwright.locator('a[role="link"]').filter({
    has: tab.playwright.locator('svg[aria-label="個人檔案"]'),
  });
  const accountCount = await account.count();
  if (accountCount < 1 || accountCount > 4) fail("Threads account navigation is ambiguous");
  let visibleAccount = false;
  for (let index = 0; index < accountCount; index += 1) {
    const link = account.nth(index);
    if (await link.getAttribute("href") !== `/@${action.scope.account_key.replace(/^@/u, "")}`) fail("Threads active account changed");
    visibleAccount ||= await link.isVisible();
  }
  if (!visibleAccount) fail("Threads account navigation is not visible");
  const region = tab.playwright.locator('[role="region"][aria-label="直欄內文"]');
  await unique(region, "Threads comment column", { visible: false });
  const input = {
    originalPath: new URL(action.post_permalink).pathname,
    targetPath: new URL(liveReplyUrl(action)).pathname,
    body: action.expected_body, reply: action.reply_text,
    account: action.scope.account_key.replace(/^@/u, ""),
  };
  const evidence = await region.evaluate((root, expected) => {
    const norm = (s) => String(s ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
    const path = (element) => {
      const parts = [];
      for (let node = element; node && node !== root; node = node.parentElement) {
        const tag = node.tagName.toLowerCase();
        const same = [...node.parentElement.children].filter((child) => child.tagName === node.tagName);
        parts.unshift(`${tag}:nth-of-type(${same.indexOf(node) + 1})`);
      }
      return `:scope > ${parts.join(" > ")}`;
    };
    const anchors = [...root.querySelectorAll('a[href]')].filter((a) => /^\/@[^/]+\/post\/[^/]+$/u.test(a.getAttribute("href")));
    const rows = [];
    for (const a of anchors) {
      let owner = a.parentElement;
      while (owner && owner !== root && !owner.querySelector('svg[aria-label="回覆"],svg[aria-label^="已回覆"]')) owner = owner.parentElement;
      if (!owner || owner === root) return { valid: false };
      const ids = new Set([...owner.querySelectorAll('a[href]')].map((link) => link.getAttribute("href")).filter((url) => /^\/@[^/]+\/post\/[^/]+$/u.test(url)));
      if (ids.size !== 1) return { valid: false };
      const permalink = a.getAttribute("href");
      if (rows.some((row) => row.permalink === permalink)) continue;
      const author = permalink.split("/")[1].slice(1);
      const authorPresent = [...owner.querySelectorAll('a[href]')].some((link) => link.getAttribute("href") === `/@${author}`);
      const icon = owner.querySelector('svg[aria-label="回覆"],svg[aria-label^="已回覆"]');
      // The direct content/action branch excludes the author/time header.
      // Read the whole content sibling, never an arbitrary exact child fragment.
      let content = [...owner.children].find((child) => child.contains(icon));
      let fullBody = null;
      while (content && content !== icon) {
        const controlBranch = [...content.children].find((child) => child.contains(icon));
        if (!controlBranch) break;
        const bodyParts = [...content.children].filter((child) => child !== controlBranch)
          .map((child) => norm(child.innerText)).filter(Boolean);
        if (bodyParts.length) { fullBody = norm(bodyParts.join(" ")); break; }
        content = controlBranch;
      }
      const button = icon.closest('[role="button"]');
      const countText = norm(button?.innerText);
      const count = countText === "" ? 0 : /^\d+$/u.test(countText) ? Number(countText) : null;
      rows.push({ permalink, author, authorPresent, count, selector: path(owner),
        bodyMatches: fullBody === norm(expected.body), exactReply: fullBody === norm(expected.reply) });
    }
    const original = rows.findIndex((row) => row.permalink === expected.originalPath);
    const target = rows.findIndex((row) => row.permalink === expected.targetPath);
    const row = rows[target];
    if (original < 0 || target <= original || !row?.bodyMatches || !row.authorPresent || row.count === null) return { valid: false };
    const replies = rows.slice(target + 1);
    const text = norm(root.innerText);
    const pending = /顯示更多回覆|查看更多回覆|載入中/u.test(text) || root.querySelector('[role="progressbar"]') !== null;
    const explicitZero = /尚無回覆/u.test(text.slice(text.indexOf(norm(expected.body))));
    const complete = !pending && row.count === replies.length && (row.count > 0 || explicitZero);
    const own = replies.filter((reply) => reply.authorPresent && reply.author.toLowerCase() === expected.account.toLowerCase());
    return { valid: true, complete, selector: row.selector, author: row.author,
      totalReplies: replies.length, ownReplyCount: own.length,
      exactOwnCount: own.filter((reply) => reply.exactReply).length };
  }, input);
  if (!evidence.valid || evidence.author !== (action.author_key || action.author_display)) {
    fail("Threads original post, parent comment, author or complete body could not be verified");
  }
  const base = { observedUrl, complete: evidence.complete === true,
    totalReplies: evidence.totalReplies, ownReplyCount: evidence.ownReplyCount,
    exactOwnCount: evidence.exactOwnCount };
  if (phase === "after") return base;
  const dialogs = tab.playwright.getByRole("dialog");
  if (await dialogs.count() === 0) {
    const target = region.locator(evidence.selector);
    return { ...base, trigger: target.getByRole("button", { name: "回覆", exact: true }) };
  }
  const dialog = await unique(dialogs, "Threads reply dialog");
  const dialogEvidence = await dialog.evaluate((root, expected) => ({
    isReply: [...root.querySelectorAll('h1,h2,[role="heading"]')].some((h) => h.innerText.trim() === "回覆"),
    parent: [...root.querySelectorAll('a[href]')].some((a) => a.getAttribute("href") === `/@${expected.author}`),
    body: [...root.querySelectorAll('div,span,p')].some((e) => {
      const norm = (s) => String(s ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
      if (norm(e.innerText) !== expected.body) return false;
      let whole = e;
      while (whole.parentElement && whole.parentElement !== root) {
        const parent = whole.parentElement;
        if (parent.querySelector('a[href],time,img,[role="textbox"],[role="heading"],h1,h2,[role="button"]')) break;
        whole = parent;
      }
      return norm(whole.innerText) === expected.body;
    }),
    own: [...root.querySelectorAll('img')].some((img) => img.getAttribute("alt") === `${expected.account}的大頭貼照`),
  }), { author: evidence.author, body: normalize(action.expected_body), account: input.account });
  if (!Object.values(dialogEvidence).every((value) => value === true)) fail("Threads composer is not bound to the approved parent and account");
  return { ...base, composer: dialog.getByRole("textbox"),
    submit: dialog.getByRole("button", { name: "發佈", exact: true }) };
}

async function inspectFacebook(tab, action, phase) {
  const observedUrl = await currentUrl(tab, action);
  await verifyFacebookAccount(tab, action);
  const author = requiredString(action.author_display, "Facebook comment author");
  const escaped = author.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const target = tab.playwright.getByRole("article", { name: new RegExp(`^${escaped}的留言`) });
  await unique(target, "Facebook original comment");
  const composer = tab.playwright.getByRole("textbox", { name: `回覆${author}`, exact: true });
  const evidence = await target.evaluate((article, expected) => {
    const norm = (s) => String(s ?? "").normalize("NFC").replace(/\s+/gu, " ").replace(/\s+(?=\p{Extended_Pictographic})/gu, "").trim();
    const rich = (node) => {
      if (node.nodeType === 3) return node.nodeValue;
      if (node.nodeType !== 1) return "";
      if (node.tagName === "IMG") return node.getAttribute("alt") || "";
      if (node.tagName === "BR") return "\n";
      return [...node.childNodes].map(rich).join("");
    };
    const exactText = (root, wanted) => [...root.querySelectorAll('div,span,p')].some((el) => el.getClientRects().length && norm(rich(el)) === norm(wanted));
    const links = [...article.querySelectorAll('a[href]')].map((a) => new URL(a.getAttribute("href"), location.origin));
    const anchor = links.some((url) => url.hostname === "www.facebook.com" && url.pathname.includes("/posts/") && url.searchParams.get("comment_id") === expected.id);
    const author = links.some((url) => url.pathname === `/${expected.authorKey}`);
    if (!anchor || !author || !exactText(article, expected.body)) return { valid: false };
    let wrapper = article;
    for (let p = article.parentElement, depth = 0; p && depth < 8; p = p.parentElement, depth += 1) {
      if (p.getAttribute("role") === "dialog") break;
      const articles = [...p.querySelectorAll('[role="article"]')];
      if (articles.some((item) => item !== article && !String(item.getAttribute("aria-label")).includes(`回覆${expected.authorDisplay}的留言`))) break;
      wrapper = p;
      if (p.querySelector(`[role="textbox"][aria-label=${JSON.stringify(`回覆${expected.authorDisplay}`)}]`)) break;
    }
    const replies = [...wrapper.querySelectorAll('[role="article"]')].filter((item) => item !== article);
    const own = replies.filter((item) => [...item.querySelectorAll('a[href]')].some((a) => {
      const url = new URL(a.getAttribute("href"), location.origin);
      return url.hostname === "www.facebook.com" && url.pathname === `/${expected.account}`;
    }));
    const pending = /查看(?:全部)?\s*\d+\s*則回覆|查看更多回覆|顯示更多回覆|載入中/u.test(wrapper.innerText);
    const boundEditor = wrapper.querySelector(`[role="textbox"][aria-label=${JSON.stringify(`回覆${expected.authorDisplay}`)}]`);
    return { valid: true, complete: !pending && (Boolean(boundEditor) || replies.length > 0),
      totalReplies: replies.length, ownReplyCount: own.length,
      exactOwnCount: own.filter((item) => exactText(item, expected.reply)).length };
  }, { id: action.comment_anchor.platform_comment_id, authorKey: action.author_key,
    authorDisplay: author, body: action.expected_body, reply: action.reply_text, account: action.scope.account_key });
  if (!evidence.valid) fail("Facebook parent comment id, author or full body changed");
  // Positive duplicate detection is useful, but editor presence is NOT proof
  // of exhaustive replies or of the selected composer actor. Until both are
  // verified on a user-authorized FB sample, this surface cannot enable send
  // or assert a successful/absent reply during reconciliation.
  const base = { observedUrl, complete: false, totalReplies: evidence.totalReplies,
    ownReplyCount: evidence.ownReplyCount, exactOwnCount: evidence.exactOwnCount };
  if (phase === "after") return base;
  if (await composer.count() === 0) return { ...base, trigger: target.getByRole("button", { name: "回覆", exact: true }) };
  await unique(composer, "Facebook target reply editor");
  const form = tab.playwright.locator("form").filter({ has: composer });
  await unique(form, "Facebook target reply form");
  return { ...base, composer, submit: form.getByRole("button", { name: "貼文留言", exact: true }) };
}

async function inspectInstagram(tab, action, phase) {
  const observedUrl = await currentUrl(tab, action);
  const identity = instagramUrlIdentity(liveReplyUrl(action), { allowComment: true });
  if (!identity.commentId) fail("Instagram inspection requires its native comment permalink");
  const account = requiredString(action.scope.account_key, "Instagram account").replace(/^@/u, "");
  const accountEvidence = await tab.playwright.evaluate((expected) => {
    const links = [...document.querySelectorAll('a[href]')].filter((a) => {
      if (a.closest('main,[role="dialog"]') || !a.querySelector('img[alt$="的大頭貼照"]')) return false;
      for (let p = a.parentElement, depth = 0; p && depth < 7; p = p.parentElement, depth += 1) {
        if (p.querySelector('main,article,[role="dialog"]')) break;
        if (['首頁', '搜尋', '新貼文'].every((label) => p.querySelector(`svg[aria-label="${label}"]`))) return true;
      }
      return false;
    });
    return links.length > 0 && links.length <= 4 && links.every((a) =>
      a.getAttribute("href") === `/${expected}/`
      && a.querySelector('img')?.getAttribute("alt") === `${expected}的大頭貼照`)
      && links.some((a) => a.getClientRects().length > 0);
  }, account);
  if (!accountEvidence) fail("Instagram active account navigation changed");
  const article = await unique(tab.playwright.locator("article"), "Instagram native post article");
  const anchorPath = `/p/${identity.shortcode}/c/${identity.commentId}/`;
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
      if (!handle || anchors.length !== 1 || !body.getClientRects().length) return null;
      return { author: handle, body: norm(body.innerText), path: anchors[0].getAttribute("href") };
    };
    const parent = read(li);
    if (!parent || parent.path !== expected.path || parent.author !== expected.author
        || parent.body !== norm(expected.body)) return { valid: false };
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
    const own = replies.filter((row) => row.author === expected.account);
    return { valid: true, totalReplies: replies.length, ownReplyCount: own.length,
      exactOwnCount: own.filter((row) => row.body === norm(expected.reply)).length,
      expansionPending: /查看回覆|查看全部.*回覆|載入中/u.test(thread.innerText) };
  }, { path: anchorPath, author: action.author_key, body: action.expected_body,
    account, reply: action.reply_text });
  if (!evidence.valid) fail("Instagram native parent, author or complete body changed");
  // Native /c/P/r/R anchors prove observed child ownership, not exhaustive
  // pagination or the selected reply state of the shared post-level textarea.
  // In particular, an @author prefill is not sufficient parent-state evidence.
  const base = { observedUrl, complete: false, totalReplies: evidence.totalReplies,
    ownReplyCount: evidence.ownReplyCount, exactOwnCount: evidence.exactOwnCount,
    expansionPending: evidence.expansionPending,
    blockedReason: "instagram_reply_exhaustion_and_selected_parent_not_verified" };
  if (phase === "after") return base;
  const composer = article.getByRole("textbox", { name: "留言⋯⋯", exact: true });
  await unique(composer, "Instagram shared comment editor");
  const form = article.locator("form").filter({
    has: tab.playwright.getByRole("textbox", { name: "留言⋯⋯", exact: true }),
  });
  await unique(form, "Instagram comment form");
  return { ...base, trigger: target.getByRole("button", { name: "回覆", exact: true }),
    composer, submit: form.getByRole("button", { name: "發佈", exact: true }) };
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

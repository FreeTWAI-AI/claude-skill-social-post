/** Source-owned, read-only Meta reply inspection. No network or submit actions. */
import {
  canonicalUrl, digestObject, fail, immutableJsonSnapshot, instagramUrlIdentity,
  LIVE_HOSTS, requiredString, unique,
} from "./comment_chrome_common.mjs";
import { assertAction, bindObservedSubmitNode } from "./comment_chrome_send_support.mjs";

export const LIVE_REPLY_ADAPTER_VERSION = "2026-08-31.3";
const inspectionBrowsers = new WeakMap();
const instagramReplyEvidence = new WeakMap();
const instagramExpansionAttempts = new WeakMap();
const instagramReadGenerations = new WeakMap();
const instagramPreparations = new WeakSet();
const instagramTabIds = new WeakMap();
const MAX_INSTAGRAM_ONE_PAGE_REPLIES = 100;

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

function recordInstagramReplyEvidence(tab, action, observedUrl, target, evidence) {
  const binding = digestObject({ action, observedUrl }, "Instagram reply evidence binding");
  const documentBinding = evidence.documentBinding;
  const documentKey = digestObject(documentBinding, "Instagram native UI binding");
  let state = instagramReplyEvidence.get(tab);
  if (!state || state.binding !== binding || state.documentKey !== documentKey) {
    state = { binding, documentBinding, documentKey, declaredCount: null,
      expandAttempted: instagramExpansionAttempts.get(tab)?.has(binding) ?? false,
      invalidated: false, stableReads: 0, terminalFingerprint: null };
    instagramReplyEvidence.set(tab, state);
  }
  state.target = target;
  state.current = evidence;
  const count = evidence.expandCount;
  const initialCount = Number.isSafeInteger(count) && count > 0
    && count <= MAX_INSTAGRAM_ONE_PAGE_REPLIES && evidence.expandControlCount === 1
    && evidence.pendingControlCount === 1 && evidence.hideControlCount === 0
    && evidence.totalReplies === 0 && !evidence.loading;
  if (initialCount && !state.expandAttempted) {
    if (state.declaredCount !== null && state.declaredCount !== count) state.invalidated = true;
    else state.declaredCount = count;
  }
  const terminal = !state.invalidated && state.expandAttempted && state.declaredCount !== null
    && evidence.totalReplies === state.declaredCount && evidence.hideControlCount === 1
    && !evidence.expansionPending && !evidence.loading;
  if (terminal) {
    const fingerprint = digestObject(evidence.rows, "Instagram native reply rows");
    if (state.terminalFingerprint !== null && state.terminalFingerprint !== fingerprint) {
      state.invalidated = true;
      state.stableReads = 0;
    } else {
      state.terminalFingerprint = fingerprint;
      state.stableReads = Math.min(2, state.stableReads + 1);
    }
  } else {
    if (state.terminalFingerprint !== null) state.invalidated = true;
    state.stableReads = 0;
  }
  const exhaustiveThread = !state.invalidated && terminal && state.stableReads === 2;
  return immutableJsonSnapshot({
    schema_version: 1, candidate_only: true, exhaustiveThread,
    scope: "instagram_native_one_page_parent_bound_replies",
    action_digest: digestObject(action, "Instagram reply action"), binding_digest: binding,
    document_binding: documentBinding, observed_url: observedUrl,
    declared_count: state.declaredCount, observed_count: evidence.totalReplies,
    expansion_attempted: state.expandAttempted, stable_reads: state.stableReads,
    rows_digest: state.terminalFingerprint,
    reason: exhaustiveThread ? "observed_count_and_two_native_reads_agree"
      : state.invalidated ? "reply_evidence_changed"
        : state.declaredCount === null ? "pre_expansion_count_not_observed"
          : "native_reply_expansion_not_stably_exhausted",
  }, "Instagram reply exhaustion candidate");
}

async function inspectInstagram(tab, action, phase) {
  const generation = (instagramReadGenerations.get(tab) ?? 0) + 1;
  instagramReadGenerations.set(tab, generation);
  try {
    return await readInstagramReplySurface(tab, action, phase, generation);
  } catch (error) {
    const state = instagramReplyEvidence.get(tab);
    if (state) { state.invalidated = true; state.stableReads = 0; }
    throw error;
  }
}

function instagramNativeTarget(rawTarget) {
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

async function readInstagramNativeComment(tab, native) {
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

async function readInstagramReplySurface(tab, action, phase, generation) {
  const native = instagramNativeTarget({
    platform: action.scope.platform, account_key: action.scope.account_key,
    post_key: action.scope.post_key, post_permalink: action.post_permalink,
    comment_permalink: liveReplyUrl(action),
    platform_comment_id: action.comment_anchor.platform_comment_id,
  });
  const { observedUrl, article, target, evidence } = await readInstagramNativeComment(tab, native);
  if (evidence.parent.author !== action.author_key || evidence.parent.body !== normalize(action.expected_body)) {
    fail("Instagram native parent, author or complete body changed");
  }
  evidence.exactOwnCount = evidence.rows.filter(
    (row) => row.author === native.account && row.body === normalize(action.reply_text),
  ).length;
  if (instagramReadGenerations.get(tab) !== generation) {
    fail("Instagram reply inspections overlapped");
  }
  const replyExhaustionCandidate = recordInstagramReplyEvidence(tab, action, observedUrl, target, evidence);
  // Native /c/P/r/R anchors prove observed child ownership, not exhaustive
  // pagination or the selected reply state of the shared post-level textarea.
  // In particular, an @author prefill is not sufficient parent-state evidence.
  const base = { observedUrl, complete: false, totalReplies: evidence.totalReplies,
    ownReplyCount: evidence.ownReplyCount, exactOwnCount: evidence.exactOwnCount,
    expansionPending: evidence.expansionPending,
    exhaustiveThread: replyExhaustionCandidate.exhaustiveThread, replyExhaustionCandidate,
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

/** One source-owned expansion of the observed native IG shape; never compose or submit. */
export async function prepareLiveReplyThread(tab, action) {
  assertAction(action);
  if (action.scope.platform !== "instagram") fail("native reply preparation is only verified for Instagram");
  if (instagramPreparations.has(tab)) fail("Instagram reply preparation is already running");
  instagramPreparations.add(tab);
  try {
    await inspectInstagram(tab, action, "after");
    const state = instagramReplyEvidence.get(tab);
    if (!state || state.invalidated || state.declaredCount === null) {
      fail("Instagram requires a positive observed pre-expansion reply count");
    }
    if (!state.expandAttempted) {
      const current = state.current;
      if (current.expandControlCount !== 1 || !current.expandLabel || current.loading
          || current.pendingControlCount !== 1 || current.totalReplies !== 0 || current.hideControlCount !== 0) {
        fail("Instagram initial reply expansion is not uniquely bound");
      }
      const thread = await unique(state.target.locator("xpath=ancestor::ul[1]"), "Instagram native parent thread");
      const expand = await unique(thread.getByRole("button", { name: current.expandLabel, exact: true }),
        "Instagram native count-bound reply expansion");
      // Latch before awaiting click: an ambiguous expansion never causes a second click.
      state.expandAttempted = true;
      let attempts = instagramExpansionAttempts.get(tab);
      if (!attempts) { attempts = new Set(); instagramExpansionAttempts.set(tab, attempts); }
      attempts.add(state.binding);
      await expand.click();
      // Wait only for the count-bound native child anchors to become visible.
      // This is UI readiness, not terminal/absence evidence; the two complete
      // parent-bound row reads below still decide whether the candidate holds.
      await thread.locator(`a[href^=${JSON.stringify(`${current.parent.path}r/`)}]`)
        .filter({ has: tab.playwright.locator("time") }).nth(state.declaredCount - 1)
        .waitFor({ state: "visible", timeoutMs: 10000 });
    }
    await inspectInstagram(tab, action, "after");
    const final = await inspectInstagram(tab, action, "after");
    if (!final.exhaustiveThread) fail("Instagram native reply expansion is not stably exhausted");
    const verified = instagramReplyEvidence.get(tab);
    if (final.ownReplyCount === 0 && final.exactOwnCount === 0 && !verified.preflightBaseline) {
      verified.preflightBaseline = immutableJsonSnapshot({
        binding: verified.binding, documentBinding: verified.documentBinding,
        documentKey: verified.documentKey, rows: verified.current.rows,
      }, "Instagram private preflight reply baseline");
    }
    return final;
  } finally {
    instagramPreparations.delete(tab);
  }
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

function newInstagramCanaryReply(state, baseline, action) {
  const current = state.current;
  if (state.binding !== baseline.binding || state.documentKey !== baseline.documentKey
      || current.loading || current.expansionPending || current.hideControlCount !== 1
      || current.ownReplyCount !== 1 || current.exactOwnCount !== 1
      || current.rows.length !== baseline.rows.length + 1) {
    fail("Instagram positive canary readback is not complete and parent-bound");
  }
  const original = new Map(baseline.rows.map((row) => [row.path, row]));
  const added = [];
  for (const row of current.rows) {
    const previous = original.get(row.path);
    if (previous) {
      if (digestObject(row) !== digestObject(previous)) fail("Instagram original reply changed during canary readback");
      original.delete(row.path);
    } else added.push(row);
  }
  const account = action.scope.account_key.replace(/^@/u, "");
  if (original.size || added.length !== 1 || added[0].author !== account
      || added[0].body !== normalize(action.reply_text)) {
    fail("Instagram canary readback requires exactly one new approved own reply");
  }
  return added[0];
}

/** Positive sent evidence only. No caller baseline, absence result, or submit retry. */
export async function inspectLiveCanaryResult(tab, action) {
  assertAction(action);
  if (action.scope.platform !== "instagram") fail("native canary readback is only verified for Instagram");
  if (instagramPreparations.has(tab)) fail("Instagram reply preparation or canary readback is already running");
  const state = instagramReplyEvidence.get(tab);
  const baseline = state?.preflightBaseline;
  const expectedBinding = digestObject({ action, observedUrl: liveReplyUrl(action) });
  if (!baseline || baseline.binding !== expectedBinding) {
    fail("Instagram positive canary readback requires its private zero-own preflight baseline");
  }
  instagramPreparations.add(tab);
  try {
    let firstDigest = null;
    let reply = null;
    let inspection = null;
    for (let read = 0; read < 2; read += 1) {
      inspection = await inspectInstagram(tab, action, "after");
      if (instagramReplyEvidence.get(tab) !== state) fail("Instagram canary UI or action binding changed");
      reply = newInstagramCanaryReply(state, baseline, action);
      const digest = digestObject(state.current.rows, "Instagram positive canary reply rows");
      if (firstDigest !== null && firstDigest !== digest) fail("Instagram positive canary rows are not stable");
      firstDigest = digest;
    }
    return immutableJsonSnapshot({
      observedUrl: inspection.observedUrl, complete: false, exhaustiveThread: false,
      verifiedNewReply: true, positive_only: true, absence_proven: false,
      replyPermalink: new URL(reply.path, inspection.observedUrl).toString(),
      totalReplies: state.current.totalReplies, ownReplyCount: 1, exactOwnCount: 1,
      action_digest: digestObject(action), binding_digest: baseline.binding,
      documentBinding: baseline.documentBinding, baseline_rows_digest: digestObject(baseline.rows),
      rows_digest: firstDigest, stable_reads: 2,
      blockedReason: "instagram_selected_parent_proof_is_separate_from_positive_readback",
    }, "Instagram positive canary result");
  } finally {
    instagramPreparations.delete(tab);
  }
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

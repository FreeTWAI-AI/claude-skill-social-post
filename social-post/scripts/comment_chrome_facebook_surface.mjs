/** Source-owned Facebook account and exact-parent read-only inspection. */
import { fail, requiredString, unique } from "./comment_chrome_common.mjs";
import { currentUrl, trustedUrl } from "./comment_chrome_live_common.mjs";

const inspectionBrowsers = new WeakMap();

/** Called only with the source-owned runtime browser by the fused bridge. */
export function bindLiveReplyBrowser(tab, browser) {
  if (!tab || !browser?.tabs || typeof browser.tabs.new !== "function") fail("live inspection requires a runtime browser");
  inspectionBrowsers.set(tab, browser);
}

export async function verifyFacebookAccount(tab, action) {
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

export async function inspectFacebook(tab, action, phase) {
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

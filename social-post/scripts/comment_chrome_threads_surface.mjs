/** Source-owned Threads native parent, reply column and composer inspection. */
import { fail, unique } from "./comment_chrome_common.mjs";
import { currentUrl, liveReplyUrl, normalize } from "./comment_chrome_live_common.mjs";

export async function inspectThreads(tab, action, phase) {
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

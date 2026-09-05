/** Pure Threads selected-modal reader; no browser access or send authority. */

/** Read the actual modal card. Its TIME has no permalink; this is not selection authority. */
export function readThreadsSelectedDialog(root, expected) {
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
  if (!visible(root) || root.getAttribute("role") !== "dialog" || root.getAttribute("aria-modal") !== "true" || root.getAttribute("aria-busy") === "true"
      || root.querySelector('[role="dialog"],[role="progressbar"],[role="status"],[aria-busy="true"]')) return null;
  const headings = [...root.querySelectorAll('h1,h2,[role="heading"]')].filter(visible);
  const times = [...root.querySelectorAll("time")].filter(visible);
  if (headings.length !== 1 || norm(headings[0].innerText) !== "回覆" || times.length !== 1) return null;
  const time = times[0];
  let card = time.parentElement;
  for (let depth = 0; card && card !== root && depth < 8; depth += 1, card = card.parentElement) {
    if (card.children.length === 4 && card.children[1].contains(time)) break;
  }
  if (!card || card === root || card.children.length !== 4 || !card.children[1].contains(time)) return null;
  const [avatar, header, connector, bodyBranch] = card.children;
  const bodyShell = bodyBranch.children[0];
  if (bodyBranch.children.length !== 1 || bodyShell?.tagName !== "DIV" || bodyShell.children.length !== 2) return null;
  const [context, content] = bodyShell.children;
  if ([bodyBranch, bodyShell, context, content].some((node) => !visible(node) || node.getAttribute("aria-hidden") === "true")) return null;
  if ([card, bodyBranch, bodyShell].some((node) => [...node.childNodes].some((child) => child.nodeType === 3 && norm(child.nodeValue)))) return null;
  const profiles = [...header.querySelectorAll('a[href]')].filter(visible);
  const avatarProfiles = [...avatar.querySelectorAll('a[href]')].filter(visible);
  const avatarImages = [...avatar.querySelectorAll("img")].filter(visible);
  if (avatar.tagName !== "DIV" || avatarProfiles.length !== 1
      || avatarProfiles[0].getAttribute("href") !== `/@${expected.author}`
      || avatarImages.length !== 1 || !avatarProfiles[0].contains(avatarImages[0])
      || avatarImages[0].getAttribute("alt") !== `${expected.author}的大頭貼照`
      || profiles.length !== 1 || profiles[0].getAttribute("href") !== `/@${expected.author}`
      || norm(profiles[0].innerText) !== expected.author || norm(connector.textContent)
      || connector.querySelector('a,img,time,button,[role]')) return null;
  const ancestorAuthor = expected.postPath.match(/^\/@([^/]+)\/post\//u)?.[1];
  const contextAuthor = norm(rich(context)).match(/^正在回覆 ?@([A-Za-z0-9._-]+)$/u)?.[1];
  if (!ancestorAuthor || contextAuthor !== ancestorAuthor
      || content.querySelector('button,[role="button"],[aria-expanded="false"]')
      || content.getAttribute("aria-expanded") === "false" || norm(rich(content)) !== expected.body
      || norm(time.innerText) !== expected.displayedAt || time.getAttribute("datetime") !== expected.targetDatetime) return null;
  if ([context, content].some((part) => [...part.querySelectorAll("*")].some((node) =>
    (!visible(node) || node.getAttribute("aria-hidden") === "true")
      && norm(node.textContent || node.getAttribute("alt"))))) return null;
  const textboxes = [...root.querySelectorAll('[role="textbox"]')].filter(visible);
  if (textboxes.length !== 1 || card.contains(textboxes[0])) return null;
  const textbox = textboxes[0];
  const placeholder = textbox.getAttribute("aria-placeholder");
  const mention = placeholder?.match(/^回覆\s*([A-Za-z0-9._-]+)(?:…{2}|⋯{2})$/u)?.[1];
  if (textbox.tagName !== "DIV" || textbox.getAttribute("contenteditable") !== "true"
      || textbox.getAttribute("data-lexical-editor") !== "true" || mention !== expected.author) return null;
  const ownImages = [...root.querySelectorAll("img")].filter((image) => visible(image)
    && image.getAttribute("alt") === `${expected.account}的大頭貼照` && !card.contains(image));
  // The observed desktop dialog repeats the account avatar once in the
  // composer and once in the add-thread branch. Anything else is ambiguous.
  if (ownImages.length !== 2) return null;
  let composeBranch = textbox.parentElement;
  while (composeBranch && composeBranch !== root
      && ownImages.filter((image) => composeBranch.contains(image)).length !== 1) {
    composeBranch = composeBranch.parentElement;
  }
  if (!composeBranch || composeBranch === root || composeBranch.contains(card)) return null;
  const accountNames = [...composeBranch.querySelectorAll('a,span,div')].filter((node) => visible(node)
    && !textbox.contains(node) && norm(node.innerText) === expected.account
    && ![...node.children].some((child) => norm(child.innerText) === expected.account));
  if (accountNames.length !== 1 || [...composeBranch.querySelectorAll('a[href]')].some((link) =>
    !textbox.contains(link) && link.getAttribute("href") !== `/@${expected.account}`)) return null;
  const submits = [...root.querySelectorAll('button,[role="button"]')].filter((node) => visible(node) && norm(node.innerText) === "發佈");
  if (submits.length !== 1 || card.contains(submits[0])) return null;
  return { author: norm(profiles[0].innerText), body: norm(rich(content)), displayedAt: norm(time.innerText),
    targetDatetime: time.getAttribute("datetime"), ancestorAuthor, account: norm(accountNames[0].innerText),
    composerText: String(textbox.innerText ?? ""), composerEmpty: !norm(textbox.textContent) && !norm(textbox.innerText)
      && !textbox.querySelector('img,svg,video,a,button,[role="button"]'), placeholder, terminal: false };
}

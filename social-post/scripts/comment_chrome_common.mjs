import { createHash } from "node:crypto";

export const SUPPORTED_PLATFORMS = new Set(["facebook", "instagram", "threads"]);
export const LIVE_HOSTS = {
  facebook: new Set(["facebook.com", "www.facebook.com", "m.facebook.com"]),
  instagram: new Set(["instagram.com", "www.instagram.com"]),
  threads: new Set(["threads.com", "www.threads.com", "threads.net", "www.threads.net"]),
};

export function fail(message) {
  throw new Error(`comment Chrome actuator: ${message}`);
}

export function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value.trim();
}

export function requireBoolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be boolean`);
  return value;
}

export function normalizedText(value) {
  return String(value ?? "").normalize("NFC").trim();
}

export function assertSingleLine(value, label) {
  const text = requiredString(value, label);
  if (/\r|\n/u.test(text)) fail(`${label} must be a single line`);
  return text.normalize("NFC");
}

export function nowIso(clock) {
  const value = clock ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail("clock returned an invalid time");
  return date.toISOString();
}

export function sha256Text(value) {
  return createHash("sha256").update(normalizedText(value), "utf8").digest("hex");
}

function canonicalValue(value, label) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, label));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key], label)]),
    );
  }
  fail(`${label} must contain only JSON-compatible values`);
}

function deepFreezeJson(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreezeJson(item);
  return Object.freeze(value);
}

export function immutableJsonSnapshot(value, label = "value") {
  return deepFreezeJson(canonicalValue(value, label));
}

export function digestObject(value, label = "value") {
  const payload = JSON.stringify(canonicalValue(value, label));
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function canonicalUrl(raw, { allowLoopbackPort = false } = {}) {
  const url = new URL(requiredString(raw, "URL"));
  if (url.username || url.password) fail("URL credentials are forbidden");
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(url.hostname);
  if (url.port && !(allowLoopbackPort && loopback)) fail("non-default URL ports are forbidden");
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

/** Same-media aliases do not authorize another host, query, or comment. */
export function instagramUrlIdentity(raw, { allowComment = false } = {}) {
  const input = requiredString(raw, "Instagram URL");
  const url = canonicalUrl(input);
  if (url.protocol !== "https:" || !LIVE_HOSTS.instagram.has(url.hostname)) {
    fail("Instagram URL is not on a trusted HTTPS host");
  }
  const rawPath = input.match(/^https:\/\/[^/?#]+([^?#]*)/iu)?.[1]?.replace(/\/+$/u, "");
  if (rawPath !== url.pathname) fail("Instagram URL path is ambiguous");
  const post = url.pathname.match(/^\/(?:([A-Za-z0-9._]+)\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)$/u);
  const comment = allowComment
    ? url.pathname.match(/^\/p\/([A-Za-z0-9_-]+)\/c\/([A-Za-z0-9_-]+)$/u) : null;
  if ((!post || /^(?:p|reel|reels|tv|c)$/u.test(post[1] ?? "")) && !comment) {
    fail("Instagram URL is not a supported post or native comment permalink");
  }
  const keys = new Set();
  for (const [key] of url.searchParams) {
    const normalized = key.toLowerCase();
    if (keys.has(normalized) || /^(?:id|comment_?id|reply_?id|media_?id|shortcode)$/u.test(normalized)) {
      fail("Instagram URL query contains duplicate or ambiguous identifiers");
    }
    keys.add(normalized);
  }
  return Object.freeze({
    url: url.toString(), hostname: url.hostname, query: url.search,
    shortcode: comment ? comment[1] : post[2], commentId: comment?.[2] ?? null,
  });
}

export function sameInstagramPostUrl(observed, expected) {
  const current = instagramUrlIdentity(observed);
  const target = instagramUrlIdentity(expected);
  return current.hostname === target.hostname && current.shortcode === target.shortcode
    && current.query === target.query;
}

function sameApprovedUrl(observed, expected) {
  return observed.protocol === expected.protocol
    && observed.hostname === expected.hostname
    && observed.port === expected.port
    && observed.pathname === expected.pathname
    && observed.search === expected.search;
}

export function mappedObservedUrl(actual, action, options = {}) {
  const expected = canonicalUrl(action.post_permalink);
  const platform = action.scope.platform;
  if (expected.protocol !== "https:" || !LIVE_HOSTS[platform].has(expected.hostname)) {
    fail(`approved ${platform} post permalink is not trusted`);
  }
  if (options.testOnly === true) {
    const actualUrl = canonicalUrl(actual, { allowLoopbackPort: true });
    if (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(actualUrl.hostname)) {
      fail("testOnly URL mapping is restricted to loopback hosts");
    }
    const mapped = canonicalUrl(options.receiptObservedUrl);
    if (!LIVE_HOSTS[platform].has(mapped.hostname) || !sameApprovedUrl(mapped, expected)) {
      fail("testOnly receipt URL differs from the approved platform post");
    }
    return mapped.toString();
  }
  const observed = canonicalUrl(actual);
  if (observed.protocol !== "https:" || !LIVE_HOSTS[platform].has(observed.hostname)) {
    fail(`live ${platform} action is on an untrusted host`);
  }
  if (!sameApprovedUrl(observed, expected)) {
    fail("current URL differs from the approved post permalink");
  }
  return observed.toString();
}

function scopeRoot(tab, target, spec, replyItem = null) {
  const within = spec.within || "page";
  if (within === "page") return tab.playwright;
  if (within === "target") return target;
  if (within === "reply") {
    if (!replyItem) fail("reply-scoped locator used without a reply item");
    return replyItem;
  }
  fail(`unknown locator scope ${within}`);
}

export function locate(tab, target, spec, replyItem = null) {
  const root = scopeRoot(tab, target, spec, replyItem);
  return spec.self === true ? root : root.locator(spec.selector, {});
}

export async function unique(locator, label, { visible = true, enabled = false } = {}) {
  const count = await locator.count();
  if (count !== 1) fail(`${label} expected exactly one match, found ${count}`);
  if (visible && !(await locator.isVisible())) fail(`${label} is not visible`);
  if (enabled && !(await locator.isEnabled())) fail(`${label} is not enabled`);
  return locator;
}

export async function readValue(locator, spec) {
  if (spec.attribute) return normalizedText(await locator.getAttribute(spec.attribute));
  if (spec.valueProperty) {
    return normalizedText(await locator.evaluate((element) => (
      "value" in element ? element.value : element.textContent
    )));
  }
  return normalizedText(await locator.textContent());
}

export function forbidMutableExpected(spec, label) {
  if (Object.prototype.hasOwnProperty.call(spec, "expected")) {
    fail(`${label}.expected is forbidden; expected evidence comes from the approved envelope`);
  }
}

export async function verifyNearestAnchorOwner(locator, ownership, label) {
  if (!ownership || typeof ownership !== "object") fail(`${label} ownership is required`);
  const attribute = requiredString(ownership.attribute, `${label} ownership attribute`);
  const expected = normalizedText(requiredString(ownership.expected, `${label} approved anchor`));
  const observed = normalizedText(await locator.evaluate((element, config) => {
    let current = config.fromParent ? element.parentElement : element;
    while (current) {
      if (typeof current.hasAttribute === "function" && current.hasAttribute(config.attribute)) {
        return current.getAttribute(config.attribute);
      }
      current = current.parentElement;
    }
    return null;
  }, { attribute, fromParent: ownership.fromParent === true }));
  if (observed !== expected) {
    fail(`${label} belongs to anchored target ${JSON.stringify(observed || null)}, not approved target ${JSON.stringify(expected)}`);
  }
  return observed;
}

export async function verifyEvidence(locator, spec, expected, label, ownership = null) {
  forbidMutableExpected(spec, label);
  await unique(locator, label, { visible: spec.visible !== false, enabled: Boolean(spec.enabled) });
  if (ownership) {
    await verifyNearestAnchorOwner(
      locator, { ...ownership, fromParent: false }, label,
    );
  }
  const observed = await readValue(locator, spec);
  const wanted = normalizedText(expected);
  if (!wanted) fail(`${label} has no approved evidence value`);
  if (observed !== wanted) {
    fail(`${label} evidence mismatch: expected ${JSON.stringify(wanted)}, found ${JSON.stringify(observed)}`);
  }
  return observed;
}

export async function readComposer(composer) {
  return normalizedText(await composer.evaluate((element) => {
    const contentEditable = typeof element.getAttribute === "function"
      ? element.getAttribute("contenteditable") : null;
    const usesEditableText = element.isContentEditable === true
      || (typeof contentEditable === "string"
        && contentEditable.toLowerCase() !== "false");
    if (usesEditableText) return element.innerText ?? element.textContent;
    if ("value" in element) return element.value;
    return element.textContent;
  }));
}

export async function verifyExpansionComplete(tab, target, spec, label) {
  const remaining = locate(tab, target, spec);
  const count = await remaining.count();
  if (count !== 0) fail(`${label} is incomplete because ${count} expansion controls remain`);
}

export async function matchingOwnReplies(
  tab, target, plan, replyText, ownAuthor, ownership,
) {
  const items = locate(tab, target, plan.replyItems);
  const total = await items.count();
  const matches = [];
  const entries = [];
  let inspectable = 0;
  let ownAuthorCount = 0;
  for (let index = 0; index < total; index += 1) {
    const item = items.nth(index);
    if (!(await item.isVisible())) continue;
    await verifyNearestAnchorOwner(
      item, { ...ownership, fromParent: true }, "reply item",
    );
    const itemAnchor = normalizedText(await item.getAttribute(ownership.attribute))
      || normalizedText(ownership.expected);
    const itemOwnership = { attribute: ownership.attribute, expected: itemAnchor };
    const bodyLocator = locate(tab, target, plan.replyBody, item);
    const authorLocator = locate(tab, target, plan.replyAuthor, item);
    if ((await bodyLocator.count()) !== 1 || (await authorLocator.count()) !== 1) continue;
    if (!(await bodyLocator.isVisible()) || !(await authorLocator.isVisible())) continue;
    await verifyNearestAnchorOwner(bodyLocator, {
      ...itemOwnership, fromParent: false,
    }, "reply body");
    await verifyNearestAnchorOwner(authorLocator, {
      ...itemOwnership, fromParent: false,
    }, "reply author");
    inspectable += 1;
    const body = await readValue(bodyLocator, plan.replyBody);
    const author = await readValue(authorLocator, plan.replyAuthor);
    entries.push({ index, body, author });
    const isOwnAuthor = author === normalizedText(ownAuthor);
    if (isOwnAuthor) ownAuthorCount += 1;
    if (body === normalizedText(replyText) && isOwnAuthor) {
      matches.push({ index, body, author });
    }
  }
  const endTotal = await items.count();
  return {
    total, end_total: endTotal, inspectable, matches,
    own_author_count: ownAuthorCount,
    snapshot_digest: digestObject({ total, entries }, "reply evidence snapshot"),
  };
}

export function receiptTestOnly(options = {}) {
  return options.testOnly === true;
}

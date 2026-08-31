/** Read-only DOM-CUA node identity; no action, claim or send authorization. */
import { digestObject, fail, immutableJsonSnapshot, unique } from "./comment_chrome_common.mjs";

const DOM_CUA_ATTRIBUTES = Object.freeze([
  "aria-disabled", "aria-label", "contenteditable", "href", "name",
  "placeholder", "role", "title", "type", "value",
]);
const DOM_CUA_BOOLEAN_ATTRIBUTES = Object.freeze([
  "checked", "disabled", "multiple", "readonly", "required", "selected",
]);

function stableVisibleText(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim().slice(0, 160);
}

function decodeDomCuaText(value) {
  return String(value ?? "")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

function parseDomCuaAttributes(raw) {
  const attributes = {};
  const booleans = [];
  const pattern = /([^\s=]+)(?:="([^"]*)")?/gu;
  for (const match of String(raw ?? "").matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (name === "node_id") continue;
    if (DOM_CUA_BOOLEAN_ATTRIBUTES.includes(name)
        && (match[2] === undefined || match[2] === "true")) {
      booleans.push(name);
    } else if (DOM_CUA_ATTRIBUTES.includes(name) && match[2] !== undefined) {
      attributes[name] = decodeDomCuaText(match[2]).normalize("NFC");
    }
  }
  return {
    attributes: Object.fromEntries(Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b))),
    booleans: [...new Set(booleans)].sort(),
  };
}

function parseDomCuaLine(rawLine) {
  const line = String(rawLine ?? "").trim();
  const opening = line.match(/^<([a-z][\w:-]*)\b([^>]*)>([\s\S]*)$/iu);
  if (!opening) return null;
  const tag = opening[1].toLowerCase();
  const nodeMatch = opening[2].match(/(?:^|\s)node_id=(?:"([^"]+)"|([^\s>]+))(?:\s|$)/u);
  if (!nodeMatch) return null;
  let body = opening[3];
  const closing = `</${tag}>`;
  if (body.toLowerCase().endsWith(closing)) body = body.slice(0, -closing.length);
  else if (body && body !== "/") return null;
  const parsed = parseDomCuaAttributes(opening[2]);
  return immutableJsonSnapshot({
    node_id: String(nodeMatch[1] ?? nodeMatch[2]).trim(),
    tag,
    attributes: parsed.attributes,
    booleans: parsed.booleans,
    text: stableVisibleText(decodeDomCuaText(body === "/" ? "" : body)),
  }, "DOM-CUA node");
}

export function captureDomCuaSnapshot(raw) {
  if (typeof raw !== "string") fail("stable-node visible DOM snapshot must be a string");
  const nodes = raw.split(/\r?\n/u).map(parseDomCuaLine).filter(Boolean);
  const ids = new Set();
  for (const node of nodes) {
    if (typeof node.node_id !== "string" || !node.node_id) {
      fail("stable-node visible DOM snapshot contains an invalid node_id");
    }
    if (ids.has(node.node_id)) fail("stable-node visible DOM snapshot contains duplicate node_id values");
    ids.add(node.node_id);
  }
  return immutableJsonSnapshot({ nodes }, "stable-node visible DOM snapshot");
}

function nodeIdentity(node) {
  return {
    tag: node.tag,
    attributes: node.attributes,
    booleans: node.booleans,
    text: node.text,
  };
}

function rehydrateStableSubmitIdentity(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("stable submit identity must be an object");
  }
  const expectedKeys = ["attributes", "booleans", "tag", "text"];
  const keys = Object.keys(raw).sort();
  if (keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])) {
    fail("stable submit identity has an unexpected shape");
  }
  if (!raw.attributes || typeof raw.attributes !== "object"
      || Array.isArray(raw.attributes)) {
    fail("stable submit identity attributes must be an object");
  }
  const attributes = {};
  for (const [name, value] of Object.entries(raw.attributes)) {
    if (!DOM_CUA_ATTRIBUTES.includes(name) || typeof value !== "string" || value === "") {
      fail("stable submit identity contains an invalid attribute");
    }
    attributes[name] = value.normalize("NFC");
  }
  if (!Array.isArray(raw.booleans)
      || raw.booleans.some((name) => (
        typeof name !== "string" || !DOM_CUA_BOOLEAN_ATTRIBUTES.includes(name)
      ))
      || new Set(raw.booleans).size !== raw.booleans.length) {
    fail("stable submit identity contains invalid boolean attributes");
  }
  if (typeof raw.tag !== "string" || typeof raw.text !== "string") {
    fail("stable submit identity tag and text must be strings");
  }
  // Browser-controlled locator evaluation can return plain data whose object
  // prototype belongs to a different JavaScript realm.  Rebuild only this
  // reviewed schema into local plain objects instead of weakening the global
  // JSON/prototype guard used for actions, plans and receipts.
  return immutableJsonSnapshot({
    tag: raw.tag.normalize("NFC").toLowerCase(),
    attributes: Object.fromEntries(
      Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right)),
    ),
    booleans: [...raw.booleans].sort(),
    text: stableVisibleText(raw.text),
  }, "stable submit identity");
}

export function bindExactVisibleNode(snapshot, identity) {
  const expected = digestObject(identity, "stable submit identity");
  const matches = snapshot.nodes.filter(
    (node) => digestObject(nodeIdentity(node), "visible DOM node identity") === expected,
  );
  if (matches.length !== 1) {
    fail(`stable submit identity requires exactly one visible DOM node, found ${matches.length}`);
  }
  return matches[0].node_id;
}

export async function readStableSubmitIdentity(locator) {
  const raw = await locator.evaluate((element, input) => {
    const attributes = {};
    for (const name of input.attributes) {
      const value = element.getAttribute(name);
      if (element.hasAttribute(name) && value !== null && value !== "") attributes[name] = value;
    }
    const booleans = input.booleans.filter((name) => element.hasAttribute(name));
    const tag = String(element.tagName ?? "").toLowerCase();
    const visibleText = tag === "textarea" ? element.value : (element.innerText ?? element.textContent ?? "");
    if (tag === "textarea" && typeof visibleText !== "string") {
      throw new Error("textarea current value is unavailable for stable-node binding");
    }
    const text = String(visibleText)
      .normalize("NFC").replace(/\s+/gu, " ").trim().slice(0, 160);
    return {
      tag,
      attributes,
      booleans,
      text,
    };
  }, { attributes: DOM_CUA_ATTRIBUTES, booleans: DOM_CUA_BOOLEAN_ATTRIBUTES });
  const identity = rehydrateStableSubmitIdentity(raw);
  if (!identity.tag || !/^[a-z][\w:-]*$/u.test(identity.tag)) {
    fail("stable submit identity has no valid DOM tag");
  }
  return identity;
}

function requireDomCuaSurface(tab) {
  if (!tab?.dom_cua
      || typeof tab.dom_cua.get_visible_dom !== "function"
      || typeof tab.dom_cua.click !== "function") {
    fail("submit requires the Browser DOM-CUA stable-node surface");
  }
  return tab.dom_cua;
}

export function assertStableNodeSurface(tab, preparation) {
  const surface = requireDomCuaSurface(tab);
  if (preparation.test_only === false) {
    fail("live submit is unavailable until a trusted Chrome host resolver exists");
  }
  return surface;
}

/** Read-only binding of an already verified, source-owned live submit locator. */
export async function bindObservedSubmitNode(tab, locator) {
  const surface = requireDomCuaSurface(tab);
  const first = captureDomCuaSnapshot(await surface.get_visible_dom());
  const identity = await readStableSubmitIdentity(locator);
  const nodeId = bindExactVisibleNode(first, identity);
  const second = captureDomCuaSnapshot(await surface.get_visible_dom());
  if (bindExactVisibleNode(second, identity) !== nodeId) {
    fail("live submit node changed during read-only binding");
  }
  return nodeId;
}

async function readStableThreadsReplyIconIdentity(locator) {
  const raw = await locator.evaluate((element, input) => {
    const norm = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
    const tag = (node) => String(node?.tagName ?? "").toLowerCase();
    const visible = (node) => {
      if (!node?.getClientRects().length) return false;
      for (let current = node; current; current = current.parentElement) {
        if (current.hasAttribute("hidden") || current.hasAttribute("inert")
            || current.getAttribute("aria-hidden") === "true") return false;
      }
      return true;
    };
    if (tag(element) !== "div" || element.getAttribute("role") !== "button" || !visible(element)
        || element.hasAttribute("disabled") || ![null, "false"].includes(element.getAttribute("aria-disabled"))
        || ["aria-label", "aria-labelledby", "title"].some((name) => element.hasAttribute(name))
        || typeof element.innerText !== "string" || norm(element.innerText)
        || typeof element.textContent !== "string" || norm(element.textContent) !== "回覆") return null;
    const icons = [...element.querySelectorAll('svg,img,[role="img"]')];
    if (icons.length !== 1) return null;
    const icon = icons[0];
    if (tag(icon) !== "svg" || !visible(icon) || icon.getAttribute("role") !== "img"
        || icon.getAttribute("aria-label") !== "回覆" || icon.hasAttribute("aria-labelledby")) return null;
    const titles = [...icon.querySelectorAll("title")];
    const children = [...icon.children];
    if (titles.length !== 1 || children.length !== 2 || children[0] !== titles[0]
        || tag(children[1]) !== "path" || children[1].children.length
        || titles[0].children.length || norm(titles[0].textContent) !== "回覆") return null;
    const textOutsideTitle = (node) => {
      if (node === titles[0]) return "";
      if (node.nodeType === 3) return node.nodeValue ?? "";
      return [...(node.childNodes ?? [])].map(textOutsideTitle).join("");
    };
    // SVG TITLE is semantic metadata, not rendered text. No other text,
    // including hidden text, may be used to manufacture this icon label.
    if (norm(textOutsideTitle(element))
        || element.querySelector('a,button,input,textarea,select,video,canvas,[role="button"],[role="textbox"],[contenteditable]')
        || [...element.querySelectorAll('[aria-label],[aria-labelledby],[title]')].some((node) => node !== icon)) return null;
    const attributes = {};
    for (const name of input.attributes) {
      const value = element.getAttribute(name);
      if (element.hasAttribute(name) && value !== null && value !== "") attributes[name] = value;
    }
    return { tag: "div", attributes,
      booleans: input.booleans.filter((name) => element.hasAttribute(name)), text: "回覆" };
  }, { attributes: DOM_CUA_ATTRIBUTES, booleans: DOM_CUA_BOOLEAN_ATTRIBUTES });
  if (!raw) fail("Threads reply icon requires its exact visible semantic SVG shape");
  return rehydrateStableSubmitIdentity(raw);
}

/** Read-only, icon-only binding; never a generic hidden-text fallback or send authority. */
export async function bindObservedThreadsReplyIconNode(tab, locator) {
  const surface = requireDomCuaSurface(tab);
  const target = await unique(locator, "Threads reply icon", { enabled: true });
  const first = captureDomCuaSnapshot(await surface.get_visible_dom());
  const identity = await readStableThreadsReplyIconIdentity(target);
  const nodeId = bindExactVisibleNode(first, identity);
  const second = captureDomCuaSnapshot(await surface.get_visible_dom());
  if (bindExactVisibleNode(second, identity) !== nodeId) {
    fail("Threads reply icon node changed during read-only binding");
  }
  const repeated = await readStableThreadsReplyIconIdentity(target);
  if (digestObject(repeated) !== digestObject(identity)) fail("Threads reply icon identity changed during read-only binding");
  const third = captureDomCuaSnapshot(await surface.get_visible_dom());
  if (bindExactVisibleNode(third, identity) !== nodeId) {
    fail("Threads reply icon node changed during final read-only binding");
  }
  return nodeId;
}

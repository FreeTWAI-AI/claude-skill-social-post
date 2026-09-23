/** Anonymous actual-DOM selection tests; no real Chrome, submit, or ledger. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import * as common from "./comment_chrome_common.mjs";
import * as sendSupport from "./comment_chrome_send_support.mjs";
import * as liveSurface from "./comment_chrome_live_surface.mjs";
import * as cuaRuntime from "./comment_cua_runtime.mjs";
import { nativeInstagramFixture, nativeNode } from "./comment_chrome_live_surface_fixture_testonly.mjs";
import { prepareInstagramCanarySelection, revalidateInstagramCanarySelection } from "./comment_chrome_instagram_selection.mjs";
import { getCommentCuaBrowser, installCommentCuaRuntime } from "./comment_cua_runtime.mjs";

const fixtures = new Map();
const browserId = "anonymous-selection-browser";
await installCommentCuaRuntime({
  getState: async () => ({ browsers: [{ id: browserId, family: "chrome", type: "extension",
    metadata: { extensionInstanceId: "anonymous-selection-extension" },
    tabs: [...fixtures.values()].map((fixture) => ({ id: fixture.tab.id, url: fixture.url })) }] }),
  getTab: async (id) => fixtures.get(id)?.tab,
  createBrowserTab: async () => { throw new Error("selection tests never create a real tab"); },
}, { browserId });

class SelectionLocator {
  constructor(fixture, inner) { this.fixture = fixture; this.inner = inner; }
  wrap(inner) { return new SelectionLocator(this.fixture, inner); }
  locator(selector) { return this.wrap(this.inner.locator(selector)); }
  getByRole(role, options) { return this.wrap(this.inner.getByRole(role, options)); }
  filter(options) { return this.wrap(this.inner.filter({ ...options, has: options.has.inner })); }
  nth(index) { return this.wrap(this.inner.nth(index)); }
  count() { return this.inner.count(); }
  isVisible() { return this.inner.isVisible(); }
  isEnabled() { return this.inner.isEnabled(); }
  waitFor(options) { return this.inner.waitFor(options); }
  evaluate(callback, argument) { return this.inner.evaluate(callback, argument); }
  async click(options) {
    const nodes = this.inner.resolve();
    if (nodes.length === 1 && nodes[0].innerText === "回覆") {
      const parent = nodes[0].closest("li");
      assert.equal(parent.querySelector('a[href] time').parentElement.getAttribute("href"), "/p/abc/c/123/",
        "the actual production locator must select the approved parent, not a child's reply control");
      assert.deepEqual(options, { timeoutMs: 5000 });
      this.fixture.selectionClicks += 1;
      this.fixture.events?.push("selection-click");
      this.fixture.editor().value = this.fixture.nativePrefix ?? "@reader ";
      this.fixture.onSelect?.(this.fixture);
      if (this.fixture.selectionThrows) throw new Error("ambiguous source selection click");
      return;
    }
    if (this.fixture.dispatch && nodes.length === 1 && nodes[0].innerText === "發佈") {
      assert.equal(options.timeoutMs, 5000);
      assert.equal(this.fixture.editor().value, this.fixture.action.reply_text);
      this.fixture.counters.submit += 1;
      this.fixture.events.push("submit-click");
      if (this.fixture.submitThrows) throw new Error("ambiguous IG submit");
      this.fixture.rows.push({ id: "502", author: "example", body: this.fixture.action.reply_text });
      this.fixture.render();
      return;
    }
    return this.inner.click(options);
  }
  async fill(text, options) {
    if (!this.fixture.dispatch) throw new Error("selection helper must never fill");
    assert.equal(options.timeoutMs, 5000);
    assert.equal(text, this.fixture.action.reply_text);
    this.fixture.counters.fill += 1;
    this.fixture.events.push("fill");
    if (!this.fixture.fillNoEffect) this.fixture.editor().value = text;
    this.fixture.afterFill?.(this.fixture);
  }
}

async function fixture(options = {}) {
  const value = nativeInstagramFixture({ rows: [{ id: "501", author: "another_reader", body: "Earlier reply" }], ...options });
  value.action.reply_text = "@reader Thanks for reading!";
  value.action.reply_hash = createHash("sha256").update(value.action.reply_text).digest("hex");
  value.selectionClicks = 0;
  value.editor = () => value.document.querySelector("textarea");
  const render = value.render.bind(value);
  value.render = () => {
    render();
    value.editor().attrs.placeholder = "留言⋯⋯";
    value.editor().hasAttribute = (name) => Object.hasOwn(value.editor().attrs, name);
    value.editor().value = options.initialText ?? "";
  };
  value.render();
  value.tab.id = `anonymous-selection-${fixtures.size + 1}`;
  const original = value.tab.playwright;
  value.tab.playwright = {
    locator: (selector) => new SelectionLocator(value, original.locator(selector)),
    getByRole: (role, query) => new SelectionLocator(value, original.getByRole(role, query)),
    evaluate: (...args) => original.evaluate(...args),
  };
  fixtures.set(value.tab.id, value);
  if (!options.unretained) await getCommentCuaBrowser().tabs.get(value.tab.id);
  return value;
}

const positive = await fixture();
const selected = await prepareInstagramCanarySelection(positive.tab, positive.action);
assert.equal(selected.selectedParentCandidate, true);
assert.equal(selected.complete, false);
assert.equal(selected.selection.schema_version, 2);
assert.equal(selected.selection.selection_kind, "source_clicked_instagram_native_reply");
assert.equal(selected.selection.composer_scope, "unique_native_post_form");
assert.equal(selected.selection.stable_reads, 2);
assert.equal(selected.composerText, "@reader ");
assert.equal(selected.composer_initial_state, "native_target_mention");
assert.equal(selected.semantic_continuity_only, true);
assert.equal(Object.hasOwn(selected.selection, "composer_node_id"), false);
assert.equal(Object.hasOwn(selected.selection.document_binding, "document_epoch"), false);
assert.equal(positive.selectionClicks, 1);
assert.equal(positive.counters.expand, 1);
assert.equal(positive.counters.fill, 0);
assert.equal(positive.counters.submit, 0);
positive.editor().value = positive.action.reply_text;
const ready = await revalidateInstagramCanarySelection(positive.tab, positive.action);
assert.equal(ready.selection_digest, selected.selection_digest);
assert.equal(ready.composerText, positive.action.reply_text);
await assert.rejects(prepareInstagramCanarySelection(positive.tab, positive.action), /already attempted/u);
assert.equal(positive.selectionClicks, 1);

const unselected = await fixture({ initialText: "@reader " });
await assert.rejects(revalidateInstagramCanarySelection(unselected.tab, unselected.action), /no valid source-click/u);
assert.equal(unselected.selectionClicks, 0, "a pre-existing mention alone is not source selection");

for (const [name, options, message] of [
  ["unretained tab", { unretained: true }, /not retained/u],
  ["existing draft", { initialText: "Do not overwrite" }, /will not overwrite/u],
  ["already replied parent", { rows: [{ id: "501", author: "example", body: "Historical own reply" }] }, /zero-own baseline/u],
  ["zero declared replies", { declaredCount: 0, rows: [] }, /positive observed pre-expansion/u],
]) {
  const value = await fixture(options);
  await assert.rejects(prepareInstagramCanarySelection(value.tab, value.action), message, name);
  assert.equal(value.selectionClicks, 0, name);
  assert.equal(value.counters.fill, 0);
  assert.equal(value.counters.submit, 0);
}

for (const [name, options, message] of [
  ["wrong native mention", { nativePrefix: "@another_reader " }, /form or draft changed/u],
  ["selection timeout after native prefix", { selectionThrows: true }, /ambiguous source selection/u],
  ["target URL drift", { onSelect: (value) => { value.url = "https://www.instagram.com/p/abc/c/456"; } }, /differs from expected URL/u],
  ["account drift", { onSelect: (value) => { value.document.querySelector("nav a").attrs.href = "/wrong_account/"; } }, /active account/u],
  ["parent body drift", { onSelect: (value) => { value.document.querySelector("li h3").nextElementSibling.text = "Changed parent"; } }, /complete body changed/u],
]) {
  const value = await fixture(options);
  await assert.rejects(prepareInstagramCanarySelection(value.tab, value.action), message, name);
  await assert.rejects(prepareInstagramCanarySelection(value.tab, value.action), /already attempted/u);
  assert.equal(value.selectionClicks, 1, `${name}: never retry the source trigger`);
  assert.equal(value.counters.fill, 0);
  assert.equal(value.counters.submit, 0);
}

for (const [name, mutate, message] of [
  ["draft changed", (value) => { value.editor().value = "Unapproved text"; }, /form or draft changed/u],
  ["form removed", (value) => { const form = value.editor().parentElement; form.parentElement.children = form.parentElement.children.filter((node) => node !== form); }, /exactly one/u],
  ["editor placeholder changed", (value) => { value.editor().attrs.placeholder = "Other editor"; }, /unique form changed/u],
  ["extra editor", (value) => { value.editor().parentElement.append(nativeNode("textarea", { "aria-label": "Other editor" })); }, /unique form changed/u],
]) {
  const value = await fixture();
  await prepareInstagramCanarySelection(value.tab, value.action);
  mutate(value);
  await assert.rejects(revalidateInstagramCanarySelection(value.tab, value.action), message, name);
  assert.equal(value.selectionClicks, 1);
  assert.equal(value.counters.submit, 0);
}

// Execute actual private preparation/claim/dispatch bodies against the actual
// live router and native readers. Only transport and ledger I/O are simulated.
const bridgeSource = await readFile(new URL("./comment_chrome_claim_bridge.mjs", import.meta.url), "utf8");
function bridgeFunction(name) {
  const start = bridgeSource.search(new RegExp(`^(?:async )?function ${name}\\(`, "mu"));
  assert.ok(start >= 0, `actual private ${name} exists`);
  const tail = bridgeSource.slice(start);
  const next = tail.slice(1).search(/^(?:export )?(?:async )?function /mu);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
const orchestration = ["requireLiveSubmitTransport", "requireCurrentReplyPermit", "readExactLiveComposer",
  "requireCanaryThread", "inspectReadyLiveComposer", "prepareLiveCanaryReply", "nativeMentionPreparation",
  "prepareInstagramCuaLiveReply", "inspectLiveFinishReceipt", "submitLiveReplyAndFinish",
  "inspectLiveReinspectionReceipt", "inspectCanaryReinspectionReceipt", "commitLiveReinspection"].map(bridgeFunction).join("\n");

async function integratedCase(options = {}) {
  const value = await fixture({ dispatch: true, events: [], ...options });
  value.action.expires_at = "2999-01-01T00:00:00.000Z";
  value.claims = 0;
  value.receipts = [];
  const environment = { ...common, ...sendSupport, ...liveSurface, ...cuaRuntime,
    Date, Object, JSON, Set, Map, WeakMap, WeakSet,
    // These actual function bodies run in a test VM, unlike the single ESM
    // source realm in production. Rehydrate only that artificial VM boundary;
    // the native reader fixtures above still retain their browser-like realm.
    digestObject: (value, label) => common.digestObject(JSON.parse(JSON.stringify(value)), label),
    immutableJsonSnapshot: (value, label) => common.immutableJsonSnapshot(JSON.parse(JSON.stringify(value)), label),
    liveCanarySelections: new WeakMap(), liveReplyExecutionReservations: new Set(),
    liveReplyRecoveryContexts: new Map(),
    requireLiveReplyPolicy: async () => {
      value.events.push("lease"); value.onLease?.(value);
      return { lease_id: "anonymous-lease", lease_digest: "anonymous-lease-digest" };
    },
    createPythonLedgerClaimSubmit: () => async () => {
      value.events.push("claim"); value.claims += 1; value.onClaim?.(value);
      if (value.claimThrows) throw new Error("anonymous durable claim rejected");
      return { claim_id: "anonymous-claim", preflight_id: "anonymous-preflight" };
    },
    isPythonLedgerClaimSubmit: () => true,
    validateWriteDecision: (decision) => decision,
    withPrivateRecoveryTab: async (_context, inspect) => {
      await cuaRuntime.requireCommentCuaTab(value.tab, value.url);
      const result = await inspect(value.tab);
      await cuaRuntime.requireCommentCuaTab(value.tab, value.url);
      return result;
    },
    commitPythonLedgerBrowserReceipt: async (_owner, operation, receipt) => {
      assert.equal(operation, value.recoveryOnly ? "browser-reconcile" : "browser-finish");
      value.receipts.push(receipt);
      return { status: receipt.exact_reply_visible ? "sent" : "needs_reconcile",
        reconcile_required: !receipt.exact_reply_visible };
    },
  };
  const api = runInNewContext(`${orchestration}\n({ prepareLiveCanaryReply, submitLiveReplyAndFinish, commitLiveReinspection })`, environment);
  const plan = { schema_version: 1, platform: "instagram", target_url: value.url };
  const canary = { intentId: value.action.intent_id, sessionId: value.action.session_id,
    leaseId: "anonymous-lease", action: value.action };
  value.prepare = () => api.prepareLiveCanaryReply(value.tab, value.action, plan, canary);
  value.send = (preparation) => api.submitLiveReplyAndFinish(value.tab, value.action, plan, preparation, canary);
  value.reconcile = () => api.commitLiveReinspection({ action: value.action,
    preparation: { preparation_id: "original-preparation", baseline_total_reply_count: 1 },
    attempt: { canary_lease_id: "original-lease", attempt_session_id: value.action.session_id,
      claim_id: "original-claim", preflight_id: "original-preflight" },
    claimSubmit: async () => { throw new Error("read-only recovery must never claim"); },
  }, { intentId: value.action.intent_id, sessionId: "fresh-recovery-session", key: "original-context" });
  value.beforeNativeRead = () => { value.events.push("native-read"); };
  return value;
}

const integrated = await integratedCase();
const preparation = await integrated.prepare();
assert.equal(preparation.selected_parent_evidence.schema_version, 2);
assert.equal(preparation.selected_parent_evidence_digest, common.digestObject(preparation.selected_parent_evidence));
assert.equal(preparation.composer_initial_state, "native_target_mention");
assert.equal(preparation.composer_initial_text, "@reader ");
assert.equal(preparation.composer_empty_before_fill, false);
assert.equal(preparation.composer_matches_reply, true);
assert.equal(integrated.claims, 0);
assert.equal(integrated.counters.fill, 1);
const sent = await integrated.send(preparation);
assert.equal(sent.status, "sent");
assert.equal(integrated.claims, 1);
assert.equal(integrated.counters.submit, 1);
assert.equal(integrated.receipts[0].submission_attempted, true);
assert.equal(integrated.receipts[0].exact_reply_visible, true,
  "actual native positive reader sees the newly added parent-bound own child");
const clickAt = integrated.events.indexOf("submit-click");
const lastRead = integrated.events.slice(0, clickAt).lastIndexOf("native-read");
assert.ok(integrated.events.lastIndexOf("lease") < lastRead && lastRead < clickAt,
  "final native parent/composer read follows last lease I/O, before one documented click");
await assert.rejects(integrated.send(preparation));
assert.equal(integrated.claims, 1);
assert.equal(integrated.counters.submit, 1);

for (const [name, options, message] of [
  ["unverified native prefix", { nativePrefix: "@wrong_reader " }, /form or draft changed/u],
  ["fill returns without changing value", { fillNoEffect: true }, /immutable approved text/u],
  ["parent drift during fill", { afterFill: (value) => { value.document.querySelector("li h3").nextElementSibling.text = "Changed"; } }, /complete body changed/u],
  ["account drift during fill", { afterFill: (value) => { value.document.querySelector("nav a").attrs.href = "/wrong_account/"; } }, /active account/u],
  ["historical own reply", { rows: [{ id: "501", author: "example", body: "Historical" }] }, /zero-own baseline/u],
]) {
  const value = await integratedCase(options);
  await assert.rejects(value.prepare(), message, name);
  assert.equal(value.claims, 0, name);
  assert.equal(value.counters.submit, 0, name);
  assert.equal(value.counters.fill, ["unverified native prefix", "historical own reply"].includes(name) ? 0 : 1);
}

for (const [name, mutate] of [
  ["parent drift before claim", (value) => { value.document.querySelector("li h3").nextElementSibling.text = "Changed"; }],
  ["draft drift before claim", (value) => { value.editor().value = "Unapproved text"; }],
]) {
  const value = await integratedCase();
  const ready = await value.prepare();
  mutate(value);
  await assert.rejects(value.send(ready), undefined, name);
  assert.equal(value.claims, 0, name);
  assert.equal(value.counters.submit, 0, name);
}

for (const [name, options] of [
  ["postclaim drift", { onClaim: (value) => { value.editor().value = "Changed after claim"; } }],
  ["last lease drift", { onLease: (value) => { if (value.claims) value.editor().value = "Changed during lease"; } }],
]) {
  const value = await integratedCase(options);
  const ready = await value.prepare();
  const result = await value.send(ready);
  assert.equal(result.status, "needs_reconcile", name);
  assert.equal(value.claims, 1, name);
  assert.equal(value.counters.submit, 0, name);
  assert.equal(value.receipts[0].submission_attempted, false);
}

const uncertain = await integratedCase({ submitThrows: true });
const uncertainPreparation = await uncertain.prepare();
assert.equal((await uncertain.send(uncertainPreparation)).status, "needs_reconcile");
assert.equal(uncertain.receipts[0].submission_attempted, true);
await assert.rejects(uncertain.send(uncertainPreparation), /second in-process execution/u);
assert.equal(uncertain.claims, 1);
assert.equal(uncertain.counters.submit, 1, "ambiguous documented click is never retried");

const recovered = await integratedCase({ recoveryOnly: true, declaredCount: 2, rows: [
  { id: "501", author: "another_reader", body: "Earlier reply" },
  { id: "502", author: "example", body: "@reader Thanks for reading!" },
] });
assert.equal((await recovered.reconcile()).status, "sent",
  "actual IG recovery must expand/read an existing own child without entering send preparation");
assert.equal(recovered.receipts[0].exact_reply_visible, true);
assert.equal(recovered.receipts[0].absence_verified, false);
assert.equal(recovered.receipts[0].own_author_reply_count, 1);
assert.equal(recovered.receipts[0].reinspection_total_reply_count, 2);
assert.equal(recovered.counters.expand, 1);
assert.equal(recovered.selectionClicks, 0, "recovery cannot click the parent Reply trigger");
assert.equal(recovered.counters.fill, 0);
assert.equal(recovered.claims, 0);
assert.equal(recovered.counters.submit, 0);

const wrongRecovered = await integratedCase({ recoveryOnly: true, declaredCount: 2, rows: [
  { id: "501", author: "another_reader", body: "Earlier reply" },
  { id: "502", author: "example", body: "Different reply text" },
] });
const unresolved = await wrongRecovered.reconcile();
assert.equal(unresolved.inspection_status, "unresolved");
assert.equal(unresolved.committed, false);
assert.equal(wrongRecovered.receipts.length, 0);
assert.equal(wrongRecovered.selectionClicks, 0);
assert.equal(wrongRecovered.counters.fill, 0);
assert.equal(wrongRecovered.claims, 0);
assert.equal(wrongRecovered.counters.submit, 0);

console.log("PASS IG CUA native selection and integrated single dispatch (anonymous DOM; simulated I/O only)");

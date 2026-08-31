/** Native Instagram reply-exhaustion, readiness, and continuity cases. */
import assert from "node:assert/strict";
import { inspectLiveReplySurface, prepareLiveReplyThread } from "./comment_chrome_live_surface.mjs";
import {
  assertCandidateOnly, inspectNative, nativeFixtures, nativeInstagramFixture,
} from "./comment_chrome_live_surface_fixture_testonly.mjs";

export async function nativeInstagramCandidateTests() {
  for (const count of [1, 2]) {
    const fixture = nativeInstagramFixture({ declaredCount: count, rows: Array.from({ length: count }, (_, index) => ({
      id: String(501 + index), author: index ? "other_reader" : "example", body: index ? "Other reply" : "Thanks!",
    })) });
    const result = await prepareLiveReplyThread(fixture.tab, fixture.action);
    assertCandidateOnly(result, true);
    assert.equal(result.totalReplies, count);
    assert.equal(result.ownReplyCount, 1);
    assert.equal(result.exactOwnCount, 1);
    assert.equal(result.replyExhaustionCandidate.declared_count, count);
    assert.equal(result.replyExhaustionCandidate.stable_reads, 2);
    assert.equal(fixture.nativeReads, 3);
    assert.equal(fixture.crossRealmNativeReads, 3);
    assert.equal(fixture.counters.expand, 1);
    assert.equal(fixture.counters.readinessWait, 1);
    assertCandidateOnly(await prepareLiveReplyThread(fixture.tab, fixture.action), true);
    assert.equal(fixture.counters.expand, 1, "a completed candidate must not click again");
    assert.equal(fixture.counters.readinessWait, 1, "readiness is awaited only after the first expansion");
    const before = await inspectLiveReplySurface(fixture.tab, fixture.action, "before");
    assertCandidateOnly(before, true);
    assert.ok(before.composer && before.submit);
  }

  // Observed native disclosure layouts: target LI followed by a heading-free
  // sibling LI, optionally nesting another UL > LI around its DIV > button.
  for (const disclosureDepth of [0, 1, 2]) {
    const fixture = nativeInstagramFixture({ disclosureDepth });
    const thread = fixture.document.querySelector("ul");
    const wrapper = thread.children[1];
    assert.equal(wrapper.tagName, "LI");
    assert.equal(wrapper.parentElement, thread);
    assert.equal(wrapper.querySelectorAll("h3").length, 0);
    assert.equal(wrapper.querySelector('[data-test-operation="expand"]').parentElement.tagName, "DIV");
    const result = await prepareLiveReplyThread(fixture.tab, fixture.action);
    assertCandidateOnly(result, true);
    assert.equal(result.totalReplies, 1);
    assert.equal(result.replyExhaustionCandidate.declared_count, 1);
    assert.equal(result.replyExhaustionCandidate.stable_reads, 2);
    assert.equal(fixture.nativeReads, 3, "count seed plus two stable native reads");
    assert.equal(fixture.counters.expand, 1);
    const expandedWrapper = fixture.document.querySelector('[data-fixture-disclosure="true"]');
    const headings = expandedWrapper.querySelectorAll("h3");
    assert.equal(headings.length, 1, "the wrapper contains a native child heading after expansion");
    assert.notEqual(headings[0].closest("li"), expandedWrapper, "the wrapper does not own the child heading");
    assert.equal(expandedWrapper.querySelectorAll('a[href="/p/abc/c/123/r/501/"]').length, 1);
    assertCandidateOnly(await inspectNative(fixture), true);
    assert.equal(fixture.counters.expand, 1);
  }

  for (const options of [
    { disclosureDepth: 1, disclosureChildOwned: true },
    { disclosureDepth: 3 }, { disclosureDepth: 0, disclosureOutside: true },
  ]) {
    const fixture = nativeInstagramFixture(options);
    const result = await inspectNative(fixture);
    assertCandidateOnly(result, false);
    assert.equal(result.replyExhaustionCandidate.declared_count, null);
    await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /positive observed pre-expansion reply count/u);
    assert.equal(fixture.counters.expand, 0, "an unbound wrapper cannot seed a count or receive a click");
  }

  for (const disclosureDepth of [0, 1]) {
    const fixture = nativeInstagramFixture({ disclosureDepth, disclosureOwnHeading: true });
    await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /Instagram native parent/u);
    assert.equal(fixture.counters.expand, 0, "a malformed wrapper-owned heading must fail closed");
  }

  for (const options of [
    { expanded: true }, { declaredCount: 0 }, { expandControls: 0 }, { expandControls: 2 },
    { declaredCount: 101 }, { expandLabel: "查看回覆（1.5）" },
    { expandLabel: "查看回覆（1+）" }, { expandLabel: "查看回覆" },
    { loading: true }, { busy: true },
  ]) {
    const fixture = nativeInstagramFixture(options);
    assertCandidateOnly(await inspectNative(fixture), false);
    await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /Instagram/u);
    assert.equal(fixture.counters.expand, 0);
  }

  for (const rows of [
    [{ id: "501", author: "example", body: "Thanks!" }, { id: "501", author: "example", body: "Thanks!" }],
    [{ path: "/p/abc/c/999/r/501/", author: "example", body: "Thanks!" }],
    [{ path: "/p/other/c/123/r/501/", author: "example", body: "Thanks!" }],
    [{ path: "/p/abc/c/123/r/501/?fake=1", author: "example", body: "Thanks!" }],
  ]) {
    const fixture = nativeInstagramFixture({ rows });
    await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /Instagram native parent|readiness timeout/u);
    assert.equal(fixture.counters.expand, 1);
    await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /Instagram/u);
    assert.equal(fixture.counters.expand, 1);
  }

  for (const options of [
    { rows: [] }, { declaredCount: 2 }, { hideControls: 0 }, { hideControls: 2 },
    { hiddenHide: true }, { keepExpand: true },
    { beforeNativeRead: (read, fixture) => { if (read === 2) { fixture.loading = true; fixture.render(); } } },
    { beforeNativeRead: (read, fixture) => { if (read === 2) { fixture.statusLoading = true; fixture.render(); } } },
  ]) {
    const fixture = nativeInstagramFixture(options);
    await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /not stably exhausted|readiness timeout/u);
    assertCandidateOnly(await inspectNative(fixture), false);
    assert.equal(fixture.counters.expand, 1);
  }

  const timedOut = nativeInstagramFixture({ rows: [] });
  await assert.rejects(prepareLiveReplyThread(timedOut.tab, timedOut.action), /readiness timeout/u);
  assert.equal(timedOut.nativeReads, 1, "a readiness timeout is not terminal evidence");
  await assert.rejects(prepareLiveReplyThread(timedOut.tab, timedOut.action), /not stably exhausted/u);
  assert.equal(timedOut.counters.expand, 1, "readiness timeout must not cause a second click");
  assert.equal(timedOut.counters.readinessWait, 1, "readiness timeout must not cause a second wait");
  timedOut.rows.push({ id: "501", author: "example", body: "Thanks!" });
  timedOut.render();
  assertCandidateOnly(await prepareLiveReplyThread(timedOut.tab, timedOut.action), true);
  assert.equal(timedOut.counters.expand, 1);
  assert.equal(timedOut.counters.readinessWait, 1);

  const lateRows = nativeInstagramFixture({ rows: [], beforeReadinessWait: (fixture) => {
    fixture.rows.push({ id: "501", author: "example", body: "Thanks!" });
    fixture.render();
  } });
  assertCandidateOnly(await prepareLiveReplyThread(lateRows.tab, lateRows.action), true);
  assert.equal(lateRows.nativeReads, 3, "readiness never replaces either stable native read");
  assert.equal(lateRows.counters.readinessWait, 1);

  for (const key of ["id", "author", "body"]) {
    const fixture = nativeInstagramFixture({ beforeNativeRead: (read, current) => {
      if (read === 3) {
        current.rows[0][key] = { id: "502", author: "other_reader", body: "Changed reply" }[key];
        current.render();
      }
    } });
    await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /not stably exhausted/u);
    const result = await inspectNative(fixture);
    assertCandidateOnly(result, false);
    assert.equal(result.replyExhaustionCandidate.reason, "reply_evidence_changed");
    assert.equal(fixture.counters.expand, 1);
  }

  for (const reset of ["action", "tab-id"]) {
    const fixture = nativeInstagramFixture();
    assertCandidateOnly(await prepareLiveReplyThread(fixture.tab, fixture.action), true);
    const changed = reset === "action" ? { ...fixture.action, intent_id: "another_intent" } : fixture.action;
    if (reset === "tab-id") {
      fixture.tab.id = "changed-native-tab";
      await assert.rejects(inspectNative(fixture), /Instagram/u);
      await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /Instagram/u);
      assert.equal(fixture.counters.expand, 1);
      continue;
    }
    const result = await inspectNative(fixture, changed);
    assertCandidateOnly(result, false);
    assert.equal(result.replyExhaustionCandidate.declared_count, null);
    await assert.rejects(prepareLiveReplyThread(fixture.tab, changed), /pre-expansion reply count/u);
    assert.equal(fixture.counters.expand, 1);
  }

  for (const failure of ["before", "after"]) {
    const fixture = nativeInstagramFixture({ clickFailure: failure });
    await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /fixture ambiguous expansion/u);
    assert.equal(fixture.counters.expand, 1);
    if (failure === "before") {
      await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /Instagram/u);
    } else assertCandidateOnly(await prepareLiveReplyThread(fixture.tab, fixture.action), true);
    assert.equal(fixture.counters.expand, 1, "ambiguous click must never be repeated");
    fixture.render();
    if (failure === "before") await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /Instagram/u);
    else assertCandidateOnly(await prepareLiveReplyThread(fixture.tab, fixture.action), true);
    assert.equal(fixture.counters.expand, 1, "identical UI replacement must not repeat an ambiguous click");
  }

  const changingTabId = nativeInstagramFixture({ beforeNativeRead: (read, fixture) => {
    if (read === 3) fixture.tab.id = "changed-during-read";
  } });
  await assert.rejects(prepareLiveReplyThread(changingTabId.tab, changingTabId.action), /Instagram/u);
  await assert.rejects(inspectNative(changingTabId), /Instagram/u);
  const changingUrl = nativeInstagramFixture({ afterNativeRead: (read, fixture) => {
    if (read === 3) fixture.url = "https://www.instagram.com/p/abc/c/999";
  } });
  await assert.rejects(prepareLiveReplyThread(changingUrl.tab, changingUrl.action), /Instagram|approved comment URL/u);

  // Replacing all DOM objects with identical visible UI is deliberately NOT a
  // detected reload: this diagnostic proves UI continuity, never document epoch.
  const sameUiReload = nativeInstagramFixture();
  const beforeReload = await prepareLiveReplyThread(sameUiReload.tab, sameUiReload.action);
  const oldDocument = sameUiReload.document;
  sameUiReload.render();
  assert.notEqual(sameUiReload.document, oldDocument);
  assert.equal(sameUiReload.document.defaultView, undefined);
  const afterReload = await prepareLiveReplyThread(sameUiReload.tab, sameUiReload.action);
  assertCandidateOnly(afterReload, true);
  assert.deepEqual(afterReload.replyExhaustionCandidate.document_binding,
    beforeReload.replyExhaustionCandidate.document_binding);
  assert.equal(sameUiReload.counters.expand, 1);

  for (const operation of ["inspect", "prepare"]) {
    const fixture = nativeInstagramFixture();
    let release;
    let entered;
    const held = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const evaluate = fixture.tab.playwright.evaluate;
    let accountReads = 0;
    fixture.tab.playwright.evaluate = async (...args) => {
      accountReads += 1;
      if (accountReads === 1) { entered(); await held; }
      return evaluate(...args);
    };
    if (operation === "inspect") {
      const first = inspectNative(fixture);
      await started;
      assertCandidateOnly(await inspectNative(fixture), false);
      release();
      await assert.rejects(first, /inspections overlapped/u);
      assert.equal(fixture.counters.expand, 0);
    } else {
      const first = prepareLiveReplyThread(fixture.tab, fixture.action);
      await started;
      await assert.rejects(prepareLiveReplyThread(fixture.tab, fixture.action), /already running/u);
      release();
      assertCandidateOnly(await first, true);
      assert.equal(fixture.counters.expand, 1);
    }
  }
  for (const fixture of nativeFixtures) {
    assert.equal(fixture.counters.submit, 0);
    assert.equal(fixture.counters.fill, 0);
    assert.equal(fixture.counters.otherClick, 0);
    assert.ok(fixture.counters.expand <= 1);
    assert.ok(fixture.counters.readinessWait <= 1);
  }
}

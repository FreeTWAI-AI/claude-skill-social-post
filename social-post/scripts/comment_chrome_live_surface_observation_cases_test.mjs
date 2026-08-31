/** Native target intake, positive-only canary, and cross-realm schema cases. */
import assert from "node:assert/strict";
import {
  inspectLiveCanaryResult, prepareLiveReplyThread, readLiveTargetComment,
} from "./comment_chrome_live_surface.mjs";
import {
  appendNativeOwnReply, expectedUiBinding, nativeInstagramFixture, nativeNode,
  nativeTarget, privateCanaryFixture,
} from "./comment_chrome_live_surface_fixture_testonly.mjs";

export async function nativeInstagramTargetTests() {
  const fixture = nativeInstagramFixture();
  fixture.document.querySelector("li h3 a").text = "Actual Reader Display";
  fixture.document.querySelector("li").children[1].text = "Actual whole native comment";
  const observed = await readLiveTargetComment(fixture.tab, {
    ...nativeTarget(fixture), author_key: "caller_forged", body: "caller supplied fragment",
  });
  assert.deepEqual(observed, {
    comment: {
      platform_comment_id: "123", comment_permalink: "https://www.instagram.com/p/abc/c/123",
      observed_parent_post_permalink: "https://www.instagram.com/p/abc",
      author_key: "reader", author_display: "Actual Reader Display", body: "Actual whole native comment",
      body_complete: true, is_own: false, has_own_reply: false, language: null,
    },
    documentBinding: expectedUiBinding(fixture, "reader", "Actual whole native comment"), observedUrl: fixture.url,
  });
  assert.equal(Object.isFrozen(observed.comment), true);
  assert.equal(fixture.crossRealmNativeReads, 1);
  assert.equal(fixture.counters.expand, 0);
  const aliasedParent = nativeInstagramFixture();
  const fromAlias = await readLiveTargetComment(aliasedParent.tab, {
    ...nativeTarget(aliasedParent), post_permalink: "https://www.instagram.com/reels/abc/",
  });
  assert.equal(fromAlias.comment.observed_parent_post_permalink, "https://www.instagram.com/p/abc");
  assert.deepEqual(fromAlias.documentBinding, expectedUiBinding(aliasedParent));
  assert.equal("documentEpoch" in fromAlias, false);
  const ownReply = nativeInstagramFixture({ expanded: true });
  const withOwn = await readLiveTargetComment(ownReply.tab, nativeTarget(ownReply));
  assert.equal(withOwn.comment.has_own_reply, true);
  assert.equal(withOwn.absence_proven, undefined);
  assert.equal(withOwn.complete, undefined);
  assert.equal(ownReply.counters.expand, 0);
  const ownParent = nativeInstagramFixture();
  const ownAuthor = ownParent.document.querySelector("li h3 a");
  ownAuthor.attrs.href = "/example/";
  ownAuthor.text = "example";
  assert.equal((await readLiveTargetComment(ownParent.tab, nativeTarget(ownParent))).comment.is_own, true);

  for (const changes of [
    { platform: "facebook" }, { account_key: "another_account" }, { account_key: "invalid/account" },
    { post_key: "other" }, { platform_comment_id: "999" },
    { post_permalink: "https://www.instagram.com/p/other" },
    { comment_permalink: "https://www.instagram.com/p/abc/c/999" },
    { comment_permalink: "https://instagram.com/p/abc/c/123" },
    { comment_permalink: "https://www.instagram.com/p/abc/c/123?extra=1" },
  ]) {
    const current = nativeInstagramFixture();
    await assert.rejects(readLiveTargetComment(current.tab, { ...nativeTarget(current), ...changes }));
    assert.equal(current.counters.expand, 0);
  }
  for (const change of ["empty-body", "duplicate-author", "changed-tab-id", "changed-url"]) {
    const current = nativeInstagramFixture();
    if (change === "empty-body") current.document.querySelector("li").children[1].text = "";
    if (change === "duplicate-author") current.document.querySelector("li").append(
      nativeNode("h3", {}, "", [nativeNode("a", { href: "/other/" }, "Other")]),
    );
    if (change === "changed-tab-id") current.afterNativeRead = () => { current.tab.id = "changed-native-tab"; };
    if (change === "changed-url") current.afterNativeRead = () => { current.url += "?changed=1"; };
    await assert.rejects(readLiveTargetComment(current.tab, nativeTarget(current)), /Instagram/u);
    assert.equal(current.counters.expand, 0);
  }
}

export async function nativeInstagramCanaryTests() {
  const fixture = await privateCanaryFixture();
  appendNativeOwnReply(fixture);
  const readsBefore = fixture.nativeReads;
  const positive = await inspectLiveCanaryResult(fixture.tab, fixture.action);
  assert.equal(fixture.nativeReads - readsBefore, 2);
  assert.equal(fixture.crossRealmNativeReads, 5, "three private preflight reads and two positive reads stay cross-realm");
  assert.equal(positive.verifiedNewReply, true);
  assert.equal(positive.replyPermalink, "https://www.instagram.com/p/abc/c/123/r/502/");
  assert.equal(positive.positive_only, true);
  assert.equal(positive.absence_proven, false);
  assert.equal(positive.complete, false);
  assert.equal(positive.exhaustiveThread, false);
  assert.equal(positive.totalReplies, 2);
  assert.equal(positive.ownReplyCount, 1);
  assert.equal(positive.exactOwnCount, 1);
  assert.equal(positive.stable_reads, 2);
  assert.deepEqual(positive.documentBinding, expectedUiBinding(fixture));
  assert.equal("documentEpoch" in positive, false);
  for (const key of ["action_digest", "binding_digest", "baseline_rows_digest", "rows_digest"]) {
    assert.match(positive[key], /^[0-9a-f]{64}$/u);
  }
  assert.equal(Object.isFrozen(positive), true);
  assert.equal(fixture.counters.expand, 1);

  for (const seededOwn of [false, true]) {
    const current = nativeInstagramFixture({ expanded: !seededOwn });
    if (seededOwn) await prepareLiveReplyThread(current.tab, current.action);
    else await readLiveTargetComment(current.tab, nativeTarget(current));
    await assert.rejects(inspectLiveCanaryResult(current.tab, current.action, {
      binding: "caller-forged", documentBinding: { kind: "caller-forged" }, rows: [], verifiedNewReply: true,
    }), /private zero-own preflight baseline/u);
  }
  for (const kind of [
    "no-new-reply", "foreign-author", "nonexact-body", "two-own", "changed-original", "missing-original",
    "wrong-parent", "duplicate-id", "loading", "missing-hide", "pending-expand", "changed-action", "changed-tab-id",
    "changed-parent", "changed-account",
  ]) {
    const current = await privateCanaryFixture();
    if (kind !== "no-new-reply") appendNativeOwnReply(current);
    if (kind === "foreign-author") current.rows[1].author = "foreign_reader";
    if (kind === "nonexact-body") current.rows[1].body = "Thanks! plus unapproved words";
    if (kind === "two-own") current.rows.push({ id: "503", author: "example", body: "Thanks!" });
    if (kind === "changed-original") current.rows[0].body = "Original reply was edited";
    if (kind === "missing-original") current.rows.shift();
    if (kind === "wrong-parent") current.rows[1].path = "/p/abc/c/999/r/502/";
    if (kind === "duplicate-id") current.rows[1].id = "501";
    if (kind === "loading") current.loading = true;
    if (kind === "missing-hide") current.hideControls = 0;
    if (kind === "pending-expand") current.keepExpand = true;
    if (kind === "changed-tab-id") current.tab.id = "changed-canary-tab";
    current.render();
    if (kind === "changed-parent") current.document.querySelector("li").children[1].text = "Changed parent body";
    if (kind === "changed-account") current.document.querySelector("nav a").attrs.href = "/another_account/";
    const approved = kind === "changed-action" ? { ...current.action, intent_id: "changed_intent" } : current.action;
    await assert.rejects(inspectLiveCanaryResult(current.tab, approved), /Instagram/u, kind);
    assert.equal(current.counters.expand, 1);
  }
  const drift = await privateCanaryFixture();
  appendNativeOwnReply(drift);
  const firstCanaryRead = drift.nativeReads + 1;
  drift.beforeNativeRead = (read, current) => {
    if (read === firstCanaryRead + 1) { current.rows[1].id = "503"; current.render(); }
  };
  await assert.rejects(inspectLiveCanaryResult(drift.tab, drift.action), /positive canary rows are not stable/u);
}

export async function nativeInstagramCrossRealmSchemaTests() {
  const corruptions = [
    ["extra-field", (row) => { row.unexpected = "not part of the native row schema"; }],
    ["missing-field", (row) => { delete row.authorDisplay; }],
    ["empty-field", (row) => { row.body = ""; }],
    ...["author", "authorDisplay", "body", "path"].map((key) => [
      `nonstring-${key}`, (row) => { row[key] = 42; },
    ]),
  ];
  for (const [label, corrupt] of corruptions) {
    for (const surface of ["prepare", "target", "canary"]) {
      const fixture = surface === "canary" ? await privateCanaryFixture()
        : nativeInstagramFixture({ expanded: surface === "target" });
      if (surface === "canary") appendNativeOwnReply(fixture);
      fixture.corruptNativeResult = (value) => {
        // Prepare must first obtain its real count and make its single expansion.
        if (value.rows.length) corrupt(surface === "target" ? value.parent : value.rows[0]);
      };
      const operation = surface === "prepare" ? prepareLiveReplyThread(fixture.tab, fixture.action)
        : surface === "target" ? readLiveTargetComment(fixture.tab, nativeTarget(fixture))
          : inspectLiveCanaryResult(fixture.tab, fixture.action);
      await assert.rejects(operation, /native reply row has an unexpected string schema/u, `${surface}: ${label}`);
      assert.equal(fixture.counters.expand, surface === "target" ? 0 : 1);
    }
  }
  for (const corruptNativeResult of [
    (value) => { value.rows = {}; },
    (value) => { value.rows[0] = null; },
    (value) => { value.rows[0] = []; },
    (value) => { value.parent = null; },
  ]) {
    const fixture = nativeInstagramFixture({ expanded: true, corruptNativeResult });
    await assert.rejects(readLiveTargetComment(fixture.tab, nativeTarget(fixture)), /native reply (?:row has|rows are)/u);
    assert.equal(fixture.counters.expand, 0);
  }
}

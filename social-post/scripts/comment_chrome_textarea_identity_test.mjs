/** Anonymous, read-only textarea stable-node identity regression cases. */
import assert from "node:assert/strict";
import { bindObservedSubmitNode } from "./comment_chrome_send_support.mjs";
import { fixture } from "./comment_chrome_actuator_fixture_test.mjs";

export async function testStableTextareaCurrentValueIdentity() {
  const bindings = [];
  const textareaLine = (body, nodeId = "112") =>
    `<textarea node_id=${nodeId} aria-label="留言⋯⋯" placeholder="留言⋯⋯">${body}</textarea>`;
  function setup({
    value = "", defaultText = "", innerText = "", tag = "textarea",
    attributes = { "aria-label": "留言⋯⋯", placeholder: "留言⋯⋯" }, snapshots,
  }) {
    const { page, tab } = fixture({ crossRealmEvaluate: true });
    Object.assign(page.nodes.composer, {
      visible: true, enabled: true, tagName: tag, value, text: defaultText,
      contentEditable: tag === "div", attributes,
    });
    const locator = tab.playwright.locator("#target").locator(".composer");
    const realEvaluate = locator.evaluate.bind(locator);
    locator.evaluate = async (callback, argument) => {
      const result = await realEvaluate((element, input) => {
        // The observed textarea has independent current value, empty innerText,
        // and stale/default textContent. Execute the actual identity callback.
        const observedElement = Object.create(element);
        Object.defineProperties(observedElement, {
          innerText: { value: innerText }, textContent: { value: defaultText },
        });
        return callback(observedElement, input);
      }, argument);
      assert.notEqual(Object.getPrototypeOf(result), Object.prototype, "identity remains cross-realm");
      return result;
    };
    tab.dom_cua.get_visible_dom = async () => {
      const index = page.domCuaSnapshotCalls++;
      return snapshots[Math.min(index, snapshots.length - 1)];
    };
    const binding = { page, tab, bind: () => bindObservedSubmitNode(tab, locator) };
    bindings.push(binding);
    return binding;
  }

  for (const scenario of [
    { value: "", defaultText: "Old default", innerText: "Old default", body: "" },
    { value: "@reader ", defaultText: "@reader ", body: "@reader" },
    { value: "Current reply", defaultText: "Stale default", innerText: "Stale default", body: "Current reply" },
    { value: "A & <B> \"C\" 'D'", body: "A &amp; &lt;B&gt; &quot;C&quot; &#39;D&#39;" },
    { value: "literal &lt; &amp;", body: "literal &amp;lt; &amp;amp;" },
    { value: "  Cafe\u0301\r\n第二行\t🐈  ", body: "Café 第二行 🐈" },
  ]) {
    const current = setup({ ...scenario, snapshots: [textareaLine(scenario.body)] });
    assert.equal(await current.bind(), "112");
    assert.equal(current.page.domCuaSnapshotCalls, 2);
    assert.equal(Object.hasOwn(current.page.nodes.composer.attributes, "value"), false);
  }

  for (const invalidValue of [undefined, null, 0, false, {}, []]) {
    const current = setup({ value: "", defaultText: "Cannot be a fallback", snapshots: [textareaLine("")] });
    if (invalidValue === undefined) delete current.page.nodes.composer.value;
    else current.page.nodes.composer.value = invalidValue;
    await assert.rejects(current.bind(), /textarea current value is unavailable for stable-node binding/u);
  }

  for (const snapshots of [
    [""],
    [textareaLine("Different current value")],
    [`${textareaLine("Current reply")}\n${textareaLine("Current reply", "113")}`],
    [textareaLine("Current reply"), textareaLine("Current reply", "113")],
  ]) {
    const current = setup({ value: "Current reply", snapshots });
    await assert.rejects(current.bind(), /exactly one visible DOM node, found [02]|live submit node changed/u);
  }
  const onlyExactMatch = setup({ value: "Current reply", snapshots: [
    `${textareaLine("Unrelated value", "113")}\n${textareaLine("Current reply")}`,
  ] });
  assert.equal(await onlyExactMatch.bind(), "112");

  // DOM-CUA's parser remains line-oriented; do not silently add multiline HTML support.
  const rawMultiline = setup({ value: "First\nSecond", snapshots: [textareaLine("First\nSecond")] });
  await assert.rejects(rawMultiline.bind(), /exactly one visible DOM node, found 0/u);

  for (const scenario of [
    {
      tag: "button", value: "Not the button label", innerText: "Publish reply", defaultText: "Stale text",
      attributes: { "aria-label": "Publish reply", type: "button" },
      snapshot: '<button node_id=112 aria-label="Publish reply" type="button">Publish reply</button>',
    },
    {
      tag: "div", value: "Not contenteditable text", innerText: "Editable reply", defaultText: "Stale text",
      attributes: { "aria-label": "Reply text", contenteditable: "true", role: "textbox" },
      snapshot: '<div node_id=112 aria-label="Reply text" contenteditable="true" role="textbox">Editable reply</div>',
    },
    {
      tag: "button", value: "Not fallback text", innerText: null, defaultText: "Fallback label",
      attributes: { type: "button" }, snapshot: '<button node_id=112 type="button">Fallback label</button>',
    },
  ]) {
    assert.equal(await setup({ ...scenario, snapshots: [scenario.snapshot] }).bind(), "112");
  }
  for (const { page } of bindings) {
    assert.equal(page.domCuaClickCalls, 0, "stable binding is read-only");
    for (const row of Object.values(page.nodes)) assert.equal(row.clicks ?? 0, 0);
  }
}

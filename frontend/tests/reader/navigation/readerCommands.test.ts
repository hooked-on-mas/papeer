import assert from "node:assert/strict";
import { test } from "node:test";
import { readerShortcutCommand } from "../../../src/features/reader/navigation/readerCommands.ts";
import type { KeyTarget } from "../../../src/features/reader/navigation/pageTurn.ts";

const command = (key: string, extra: Partial<Parameters<typeof readerShortcutCommand>[0]> = {}, target: KeyTarget = "other") =>
  readerShortcutCommand({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra }, target);

test("reader arrow commands leave history, selection and editable widget keys to their owners", () => {
  assert.deepEqual(command("ArrowLeft"), { type: "step", amount: -1 });
  assert.deepEqual(command("ArrowRight"), { type: "step", amount: 1 });
  for (const extra of [{ altKey: true }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }])
    assert.equal(command("ArrowLeft", extra), null);
  assert.equal(command("ArrowRight", {}, "editable"), null);
  assert.equal(command(" ", {}, "button"), null);
});

test("reader zoom accepts Windows, Mac, Japanese physical keys and the keypad", () => {
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    for (const input of [{ key: "+" }, { key: "=" }, { key: ";" }, { key: ":", code: "Semicolon", shiftKey: true }, { key: "+", code: "NumpadAdd" }])
      assert.deepEqual(command(input.key, { ...modifier, ...input }), { type: "zoom-step", steps: 1 });
    assert.deepEqual(command("-", modifier), { type: "zoom-step", steps: -1 });
    assert.deepEqual(command("0", modifier), { type: "zoom-reset" });
    assert.deepEqual(command("g", modifier), { type: "focus-page-input" });
    assert.equal(command("+", modifier, "editable"), null);
    assert.equal(command("g", modifier, "editable"), null);
    assert.equal(command("+", { ...modifier, altKey: true }), null);
    assert.equal(command("0", { ...modifier, shiftKey: true }), null);
  }
  assert.equal(command("+"), null);
});

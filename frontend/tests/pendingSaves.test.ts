import assert from "node:assert/strict";
import { test } from "node:test";
import { beginOpenEdit, flushPendingSaves, openEditLabels, registerPendingSaves } from "../src/lib/pendingSaves.ts";

test("open edits are listed while they last, each label once", () => {
  assert.deepEqual(openEditLabels(), []);
  const endSticky = beginOpenEdit("付箋");
  const endOther = beginOpenEdit("付箋");
  const endGlossary = beginOpenEdit("翻訳の設定・辞書");
  assert.deepEqual(openEditLabels(), ["付箋", "翻訳の設定・辞書"]);
  endSticky();
  assert.deepEqual(openEditLabels(), ["付箋", "翻訳の設定・辞書"]);
  endOther();
  endGlossary();
  endGlossary(); // Ending twice is harmless.
  assert.deepEqual(openEditLabels(), []);
});

test("flushing reports the first failed save", async () => {
  const saved: string[] = [];
  const unregisterNotes = registerPendingSaves(async () => { saved.push("notes"); }, "メモを保存できませんでした。");
  const unregisterInk = registerPendingSaves(async () => { throw new Error("offline"); }, "書き込みを保存できませんでした。");
  const failure = await flushPendingSaves();
  assert.deepEqual(saved, ["notes"]);
  assert.equal(failure?.message, "書き込みを保存できませんでした。");
  unregisterInk();
  assert.equal(await flushPendingSaves(), null);
  unregisterNotes();
});

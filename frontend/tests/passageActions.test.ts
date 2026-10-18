import assert from "node:assert/strict";
import { test } from "node:test";
import { kindCapabilities } from "../src/lib/itemKinds.ts";
import { passageActions } from "../src/features/reader/passageActions.ts";

const offered = (kind: string) => [...passageActions(kindCapabilities(kind))].sort();

test("a PDF is offered every action on a selected passage", () => {
  assert.deepEqual(offered("pdf"), ["attach", "explain", "fix-paragraph", "fix-terms", "highlight", "quote", "sticky"]);
});

test("an item is offered only what its capabilities allow: a notebook can quote into its memo, and nothing else", () => {
  assert.deepEqual(offered("notebook"), ["quote"]);
  assert.deepEqual(offered("whiteboard"), []);
});

test("each action follows the capability of the tab or pane it goes to", () => {
  const base = kindCapabilities("whiteboard");
  assert.deepEqual([...passageActions({ ...base, translate: true })].sort(), ["fix-paragraph", "fix-terms"]);
  assert.deepEqual([...passageActions({ ...base, chat: true })].sort(), ["attach", "explain"]);
  assert.deepEqual([...passageActions({ ...base, memo: true })], ["quote"]);
  assert.deepEqual([...passageActions({ ...base, stickyNotes: true })].sort(), ["highlight", "sticky"]);
});

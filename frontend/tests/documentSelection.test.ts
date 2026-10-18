import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseDocument } from "../src/features/documents/documentSelection.ts";

const a = { id: "a", title: "資料A" };
const b = { id: "b", title: "資料B" };

test("a pane opened without a chosen document shows the first one", () => {
  assert.deepEqual(chooseDocument([b, a], undefined), { kind: "document", document: b });
  assert.deepEqual(chooseDocument([b, a], ""), { kind: "document", document: b });
  assert.deepEqual(chooseDocument([], undefined), { kind: "empty" });
});

test("a chosen document that exists is shown, wherever it is in the list", () => {
  assert.deepEqual(chooseDocument([b, a], "a"), { kind: "document", document: a });
  assert.deepEqual(chooseDocument([b, a], "b"), { kind: "document", document: b });
});

test("a chosen document that is gone is missing, and another document is never shown in its place", () => {
  assert.deepEqual(chooseDocument([b], "a"), { kind: "missing", id: "a" });
  assert.deepEqual(chooseDocument([], "a"), { kind: "missing", id: "a" });
});

test("choosing an existing document afterwards shows it", () => {
  const documents = [b];
  assert.equal(chooseDocument(documents, "a").kind, "missing");
  assert.deepEqual(chooseDocument(documents, "b"), { kind: "document", document: b });
});

test("a list that is not loaded yet is neither missing nor empty", () => {
  assert.deepEqual(chooseDocument(undefined, "a"), { kind: "loading" });
  assert.deepEqual(chooseDocument(undefined, undefined), { kind: "loading" });
});

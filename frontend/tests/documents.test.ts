import assert from "node:assert/strict";
import { test } from "node:test";
import { reorderedAttachments } from "../src/features/documents/attachmentOrder.ts";
import { scriptPermission, setScriptPermission } from "../src/features/documents/documentPermissions.ts";
import { memoChildren } from "../src/features/library/memoChildren.ts";

test("memo and HTML ordering preserve the other format's slots", () => {
  const rows = [{ id: "m1", format: "md" }, { id: "h1", format: "html" }, { id: "m2", format: "md" }, { id: "h2", format: "html" }];
  assert.deepEqual(reorderedAttachments(rows, "m1", 1), ["m2", "h1", "m1", "h2"]);
  assert.deepEqual(reorderedAttachments(rows, "h2", -1), ["m1", "h2", "m2", "h1"]);
  assert.deepEqual(reorderedAttachments(rows, "h2", 1), rows.map(row => row.id));
});

test("HTML and memo children share one ordered five-row limit without losing format", () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({ id: `a${index}`, title: `資料${index}`, format: index % 2 ? "md" as const : "html" as const }));
  const children = memoChildren(rows);
  assert.equal(children.length, 6);
  assert.deepEqual(children[0], { kind: "attachment", ...rows[0] });
  assert.deepEqual(children[5], { kind: "more", id: "more", title: "ほか 2件" });
});

test("script permission belongs to one exact document revision and fails closed when storage is unavailable", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  try {
    assert.equal(scriptPermission("h1", "old"), false);
    setScriptPermission("h1", "old", true);
    assert.equal(scriptPermission("h1", "old"), true);
    assert.equal(scriptPermission("h1", "changed"), false);
    assert.equal(scriptPermission("h2", "old"), false);
    setScriptPermission("h1", "old", false);
    assert.equal(scriptPermission("h1", "old"), false);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("disabled"); } });
    assert.equal(scriptPermission("h1", "old"), false);
    assert.throws(() => setScriptPermission("h1", "old", true), /disabled/);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { migrateStorage } from "../src/lib/migrateStorage.ts";

function storage(values) {
  return Object.defineProperties({ ...values }, {
    getItem: { value(key) { return this[key] ?? null; } },
    setItem: { value(key, value) { this[key] = value; } },
    removeItem: { value(key) { delete this[key]; } },
  });
}

test("migrates preferences and unsaved ink without replacing newer values", () => {
  const data = storage({
    "paper-desk-storage": "layout",
    "paperdesk-ui-theme": "dark",
    "papeer-ui-theme": "light",
    "paperdesk-ink:abc:original:1": "draft",
    unrelated: "keep",
  });
  migrateStorage(data);
  assert.deepEqual({ ...data }, {
    "papeer-storage": "layout",
    "papeer-ui-theme": "light",
    "papeer-ink:abc:original:1": "draft",
    unrelated: "keep",
  });
  migrateStorage(data);
  assert.equal(data.getItem("papeer-ink:abc:original:1"), "draft");
});

test("a failed write preserves the legacy value", () => {
  const data = storage({ "paperdesk-ui-theme": "dark" });
  const failing = {
    "paperdesk-ui-theme": "dark",
    getItem: data.getItem.bind(data),
    setItem() { throw new Error("quota"); },
    removeItem: data.removeItem.bind(data),
  };
  assert.throws(() => migrateStorage(failing), /quota/);
  assert.equal(data.getItem("paperdesk-ui-theme"), "dark");
});

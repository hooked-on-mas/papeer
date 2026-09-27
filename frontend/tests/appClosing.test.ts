import assert from "node:assert/strict";
import { test } from "node:test";
import { isAppClosing, reloadUnlessClosing, setAppClosing } from "../src/app/appClosing.ts";

test("reloads at once while the app is not closing", () => {
  let reloads = 0;
  reloadUnlessClosing(() => { reloads += 1; });
  assert.equal(reloads, 1);
});

test("holds the reload back while closing, and runs it only when the closing is called off", () => {
  let reloads = 0;
  setAppClosing(true);
  assert.equal(isAppClosing(), true);
  reloadUnlessClosing(() => { reloads += 1; });
  assert.equal(reloads, 0);
  setAppClosing(false);
  assert.equal(reloads, 1);
  // Held once, run once.
  setAppClosing(false);
  assert.equal(reloads, 1);
});

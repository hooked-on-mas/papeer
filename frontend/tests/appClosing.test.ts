import assert from "node:assert/strict";
import { test } from "node:test";
import { isAppClosing, onAppClosingChange, reloadUnlessClosing, setAppClosing } from "../src/app/appClosing.ts";

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

test("listeners hear the closing start and be called off, once per change", () => {
  const heard: boolean[] = [];
  const unsubscribe = onAppClosingChange((closing) => heard.push(closing));
  setAppClosing(true);
  setAppClosing(true);
  setAppClosing(false);
  unsubscribe();
  setAppClosing(true);
  setAppClosing(false);
  assert.deepEqual(heard, [true, false]);
});

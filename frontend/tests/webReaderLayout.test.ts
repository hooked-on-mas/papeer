import assert from "node:assert/strict";
import { test } from "node:test";
import { automaticReaderSplit } from "../src/web/readerLayout.ts";

test("automatic paired reading requires width and a wide aspect ratio", () => {
  assert.equal(automaticReaderSplit(1024, 1250, false), false);
  assert.equal(automaticReaderSplit(900, 500, false), false);
  assert.equal(automaticReaderSplit(1024, 650, false), true);
});

test("a small resize at either boundary does not alternate layouts", () => {
  assert.equal(automaticReaderSplit(950, 700, false), false);
  assert.equal(automaticReaderSplit(950, 700, true), true);
  assert.equal(automaticReaderSplit(1000, 900, false), false);
  assert.equal(automaticReaderSplit(1000, 900, true), true);
  assert.equal(automaticReaderSplit(900, 700, true), false);
  assert.equal(automaticReaderSplit(1000, 1000, true), false);
});

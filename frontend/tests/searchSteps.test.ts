import assert from "node:assert/strict";
import { test } from "node:test";
import { stepSearchResult } from "../src/features/reader/searchSteps.ts";

test("search steps wrap around and start from either end", () => {
  assert.equal(stepSearchResult(-1, 5, 1), 0);
  assert.equal(stepSearchResult(-1, 5, -1), 4);
  assert.equal(stepSearchResult(0, 5, 1), 1);
  assert.equal(stepSearchResult(4, 5, 1), 0);
  assert.equal(stepSearchResult(0, 5, -1), 4);
  // Results changed under the index.
  assert.equal(stepSearchResult(7, 3, 1), 0);
  assert.equal(stepSearchResult(2, 0, 1), -1);
});

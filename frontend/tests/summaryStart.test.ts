import assert from "node:assert/strict";
import { test } from "node:test";
import { summaryQuestionKey, summaryStartQuestion } from "../src/features/summary/summaryStart.ts";

test("the first サマリー is made without a question; one that exists is replaced only after a confirmation", () => {
  assert.equal(summaryStartQuestion(false), null);
  const question = summaryStartQuestion(true);
  assert.ok(question);
  assert.equal(question.okLabel, "再作成する");
  // It says what the confirmation is for: the AI's time and quota, and that the old one is replaced.
  assert.match(question.message, /利用枠/);
  assert.match(question.message, /置き換わります/);
});

test("when it cannot be told whether a サマリー exists, it asks all the same", () => {
  assert.deepEqual(summaryStartQuestion(null), summaryStartQuestion(true));
});

test("the question is asked once at a time per paper", () => {
  assert.equal(summaryQuestionKey("p1"), summaryQuestionKey("p1"));
  assert.notEqual(summaryQuestionKey("p1"), summaryQuestionKey("p2"));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { initialSummaryChoice, summaryQuestionKey, summarySelection, summaryStartQuestion, type SummaryPlan } from "../src/features/summary/summaryStart.ts";

const plan: SummaryPlan = { page_count: 186, requires_selection: true, chapters: [
  { title: "Methods", depth: 0, start_page: 5, end_page: 12 },
  { title: "Experiment", depth: 1, start_page: 8, end_page: 12 },
  { title: "Results", depth: 0, start_page: 13, end_page: 20 },
] };

test("long summary starts with no pages authorized, including when no outline exists", () => {
  const choice = initialSummaryChoice(plan);
  assert.equal(choice.scope, "chapters");
  assert.ok(summarySelection(plan, choice).error);
  const withoutOutline = { ...plan, chapters: [] };
  const custom = initialSummaryChoice(withoutOutline);
  assert.equal(custom.scope, "custom");
  assert.ok(summarySelection(withoutOutline, custom).error);
});

test("short summaries offer the same scope choices, defaulting to all pages", () => {
  const shortPlan = { ...plan, page_count: 29, requires_selection: false };
  const choice = initialSummaryChoice(shortPlan);
  assert.equal(choice.scope, "all");
  assert.deepEqual(summarySelection(shortPlan, choice), { pages: "", count: 29, error: "" });
  assert.equal(summarySelection(shortPlan, { ...choice, scope: "chapters", chapters: [0] }).count, 8);
  assert.equal(summarySelection(shortPlan, { ...choice, scope: "custom", customRange: "2-4" }).count, 3);
});

test("chapter selection deduplicates overlapping parent and child pages", () => {
  const choice = { ...initialSummaryChoice(plan), chapters: [0, 1] };
  const result = summarySelection(plan, choice);
  assert.equal(result.error, "");
  assert.equal(result.count, 8);
  assert.equal(result.pages, "5,6,7,8,9,10,11,12");
});

test("custom pages are validated and only explicit all selects the entire document", () => {
  const custom = { ...initialSummaryChoice(plan), scope: "custom" as const, customRange: "３～５、8" };
  assert.deepEqual(summarySelection(plan, custom), { pages: "3,4,5,8", count: 4, error: "" });
  assert.ok(summarySelection(plan, { ...custom, customRange: "187" }).error);
  assert.deepEqual(summarySelection(plan, { ...custom, scope: "all" }), { pages: "", count: 186, error: "" });
});

test("the first サマリー needs no replacement confirmation; one that exists is replaced only after a confirmation", () => {
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

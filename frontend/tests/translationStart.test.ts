import assert from "node:assert/strict";
import { test } from "node:test";
import {
  glossaryKey, glossaryReviewSkip, isResuming, mergeDraftTerms, normalizeTerms, readReviewedGlossary,
  recordReviewedGlossary, retranslationWarning, reviewSkipMessage, startButtonLabel, translationTargetText, type TranslationPlan,
} from "../src/features/reader/translationStart.ts";

const plan = (overrides: Partial<TranslationPlan> = {}): TranslationPlan => ({
  model: "model-b", selected_pages: [1, 2, 3], reusable_pages: [], pending_pages: [1, 2, 3],
  retranslated_pages: [], previous_models: [], needs_ai: true, ...overrides,
});

test("the glossary key ignores order, blank rows and surrounding spaces", () => {
  const terms = [{ source: "RL", target: "強化学習" }, { source: "MPC", target: "モデル予測制御" }];
  const key = glossaryKey(terms);
  assert.equal(glossaryKey([{ source: " MPC ", target: "モデル予測制御" }, { source: "", target: " " }, terms[0]]), key);
  assert.notEqual(glossaryKey([terms[0]]), key);
  assert.notEqual(glossaryKey([terms[0], { source: "MPC", target: "モデル予測" }]), key);
  assert.notEqual(glossaryKey([]), key);
  assert.deepEqual(normalizeTerms([{ source: " a ", target: "" }, { source: " ", target: "" }]), [{ source: "a", target: "" }]);
});

test("a run resumes when the unfinished run's target covers the pages asked for", () => {
  const preview = { complete: false, target_pages: [2, 3, 4] };
  assert.equal(isResuming(preview, [2, 3]), true);
  assert.equal(isResuming(preview, [1, 2]), false);
  assert.equal(isResuming({ ...preview, complete: true }, [2]), false);
  assert.equal(isResuming(null, [2]), false);
  assert.equal(isResuming(preview, null), false);
});

test("the check for unregistered terms is suggested only when it may tell something new", () => {
  const base = { plan: plan(), glossaryDirty: false, resuming: false, reviewedKey: null, currentKey: "k1" };
  assert.equal(glossaryReviewSkip(base), null);
  // Only redrawing: no AI request at all, not even for the check.
  assert.equal(glossaryReviewSkip({ ...base, plan: plan({ needs_ai: false, pending_pages: [] }) }), "reusable");
  // Unsaved glossary edits are saved on start and change the pages' source.
  assert.equal(glossaryReviewSkip({ ...base, plan: plan({ needs_ai: false }), glossaryDirty: true }), null);
  assert.equal(glossaryReviewSkip({ ...base, resuming: true }), "resume");
  assert.equal(glossaryReviewSkip({ ...base, reviewedKey: "k1" }), "unchanged");
  assert.equal(glossaryReviewSkip({ ...base, reviewedKey: "k0" }), null);
  // While the plan loads nothing is assumed about saved translations.
  assert.equal(glossaryReviewSkip({ ...base, plan: undefined }), null);
});

test("the main button starts without the check unless it has been done", () => {
  assert.equal(startButtonLabel({ reviewed: false, skip: null }), "用語を確認せずに翻訳");
  assert.equal(startButtonLabel({ reviewed: true, skip: null }), "確認して開始");
  assert.equal(startButtonLabel({ reviewed: true, skip: "unchanged" }), "確認して開始");
  assert.equal(startButtonLabel({ reviewed: false, skip: "reusable" }), "保存済みの訳文でPDFを作り直す");
  assert.equal(startButtonLabel({ reviewed: false, skip: "resume" }), "翻訳を開始");
  for (const skip of ["reusable", "resume", "unchanged", null] as const) assert.ok(reviewSkipMessage(skip));
});

test("retranslating translated pages is announced, naming a model change", () => {
  assert.equal(retranslationWarning(undefined), null);
  assert.equal(retranslationWarning(plan()), null);
  assert.equal(retranslationWarning(plan({ needs_ai: false, retranslated_pages: [1] })), null);
  assert.equal(retranslationWarning(plan({ retranslated_pages: [1, 2], previous_models: ["model-a", "model-b"] })),
    "翻訳済みの2ページを新しいモデル（model-b）で訳し直します（利用枠を使います）。前回のモデル: model-a");
  assert.match(retranslationWarning(plan({ model: "", retranslated_pages: [1], previous_models: ["model-a"] })) ?? "", /既定モデル/);
  assert.match(retranslationWarning(plan({ retranslated_pages: [3], previous_models: ["model-b"] })) ?? "", /^翻訳済みの1ページも訳し直します/);
});

test("candidates already in the glossary are not added twice", () => {
  const glossary = [{ source: "Policy", target: "方策" }];
  const { glossary: merged, added } = mergeDraftTerms(glossary, [
    { source: "policy", target: "ポリシー" }, { source: "reward", target: "報酬" }, { source: "Reward ", target: "報酬" }, { source: " ", target: "x" },
  ]);
  assert.deepEqual(added, [{ source: "reward", target: "報酬" }]);
  assert.deepEqual(merged, [...glossary, { source: "reward", target: "報酬" }]);
});

test("the recorded check survives only as a convenience", () => {
  const values = new Map<string, string>();
  const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  assert.equal(readReviewedGlossary(storage, "p1"), null);
  recordReviewedGlossary(storage, "p1", "k1");
  assert.equal(readReviewedGlossary(storage, "p1"), "k1");
  assert.equal(readReviewedGlossary(storage, "p2"), null);
  const broken = () => ({ getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
  assert.equal(readReviewedGlossary(broken, "p1"), null);
  assert.doesNotThrow(() => recordReviewedGlossary(broken, "p1", "k1"));
  // Reading localStorage itself throws where storage is disabled.
  const denied = (): Storage => { throw new Error("SecurityError"); };
  assert.equal(readReviewedGlossary(denied, "p1"), null);
  assert.doesNotThrow(() => recordReviewedGlossary(denied, "p1", "k1"));
  assert.equal(readReviewedGlossary(() => undefined, "p1"), null);
});

test("the target line counts the pages of the run and the saved ones among them alike", () => {
  assert.equal(translationTargetText(2, undefined), "翻訳対象: 2ページ");
  assert.equal(translationTargetText(3, plan()), "翻訳対象: 3ページ");
  assert.equal(translationTargetText(2, plan({ selected_pages: [2, 3, 4], reusable_pages: [3, 4] })),
    "翻訳対象: 3ページ（文が続く1ページを含む）。うち2ページは保存済みの訳文を使い、AIには送りません");
  assert.equal(translationTargetText(3, plan({ reusable_pages: [1] })), "翻訳対象: 3ページ。うち1ページは保存済みの訳文を使い、AIには送りません");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  effectiveTerms, glossaryKey, glossaryReviewSkip, isResuming, mergeDraftTerms, normalizeTerms, primaryDomain, readReviewedGlossary,
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

test("normalizing keeps a domain, trimmed, and drops it for 共通 and blanks", () => {
  assert.deepEqual(normalizeTerms([
    { source: "a", target: "あ", domain: " 強化学習 " }, { source: "b", target: "い", domain: "共通" },
    { source: "c", target: "う", domain: " 共通 " }, { source: "d", target: "え", domain: "  " }, { source: "e", target: "お" },
  ]), [
    { source: "a", target: "あ", domain: "強化学習" }, { source: "b", target: "い" },
    { source: "c", target: "う" }, { source: "d", target: "え" }, { source: "e", target: "お" },
  ]);
  for (const term of normalizeTerms([{ source: "b", target: "い", domain: "" }])) assert.ok(!("domain" in term));
});

test("the terms a paper uses: 共通 and the domains selected, first source first", () => {
  const terms = [
    { source: "cell", target: "細胞", domain: "生物" }, { source: "cell", target: "セル", domain: "電池" },
    { source: "RL", target: "強化学習" }, { source: "policy", target: "方策", domain: "強化学習" },
    { source: "Cell", target: "セル（共通）" }, { source: "loss", target: "損失", domain: "機械学習" },
  ];
  assert.deepEqual(effectiveTerms(terms, { domains: ["電池"], new_domain: null }), [terms[1], terms[2]]);
  // Order of the glossary, not of the selection; the first of a source in several selected domains wins.
  assert.deepEqual(effectiveTerms(terms, { domains: ["電池", "生物"], new_domain: null }), [terms[0], terms[2]]);
  // A new domain counts as selected.
  assert.deepEqual(effectiveTerms(terms, { domains: [], new_domain: "機械学習" }), [terms[2], terms[4], terms[5]]);
  assert.deepEqual(effectiveTerms(terms, { domains: [], new_domain: null }), [terms[2], terms[4]]);
  // Nothing recorded: every term, as before domains existed.
  assert.deepEqual(effectiveTerms(terms, null), terms);
});

test("the domain a paper's new terms go to", () => {
  assert.equal(primaryDomain(null), "共通");
  assert.equal(primaryDomain({ domains: [], new_domain: null }), "共通");
  assert.equal(primaryDomain({ domains: ["電池", "生物"], new_domain: null }), "電池");
  assert.equal(primaryDomain({ domains: ["電池"], new_domain: "新分野" }), "新分野");
});

test("the key follows the terms in use, and tells domains apart without changing for 共通", () => {
  const common = [{ source: "RL", target: "強化学習" }];
  const terms = [...common, { source: "cell", target: "細胞", domain: "生物" }, { source: "cell", target: "セル", domain: "電池" }];
  const key = (domains: string[]) => glossaryKey(effectiveTerms(terms, { domains, new_domain: null }));
  // A dictionary the paper does not use is no reason to suggest the check again.
  assert.equal(glossaryKey(effectiveTerms([...terms, { source: "x", target: "y", domain: "他" }], { domains: ["生物"], new_domain: null })), key(["生物"]));
  assert.notEqual(key(["生物"]), key(["電池"]));
  assert.notEqual(key(["生物"]), key([]));
  assert.equal(glossaryKey([...terms].reverse()), glossaryKey(terms));
  // The domain is not sent to the AI: moving a term between the domains in use does not change the key.
  assert.equal(glossaryKey([{ source: "cell", target: "細胞", domain: "生物" }]), glossaryKey([{ source: "cell", target: "細胞" }]));
  assert.notEqual(glossaryKey([{ source: "cell", target: "細胞", domain: "生物" }]), glossaryKey([{ source: "cell", target: "セル", domain: "生物" }]));
  // 共通 as before domains existed (a key recorded then still matches).
  assert.equal(glossaryKey(common), glossaryKey([{ source: "RL", target: "強化学習", domain: "共通" }]));
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
  assert.match(reviewSkipMessage("unchanged"), /この論文に使う辞書が変わっていない/);
});

test("retranslating translated pages is announced, naming a model change", () => {
  assert.equal(retranslationWarning(undefined), null);
  assert.equal(retranslationWarning(plan()), null);
  assert.equal(retranslationWarning(plan({ needs_ai: false, retranslated_pages: [1] })), null);
  assert.equal(retranslationWarning(plan({ retranslated_pages: [1, 2], previous_models: ["model-a", "model-b"] })),
    "翻訳済みの2ページを新しいモデル（model-b）で訳し直します（利用枠を使います）。前回のモデル: model-a");
  assert.match(retranslationWarning(plan({ model: "", retranslated_pages: [1], previous_models: ["model-a"] })) ?? "", /既定モデル/);
  assert.match(retranslationWarning(plan({ retranslated_pages: [3], previous_models: ["model-b"] })) ?? "", /^翻訳済みの1ページも訳し直します/);
  // With domain dictionaries, a change of the ones the paper uses is a possible reason; a model change is not blamed on it.
  const same = plan({ retranslated_pages: [3], previous_models: ["model-b"] });
  assert.doesNotMatch(retranslationWarning(same) ?? "", /分野辞書/);
  assert.match(retranslationWarning(same, true) ?? "", /^翻訳済みの1ページも訳し直します（.*分野辞書の選択が変わったことも原因になります。.*利用枠を使います）。$/);
  assert.doesNotMatch(retranslationWarning(plan({ retranslated_pages: [1], previous_models: ["model-a"] }), true) ?? "", /分野辞書/);
});

test("candidates already in the glossary are not added twice", () => {
  const glossary = [{ source: "Policy", target: "方策" }];
  const { glossary: merged, added } = mergeDraftTerms(glossary, [
    { source: "policy", target: "ポリシー" }, { source: "reward", target: "報酬" }, { source: "Reward ", target: "報酬" }, { source: " ", target: "x" },
  ], "共通");
  assert.deepEqual(added, [{ source: "reward", target: "報酬" }]);
  assert.deepEqual(merged, [...glossary, { source: "reward", target: "報酬" }]);
  // 共通 is the default.
  assert.deepEqual(mergeDraftTerms(glossary, [{ source: "reward", target: "報酬" }]).added, added);
});

test("candidates go to the paper's main domain, and are known by domain and source", () => {
  const glossary = [
    { source: "policy", target: "方策", domain: "強化学習" }, { source: "cell", target: "セル" }, { source: "loss", target: "損失", domain: "機械学習" },
  ];
  const { glossary: merged, added } = mergeDraftTerms(glossary, [
    { source: "Policy", target: "ポリシー" }, // Known in this domain.
    { source: "cell", target: "細胞" }, // Only in 共通: a different dictionary.
    { source: "loss", target: "ロス" }, // Only in another domain.
    { source: "reward", target: "報酬", domain: "他" }, // A domain the candidate brings is replaced.
  ], "強化学習");
  assert.deepEqual(added, [
    { source: "cell", target: "細胞", domain: "強化学習" }, { source: "loss", target: "ロス", domain: "強化学習" },
    { source: "reward", target: "報酬", domain: "強化学習" },
  ]);
  assert.deepEqual(merged, [...glossary, ...added]);
  // In 共通 a candidate has no domain key, and a term of a domain does not make its source known there.
  const common = mergeDraftTerms(glossary, [{ source: "policy", target: "ポリシー", domain: "強化学習" }, { source: "cell", target: "細胞" }], "共通");
  assert.deepEqual(common.added, [{ source: "policy", target: "ポリシー" }]);
  assert.ok(!("domain" in common.added[0]));
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

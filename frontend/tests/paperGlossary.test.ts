import assert from "node:assert/strict";
import { test } from "node:test";
import { applyGlossaryReview, moveGlossaryTerms, withPaperTerms } from "../src/features/reader/paperGlossary.ts";
import { effectiveTerms } from "../src/features/reader/translationStart.ts";

test("review opts in to paper-only terms and remembers unchecked candidates", () => {
  const candidates = [{ source: "slope", target: "勾配", reason: "意味が変わる" }, { source: "work", target: "作業" }];
  const base = { terms: [], dismissed: [] };
  assert.deepEqual(applyGlossaryReview(base, candidates, new Set()), { terms: [], dismissed: ["slope", "work"] });
  assert.deepEqual(applyGlossaryReview(base, candidates, new Set(["slope"])), {
    terms: [{ source: "slope", target: "勾配" }], dismissed: ["work"],
  });
  assert.deepEqual(base, { terms: [], dismissed: [] });
});

test("paper overrides win over shared translations without modifying shared data", () => {
  const shared = [{ source: "slope", target: "法面", domain: "土工" }, { source: "control", target: "制御" }];
  assert.deepEqual(withPaperTerms(shared, [{ source: "Slope", target: "勾配" }]), [
    { source: "Slope", target: "勾配" }, shared[1],
  ]);
  assert.equal(shared[0].target, "法面");
});

test("a broad domain's unsuitable translations never enter the effective dictionary", () => {
  const terms = [{ source: "slope", target: "法面", domain: "ロボティクス・建設機械" },
    { source: "trajectory optimization", target: "軌道最適化", domain: "ロボティクス・建設機械" }];
  const selection = { domains: ["ロボティクス・建設機械"], new_domain: "自動車の自動運転", scope_terms: [terms[1]] };
  assert.deepEqual(effectiveTerms(terms, selection), [terms[1]]);
  assert.deepEqual(effectiveTerms([{ ...terms[1], target: "別の訳" }], selection), []);
});

test("bulk classification moves just the selected entries and refuses conflicting merges", () => {
  const terms = [{ source: "slope", target: "法面", domain: "広い分野" },
    { source: "trajectory", target: "軌道", domain: "広い分野" }];
  assert.deepEqual(moveGlossaryTerms(terms, new Set([0]), "法面工学"), [{ ...terms[0], domain: "法面工学" }, terms[1]]);
  assert.equal(terms[0].domain, "広い分野");
  const conflicting = [...terms, { source: "Slope", target: "勾配", domain: "数学" }];
  assert.throws(() => moveGlossaryTerms(conflicting, new Set([0]), "数学"), /別の訳語/);
  assert.equal(conflicting[0].domain, "広い分野");
  assert.deepEqual(moveGlossaryTerms([terms[0], { ...terms[0], domain: "法面工学" }], new Set([0]), "法面工学"),
    [{ ...terms[0], domain: "法面工学" }]);
});

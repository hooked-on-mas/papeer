import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autoGlossaryJobs, checkedDomains, nextAutoStart, countDomainTerms, domainFailureMessage, domainJobMessage, domainNamesIn, inDomainFilter, readSplitChecked,
  recordSplitChecked, selectionOf, splitCheckedCounts, splitDoneMessage, toggledChoice, unchosenNewDomains, unchosenNewDomainsMessage, withDomain,
} from "../src/features/reader/glossaryDomains.ts";

const base = {
  availableDomains: ["強化学習", "電池"], domainCounts: { 共通: 10, 強化学習: 20, 電池: 5 },
  record: null, dirty: false, running: false, splitChecked: {}, splitAt: 150,
};

test("nothing is started while the glossary has unsaved edits or a paper job runs", () => {
  const none = { select: false, split: null };
  assert.deepEqual(autoGlossaryJobs({ ...base, dirty: true }), none);
  assert.deepEqual(autoGlossaryJobs({ ...base, running: true }), none);
  assert.deepEqual(autoGlossaryJobs({ ...base, dirty: true, domainCounts: { 共通: 500 } }), none);
});

test("the choice is made once there is a domain dictionary and no choice, or the AI's choice is stale", () => {
  assert.deepEqual(autoGlossaryJobs(base), { select: true, split: null });
  assert.deepEqual(autoGlossaryJobs({ ...base, record: { chosen_by: null, stale: false } }), { select: true, split: null });
  assert.deepEqual(autoGlossaryJobs({ ...base, record: { chosen_by: "ai", stale: true } }), { select: true, split: null });
  assert.deepEqual(autoGlossaryJobs({ ...base, record: { chosen_by: "ai", stale: false } }), { select: false, split: null });
  // The user's choice is the user's, also when new dictionaries appeared.
  assert.deepEqual(autoGlossaryJobs({ ...base, record: { chosen_by: "user", stale: true } }), { select: false, split: null });
  assert.deepEqual(autoGlossaryJobs({ ...base, record: { chosen_by: "user", stale: false } }), { select: false, split: null });
  // Nothing to choose from: the AI is not called (an empty glossary, or 共通 only).
  assert.deepEqual(autoGlossaryJobs({ ...base, availableDomains: [], domainCounts: { 共通: 10 } }), { select: false, split: null });
  assert.deepEqual(autoGlossaryJobs({ ...base, availableDomains: [], domainCounts: {} }), { select: false, split: null });
});

test("large dictionaries are not split on the reading path, and legacy or edited scopes are rechecked", () => {
  assert.deepEqual(autoGlossaryJobs({ ...base, domainCounts: { 共通: 500, 強化学習: 400 } }), { select: true, split: null });
  assert.deepEqual(autoGlossaryJobs({ ...base, record: { chosen_by: "user", stale: false, scope_stale: true } }), { select: true, split: null });
  assert.deepEqual(autoGlossaryJobs({ ...base, record: { chosen_by: "ai", stale: false, scope_stale: true } }), { select: true, split: null });
});

test("terms are counted per dictionary, 共通 for a term without a domain", () => {
  assert.deepEqual(countDomainTerms([{}, { domain: "電池" }, { domain: " 電池 " }, { domain: "" }, { domain: "共通" }, { domain: "生物" }]),
    { 共通: 3, 電池: 2, 生物: 1 });
  assert.deepEqual(countDomainTerms([]), {});
});

test("the counts of the last split are kept in the memory too, and the storage is only a convenience", () => {
  const values = new Map<string, string>();
  const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } });
  const memory = new Map<string, number>();
  assert.deepEqual(readSplitChecked(storage, memory), {});
  recordSplitChecked(storage, { 共通: 160 }, memory);
  recordSplitChecked(storage, { 電池: 151, 共通: 170 }, memory);
  assert.deepEqual(readSplitChecked(storage, memory), { 共通: 170, 電池: 151 });
  // What another window stored counts too; this window's own record wins.
  values.set("papeer-glossary-split-checked", JSON.stringify({ 共通: 100, 生物: 200 }));
  assert.deepEqual(readSplitChecked(storage, memory), { 共通: 170, 電池: 151, 生物: 200 });
  // Something else in the storage is ignored, not trusted.
  for (const text of ["not json", "[1]", "null", "3", '{"共通":"x","電池":2}']) {
    const other = () => ({ getItem: () => text });
    assert.deepEqual(readSplitChecked(other, new Map()), text.includes("電池") ? { 電池: 2 } : {});
  }
  // A storage that cannot be used (denied, disabled, full): the memory still stops the same dictionary from being sent again.
  const broken = () => ({ getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
  const denied = (): Storage => { throw new Error("SecurityError"); };
  for (const unusable of [broken, denied, () => undefined]) {
    const kept = new Map<string, number>();
    assert.deepEqual(readSplitChecked(unusable, kept), {});
    assert.doesNotThrow(() => recordSplitChecked(unusable, { 共通: 120 }, kept));
    assert.deepEqual(readSplitChecked(unusable, kept), { 共通: 120 });
  }
});

test("a finished split records the counts it left, not those before it", () => {
  const result = { moved: 60, domains: [{ name: "強化学習", count: 35 }, { name: "電池", count: 25 }] };
  // 共通 lost the terms that moved; the result does not list it.
  assert.deepEqual(splitCheckedCounts(result, "共通", 160), { 強化学習: 35, 電池: 25, 共通: 100 });
  assert.deepEqual(splitCheckedCounts({ moved: 500, domains: [] }, "共通", 160), { 共通: 0 });
  // A domain split: the ones the result lists, and the launched one even when it has no term left.
  assert.deepEqual(splitCheckedCounts({ moved: 40, domains: [{ name: "電池", count: 25 }, { name: "生物", count: 40 }] }, "強化学習", 200),
    { 電池: 25, 生物: 40, 強化学習: 0 });
  assert.deepEqual(splitCheckedCounts({ moved: 10, domains: [{ name: "強化学習", count: 190 }, { name: "生物", count: 10 }] }, "強化学習", 200),
    { 強化学習: 190, 生物: 10 });
  // Nothing moved: the dictionary counted as it was is what stops the next split.
  assert.deepEqual(splitCheckedCounts({ moved: 0, domains: [{ name: "電池", count: 151 }] }, "電池", 151), { 電池: 151 });
  assert.deepEqual(splitCheckedCounts({ moved: 0, domains: [] }, "共通", 155), { 共通: 155 });
});

test("the domains of the terms, in order, and the narrowing of the list", () => {
  const terms = [{ domain: "電池" }, {}, { domain: " 生物 " }, { domain: "共通" }, { domain: "電池" }, { domain: "" }];
  assert.deepEqual(domainNamesIn(terms), ["電池", "生物"]);
  assert.deepEqual(domainNamesIn([{}, { domain: "共通" }]), []);
  assert.deepEqual(terms.filter((t) => inDomainFilter(t, null)).length, 6);
  assert.equal(terms.filter((t) => inDomainFilter(t, "共通")).length, 3);
  assert.equal(terms.filter((t) => inDomainFilter(t, "電池")).length, 2);
  assert.equal(terms.filter((t) => inDomainFilter(t, "生物")).length, 1);
});

test("a term is moved to a domain by writing its domain, and to 共通 by dropping the key", () => {
  const term = { source: "cell", target: "細胞" };
  assert.deepEqual(withDomain(term, " 生物 "), { source: "cell", target: "細胞", domain: "生物" });
  assert.deepEqual(withDomain({ ...term, domain: "生物" }, "共通"), term);
  assert.deepEqual(withDomain({ ...term, domain: "生物" }, ""), term);
  assert.ok(!("domain" in withDomain({ ...term, domain: "生物" }, "共通")));
  assert.deepEqual(withDomain({ ...term, domain: "生物" }, "電池"), { ...term, domain: "電池" });
  // The term itself is not changed.
  assert.deepEqual(term, { source: "cell", target: "細胞" });
});

const record = (overrides: Partial<Parameters<typeof toggledChoice>[0] & { stale: boolean; known_domains: string[] }> = {}) => ({
  domains: ["電池"], new_domain: null, chosen_by: "ai" as const, available: ["電池", "生物", "強化学習"],
  stale: false, known_domains: ["電池", "生物", "強化学習"], ...overrides,
});

test("the boxes checked are the choice, or every dictionary while none is recorded", () => {
  assert.deepEqual(checkedDomains(record()), ["電池"]);
  assert.deepEqual(checkedDomains(record({ chosen_by: null, domains: [] })), []);
  assert.equal(selectionOf(undefined), null);
  assert.equal(selectionOf(record({ chosen_by: null, domains: [] })), null);
  assert.deepEqual(selectionOf(record({ new_domain: "材料" })), { domains: ["電池"], new_domain: "材料", scope_terms: [] });
});

test("checking a box keeps the order of the others, and the sidecar's new domain", () => {
  assert.deepEqual(toggledChoice(record({ domains: ["生物", "電池"] }), "強化学習", true), { domains: ["生物", "電池", "強化学習"], newDomain: null });
  assert.deepEqual(toggledChoice(record({ domains: ["生物", "電池"] }), "生物", false), { domains: ["電池"], newDomain: null });
  assert.deepEqual(toggledChoice(record({ domains: ["電池"], new_domain: "材料" }), "生物", true), { domains: ["電池", "生物"], newDomain: "材料" });
  // Nothing recorded: every box shows checked, so unchecking one keeps the rest.
  assert.deepEqual(toggledChoice(record({ chosen_by: null, domains: [] }), "生物", false), { domains: [], newDomain: null });
  // A name that is not in the glossary any more is dropped, and cannot be checked.
  assert.deepEqual(toggledChoice(record({ domains: ["電池", "消えた分野"] }), "生物", true), { domains: ["電池", "生物"], newDomain: null });
  assert.deepEqual(toggledChoice(record(), "消えた分野", true), { domains: ["電池"], newDomain: null });
});

test("the dictionaries added after the user chose are announced, and only to the user who chose", () => {
  const added = record({ chosen_by: "user", stale: true, known_domains: ["電池"], available: ["電池", "生物", "強化学習"] });
  assert.deepEqual(unchosenNewDomains(added), ["生物", "強化学習"]);
  assert.match(unchosenNewDomainsMessage(unchosenNewDomains(added)) ?? "", /^新しい分野辞書 生物、強化学習 は未選択です/);
  assert.deepEqual(unchosenNewDomains({ ...added, chosen_by: "ai" }), []);
  assert.deepEqual(unchosenNewDomains({ ...added, stale: false }), []);
  // A dictionary that is gone makes the choice stale, but there is nothing new to choose.
  assert.deepEqual(unchosenNewDomains(record({ chosen_by: "user", stale: true, known_domains: ["電池", "消えた分野"], available: ["電池"] })), []);
  assert.deepEqual(unchosenNewDomains(undefined), []);
  assert.equal(unchosenNewDomainsMessage([]), null);
});

test("the status line says what the AI is doing, and how it failed", () => {
  assert.equal(domainJobMessage("select"), "AIが原文の使われ方を見て、適用する訳語を選んでいます…");
  assert.equal(domainJobMessage("split"), "AIが辞書を分野ごとに分けています…");
  assert.equal(domainJobMessage(null), null);
  assert.match(domainFailureMessage("select", "接続できません"), /^AIが訳語の適用を判定できませんでした（接続できません）。.*選び直せます/);
  assert.doesNotMatch(domainFailureMessage("select", "x"), /共通だけ/);
  assert.match(domainFailureMessage("split", null), /^AIが辞書を分けられませんでした（不明なエラー）/);
  assert.match(domainFailureMessage("split", "  "), /不明なエラー/);
  assert.match(splitDoneMessage(12), /12件/);
  assert.match(splitDoneMessage(0), /ありませんでした/);
});

const rules = { ...base, paperId: "p1", tried: { splits: {}, selects: new Set<string>() } };

test("term selections do not repeat on failure, but changed translations get a new attempt", () => {
  const record = { chosen_by: "ai" as const, stale: false, scope_stale: true, selection_key: "first" };
  const key = "p1:強化学習\n電池:first";
  assert.deepEqual(nextAutoStart({ ...rules, record }), { kind: "select", key });
  const tried = { splits: {}, selects: new Set([key]) };
  assert.equal(nextAutoStart({ ...rules, record, tried }), null);
  assert.deepEqual(nextAutoStart({ ...rules, record: { ...record, selection_key: "edited" }, tried }),
    { kind: "select", key: "p1:強化学習\n電池:edited" });
  assert.equal(nextAutoStart({ ...rules, record, running: true }), null);
});

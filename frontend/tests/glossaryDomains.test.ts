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

test("a dictionary that reached the split size is split first, and only once at that size", () => {
  const big = { ...base, domainCounts: { 共通: 150, 強化学習: 20, 電池: 5 } };
  assert.deepEqual(autoGlossaryJobs(big), { select: false, split: "共通" });
  // The choice waits for the split, whatever the record says.
  assert.deepEqual(autoGlossaryJobs({ ...big, record: { chosen_by: "ai", stale: true } }), { select: false, split: "共通" });
  assert.deepEqual(autoGlossaryJobs({ ...big, splitChecked: { 共通: 150 } }), { select: true, split: null });
  // Grown since, so worth another look.
  assert.deepEqual(autoGlossaryJobs({ ...big, splitChecked: { 共通: 149 } }), { select: false, split: "共通" });
  assert.deepEqual(autoGlossaryJobs({ ...base, domainCounts: { 共通: 149 } }), { select: true, split: null });
  // The first of the dictionaries that need it: 共通, then the domains in order.
  const several = { ...base, domainCounts: { 共通: 200, 強化学習: 151, 電池: 400 } };
  assert.deepEqual(autoGlossaryJobs(several), { select: false, split: "共通" });
  assert.deepEqual(autoGlossaryJobs({ ...several, splitChecked: { 共通: 200 } }), { select: false, split: "強化学習" });
  assert.deepEqual(autoGlossaryJobs({ ...several, splitChecked: { 共通: 200, 強化学習: 151 } }), { select: false, split: "電池" });
  assert.deepEqual(autoGlossaryJobs({ ...several, splitChecked: { 共通: 200, 強化学習: 151, 電池: 400 } }), { select: true, split: null });
  // The size comes from the sidecar.
  assert.deepEqual(autoGlossaryJobs({ ...big, splitAt: 151 }), { select: true, split: null });
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
  assert.deepEqual(checkedDomains(record({ chosen_by: null, domains: [] })), ["電池", "生物", "強化学習"]);
  assert.equal(selectionOf(undefined), null);
  assert.equal(selectionOf(record({ chosen_by: null, domains: [] })), null);
  assert.deepEqual(selectionOf(record({ new_domain: "材料" })), { domains: ["電池"], new_domain: "材料" });
});

test("checking a box keeps the order of the others, and the sidecar's new domain", () => {
  assert.deepEqual(toggledChoice(record({ domains: ["生物", "電池"] }), "強化学習", true), { domains: ["生物", "電池", "強化学習"], newDomain: null });
  assert.deepEqual(toggledChoice(record({ domains: ["生物", "電池"] }), "生物", false), { domains: ["電池"], newDomain: null });
  assert.deepEqual(toggledChoice(record({ domains: ["電池"], new_domain: "材料" }), "生物", true), { domains: ["電池", "生物"], newDomain: "材料" });
  // Nothing recorded: every box shows checked, so unchecking one keeps the rest.
  assert.deepEqual(toggledChoice(record({ chosen_by: null, domains: [] }), "生物", false), { domains: ["電池", "強化学習"], newDomain: null });
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
  assert.equal(domainJobMessage("select"), "AIがこの論文の分野辞書を選んでいます…");
  assert.equal(domainJobMessage("split"), "AIが辞書を分野ごとに分けています…");
  assert.equal(domainJobMessage(null), null);
  assert.match(domainFailureMessage("select", "接続できません"), /^AIが分野辞書を選べませんでした（接続できません）。.*チェックで選べます/);
  assert.doesNotMatch(domainFailureMessage("select", "x"), /共通だけ/);
  assert.match(domainFailureMessage("split", null), /^AIが辞書を分けられませんでした（不明なエラー）/);
  assert.match(domainFailureMessage("split", "  "), /不明なエラー/);
  assert.match(splitDoneMessage(12), /12件/);
  assert.match(splitDoneMessage(0), /ありませんでした/);
});

const rules = { ...base, paperId: "p1", tried: { splits: {}, selects: new Set<string>() } };

test("what the window started is not started again, and does not hold up the choice", () => {
  const big = { ...rules, domainCounts: { 共通: 160, 強化学習: 20, 電池: 5 } };
  // A split that is due goes first, and the choice waits for it.
  assert.deepEqual(nextAutoStart(big), { kind: "split", domain: "共通" });
  // It was started at this size (and did not go through, or its result is not read yet): the choice is looked at.
  const tried = { splits: { 共通: 160 }, selects: new Set<string>() };
  assert.deepEqual(nextAutoStart({ ...big, tried }), { kind: "select", key: "p1:強化学習\n電池" });
  assert.equal(nextAutoStart({ ...big, tried, record: { chosen_by: "ai", stale: false } }), null);
  // The dictionary has changed in size since: worth a look again.
  assert.deepEqual(nextAutoStart({ ...big, tried: { ...tried, splits: { 共通: 159 } } }), { kind: "split", domain: "共通" });
  // The next dictionary that is due is split even when the first is not.
  assert.deepEqual(nextAutoStart({ ...big, domainCounts: { 共通: 160, 強化学習: 151, 電池: 5 }, tried }), { kind: "split", domain: "強化学習" });
  // A choice started for these dictionaries is not started again; other dictionaries, or another paper, are new.
  const chosen = { splits: {}, selects: new Set(["p1:強化学習\n電池"]) };
  assert.equal(nextAutoStart({ ...rules, tried: chosen }), null);
  assert.deepEqual(nextAutoStart({ ...rules, tried: chosen, paperId: "p2" }), { kind: "select", key: "p2:強化学習\n電池" });
  assert.deepEqual(nextAutoStart({ ...rules, tried: chosen, availableDomains: ["強化学習", "電池", "生物"] }),
    { kind: "select", key: "p1:強化学習\n電池\n生物" });
});

test("a split just done, or dictionaries still being read, do not start the split again", () => {
  const big = { ...rules, domainCounts: { 共通: 160, 強化学習: 20 } };
  // After a split by hand the counts left are recorded, but the glossary read is still the old one (160): the size
  // the split started at stops it, whatever was recorded.
  const byHand = { ...big, splitChecked: { 共通: 100 }, tried: { splits: { 共通: 160 }, selects: new Set<string>() } };
  assert.equal(nextAutoStart({ ...byHand, record: { chosen_by: "ai", stale: false } }), null);
  // What the storage remembers of another size does not bring the split back either.
  assert.equal(nextAutoStart({ ...byHand, splitChecked: { 共通: 160 }, record: { chosen_by: "ai", stale: false } }), null);
  // Cached data while it is read again (a job may have changed it): nothing is started.
  assert.deepEqual(nextAutoStart({ ...big, running: true }), null);
  assert.deepEqual(nextAutoStart({ ...rules, running: true }), null);
  // Once read: the split has shrunk the dictionary, so no split is due, and the choice follows.
  assert.deepEqual(nextAutoStart({ ...byHand, domainCounts: { 共通: 100, 強化学習: 60 } }), { kind: "select", key: "p1:強化学習\n電池" });
});

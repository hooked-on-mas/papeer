import assert from "node:assert/strict";
import { test } from "node:test";
import { invalidationsFor, type DataChange, type StaleQuery } from "../src/api/invalidation.ts";
import { QK } from "../src/lib/queryKeys.ts";

const keys = (change: DataChange): StaleQuery[] => invalidationsFor(change);
const roots = (...names: string[]): StaleQuery[] => names.map((name) => ({ queryKey: [name] }));

test("a change of one paper refreshes the paper itself, not the library lists (paper.changed updates its row)", () => {
  assert.deepEqual(keys({ kind: "paper", paperId: "p1" }), [{ queryKey: [QK.papers, "p1"], exact: true }]);
  // Moved to another folder: the folder tree too.
  assert.deepEqual(keys({ kind: "paper", paperId: "p1", collection: true }),
    [{ queryKey: [QK.papers, "p1"], exact: true }, { queryKey: [QK.collections] }]);
  for (const change of [{ kind: "paper", paperId: "p1" }, { kind: "paper", paperId: "p1", collection: true }] as DataChange[]) {
    assert.ok(!keys(change).some((stale) => stale.queryKey.length === 1 && stale.queryKey[0] === QK.papers && !stale.exact),
      "no reload of every list");
  }
});

test("the library as a whole: folder actions, library.changed and a reconnect", () => {
  assert.deepEqual(keys({ kind: "folders" }), roots(QK.papers, QK.collections));
  // An action on several papers reloads what library.changed would have (refreshAfterChanges).
  assert.deepEqual(keys({ kind: "library" }), roots(QK.papers, QK.collections, QK.librarySearch, QK.tags));
  assert.deepEqual(keys({ kind: "reconnected" }), [...keys({ kind: "library" }), { queryKey: [QK.reading] }]);
  assert.deepEqual(keys({ kind: "imported" }), roots(QK.papers));
});

test("papers changed as paper.changed said: the lists only when too many rows to replace", () => {
  assert.deepEqual(keys({ kind: "papersChanged", all: false, collections: false, tags: false }), roots(QK.librarySearch));
  assert.deepEqual(keys({ kind: "papersChanged", all: true, collections: true, tags: true }),
    roots(QK.papers, QK.collections, QK.tags, QK.librarySearch));
  assert.deepEqual(keys({ kind: "pageTranslated", paperId: "p1" }),
    [{ queryKey: [QK.reading, "p1"] }, { queryKey: [QK.paperSearch, "p1"] }]);
});

test("a memo and the tags on a paper", () => {
  assert.deepEqual(keys({ kind: "note" }), roots(QK.librarySearch));
  assert.deepEqual(keys({ kind: "paperTags" }), roots(QK.tags));
});

test("tag choices: deleting a paper tag takes it off every paper, the other kinds refresh their own list", () => {
  assert.deepEqual(keys({ kind: "tagChoice", tagKind: "paper", removed: false }), roots(QK.tags));
  assert.deepEqual(keys({ kind: "tagChoice", tagKind: "paper", removed: true }), roots(QK.tags, QK.papers, QK.librarySearch));
  for (const removed of [false, true]) {
    assert.deepEqual(keys({ kind: "tagChoice", tagKind: "status", removed }), roots(QK.readingStatuses));
    assert.deepEqual(keys({ kind: "tagChoice", tagKind: "sticky", removed }), roots(QK.stickyLabels));
  }
});

test("sticky notes: the library's search finds their text, but not where they are", () => {
  assert.deepEqual(keys({ kind: "stickyNote" }), roots(QK.stickyNotes, QK.librarySearch));
  assert.deepEqual(keys({ kind: "stickyNoteMoved" }), roots(QK.stickyNotes));
});

test("the glossary, from the translation dialog and the PDF's context menu alike", () => {
  assert.deepEqual(keys({ kind: "glossary" }), roots(QK.glossary, QK.glossaryDomains, QK.effectiveGlossary, QK.paragraphs, QK.translationPlan));
  assert.deepEqual(keys({ kind: "glossaryDomains", paperId: "p1" }), [
    { queryKey: [QK.glossaryDomains, "p1"] }, { queryKey: [QK.translationPlan, "p1"] },
    { queryKey: [QK.paragraphs, "p1"] }, { queryKey: [QK.effectiveGlossary, "p1"] }]);
  assert.deepEqual(keys({ kind: "translationRevised", paperId: "p1" }),
    [{ queryKey: [QK.paragraphs, "p1"] }, { queryKey: [QK.revisions, "p1"] }]);
});

test("templates, settings and the sync folder go through QK too", () => {
  assert.deepEqual(keys({ kind: "noteTemplates" }), roots(QK.noteTemplates));
  assert.deepEqual(keys({ kind: "settings" }), roots(QK.settings, QK.prompts, QK.models, QK.efforts, QK.usageLimits));
  assert.deepEqual(keys({ kind: "drive" }), [{ queryKey: ["drive"] }]);
});

test("every key the table names is one of QK's", () => {
  const known = new Set<unknown>(Object.values(QK));
  const changes: DataChange[] = [
    { kind: "folders" }, { kind: "library" }, { kind: "reconnected" }, { kind: "imported" },
    { kind: "papersChanged", all: true, collections: true, tags: true }, { kind: "pageTranslated", paperId: "p" },
    { kind: "paper", paperId: "p", collection: true }, { kind: "paperTags" }, { kind: "note" },
    { kind: "tagChoice", tagKind: "paper", removed: true }, { kind: "tagChoice", tagKind: "status", removed: true },
    { kind: "tagChoice", tagKind: "sticky", removed: false }, { kind: "stickyNote" }, { kind: "stickyNoteMoved" },
    { kind: "glossary" }, { kind: "glossaryDomains", paperId: "p" }, { kind: "translationRevised", paperId: "p" }, { kind: "noteTemplates" }, { kind: "settings" },
    { kind: "drive" },
  ];
  for (const change of changes) {
    const stale = keys(change);
    assert.ok(stale.length > 0, change.kind);
    for (const { queryKey } of stale) assert.ok(known.has(queryKey[0]), `${change.kind}: ${String(queryKey[0])}`);
  }
});

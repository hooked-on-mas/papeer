import assert from "node:assert/strict";
import { test } from "node:test";
import { countRows, describeDifference, describeSideBackup, type LibraryDifference, type SideBackup } from "../src/features/settings/conflictSummary.ts";

const same: LibraryDifference = {
  local_only: 0, remote_only: 0, local_titles: [], remote_titles: [], notes: 0, stickies: 0, ink: 0,
  local_counts: { papers: 2 }, remote_counts: { papers: 2 },
};

test("papers only one side has are listed with a few titles", () => {
  const lines = describeDifference({ ...same, remote_only: 7, remote_titles: ["A", "B"], local_only: 1, local_titles: ["C"],
    remote_counts: { papers: 8 } });
  assert.deepEqual(lines, [
    "論文の数：このPC 2件、同期フォルダー 8件",
    "同期フォルダーにだけある論文：7件（「A」、「B」 ほか）",
    "このPCにだけある論文：1件（「C」）",
  ]);
});

test("memos, sticky notes and ink that differ are counted in one line, leaving out the kinds without a difference", () => {
  assert.equal(describeDifference({ ...same, notes: 3, ink: 2 })[1], "両方にある論文で内容が異なるもの：メモ 3件・書き込み 2ページ");
});

test("libraries that differ only elsewhere, or a difference that could not be read, still say so", () => {
  assert.match(describeDifference(same)[1], /違いはありません/);
  assert.match(describeDifference(null)[0], /読み取れませんでした/);
});

test("a kept library tells whose it was, when it was saved, and what it holds", () => {
  const item: SideBackup = { path: "p", name: "n.zip", size: 5 * 1024 ** 2, side: "remote", device: "LAPTOP",
    created: "c", saved: "s", counts: { papers: 3, notes: 1, stickies: 0, ink: 2 } };
  assert.deepEqual(describeSideBackup(item, iso => `<${iso}>`), {
    title: "LAPTOP で同期したデータ（<c> 時点）",
    detail: "論文 3件・メモ 1件・付箋 0件・書き込み 2ページ　退避：<s>　5 MB",
  });
  assert.equal(describeSideBackup({ ...item, side: "local" }, iso => iso).title, "このPC（LAPTOP）のデータ（c 時点）");
  // Without its description only the file name and size are known.
  assert.deepEqual(describeSideBackup({ ...item, side: null, device: null, created: null, saved: null, counts: null }, iso => iso),
    { title: "n.zip", detail: "5 MB" });
});

test("the notebooks and the memos and documents of a kept library are told when it has some, and not as 0", () => {
  const item: SideBackup = { path: "p", name: "n.zip", size: 5 * 1024 ** 2, side: "remote", device: "LAPTOP",
    created: null, saved: null, counts: { papers: 3, notes: 1, stickies: 0, ink: 2, notebooks: 2, attachments: 0 } };
  assert.equal(describeSideBackup(item, iso => iso).detail, "論文 3件・メモ 1件・付箋 0件・書き込み 2ページ・ノート 2件　5 MB");
  const withDocuments = { ...item, counts: { ...item.counts, notebooks: 0, attachments: 4 } };
  assert.equal(describeSideBackup(withDocuments, iso => iso).detail, "論文 3件・メモ 1件・付箋 0件・書き込み 2ページ・追加のメモ・資料 4件　5 MB");
  // A library of papers only: the four counts every library has, and nothing of notebooks or documents.
  const papersOnly = { ...item, counts: { ...item.counts, notebooks: 0, attachments: 0 } };
  assert.equal(describeSideBackup(papersOnly, iso => iso).detail, "論文 3件・メモ 1件・付箋 0件・書き込み 2ページ　5 MB");
});

test("a difference in notebooks or in memos and documents is told on its own line, and its notebooks are named with the papers", () => {
  assert.deepEqual(describeDifference({ ...same, local_only: 1, local_titles: ["N"],
    local_counts: { papers: 2, notebooks: 1, attachments: 3 }, remote_counts: { papers: 2, notebooks: 0, attachments: 3 } }), [
    "論文の数：このPC 2件、同期フォルダー 2件",
    "ノートの数：このPC 1件、同期フォルダー 0件",
    "追加のメモ・資料の数：このPC 3件、同期フォルダー 3件",
    "このPCにだけある論文・ノート：1件（「N」）",
  ]);
  // Neither side has any: no line, as for the records of an earlier Papeer.
  assert.equal(describeDifference({ ...same, local_counts: { papers: 2, notebooks: 0, attachments: 0 },
    remote_counts: { papers: 2, notebooks: 0, attachments: 0 } }).length, 2);
});

test("the review's table has a row for each count either side knows, marking those that went down", () => {
  const rows = countRows({ papers: 10, notes: 2, stickies: 0, ink: 3, notebooks: 4, attachments: 9 },
    { papers: 10, notes: 2, stickies: 0, ink: 3, notebooks: 4, attachments: 2 });
  assert.deepEqual(rows.map((row) => [row.label, row.before, row.after, row.shrunk]), [
    ["論文", 10, 10, false], ["メモ", 2, 2, false], ["付箋", 0, 0, false], ["書き込み（ページ）", 3, 3, false],
    ["ノート", 4, 4, false], ["追加のメモ・資料", 9, 2, true],
  ]);
  // A record of an earlier Papeer lacks the last two: their rows show only what the other side has.
  const older = countRows({ papers: 10, notes: 2, stickies: 0, ink: 3 }, { papers: 5, notes: 2, stickies: 0, ink: 3 });
  assert.deepEqual(older.map((row) => row.key), ["papers", "notes", "stickies", "ink"]);
  assert.equal(older[0].shrunk, true);
  // One side knows the count and has some: its row shows, with the other side's unknown.
  const half = countRows({ papers: 1, notes: 0, stickies: 0, ink: 0 }, { papers: 1, notes: 0, stickies: 0, ink: 0, notebooks: 2, attachments: 0 });
  assert.deepEqual(half.slice(4).map((row) => [row.key, row.before, row.after, row.shrunk]), [["notebooks", undefined, 2, false]]);
  // A library of papers only has 0 notebooks and documents on both sides, which the table does not list.
  const papersOnly = countRows({ papers: 10, notes: 2, stickies: 0, ink: 3, notebooks: 0, attachments: 0 },
    { papers: 9, notes: 2, stickies: 0, ink: 3, notebooks: 0, attachments: 0 });
  assert.deepEqual(papersOnly.map((row) => row.key), ["papers", "notes", "stickies", "ink"]);
  // Some to none is a loss: its row stays, and is marked.
  const lost = countRows({ papers: 10, notes: 2, stickies: 0, ink: 3, notebooks: 3, attachments: 0 },
    { papers: 10, notes: 2, stickies: 0, ink: 3, notebooks: 0, attachments: 0 });
  assert.deepEqual(lost.slice(4).map((row) => [row.key, row.before, row.after, row.shrunk]), [["notebooks", 3, 0, true]]);
  // No earlier state to compare with (the first sync).
  assert.deepEqual(countRows(null, { papers: 3 }).map((row) => [row.key, row.before, row.after]), [["papers", undefined, 3]]);
});

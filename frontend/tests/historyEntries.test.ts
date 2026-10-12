import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeEntry, describeHistoryDifference, formatSize, groupEntries, validSetting, type HistoryEntry,
} from "../src/features/settings/historyApi.ts";

const entry = (values: Partial<HistoryEntry>): HistoryEntry => ({
  id: "1", created: "2026-09-01T00:00:00Z", day: "2026-09-01", kind: "publish", group: "recent", device: "PC-A",
  counts: { papers: 3, notes: 1, stickies: 2, ink: 0 }, size: 5 * 1024 ** 2, files: 10, complete: true, verified: true, ...values,
});
const date = (iso: string) => iso.slice(0, 10);

test("entries are grouped as the list shows them, empty groups left out", () => {
  const groups = groupEntries([entry({ id: "a", group: "special", kind: "set_aside" }), entry({ id: "b" }), entry({ id: "c" })]);
  assert.deepEqual(groups.map(part => [part.label, part.entries.map(item => item.id)]),
    [["最近の同期", ["b", "c"]], ["退避・戻す前", ["a"]]]);
});

test("each kind says what the state was and whose", () => {
  assert.equal(describeEntry(entry({}), date).title, "2026-09-01　保存");
  assert.equal(describeEntry(entry({ kind: "pull", source_device: "PC-B" }), date).title, "2026-09-01　取り込み：PC-B から取り込み");
  assert.equal(describeEntry(entry({ kind: "set_aside", side: "remote", source_device: "PC-B" }), date).title,
    "2026-09-01　退避：PC-B のデータ（選ばなかった側）");
  assert.equal(describeEntry(entry({ kind: "set_aside", side: "local" }), date).title, "2026-09-01　退避：このPCのデータ（選ばなかった側）");
  assert.equal(describeEntry(entry({ kind: "before_restore" }), date).title, "2026-09-01　戻す前");
  assert.equal(describeEntry(entry({}), date).detail, "論文 3件・メモ 1件・付箋 2件・書き込み 0ページ　5 MB");
  assert.match(describeEntry(entry({ complete: false, counts: null }), date).detail, /戻せません/);
});

test("sizes read in MB below a gigabyte, never as 0 MB when something is there", () => {
  assert.equal(formatSize(0), "0 MB");
  assert.equal(formatSize(10), "1 MB");
  assert.equal(formatSize(1.5 * 1024 ** 3), "1.5 GB");
});

test("settings must be whole numbers within their range", () => {
  assert.ok(validSetting(5, [1, 50]));
  assert.ok(!validSetting(0, [1, 50]) && !validSetting(51, [1, 50]) && !validSetting(2.5, [1, 50]) && !validSetting(NaN, [1, 50]));
});

test("what going back would change is told from the library's side", () => {
  const lines = describeHistoryDifference({ local_only: 1, remote_only: 0, local_titles: ["新しい論文"], remote_titles: [],
    notes: 2, stickies: 0, ink: 0, local_counts: { papers: 4 }, remote_counts: { papers: 3 } });
  assert.deepEqual(lines, ["論文の数：今 4件、この時点 3件", "今だけある論文（戻すとなくなります）：1件（「新しい論文」）",
    "両方にある論文で内容が異なるもの：メモ 2件"]);
});

test("a state of the history tells the notebooks and the memos and documents it holds, when it has some", () => {
  const counts = { papers: 3, notes: 1, stickies: 2, ink: 0, notebooks: 0, attachments: 4 };
  assert.equal(describeEntry(entry({ counts }), date).detail, "論文 3件・メモ 1件・付箋 2件・書き込み 0ページ・追加のメモ・資料 4件　5 MB");
  assert.equal(describeEntry(entry({ counts: { ...counts, notebooks: 2, attachments: 0 } }), date).detail,
    "論文 3件・メモ 1件・付箋 2件・書き込み 0ページ・ノート 2件　5 MB");
  // A library of papers only: no 0 of notebooks or documents.
  assert.equal(describeEntry(entry({ counts: { ...counts, attachments: 0 } }), date).detail, "論文 3件・メモ 1件・付箋 2件・書き込み 0ページ　5 MB");
});

test("the notebooks and documents a state differs by are told apart from the papers, and the notebooks are named with them", () => {
  const lines = describeHistoryDifference({ local_only: 1, remote_only: 0, local_titles: ["ノート"], remote_titles: [],
    notes: 0, stickies: 0, ink: 0,
    local_counts: { papers: 4, notebooks: 2, attachments: 5 }, remote_counts: { papers: 4, notebooks: 1, attachments: 0 } });
  assert.deepEqual(lines, [
    "論文の数：今 4件、この時点 4件",
    "ノートの数：今 2件、この時点 1件",
    "追加のメモ・資料の数：今 5件、この時点 0件",
    "今だけある論文・ノート（戻すとなくなります）：1件（「ノート」）",
  ]);
});

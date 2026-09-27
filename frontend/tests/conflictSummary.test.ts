import assert from "node:assert/strict";
import { test } from "node:test";
import { describeDifference, describeSideBackup, type LibraryDifference, type SideBackup } from "../src/features/settings/conflictSummary.ts";

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

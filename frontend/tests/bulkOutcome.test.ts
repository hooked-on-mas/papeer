import assert from "node:assert/strict";
import { test } from "node:test";
import { bulkReport, LISTED_FAILURES, runBulk, type BulkOutcome, type BulkWording } from "../src/features/library/bulkOutcome.ts";
import { forgetPapers, movesRecord, undoLabel } from "../src/features/library/undoHistory.ts";
import type { LibraryUndoRecord } from "../src/store/index.ts";

class StopError extends Error {}

const wording: BulkWording = {
  done: (n) => `${n}件の論文を「ML」へ移動しました。`,
  unchanged: (n) => `${n}件はすでに「ML」にあります。`,
  failed: (n) => `${n}件の論文を移動できませんでした`,
};

test("each item is run in turn, and sorted by what its step did", async () => {
  const order: string[] = [];
  const progress: string[] = [];
  const outcome = await runBulk(["a", "b", "c", "d"], async (item) => {
    order.push(item);
    if (item === "b") return "unchanged";
    if (item === "c") throw new Error("処理中のジョブがあるため削除できません。");
    return "done";
  }, { progress: (ran, total) => progress.push(`${ran}/${total}`) });
  assert.deepEqual(order, ["a", "b", "c", "d"]);
  assert.deepEqual(progress, ["0/4", "1/4", "2/4", "3/4"]);
  assert.deepEqual(outcome.done, ["a", "d"]);
  assert.deepEqual(outcome.unchanged, ["b"]);
  assert.deepEqual(outcome.failed.map((f) => f.item), ["c"]);
  assert.deepEqual(outcome.notRun, []);
  assert.equal(outcome.stoppedBy, undefined);
});

test("a failure that would fail the rest stops them, and they are not run", async () => {
  const order: string[] = [];
  const stop = new StopError("同期中のため処理できません。");
  const outcome = await runBulk(["a", "b", "c", "d"], async (item) => {
    order.push(item);
    if (item === "b") throw stop;
    return "done";
  }, { stopsAll: (error) => error instanceof StopError });
  assert.deepEqual(order, ["a", "b"]);
  assert.deepEqual(outcome.done, ["a"]);
  assert.deepEqual(outcome.failed.map((f) => f.item), ["b"]);
  assert.deepEqual(outcome.notRun, ["c", "d"]);
  assert.equal(outcome.stoppedBy, stop);
});

test("stopped by the user, the step running finishes and the rest are not run", async () => {
  const controller = new AbortController();
  const order: string[] = [];
  const outcome = await runBulk(["a", "b", "c", "d"], async (item) => {
    order.push(item);
    if (item === "b") controller.abort();
    return "done";
  }, { signal: controller.signal });
  assert.deepEqual(order, ["a", "b"]);
  assert.deepEqual(outcome.done, ["a", "b"]);
  assert.deepEqual(outcome.notRun, ["c", "d"]);
  assert.equal(outcome.cancelled, true);
  // Stopped before it started.
  const early = await runBulk(["a"], async () => "done", { signal: AbortSignal.abort() });
  assert.deepEqual([early.done, early.notRun, early.cancelled], [[], ["a"], true]);
});

const outcomeOf = (partial: Partial<BulkOutcome<string>>): BulkOutcome<string> =>
  ({ done: [], unchanged: [], failed: [], notRun: [], stoppedBy: undefined, cancelled: false, ...partial });
const name = (id: string) => `論文${id}`;

test("when all went well, the status bar says so and there is no error", () => {
  assert.deepEqual(bulkReport(outcomeOf({ done: ["a", "b", "c"] }), name, wording),
    { status: "3件の論文を「ML」へ移動しました。", error: null });
  assert.deepEqual(bulkReport(outcomeOf({ done: ["a"], unchanged: ["b", "c"] }), name, wording),
    { status: "1件の論文を「ML」へ移動しました。2件はすでに「ML」にあります。", error: null });
  // Without its own words for it, unchanged papers are counted plainly.
  assert.equal(bulkReport(outcomeOf({ unchanged: ["a"] }), name, { done: wording.done, failed: wording.failed }).status,
    "1件は変更ありませんでした。");
});

test("failures are counted in the status bar and listed by name and reason in the error dialog", () => {
  const report = bulkReport(outcomeOf({
    done: ["a", "b"], unchanged: ["c"], failed: [{ item: "d", error: new Error("論文が見つかりません。") }, { item: "e", error: "理由" }],
  }), name, wording);
  assert.equal(report.status, "2件の論文を「ML」へ移動しました。1件はすでに「ML」にあります。2件の論文を移動できませんでした。");
  assert.deepEqual(report.error, {
    title: "2件の論文を移動できませんでした",
    message: "5件のうち3件は完了しました。\n\n・「論文d」：論文が見つかりません。\n・「論文e」：理由",
  });
});

test("papers not run are counted with the reason that stopped them", () => {
  const stop = new Error("バックエンドに接続できませんでした。");
  const report = bulkReport(outcomeOf({ failed: [{ item: "a", error: stop }], notRun: ["b", "c"], stoppedBy: stop }), name, wording);
  assert.equal(report.status, "3件の論文を移動できませんでした。");
  assert.deepEqual(report.error, {
    title: "3件の論文を移動できませんでした",
    message: "・「論文a」：バックエンドに接続できませんでした。\n\n残りの2件は、次の理由で処理していません：バックエンドに接続できませんでした。",
  });
});

test("a long list of failures is cut short and the rest counted", () => {
  const failed = Array.from({ length: LISTED_FAILURES + 3 }, (_, i) => ({ item: String(i), error: new Error("失敗") }));
  const message = bulkReport(outcomeOf({ failed }), name, wording).error!.message.split("\n");
  assert.equal(message.length, LISTED_FAILURES + 1);
  assert.equal(message[LISTED_FAILURES], "ほか3件");
  // An empty reason still says something.
  assert.match(bulkReport(outcomeOf({ failed: [{ item: "a", error: new Error("") }] }), name, wording).error!.message, /：不明なエラー$/);
});

test("papers moved together are one record in the undo history, and its button says how many", () => {
  const moves = [{ paperId: "a", from: "", to: "ML" }, { paperId: "b", from: "Bio", to: "ML" }];
  assert.equal(movesRecord([]), null);
  assert.deepEqual(movesRecord(moves.slice(0, 1)), moves[0]);
  const record = movesRecord(moves);
  assert.deepEqual(record, { kind: "move-papers", moves });
  assert.equal(undoLabel(record!), "2件の論文の移動を元に戻す");
  assert.equal(undoLabel(moves[0]), "論文の移動を元に戻す");
  assert.equal(undoLabel({ kind: "delete-folder", path: "ML", token: "t" }), "「ML」の削除を元に戻す");
  assert.equal(undoLabel(undefined), "論文の移動を元に戻す");
});

test("deleted papers leave the undo history, and papers moved with them keep their moves", () => {
  const folder: LibraryUndoRecord = { kind: "delete-folder", path: "ML", token: "t" };
  const history: LibraryUndoRecord[] = [
    { paperId: "a", from: "", to: "ML" },
    { kind: "move-papers", moves: [{ paperId: "a", from: "ML", to: "Bio" }, { paperId: "b", from: "", to: "Bio" }] },
    { kind: "move-papers", moves: [{ paperId: "a", from: "Bio", to: "" }, { paperId: "c", from: "", to: "" }] },
    folder,
  ];
  assert.deepEqual(forgetPapers(history, new Set(["a", "c"])), [
    { kind: "move-papers", moves: [{ paperId: "b", from: "", to: "Bio" }] },
    folder,
  ]);
  // Records that keep all their moves are kept as they are.
  const kept = forgetPapers(history, new Set(["z"]));
  kept.forEach((entry, i) => assert.equal(entry, history[i]));
});

test("stopped by the user, the papers left are counted in the status bar, without an error unless one failed", () => {
  assert.deepEqual(bulkReport(outcomeOf({ done: ["a"], notRun: ["b", "c"], cancelled: true }), name, wording), {
    status: "1件の論文を「ML」へ移動しました。中止したため、残りの2件は処理していません。", error: null,
  });
  assert.equal(bulkReport(outcomeOf({ done: ["a"], cancelled: true }), name, wording).status, "1件の論文を「ML」へ移動しました。中止しました。");
  const report = bulkReport(outcomeOf({ failed: [{ item: "a", error: new Error("失敗") }], notRun: ["b"], cancelled: true }), name, wording);
  assert.equal(report.status, "1件の論文を移動できませんでした。中止したため、残りの1件は処理していません。");
  assert.deepEqual(report.error, { title: "1件の論文を移動できませんでした", message: "・「論文a」：失敗" });
});

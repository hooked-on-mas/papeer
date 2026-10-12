import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelAnswer, createDialogQueue, insertDialog, normalizeAnswer, shownDialog, type DialogRequest } from "../src/lib/dialogQueue.ts";

const confirm = (title: string): DialogRequest => ({ kind: "confirm", title, message: "", okLabel: "OK", destructive: false });
const text = (title: string): DialogRequest => ({ kind: "text", title, label: "", defaultValue: "" });
const titles = (queue: readonly { request: DialogRequest }[]) => queue.map((entry) => entry.request.title);

/** Settles pending promise callbacks, so a test sees which answers have arrived. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("an ordinary question waits at the back; an urgent one goes ahead of the ordinary ones only", () => {
  const a = { id: 1, urgent: false };
  const b = { id: 2, urgent: false };
  const u1 = { id: 3, urgent: true };
  const u2 = { id: 4, urgent: true };
  assert.deepEqual(insertDialog([a], b), [a, b]);
  // Ahead of the one on screen too: it steps back to the head of the line.
  assert.deepEqual(insertDialog([a, b], u1), [u1, a, b]);
  // Urgent ones keep their order among themselves.
  assert.deepEqual(insertDialog([u1, a, b], u2), [u1, u2, a, b]);
  assert.deepEqual(insertDialog([u1], u2), [u1, u2]);
  assert.deepEqual(insertDialog([], u1), [u1]);
});

test("answers are shaped by the kind of question; dismissing gives the cancel answer", () => {
  assert.equal(normalizeAnswer("text", "name"), "name");
  assert.equal(normalizeAnswer("text", ""), "");
  assert.equal(normalizeAnswer("text", null), null);
  assert.equal(normalizeAnswer("confirm", true), true);
  assert.equal(normalizeAnswer("confirm", "yes"), false);
  assert.equal(normalizeAnswer("message", "x"), undefined);
  assert.equal(cancelAnswer("text"), null);
  assert.equal(cancelAnswer("confirm"), false);
  assert.equal(cancelAnswer("message"), undefined);
  assert.equal(cancelAnswer("summary"), null);
  assert.equal(normalizeAnswer("summary", ""), ""); // Explicit whole-document selection.
  assert.equal(normalizeAnswer("summary", "3,4"), "3,4");
  assert.equal(normalizeAnswer("summary", null), null);
});

test("a question asked while one is on screen waits its turn, and every caller gets its own answer", async () => {
  const dialogs = createDialogQueue();
  const answers: unknown[] = [];
  const first = dialogs.ask(confirm("フォルダーを削除")).then((ok) => answers.push(["first", ok]));
  const second = dialogs.ask(text("フォルダー名を変更")).then((name) => answers.push(["second", name]));
  assert.deepEqual(titles(dialogs.getQueue()), ["フォルダーを削除", "フォルダー名を変更"]);

  dialogs.answer(dialogs.getQueue()[0].id, true);
  await settle();
  assert.deepEqual(answers, [["first", true]]);
  assert.deepEqual(titles(dialogs.getQueue()), ["フォルダー名を変更"]);

  dialogs.answer(dialogs.getQueue()[0].id, "新しい名前");
  await Promise.all([first, second]);
  assert.deepEqual(answers, [["first", true], ["second", "新しい名前"]]);
  assert.equal(dialogs.getQueue().length, 0);
});

test("answering twice, or a question no longer in the line, changes nothing", async () => {
  const dialogs = createDialogQueue();
  const answer = dialogs.ask(confirm("論文を削除"));
  const id = dialogs.getQueue()[0].id;
  dialogs.answer(id, true);
  dialogs.answer(id, false);
  dialogs.answer(999, true);
  assert.equal(await answer, true);
  assert.equal(dialogs.getQueue().length, 0);
});

test("the close confirmation goes ahead of the question on screen, which comes back if closing is called off", async () => {
  const dialogs = createDialogQueue();
  const rename = dialogs.ask(text("ファイル名を変更"));
  const close = dialogs.ask(confirm("処理中"), { key: "app-close", urgent: true });
  assert.deepEqual(titles(dialogs.getQueue()), ["処理中", "ファイル名を変更"]);

  // Closing is called off (キャンセル): the rename is on screen again, still waiting for its answer.
  dialogs.answer(dialogs.getQueue()[0].id, false);
  assert.equal(await close, false);
  assert.deepEqual(titles(dialogs.getQueue()), ["ファイル名を変更"]);
  dialogs.answer(dialogs.getQueue()[0].id, "renamed");
  assert.equal(await rename, "renamed");
});

test("what the close sequence asks goes ahead of questions left waiting, in the order it asks", () => {
  const dialogs = createDialogQueue();
  void dialogs.ask(confirm("テンプレートを削除"));
  void dialogs.ask(confirm("処理中"), { key: "app-close", urgent: true });
  void dialogs.ask(confirm("同期フォルダーを更新できませんでした"), { urgent: true });
  void dialogs.ask(confirm("辞書の変更を破棄"));
  assert.deepEqual(titles(dialogs.getQueue()), ["処理中", "同期フォルダーを更新できませんでした", "テンプレートを削除", "辞書の変更を破棄"]);
});

test("pressing close again while its confirmation is up does not ask twice; that press gets the cancel answer", async () => {
  const dialogs = createDialogQueue();
  const first = dialogs.ask(confirm("処理中"), { key: "app-close", urgent: true });
  const again = dialogs.ask(confirm("処理中"), { key: "app-close", urgent: true });
  assert.equal(await again, false);
  assert.equal(dialogs.getQueue().length, 1);
  dialogs.answer(dialogs.getQueue()[0].id, true);
  assert.equal(await first, true);
  // Once answered, the same key may be asked again.
  void dialogs.ask(confirm("処理中"), { key: "app-close", urgent: true });
  assert.equal(dialogs.getQueue().length, 1);
});

test("while ordinary questions are held, only an urgent one is shown", () => {
  const a = { id: 1, urgent: false };
  const u = { id: 2, urgent: true };
  assert.equal(shownDialog([a], false), a);
  assert.equal(shownDialog([a], true), null);
  assert.equal(shownDialog([u, a], true), u);
  assert.equal(shownDialog([], false), null);
});

test("once closing is confirmed, the question it pushed back stays hidden, and comes back if the closing is called off", async () => {
  const dialogs = createDialogQueue();
  let renamed: unknown;
  void dialogs.ask(text("ファイル名を変更")).then((name) => { renamed = name; });
  const rename = dialogs.getShown();
  const close = dialogs.ask(confirm("処理中"), { key: "app-close", urgent: true });
  assert.equal(dialogs.getShown()?.request.title, "処理中");

  // 「中止して終了」: the app starts closing (setAppClosing(true) holds the ordinary questions).
  dialogs.answer(dialogs.getShown()!.id, true);
  dialogs.hold(true);
  assert.equal(await close, true);
  // Not shown during the closing, so it cannot be answered and start work in the middle of it.
  assert.equal(dialogs.getShown(), null);
  assert.deepEqual(titles(dialogs.getQueue()), ["ファイル名を変更"]);

  // What the closing itself asks is shown all the same.
  const unsynced = dialogs.ask(confirm("同期フォルダーを更新できませんでした"), { urgent: true });
  assert.equal(dialogs.getShown()?.request.title, "同期フォルダーを更新できませんでした");
  dialogs.answer(dialogs.getShown()!.id, false);
  assert.equal(await unsynced, false);
  assert.equal(dialogs.getShown(), null);

  // The closing is called off (the sync asked to stay): the held question is back, unanswered, as it was.
  dialogs.hold(false);
  assert.equal(dialogs.getShown(), rename);
  await settle();
  assert.equal(renamed, undefined);
  dialogs.answer(dialogs.getShown()!.id, "renamed");
  await settle();
  assert.equal(renamed, "renamed");
});

test("holding tells the listeners only when it changes", () => {
  const dialogs = createDialogQueue();
  let heard = 0;
  dialogs.subscribe(() => { heard += 1; });
  dialogs.hold(true);
  dialogs.hold(true);
  dialogs.hold(false);
  assert.equal(heard, 2);
});

test("listeners hear each change to the line, and stop hearing once unsubscribed", async () => {
  const dialogs = createDialogQueue();
  let heard = 0;
  const unsubscribe = dialogs.subscribe(() => { heard += 1; });
  const answer = dialogs.ask(confirm("a"));
  assert.equal(heard, 1);
  dialogs.answer(dialogs.getQueue()[0].id, true);
  assert.equal(heard, 2);
  await answer;
  unsubscribe();
  void dialogs.ask(confirm("b"));
  assert.equal(heard, 2);
});

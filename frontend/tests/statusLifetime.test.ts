import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inProgress, readingTime, STATUS_IN_PROGRESS_MS, STATUS_MAX_MS, STATUS_MIN_MS, statusLifetime,
} from "../src/lib/statusLifetime.ts";

test("an outcome is cleared after a time that grows with its length, within bounds", () => {
  const short = statusLifetime("付箋を保存しました。");
  const long = statusLifetime("ファイル名を「Smith 2020 Attention.pdf」に変更しました。取り込み元のファイル名は変更されません。");
  assert.equal(short, STATUS_MIN_MS);
  assert.ok(long !== null && long > STATUS_MIN_MS && long <= STATUS_MAX_MS);
  assert.equal(statusLifetime("あ".repeat(500)), STATUS_MAX_MS);
});

test("a message about work still going on waits for its outcome, but not forever", () => {
  for (const message of [
    "終了しています…",
    "中止しています… API通信中の場合は応答またはタイムアウトまで待ちます。",
    "処理を中止しています…終了まで少しお待ちください。",
    "バックエンドの起動を待っています…",
    "準備中...",
  ]) {
    assert.equal(inProgress(message), true, message);
    assert.equal(statusLifetime(message), STATUS_IN_PROGRESS_MS, message);
  }
  assert.ok(STATUS_IN_PROGRESS_MS > STATUS_MAX_MS && STATUS_IN_PROGRESS_MS <= 5 * 60_000);
});

test("an empty status has nothing to clear", () => {
  assert.equal(statusLifetime(""), null);
  assert.equal(statusLifetime("  "), null);
});

test("reading time counts characters, not UTF-16 units, and keeps to its bounds", () => {
  assert.equal(readingTime("", 6_000, 15_000), 6_000);
  assert.equal(readingTime("あ".repeat(50), 6_000, 15_000), 8_000);
  assert.equal(readingTime("😀".repeat(50), 6_000, 15_000), 8_000);
  assert.equal(readingTime("あ".repeat(1000), 6_000, 15_000), 15_000);
});

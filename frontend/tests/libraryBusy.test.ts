import assert from "node:assert/strict";
import { test } from "node:test";
import { LIBRARY_BUSY, sendWhenLibraryFree, setLibraryBusyWaiter } from "../src/lib/libraryBusy.ts";

const busy = { status: 409, body: { detail: "同期・バックアップ・復元が終わるまでお待ちください。", code: LIBRARY_BUSY } };
const done = { status: 200, body: { ok: true } };

function responses(...items: { status: number; body: unknown }[]) {
  let calls = 0;
  const send = async () => items[Math.min(calls++, items.length - 1)];
  return { send, calls: () => calls };
}

test("a refusal during a background sync is sent again once the waiter allows it", async () => {
  let waits = 0;
  setLibraryBusyWaiter(async () => { waits += 1; return true; });
  const { send, calls } = responses(busy, done);
  assert.deepEqual(await sendWhenLibraryFree(send), done);
  assert.equal(calls(), 2);
  assert.equal(waits, 1);
});

test("a refusal stays an error when the waiter says no (a sync that may replace the library, a backup)", async () => {
  setLibraryBusyWaiter(async () => false);
  const { send, calls } = responses(busy, done);
  assert.deepEqual(await sendWhenLibraryFree(send), busy);
  assert.equal(calls(), 1);
});

test("other conflicts are never sent again, and retries stop after the limit", async () => {
  setLibraryBusyWaiter(async () => true);
  const other = { status: 409, body: { detail: "訳文が更新されています。" } };
  const first = responses(other, done);
  assert.deepEqual(await sendWhenLibraryFree(first.send), other);
  assert.equal(first.calls(), 1);
  const stuck = responses(busy);
  assert.deepEqual(await sendWhenLibraryFree(stuck.send, 3), busy);
  assert.equal(stuck.calls(), 3);
  setLibraryBusyWaiter(async () => false);
});

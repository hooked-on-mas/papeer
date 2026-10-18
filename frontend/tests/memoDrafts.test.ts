import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoDrafts, isOlderRevision } from "../src/features/notes/memoDrafts.ts";

/** Lets the save chain run up to the PATCH it is waiting on. */
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

type Reply = { resolve: (updatedAt: string) => void; reject: (error: Error) => void };

/** Drafts whose saves wait for the test to answer them, one `Reply` per PATCH. */
function draftsWithDeferredSaves() {
  const replies: Reply[] = [];
  const sent: string[] = [];
  const drafts = createMemoDrafts({
    patch: (owner, id, content) => new Promise((resolve, reject) => {
      sent.push(content);
      replies.push({ resolve: updatedAt => resolve({ id, owner_id: owner, content, updated_at: updatedAt }), reject });
    }),
  });
  const load = (content: string, updatedAt: string) =>
    drafts.hydrate({ id: "m", owner_id: "p", content, updated_at: updatedAt });
  const draft = () => drafts.store.getState().drafts.m;
  return { drafts, replies, sent, load, draft };
}

const T1 = "2026-10-12T01:00:00.000100+00:00";
const T2 = "2026-10-12T01:00:05.250000+00:00";
const T3 = "2026-10-12T01:00:09.000000+00:00";

test("a save answered after its draft was forgotten does not bring the draft back", async () => {
  const { drafts, replies, load, draft } = draftsWithDeferredSaves();
  load("old", T1);
  drafts.change("m", "new");
  const saving = drafts.save("m");
  await tick();
  assert.equal(draft().saving, true);
  drafts.forget("m");
  replies[0].resolve(T2);
  await saving;
  assert.equal(draft(), undefined);
  // Nothing is left for a flush to send, so it cannot stay stuck on a draft with no owner.
  assert.deepEqual(Object.keys(drafts.store.getState().drafts), []);
  await drafts.save("m");
  assert.equal(replies.length, 1);
});

test("a save refused after its draft was forgotten neither brings it back nor fails the flush", async () => {
  const { drafts, replies, load, draft } = draftsWithDeferredSaves();
  load("old", T1);
  drafts.change("m", "new");
  const saving = drafts.save("m");
  await tick();
  drafts.forget("m");
  replies[0].reject(new Error("メモが見つかりません。"));
  await saving; // Resolves: the memo is gone, there is nothing to retry.
  assert.equal(draft(), undefined);
  assert.deepEqual(Object.keys(drafts.store.getState().drafts), []);
});

test("an answer to a forgotten draft does not touch the draft loaded again, nor its next save", async () => {
  const { drafts, replies, sent, load, draft } = draftsWithDeferredSaves();
  load("old", T1);
  drafts.change("m", "first");
  const first = drafts.save("m");
  await tick();
  drafts.forget("m");
  load("reloaded", T2);
  drafts.change("m", "second");
  const second = drafts.save("m");
  replies[0].resolve(T2);
  await first;
  // The old answer left the new draft as it was: not marked saved as "first".
  assert.deepEqual([draft().text, draft().saved, draft().revision], ["second", "reloaded", T2]);
  await tick();
  assert.deepEqual(sent, ["first", "second"]);
  assert.equal(draft().saving, true);
  replies[1].resolve(T3);
  await second;
  assert.deepEqual([draft().text, draft().saved, draft().saving, draft().revision], ["second", "second", false, T3]);
});

test("a failed save keeps the draft and its text for a retry", async () => {
  const { drafts, replies, load, draft } = draftsWithDeferredSaves();
  load("old", T1);
  drafts.change("m", "new");
  const saving = drafts.save("m");
  await tick();
  replies[0].reject(new Error("offline"));
  await assert.rejects(saving, /offline/);
  assert.deepEqual([draft().text, draft().saved, draft().saving, draft().error], ["new", "old", false, "offline"]);
});

test("a load that read the memo before a save does not put the older text back", async () => {
  const { drafts, replies, load, draft } = draftsWithDeferredSaves();
  load("old", T1);
  drafts.change("m", "new");
  const saving = drafts.save("m");
  await tick();
  replies[0].resolve(T2);
  await saving;
  assert.deepEqual([draft().text, draft().saved, draft().revision], ["new", "new", T2]);
  // The slow GET, sent while the PATCH was in flight, answers now with what it read first.
  load("old", T1);
  assert.deepEqual([draft().text, draft().saved, draft().revision], ["new", "new", T2]);
  // A load that read the saved memo is the same text; a genuinely newer one is taken in.
  load("new", T2);
  assert.equal(draft().saved, "new");
  load("changed elsewhere", T3);
  assert.deepEqual([draft().text, draft().saved, draft().revision], ["changed elsewhere", "changed elsewhere", T3]);
});

test("revisions order the library's two timestamp forms and ignore what they cannot read", () => {
  assert.equal(isOlderRevision("2026-10-12 01:00:00", "2026-10-12T01:00:00.000001+00:00"), true);
  assert.equal(isOlderRevision("2026-10-12T01:00:00.100000+00:00", "2026-10-12 01:00:00"), false);
  assert.equal(isOlderRevision("2026-10-12T01:00:00.1+00:00", "2026-10-12T01:00:00.100000+00:00"), false);
  assert.equal(isOlderRevision("2026-10-11T23:59:59.999999+00:00", "2026-10-12 00:00:00"), true);
  assert.equal(isOlderRevision("garbage", T1), false);
  assert.equal(isOlderRevision(T1, ""), false);
});

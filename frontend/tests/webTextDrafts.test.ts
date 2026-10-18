import assert from "node:assert/strict";
import { test } from "node:test";
import { TextDrafts } from "../src/web/textDrafts.ts";
import type { Anchor } from "../src/web/annotations.ts";

const anchor: Anchor = { paper_id: "a".repeat(32), side: "original", source_sha256: "b".repeat(64), page: 2 };
const draft = { at: [.2, .3] as [number, number], value: "入力中の文字メモ" };
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } } as Storage;
}

test("scratch text survives a new session, is scoped by library/document/page/version, and clears after placement", () => {
  const local = storage(), first = new TextDrafts(() => local), key = first.key("library", anchor);
  first.write(key, draft);
  const next = new TextDrafts(() => local);
  assert.deepEqual(next.read(key), draft);
  for (const other of [next.key("other", anchor), next.key("library", { ...anchor, page: 3 }),
    next.key("library", { ...anchor, source_sha256: "c".repeat(64) })]) assert.equal(next.read(other), undefined);
  next.write(key, undefined);
  assert.equal(new TextDrafts(() => local).read(key), undefined);
});

test("a quota failure preserves current text in memory and blocks leaving until a durable retry succeeds", () => {
  const local = storage(), drafts = new TextDrafts(() => local), key = drafts.key("library", anchor);
  drafts.write(key, { ...draft, value: "先に保存した文章" });
  const write = local.setItem;
  local.setItem = () => { throw new Error("quota"); };
  assert.throws(() => drafts.write(key, draft), /quota/);
  assert.deepEqual(drafts.read(key), draft);
  assert.equal(drafts.prepareNavigation(), false);
  local.setItem = write;
  assert.equal(drafts.prepareNavigation(), true);
  assert.deepEqual(new TextDrafts(() => local).read(key), draft);
});

test("malformed scratch text fails with a recovery message without erasing the original data", () => {
  const local = storage(), drafts = new TextDrafts(() => local), key = drafts.key("library", anchor);
  const raw = JSON.stringify({ ...draft, at: [0, 3] }); local.setItem(key, raw);
  assert.throws(() => drafts.read(key), /元のデータ/);
  assert.equal(local.getItem(key), raw);
});

test("an observed edit conflict never overwrites or deletes another tab's draft", () => {
  const local = storage(), first = new TextDrafts(() => local), second = new TextDrafts(() => local);
  const key = first.key("library", anchor);
  first.write(key, draft); second.read(key);
  const remote = { ...draft, value: "先のタブで変更した文章" };
  first.write(key, remote);
  assert.throws(() => second.write(key, { ...draft, value: "後のタブで入力した文章" }), /別のタブ/);
  assert.equal(second.prepareNavigation(), false);
  second.write(key, undefined);
  assert.equal(second.prepareNavigation(), true);
  assert.deepEqual(new TextDrafts(() => local).read(key), remote);
});

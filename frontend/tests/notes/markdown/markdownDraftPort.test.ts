import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserMarkdownDraftPort } from '../../../src/adapters/browser/canonicalMarkdownDrafts.ts';
import type { MarkdownDraft } from '../../../src/features/notes/markdown/MarkdownDraftPort.ts';

const scope = { accountId: 'draft-fixture', libraryId: crypto.randomUUID(), epoch: 'draft-epoch' };
const documentId = crypto.randomUUID();
const draft: MarkdownDraft = { version: 1, documentId, baseVersion: crypto.randomUUID(), content: '未保存の本文\n', generation: 3, appendIds: [crypto.randomUUID()], imageResources: [] };
function memory() {
  const values = new Map<string, string>();
  return { values, get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

test('canonical Markdown scratch is isolated by account, library, epoch and document', () => {
  const storage = memory(), mutable = { ...scope };
  const first = new BrowserMarkdownDraftPort(mutable, storage); mutable.accountId = 'changed-after-construction';
  first.write(documentId, draft);
  assert.deepEqual(first.targets(), [documentId]);
  assert.deepEqual(first.read(documentId), draft); assert.equal(first.read(crypto.randomUUID()), undefined);
  for (const other of [{ ...scope, accountId: 'other' }, { ...scope, libraryId: crypto.randomUUID() }, { ...scope, epoch: 'next' }]) {
    const port = new BrowserMarkdownDraftPort(other, storage);
    assert.deepEqual(port.targets(), []);
    assert.equal(port.read(documentId), undefined); port.remove(documentId);
    assert.deepEqual(first.read(documentId), draft);
  }
  assert.throws(() => first.write(crypto.randomUUID(), draft), /markdown-draft-target/);
  first.remove(documentId); assert.equal(storage.values.size, 0);
});

test('malformed content and failed writes or removals retain the previous raw draft', () => {
  const storage = memory(), port = new BrowserMarkdownDraftPort(scope, storage);
  port.write(documentId, draft); const key = [...storage.values.keys()][0];
  storage.values.set(key, '{unreadable draft');
  assert.throws(() => port.read(documentId), SyntaxError); assert.equal(storage.values.get(key), '{unreadable draft');
  storage.values.set(key, JSON.stringify(draft));
  const failing = new BrowserMarkdownDraftPort(scope, { getItem: storage.getItem, key: storage.key, get length() { return storage.length; },
    setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('unavailable'); } });
  assert.throws(() => failing.write(documentId, { ...draft, content: 'new text' }), /quota/);
  assert.throws(() => failing.remove(documentId), /unavailable/);
  assert.deepEqual(port.read(documentId), draft);
});

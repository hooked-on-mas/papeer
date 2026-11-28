import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMarkdownDraft } from '../src/adapters/browser/markdownDrafts.ts';
import type { NoteDocument } from '../src/runtime/noteDocuments.ts';
const note: NoteDocument = { id: 'a'.repeat(32), kind: 'markdown', title: 'note', content: 'remote', revision: 'remote-version',
  collection_name: '', parent_id: null, note_position: 0 };
function memory() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } as Storage;
  return { values, storage };
}
test('one-time text-only draft recovery never assigns the current remote revision as its edit base', () => {
  const { values, storage } = memory(); values.set('legacy', 'unbased local');
  const recovered = loadMarkdownDraft(storage, 'draft', 'legacy', note);
  assert.equal(recovered.draft, undefined); assert.deepEqual(recovered.recoveries, ['unbased local']);
  assert.equal(values.has('legacy'), false);
  assert.deepEqual(loadMarkdownDraft(storage, 'draft', 'legacy', note).recoveries, ['unbased local']);
  recovered.clearRecoveries(); assert.equal(values.has('draft:recovered'), false);
});
test('migration quota failure keeps the original text and does not claim a converted copy', () => {
  const { values, storage } = memory(); values.set('legacy', 'do not lose');
  storage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => loadMarkdownDraft(storage, 'draft', 'legacy', note), /quota/);
  assert.equal(values.get('legacy'), 'do not lose');
});
test('structured drafts preserve their original revision and wrong-target drafts are retained', () => {
  const { values, storage } = memory(); values.set('draft', JSON.stringify({ ...note, revision: 'old-version', content: 'local' }));
  assert.equal(loadMarkdownDraft(storage, 'draft', 'legacy', note).draft?.revision, 'old-version');
  values.set('draft', JSON.stringify({ ...note, id: 'b'.repeat(32) }));
  assert.throws(() => loadMarkdownDraft(storage, 'draft', 'legacy', note), /対象/);
  assert.ok(values.has('draft'));
});

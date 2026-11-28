import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newPage, replayNotes, validateNoteDocument, type NoteDocument, type NoteOperation } from '../src/runtime/noteDocuments.ts';
const note: NoteDocument = { id: 'a'.repeat(32), title: 'Note', kind: 'markdown', content: 'Base', parent_id: null, collection_name: '研究', note_position: 0, revision: 'base' };
const operation = (id: string, content: string, base = 'base'): NoteOperation => ({ version: 1, id, library_id: 'library', note_id: note.id, base, note: { ...note, content } });
test('concurrent versions preserve both texts independently of listing order', () => {
  const a = operation('11111111-1111-4111-8111-111111111111', 'A');
  const b = operation('22222222-2222-4222-8222-222222222222', 'B');
  assert.deepEqual(replayNotes([note], [a, b], []), replayNotes([note], [b, a], []));
  assert.deepEqual(replayNotes([note], [a, b], []).notes.map(n => n.content).sort(), ['A', 'B']);
});
test('dependent offline versions are applied in causal order and acknowledged edits are skipped', () => {
  const a = operation('11111111-1111-4111-8111-111111111111', 'A');
  const b = operation('22222222-2222-4222-8222-222222222222', 'B', a.id);
  assert.equal(replayNotes([note], [b, a], []).notes[0].content, 'B');
  assert.equal(replayNotes([{ ...note, content: 'A', revision: a.id }], [b, a], [a.id]).notes[0].content, 'B');
});
test('deletion detaches child notes and a concurrent edit survives', () => {
  const child = { ...note, id: 'b'.repeat(32), parent_id: note.id };
  const remove: NoteOperation = { version: 1, id: '11111111-1111-4111-8111-111111111111', library_id: 'library', note_id: note.id, base: 'base', note: null };
  const result = replayNotes([note, child], [remove], []);
  assert.equal(result.notes[0].parent_id, null);
  assert.equal(replayNotes([note], [remove, operation('22222222-2222-4222-8222-222222222222', 'Kept')], []).notes[0].content, 'Kept');
});
test('handwriting rejects mismatched paper dimensions', () => {
  const page = newPage({ size: 'A4', orientation: 'portrait', template: 'grid5', color: 'white' });
  const drawing: NoteDocument = { ...note, kind: 'notebook', document: { version: 1, revision: 1, pages: [page] }, ink: {} };
  assert.equal(validateNoteDocument(drawing), drawing);
  assert.throws(() => validateNoteDocument({ ...drawing, document: { ...drawing.document, pages: [{ ...page, width_mm: 1 }] } }));
});

test('a conflict title of 200 Unicode code points remains valid when reopened or imported', () => {
  const titled = { ...note, title: '𠮷'.repeat(200) };
  validateNoteDocument(titled);
  const a = operation('11111111-1111-4111-8111-111111111111', 'A'), b = operation('22222222-2222-4222-8222-222222222222', 'B');
  a.note = { ...titled, content: 'A' }; b.note = { ...titled, content: 'B' };
  const result = replayNotes([titled], [a, b], []);
  for (const value of result.notes) { validateNoteDocument(value); assert.ok(Array.from(value.title).length <= 200); }
});

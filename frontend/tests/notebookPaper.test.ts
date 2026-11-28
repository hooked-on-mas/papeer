import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeNotebookPaper } from '../src/features/notes/notebookPaper.ts';
import { NoteEditSession } from '../src/features/notes/noteEditSession.ts';
import { newPage, type NoteDocument } from '../src/runtime/noteDocuments.ts';

function fixture(): NoteDocument {
  const page = newPage({ size: 'A4', orientation: 'portrait', template: 'blank', color: 'white' });
  return { id: 'a'.repeat(32), kind: 'notebook', title: 'Physical paper', parent_id: null, collection_name: '', note_position: 0, revision: 'base',
    document: { version: 1, revision: 1, pages: [page] }, ink: { [page.id]: [{ id: 'physical', kind: 'rectangle', points: [[.1,.1],[.2,.1],[.2,.2],[.1,.2],[.1,.1]], width: .003, color: '#000000' }] } };
}
const physical = (note: NoteDocument) => {
  const page = note.document!.pages[0], stroke = note.ink![page.id][0];
  return { points: stroke.points.map(([x,y]) => [x * page.width_mm, y * page.height_mm]), width: stroke.width * page.width_mm };
};
test('paper orientation and size preserve physical geometry and linewidth, including full Undo', async () => {
  const note = fixture(), page = note.document!.pages[0], expected = physical(note);
  const next = changeNotebookPaper(note, page.id, { orientation: 'landscape' });
  for (const [index, point] of physical(next).points.entries()) for (const [axis, value] of point.entries()) assert.ok(Math.abs(value - expected.points[index][axis]) < 1e-10);
  assert.ok(Math.abs(physical(next).width - expected.width) < 1e-10);
  const session = new NoteEditSession(note, { save: value => ({ ...value, revision: crypto.randomUUID() }) });
  session.editDocument(current => changeNotebookPaper(current, page.id, { orientation: 'landscape' })); await session.flush();
  session.undo(); await session.flush(); assert.deepEqual(physical(session.getSnapshot().note), expected);
  session.redo(); await session.flush(); assert.deepEqual(physical(session.getSnapshot().note), physical(next));
});
test('paper overflow leaves the input intact; explicit fit uniformly transforms all points and width', () => {
  const note = fixture(), page = note.document!.pages[0];
  note.ink![page.id][0].points = [[.1,.8],[.2,.8],[.2,.9],[.1,.9],[.1,.8]];
  const before = structuredClone(note);
  assert.throws(() => changeNotebookPaper(note, page.id, { orientation: 'landscape' }), /はみ出/);
  assert.deepEqual(note, before);
  const next = changeNotebookPaper(note, page.id, { orientation: 'landscape' }, true), original = physical(note), fitted = physical(next), scale = 210 / 297;
  assert.ok(Math.abs(fitted.width / original.width - scale) < 1e-10);
  for (let index = 1; index < fitted.points.length; index++) for (let axis = 0; axis < 2; axis++) {
    const actual = fitted.points[index][axis] - fitted.points[0][axis], previous = original.points[index][axis] - original.points[0][axis];
    assert.ok(Math.abs(actual - previous * scale) < 1e-10);
  }
});

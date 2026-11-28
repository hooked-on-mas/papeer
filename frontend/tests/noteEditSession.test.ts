import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NoteEditSession } from '../src/features/notes/noteEditSession.ts';
import type { NoteDocument } from '../src/runtime/noteDocuments.ts';

const note: NoteDocument = { id: 'a'.repeat(32), title: 'Note', kind: 'notebook', parent_id: null,
  collection_name: '', note_position: 0, revision: 'base', document: { version: 1, revision: 1, pages: [] }, ink: {} };
const drawn: NoteDocument = { ...note, ink: { page: [{ id: 'stroke', points: [[.2, .3]], color: '#000000', width: .003 }] } };

test('owner release finalizes gestures before adopting remote content and rejects late old-owner writes', async () => {
  const session = new NoteEditSession(note, { save: () => { throw new Error('conflict'); } });
  const oldOwner = Symbol(), nextOwner = Symbol(); let finalized = 0;
  session.acquireEditor(oldOwner); session.setDrawingFrom(oldOwner, true);
  session.registerEditorFinalizer(oldOwner, () => { finalized++; session.editFrom(oldOwner, drawn); });
  session.receive({ ...note, revision: 'peer', document: { ...note.document!, revision: 2 } });
  session.releaseEditor(oldOwner);
  assert.equal(finalized, 1); assert.equal(session.getSnapshot().note, drawn);
  assert.equal(session.getSnapshot().remote.revision, 'peer');
  session.acquireEditor(nextOwner); session.setDrawingFrom(nextOwner, true);
  session.releaseEditor(oldOwner); session.editFrom(oldOwner, note); session.setDrawingFrom(oldOwner, false);
  assert.equal(finalized, 1); assert.equal(session.getSnapshot().note, drawn); assert.equal(session.canLeave(), false);
  await assert.rejects(session.flush(), /conflict/);
});

test('a remote refresh during a gesture preserves its edit-start revision and retains a rejected draft', async () => {
  const remote = { ...drawn, revision: 'peer-save' };
  let draft: NoteDocument | undefined, sent: NoteDocument | undefined;
  const session = new NoteEditSession(note, {
    writeDraft: next => { draft = next; },
    save: next => { sent = next; if (next.revision !== remote.revision) throw new Error('revision conflict'); return next; },
  });
  const owner = Symbol(); session.acquireEditor(owner); session.setDrawingFrom(owner, true);
  const gestureBase = session.getSnapshot().note;
  session.receive(remote, session.beginRead());
  assert.equal(session.getSnapshot().note, gestureBase);
  assert.equal(session.getSnapshot().remote, remote);
  // Central ink combines its captured stroke list with the session's current metadata.
  const local = { ...session.getSnapshot().note, ink: { page: [{ ...drawn.ink!.page[0], id: 'local' }] } };
  session.editFrom(owner, local); session.setDrawingFrom(owner, false);
  await assert.rejects(session.flush(), /revision conflict/);
  assert.equal(sent!.revision, 'base');
  assert.equal(session.getSnapshot().note, local);
  assert.equal(session.getSnapshot().remote, remote);
  assert.equal(draft, local); assert.equal(session.getSnapshot().durable, true);
  session.releaseEditor(owner);
  assert.equal(session.getSnapshot().note, local, 'placement changes must retain the conflicting draft');
});

test('cancelling or releasing an unstaged gesture adopts the latest deferred remote content', () => {
  for (const release of [false, true]) {
    const session = new NoteEditSession(note, { save: () => assert.fail('cancel must not save') });
    const owner = Symbol(); session.acquireEditor(owner); session.setDrawingFrom(owner, true);
    session.receive({ ...drawn, revision: 'older-peer-save' });
    const latest = { ...drawn, revision: 'latest-peer-save' }; session.receive(latest);
    session.setDrawingFrom(Symbol(), false); session.releaseEditor(Symbol());
    assert.equal(session.getSnapshot().note, note, 'an obsolete view cannot end the gesture');
    if (release) session.releaseEditor(owner); else session.setDrawingFrom(owner, false);
    assert.equal(session.getSnapshot().note, latest);
    assert.equal(session.getSnapshot().pending, false); assert.equal(session.canLeave(), true);
  }
});

test('only adopted external Markdown content resets the text editor generation, preserving local save and append Undo', async () => {
  const base: NoteDocument = { ...note, kind: 'markdown', content: 'initial' };
  const session = new NoteEditSession(base, { save: value => ({ ...value, revision: 'my-save' }) });
  session.editText('my edit'); await session.flush(); assert.equal(session.getSnapshot().textGeneration, 0);
  session.receive({ ...base, content: 'peer edit', revision: 'remote-v2' });
  assert.equal(session.getSnapshot().textGeneration, 1); assert.equal(session.getSnapshot().note.content, 'peer edit');
  session.appendText('local append', 'append-1'); assert.equal(session.getSnapshot().textGeneration, 1);
  session.receive({ ...base, content: 'another peer edit', revision: 'remote-v3' });
  assert.equal(session.getSnapshot().textGeneration, 1); assert.match(session.getSnapshot().note.content!, /local append/);
});

test('a document change drains the shared writer and prevents drawing, Undo and a second structure request from racing it', async () => {
  const session = new NoteEditSession(note, { save: next => ({ ...next, revision: 'accepted' }) }), owner = Symbol();
  session.acquireEditor(owner); session.setDrawingFrom(owner, true);
  await assert.rejects(session.changeDocument(async () => assert.fail('changed a document during a gesture')), /描画/);
  session.setDrawingFrom(Symbol(), false);
  await assert.rejects(session.changeDocument(async () => note), /描画/, 'another view cannot release the gesture owner');
  session.setDrawingFrom(owner, false); session.editFrom(owner, drawn);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const changing = session.changeDocument(async current => { assert.equal(current.revision, 'accepted'); await gate; return { ...current, revision: 'page-change' }; });
  assert.equal(session.canLeave(), false); session.editFrom(owner, note); session.undo(owner);
  await assert.rejects(session.changeDocument(async () => note), /ページ変更/);
  release(); await changing;
  assert.deepEqual(session.getSnapshot().note.ink, drawn.ink); assert.equal(session.getSnapshot().note.revision, 'page-change');
  assert.equal(session.getSnapshot().editingBlocked, false); assert.equal(session.canLeave(), true);
});

test('Web storage rejection retains ink, blocks navigation and can retry unchanged', async () => {
  let fail = true;
  const session = new NoteEditSession(note, { save: next => { if (fail) throw new Error('QuotaExceeded'); return { ...next, revision: 'accepted' }; } });
  session.setDrawing(true);
  assert.equal(session.canLeave(), false, 'an active stroke also blocks navigation');
  session.setDrawing(false);
  session.edit(drawn);
  await assert.rejects(session.flush(), /QuotaExceeded/);
  assert.deepEqual(session.getSnapshot().note.ink, drawn.ink);
  assert.equal(session.canLeave(), false);
  session.receive({ ...note, revision: 'remote' });
  assert.equal(session.getSnapshot().note, drawn);
  fail = false;
  await session.flush();
  assert.equal(session.getSnapshot().note.revision, 'accepted');
  assert.equal(session.canLeave(), true);
});

test('PC draft failure does not claim durability; network failure keeps a durable draft', async () => {
  let quota = true, offline = true, saves = 0;
  const session = new NoteEditSession(note, {
    writeDraft: () => { if (quota) throw new Error('quota'); },
    save: next => { saves++; if (offline) throw new Error('offline'); return { ...next, revision: 'saved' }; },
  });
  session.edit(drawn);
  await assert.rejects(session.flush(), /quota/);
  assert.equal(session.getSnapshot().durable, false);
  assert.equal(saves, 0);
  quota = false;
  await assert.rejects(session.flush(), /offline/);
  assert.equal(session.getSnapshot().durable, true);
  assert.equal(session.canLeave(), true);
  offline = false;
  await session.flush();
  assert.equal(session.getSnapshot().pending, false);
});

test('edits and undo during an in-flight request use the acknowledged revision', async () => {
  let release!: (note: NoteDocument) => void;
  const saved: NoteDocument[] = [];
  const session = new NoteEditSession(note, { save: next => {
    saved.push(next);
    return saved.length === 1 ? new Promise(resolve => { release = resolve; }) : { ...next, revision: 'second' };
  } });
  session.edit(drawn);
  await Promise.resolve();
  session.edit(note); // Undo before the first request finishes.
  const finish = session.flush();
  release({ ...drawn, revision: 'first' });
  await finish;
  assert.equal(saved.length, 2);
  assert.equal(saved[1].revision, 'first');
  assert.deepEqual(session.getSnapshot().note.ink, {});
});

test('draft cleanup failure does not resend an already accepted revision', async () => {
  let saves = 0;
  const session = new NoteEditSession(note, {
    save: next => { saves++; return { ...next, revision: 'saved' }; },
    clearDraft: () => { throw new Error('storage unavailable'); },
  });
  session.edit(drawn);
  await session.flush(); await session.flush();
  assert.equal(saves, 1);
  assert.equal(session.getSnapshot().pending, false);
  assert.match(session.getSnapshot().error, /削除できません/);
});

test('R01: editor transfer retains a single history and rejects stale view callbacks', async () => {
  const session = new NoteEditSession(note, { save: next => ({ ...next, revision: crypto.randomUUID() }) });
  const right = Symbol('right'), center = Symbol('center');
  assert.equal(session.acquireEditor(right), true);
  assert.equal(session.acquireEditor(center), false);
  session.editFrom(right, drawn); await session.flush();
  session.releaseEditor(right); assert.equal(session.acquireEditor(center), true);
  const second = { ...session.getSnapshot().note, ink: { ...drawn.ink, other: drawn.ink!.page } };
  session.editFrom(center, second); await session.flush();
  session.setDrawingFrom(center, true);
  session.releaseEditor(right); session.setDrawingFrom(right, false);
  assert.equal(session.canLeave(), false, 'an obsolete owner cannot clear the active drawing guard');
  session.setDrawingFrom(center, false);
  session.undo(right); assert.deepEqual(session.getSnapshot().note.ink, second.ink);
  session.undo(center); await session.flush();
  assert.deepEqual(session.getSnapshot().note.ink, drawn.ink, 'Undo removes only B, not the previous view\'s A');
  session.redo(center); await session.flush(); assert.deepEqual(session.getSnapshot().note.ink, second.ink);
});

test('R02: dirty Markdown retains its edit-start base and remote body separately, including restored drafts', async () => {
  const base: NoteDocument = { ...note, kind: 'markdown', content: 'base', document: undefined, ink: undefined };
  let saved: NoteDocument | undefined;
  const session = new NoteEditSession(base, { save: next => { saved = next; return { ...next, revision: 'accepted' }; } });
  session.editText('local');
  session.receive({ ...base, revision: 'remote', content: 'other device' });
  assert.equal(session.getSnapshot().note.revision, 'base');
  assert.equal(session.getSnapshot().remote.content, 'other device');
  await session.flush(); assert.equal(saved!.revision, 'base'); assert.equal(saved!.content, 'local');
  const restored = new NoteEditSession({ ...base, revision: 'new-remote' }, { save: next => { saved = next; return next; } }, { ...base, content: 'recovered' });
  await restored.flush(); assert.equal(saved!.revision, 'base'); assert.equal(saved!.content, 'recovered');
});

test('Markdown append retry and storage failure retain the buffer without a duplicate append', async () => {
  const base: NoteDocument = { ...note, kind: 'markdown', content: 'base' };
  let fail = true;
  const session = new NoteEditSession(base, { writeDraft: () => { if (fail) throw new Error('quota'); }, save: next => next });
  session.appendText('quoted passage', 'operation');
  assert.equal(session.canLeave(), false);
  const content = session.getSnapshot().note.content;
  await assert.rejects(session.flush(), /quota/);
  session.appendText('quoted passage', 'operation'); assert.equal(session.getSnapshot().note.content, content);
  fail = false; await session.flush(); assert.equal(session.getSnapshot().pending, false);
});

test('saving a recovery copy preserves the original dirty buffer and bounds the Unicode title', async () => {
  const base: NoteDocument = { ...note, kind: 'markdown', title: '𠮷'.repeat(200), content: 'base' };
  let copy: NoteDocument | undefined;
  const session = new NoteEditSession(base, { save: () => { throw new Error('conflict'); }, createCopy: value => { copy = value; } });
  session.editText('local'); await assert.rejects(session.flush(), /conflict/);
  await session.saveCopy();
  assert.equal(copy!.content, 'local'); assert.equal(Array.from(copy!.title).length, 200); assert.notEqual(copy!.id, base.id);
  assert.equal(session.getSnapshot().note.content, 'local'); assert.equal(session.getSnapshot().pending, true);
});

test('a late read cannot overwrite an edit or its acknowledged revision after a view remount', async () => {
  const base: NoteDocument = { ...note, kind: 'markdown', content: 'base' };
  const session = new NoteEditSession(base, { save: next => ({ ...next, revision: 'accepted' }) });
  const oldRead = session.beginRead();
  session.editText('local'); await session.flush();
  session.receive(base, oldRead);
  assert.equal(session.getSnapshot().note.content, 'local'); assert.equal(session.getSnapshot().note.revision, 'accepted');
  session.editText('second local');
  const readDuringPendingSave = session.beginRead();
  await session.flush(); session.receive(base, readDuringPendingSave);
  assert.equal(session.getSnapshot().note.content, 'second local', 'a save acknowledgement invalidates reads started while that save was pending');
  const first = session.beginRead(), second = session.beginRead();
  session.receive({ ...base, revision: 'latest-read', content: 'new remote' }, second);
  session.receive({ ...base, revision: 'older-read', content: 'old remote' }, first);
  assert.equal(session.getSnapshot().note.content, 'new remote');
});

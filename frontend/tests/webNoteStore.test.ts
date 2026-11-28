import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebNoteStore } from '../src/web/noteStore.ts';
import type { DriveSession, Manifest } from '../src/web/drive.ts';
import type { NoteDocument } from '../src/runtime/noteDocuments.ts';

test('a startup with no pending edits does not prevent later saves, and failed edits survive restart', async () => {
  const values = new Map<string, string>();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return values.size; }, key: (i: number) => [...values.keys()][i], getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  try {
    let calls = 0, failing = false;
    const session = { noteFiles: async () => [], saveNote: async () => { calls++; if (failing) throw new Error('offline'); } } as unknown as DriveSession;
    const manifest: Manifest = { version: 1, revision: 'r', updated_at: '', items: [], attachments: [], files: {} };
    const store = new WebNoteStore(session, 'library', manifest);
    await store.start();
    const note: NoteDocument = { id: 'a'.repeat(32), title: 'Draft', kind: 'markdown', content: 'Keep me', revision: '', collection_name: '', note_position: 0, parent_id: null };
    store.edit(note); await store.flush();
    assert.equal(calls, 1);
    assert.equal(store.getSnapshot().status, 'Driveへ同期済み');
    failing = true;
    const saved = store.getSnapshot().notes[0];
    store.edit({ ...saved, content: 'Offline edit' }, saved); await store.flush(); store.dispose();
    const next = new WebNoteStore(session, 'library', manifest);
    await next.start();
    assert.equal(next.getSnapshot().notes[0].content, 'Offline edit');
    failing = false; await next.flush();
    assert.equal(next.getSnapshot().status, 'Driveへ同期済み'); next.dispose();
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

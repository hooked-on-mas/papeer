import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnnotationStore, type Anchor } from '../src/web/annotations.ts';
import type { Manifest } from '../src/web/drive.ts';
import type { LibraryTransport } from '../src/web/offlineLibrary.ts';
import { moveInkHistory, type PageHistory } from '../src/web/pdfWritingHistory.ts';

test('restored IDs follow every grouped history reference through repeated Undo and Redo', async () => {
  const values = new Map<string, string>();
  const storage = { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear() } as Storage;
  const transport = { annotationFiles: async () => [], saveAnnotation: async () => {} } as unknown as LibraryTransport;
  const store = new AnnotationStore(transport, 'history-test', { files: {}, folder_id: 'unused' } as Manifest, storage);
  await store.start();
  const anchor: Anchor = { paper_id: 'a'.repeat(32), side: 'original', source_sha256: 'b'.repeat(64), page: 1 };
  const stroke = { points: [[.2, .2], [.3, .3]] as [number, number][], width: .003, color: '#000000' };
  let history: PageHistory = { undo: [], redo: [] };
  const a = store.add(anchor, stroke), b = store.add(anchor, stroke);
  history.undo.push({ action: 'add', strokes: [a] }, { action: 'add', strokes: [b] });
  store.edit(anchor, { remove: [a.id, b.id] }); history.undo.push({ action: 'remove', strokes: [a, b] });
  const move = (direction: 'undo' | 'redo') => {
    const entry = history[direction][history[direction].length - 1]!;
    const adds = direction === 'undo' ? entry.action === 'remove' : entry.action === 'add';
    const restored = adds ? store.edit(anchor, { add: entry.strokes }) : undefined;
    if (!adds) store.edit(anchor, { remove: entry.strokes.map(value => value.id) });
    history = moveInkHistory(history, direction, restored);
  };
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const expected of [2, 1, 0]) { move('undo'); assert.equal(store.page(anchor).strokes.length, expected); }
    for (const expected of [1, 2, 0]) { move('redo'); assert.equal(store.page(anchor).strokes.length, expected); }
  }
  await store.flush(); store.dispose();
});

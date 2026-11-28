import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { DocumentSnapshot, EditBatch, HistoryRecord, PageEditBatch, DocumentEditBatch } from '../../../src/runtime/edits/contracts.ts';
import { applyBatch } from '../../../src/runtime/edits/editModel.ts';
import { activeDocumentPages, pageExpectation } from '../../../src/runtime/edits/documentPages.ts';
import { DocumentEditHistory, inverseDocumentEdit, type DocumentVersions } from '../../../src/features/reader/edit/documentHistory.ts';
import { translatedBinding } from '../../../src/features/reader/pageMapping.ts';
import { DurableEditRepository } from '../../../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from '../../support/editMemoryDatabase.ts';
import { EditGraph } from '../../../src/runtime/edits/editGraph.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
function harness(root: DocumentSnapshot) {
  let current = structuredClone(root);
  const states = new Map([[root.version, current]]), batches = new Map<string, EditBatch>(), records: HistoryRecord[] = [];
  const history = new DocumentEditHistory();
  const versions: DocumentVersions = { batch: id => batches.get(id), snapshot: id => states.get(id) };
  const apply = (batch: PageEditBatch | DocumentEditBatch, record: HistoryRecord = {
    operationId: batch.id, beforeVersion: current.version, afterVersion: batch.id, undoRequested: false,
  }) => {
    current = applyBatch(current, batch) as DocumentSnapshot;
    states.set(batch.id, current); batches.set(batch.id, batch); records.push(record); history.record(batch, record);
  };
  return { history, versions, records, apply, current: () => current,
    undo() { const command = history.command('undo', versions, current, crypto.randomUUID()); assert.ok(command); apply(command.batch, command.history); return command; },
    redo() { const command = history.command('redo', versions, current, crypto.randomUUID()); assert.ok(command); apply(command.batch, command.history); return command; } };
}

test('one document history undoes translated ink and mapping in applied order across restart', () => {
  const root: DocumentSnapshot = fixture.translation.root, h = harness(root);
  h.apply(fixture.translation.batches[0]); h.apply(fixture.translation.batches[1]);
  assert.ok(h.undo().affectedPages.includes(root.translation!.pages[0].id));
  assert.equal(h.current().translation!.pages[0].id, root.translation!.pages[0].id);
  const inkUndo = h.undo(); assert.equal(inkUndo.batch.kind, 'page');
  assert.deepEqual(h.current().translation!.pages[0].annotations, []);
  const restored = new DocumentEditHistory(); restored.restore(h.versions, h.current().version, h.records);
  assert.deepEqual(restored.getSnapshot(), h.history.getSnapshot());
  h.redo(); h.redo();
  assert.equal(h.current().translation!.pages[0].id, fixture.translation.batches[1].changes[0].translation.pages[0].id);
  h.undo();
  assert.equal(h.current().translation!.pages[0].annotations.length, 1);
});

test('bulk page delete and several page moves restore original order and immutable page contents', () => {
  const root: DocumentSnapshot = structuredClone(fixture.document);
  root.pages.push({ ...structuredClone(root.pages[0]), id: crypto.randomUUID() }, { ...structuredClone(root.pages[0]), id: crypto.randomUUID() });
  const h = harness(root);
  h.apply({ kind: 'document', id: crypto.randomUUID(), libraryId: fixture.libraryId, targetId: root.id, parents: [root.version],
    changes: [{ type: 'remove', expected: pageExpectation(root.pages[0]) }, { type: 'remove', expected: pageExpectation(root.pages[1]) }] });
  h.undo(); assert.deepEqual(h.current().pages.map(page => page.id), root.pages.map(page => page.id));
  h.redo(); assert.deepEqual(h.current().pages.map(page => page.id), root.pages.slice(2).map(page => page.id));
  h.undo();
  const before = h.current();
  h.apply({ kind: 'document', id: crypto.randomUUID(), libraryId: fixture.libraryId, targetId: root.id, parents: [before.version],
    changes: [{ type: 'move', expected: pageExpectation(before.pages[0]), index: 3 }, { type: 'move', expected: pageExpectation(before.pages[1]), index: 2 }] });
  h.undo(); assert.deepEqual(h.current().pages.map(page => page.id), root.pages.map(page => page.id));
});

test('mixed bulk insert/remove/move operations retain page order through Undo and Redo for varied command orders', () => {
  let seed = 71;
  const random = (size: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % size; };
  for (let trial = 0; trial < 80; trial++) {
    const root: DocumentSnapshot = structuredClone(fixture.document);
    root.pages = Array.from({ length: 5 }, () => ({ ...structuredClone(root.pages[0]), id: crypto.randomUUID() }));
    const h = harness(root), current = [...root.pages], changes: DocumentEditBatch['changes'] = [];
    for (const page of root.pages) {
      const index = current.findIndex(value => value.id === page.id);
      if (random(3) === 0 && current.length > 1) {
        changes.push({ type: 'remove', expected: pageExpectation(page) }); current.splice(index, 1);
      } else {
        const destination = random(current.length);
        changes.push({ type: 'move', expected: pageExpectation(page), index: destination });
        current.splice(destination, 0, current.splice(index, 1)[0]);
      }
    }
    const inserted = { ...structuredClone(root.pages[0]), id: crypto.randomUUID() }, position = random(current.length + 1);
    changes.push({ type: 'insert', page: inserted, index: position }); current.splice(position, 0, inserted);
    h.apply({ kind: 'document', id: crypto.randomUUID(), libraryId: fixture.libraryId, targetId: root.id, parents: [root.version], changes });
    const edited = h.current().pages.map(page => page.id);
    h.undo(); assert.deepEqual(h.current().pages.map(page => page.id), root.pages.map(page => page.id), `Undo trial ${trial}`);
    h.redo(); assert.deepEqual(h.current().pages.map(page => page.id), edited, `Redo trial ${trial}`);
  }
});

test('Undo restores deleted annotations in the same draw order and never overwrites a divergent page', () => {
  const root: DocumentSnapshot = structuredClone(fixture.document), annotation = fixture.batches[0].changes[0].annotation;
  root.pages[0].annotations = Array.from({ length: 3 }, () => ({ ...structuredClone(annotation), id: crypto.randomUUID() }));
  const h = harness(root), page = root.pages[0];
  h.apply({ kind: 'page', id: crypto.randomUUID(), libraryId: fixture.libraryId, targetId: root.id, parents: [root.version],
    expected: pageExpectation(page), changes: [{ type: 'delete', id: page.annotations[0].id }] });
  const execution = h.current().version;
  h.undo(); assert.deepEqual(h.current().pages[0].annotations, page.annotations);
  h.redo(); assert.deepEqual(h.current().pages[0].annotations, page.annotations.slice(1));
  const divergent = structuredClone(h.current()); divergent.pages[0].annotations.pop();
  assert.throws(() => inverseDocumentEdit(h.versions, execution, divergent, crypto.randomUUID()), /history-diverged/);
});

test('background Undo rebinds text highlights and translation references to the restored physical page', () => {
  const root: DocumentSnapshot = structuredClone(fixture.translation.root), first = root.pages[0];
  first.annotations = [{ kind: 'highlight', id: crypto.randomUUID(), backgroundRevision: first.backgroundRevision,
    range: { kind: 'indexed', start: 0, end: 3 }, quote: 'abc', text: 'comment', anchor: { x: 1, y: 1 }, metadata: { label: '重要', createdAt: '2026-10-25T00:00:00Z' },
    color: '#facc15', quads: [[{ x: 1, y: 1 }, { x: 10, y: 1 }, { x: 10, y: 10 }, { x: 1, y: 10 }]] }];
  const h = harness(root), id = crypto.randomUUID();
  const replacement = fixture.resource.metadata.pdfPages[1];
  h.apply({ kind: 'document', id, libraryId: fixture.libraryId, targetId: root.id, parents: [root.version], changes: [{ type: 'replace', expected: pageExpectation(first),
    page: { ...first, ...replacement, background: { ...first.background, kind: 'pdf', pdfPage: 2 } as typeof first.background,
      annotations: [], backgroundRevision: id } }] });
  assert.equal(translatedBinding(h.current(), first.id).status, 'unresolved');
  h.undo();
  const restored = h.current().pages[0]; assert.equal(restored.widthPt, first.widthPt);
  assert.equal(restored.annotations[0].kind === 'highlight' && restored.annotations[0].backgroundRevision, restored.backgroundRevision);
  assert.equal(translatedBinding(h.current(), first.id).status, 'resolved');
  h.redo(); assert.equal(h.current().pages[0].widthPt, replacement.widthPt);
});

test('history is bounded, a new edit clears Redo, and durable recovery uses references rather than document copies', async () => {
  const root: DocumentSnapshot = fixture.document, h = harness(root);
  for (let i = 0; i < 55; i++) {
    const current = h.current(), page = current.pages[0];
    h.apply({ kind: 'document', id: crypto.randomUUID(), libraryId: fixture.libraryId, targetId: root.id, parents: [current.version],
      changes: [{ type: 'replace', expected: pageExpectation(page), page: { ...page, widthPt: page.widthPt + 1 } }] });
  }
  assert.equal(h.history.getSnapshot().undo.length, 50);
  h.undo(); assert.equal(h.history.getSnapshot().redo.length, 1);
  const current = h.current();
  h.apply({ kind: 'document', id: crypto.randomUUID(), libraryId: fixture.libraryId, targetId: root.id, parents: [current.version],
    changes: [{ type: 'replace', expected: pageExpectation(current.pages[0]), page: { ...current.pages[0], widthPt: 900 } }] });
  assert.equal(h.history.getSnapshot().redo.length, 0);
  assert.ok(Object.keys(h.history.getSnapshot().undo[0]).every(key => ['operationId', 'executionId'].includes(key)));
  const repository = new DurableEditRepository({ accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'history' }, new EditMemoryDatabase());
  await repository.initialize(root);
  for (const record of h.records) {
    assert.equal((await repository.commit(h.versions.batch(record.operationId)!, record)).status, 'durable');
  }
  const read = await repository.read(root.id), graph = new EditGraph(read.checkpoint), restored = new DocumentEditHistory();
  restored.restore({ batch: id => read.checkpoint.batches.find(batch => batch.id === id), snapshot: id => graph.snapshot(id) as DocumentSnapshot | undefined }, read.heads[0], read.history);
  assert.deepEqual(restored.getSnapshot(), h.history.getSnapshot());
  assert.equal(activeDocumentPages(graph.snapshot(read.heads[0]) as DocumentSnapshot).length, root.pages.length);
});

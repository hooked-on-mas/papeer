import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LibrarySnapshot, LibraryItem, EditBatch } from '../../../src/runtime/edits/contracts.ts';
import { applyBatch, assertSnapshot } from '../../../src/runtime/edits/editModel.ts';
import { noteTemplateMetadata, validateTemplateInput } from '../../../src/runtime/markdown/noteTemplates.ts';
import { DurableEditRepository } from '../../../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from '../../support/editMemoryDatabase.ts';

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const item = (n: number, title = 'Custom'): LibraryItem => ({ id: id(n), kind: 'markdown', title, ownerId: null,
  folderId: null, position: 0, tags: [], read: false, metadata: noteTemplateMetadata() });
const root = (items: LibraryItem[] = []): LibrarySnapshot => ({ kind: 'library', id: id(1), version: id(2), items, folders: [], links: [], deletions: [] });

test('template input preserves body and uses Python-compatible whitespace and Unicode character limits', () => {
  assert.deepEqual(validateTemplateInput('\u00a0Example\u0085', '  ## Body\n'), { name: 'Example', content: '  ## Body\n' });
  assert.equal(validateTemplateInput('𠮷'.repeat(80), '𠮷'.repeat(50_000)).name.length, 160);
  for (const name of ['', ' \u0085', '𠮷'.repeat(81), '読書メモ']) assert.throws(() => validateTemplateInput(name, 'body'), /note-template-name/);
  for (const body of ['', ' \n\t', '𠮷'.repeat(50_001)]) assert.throws(() => validateTemplateInput('Example', body), /note-template-content/);
});

test('template catalog rejects duplicate names atomically and keeps ordinary notes distinct', () => {
  const before = root([item(10)]), preserved = structuredClone(before);
  const batch: EditBatch = { kind: 'library', id: id(20), libraryId: before.id, targetId: before.id, parents: [before.version],
    changes: [{ type: 'put-item', item: item(11, 'Other') }, { type: 'put-item', item: item(12) }] };
  assert.throws(() => applyBatch(before, batch), /duplicate-note-template-name/);
  assert.deepEqual(before, preserved);
  const normal = { ...item(11), metadata: {} };
  assert.doesNotThrow(() => assertSnapshot(root([item(10), normal])));
});

test('repository rejects a duplicate template transaction without a receipt, outbox or partial projection', async () => {
  const before = root([item(10)]);
  const repository = new DurableEditRepository({ accountId: 'template-contract', libraryId: before.id, epoch: 'one' }, new EditMemoryDatabase());
  await repository.initialize({ kind: 'markdown', id: id(10), version: id(40), content: 'Template body', appendIds: [], imageResources: [] });
  await repository.initialize(before);
  const batch: EditBatch = { kind: 'library', id: id(20), libraryId: before.id, targetId: before.id, parents: [before.version],
    changes: [{ type: 'put-item', item: item(11, 'Other') }, { type: 'put-item', item: item(12) }] };
  const unchanged = await repository.read(before.id);
  const result = await repository.commit(batch);
  assert.equal(result.status, 'aborted');
  assert.match('reason' in result ? result.reason : '', /duplicate-note-template-name/);
  assert.deepEqual(await repository.read(before.id), unchanged);
  assert.equal(await repository.receipt(batch.id), undefined);
  assert.deepEqual(await repository.pending(), []);
});

test('reserved catalog roles cannot hide existing notes or become ordinary notes by metadata replacement', () => {
  for (const original of [item(10), { ...item(10), metadata: {} }]) {
    const before = root([original]);
    assert.throws(() => applyBatch(before, { kind: 'library', id: id(20), libraryId: before.id, targetId: before.id, parents: [before.version],
      changes: [{ type: 'put-item', item: { ...original, metadata: Object.keys(original.metadata).length ? {} : noteTemplateMetadata() } }] }), /note-template-role-rebind/);
  }
});

test('templates cannot own ordinary children hidden from the normal catalog', () => {
  const child = { ...item(11, 'Child'), ownerId: id(10), metadata: {} };
  assert.throws(() => assertSnapshot(root([item(10), child])), /invalid-owner/);
  assert.doesNotThrow(() => assertSnapshot(root([{ ...item(10), metadata: {} }, child])));
});

test('template names, versions, topology and explicit deletion enforce one resolved catalog meaning', () => {
  assert.doesNotThrow(() => assertSnapshot(root([item(10, '𠮷'.repeat(80))])));
  for (const title of [' Custom ', '𠮷'.repeat(81), '読書メモ']) assert.throws(() => assertSnapshot(root([item(10, title)])), /note-template-name/);
  assert.throws(() => assertSnapshot(root([{ ...item(10), metadata: { 'papeer.note-template': 'v2' } }])), /note-template-version/);
  assert.throws(() => assertSnapshot(root([{ ...item(10), kind: 'pdf' }])), /note-template-kind/);
  const deleted = root([item(10), item(11)]);
  deleted.deletions.push({ id: id(30), itemIds: [id(10)], observed: [{ targetId: id(10), heads: [id(40)] }], active: true });
  assert.doesNotThrow(() => assertSnapshot(deleted));
  assert.throws(() => applyBatch(deleted, { kind: 'library', id: id(21), libraryId: deleted.id, targetId: deleted.id, parents: [deleted.version],
    changes: [{ type: 'put-deletion', deletion: { ...deleted.deletions[0], active: false } }] }), /duplicate-note-template-name/);
});

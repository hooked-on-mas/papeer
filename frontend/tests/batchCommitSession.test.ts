import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BatchCommitSession } from '../src/runtime/edits/batchCommitSession.ts';
import { createDesktopEditRepository } from '../src/adapters/desktop/editRepository.ts';
import type { EditRepository, CommitResult, BatchReceipt } from '../src/runtime/edits/ports.ts';
import type { EditBatch, PageEditBatch } from '../src/runtime/edits/contracts.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const original: PageEditBatch = fixture.batches[0];
const inverse: EditBatch = { ...original, id: crypto.randomUUID(), parents: [original.id],
  expected: { ...original.expected, annotationVersion: original.id }, changes: [{ type: 'delete', id: original.changes[0].type === 'create' ? original.changes[0].annotation.id : '' }] };
const receipt = (batch: EditBatch): BatchReceipt => ({ id: batch.id, targetId: batch.targetId, durable: true, upload: 'pending', importedBy: [] });

test('Undo requested by a durable-state subscriber still saves the inverse before the session can leave', async () => {
  const requests: string[] = [];
  const session = new BatchCommitSession({ commit: async (batch: EditBatch) => {
    requests.push(batch.id); return { status: 'durable', receipt: receipt(batch) };
  } }, { batch: original }, () => ({ batch: inverse }));
  session.subscribe(() => {
    if (session.getSnapshot().phase === 'durable' && !session.getSnapshot().undoRequested) session.requestUndo();
  });
  await session.flush();
  assert.deepEqual(requests, [original.id, inverse.id]);
  assert.equal(session.getSnapshot().phase, 'undone');
  assert.equal(session.canLeave(), true);
});

test('R21: response loss + Undo resends the identical original before saving an inverse', async () => {
  let release!: (value: CommitResult) => void;
  const requests: EditBatch[] = [];
  let inverseFailure = true;
  const repository = { commit: async (batch: EditBatch): Promise<CommitResult> => {
    requests.push(batch);
    if (requests.length === 1) return new Promise(resolve => { release = resolve; });
    if (batch.id === inverse.id && inverseFailure) return { status: 'aborted', reason: 'quota' };
    return { status: 'durable', receipt: receipt(batch) };
  } };
  const session = new BatchCommitSession(repository, { batch: original }, () => ({ batch: inverse }));
  const first = session.flush(); await Promise.resolve(); session.requestUndo();
  assert.equal(session.canLeave(), false); assert.equal(session.getSnapshot().phase, 'saving');
  release({ status: 'unknown', reason: 'response-lost' }); await first;
  assert.equal(session.getSnapshot().phase, 'unknown'); assert.equal(session.canLeave(), false);
  await session.flush();
  assert.deepEqual(requests[0], requests[1]); assert.equal(requests[2].id, inverse.id);
  assert.equal(session.getSnapshot().phase, 'aborted'); assert.equal(session.canLeave(), false);
  inverseFailure = false; await session.flush();
  assert.equal(requests[3].id, inverse.id); assert.equal(session.getSnapshot().phase, 'undone'); assert.equal(session.canLeave(), true);
});
test('an unstarted/proven-aborted operation can cancel without ever reaching the repository', async () => {
  let writes = 0;
  const repository: Pick<EditRepository, 'commit'> = { commit: async () => { writes++; return { status: 'aborted', reason: 'quota' }; } };
  const session = new BatchCommitSession(repository, { batch: original }, () => ({ batch: inverse }));
  session.requestUndo(); await session.flush(); assert.equal(writes, 0); assert.equal(session.getSnapshot().phase, 'cancelled');
});
test('desktop HTTP failures are unknown, including malformed/missing replies after a server commit', async () => {
  const repository = createDesktopEditRepository({ accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'test' }, async () => { throw new Error('network'); });
  assert.equal((await repository.commit(original)).status, 'unknown');
});

test('a later proven-aborted retry does not disprove an earlier unknown original request', async () => {
  let calls = 0;
  const repository = { commit: async (): Promise<CommitResult> => ++calls === 1 ? { status: 'unknown', reason: 'lost' } : { status: 'aborted', reason: 'busy' } };
  const session = new BatchCommitSession(repository, { batch: original }, () => ({ batch: inverse }));
  await session.flush(); await session.flush();
  assert.equal(session.getSnapshot().phase, 'unknown');
  session.requestUndo(); await session.flush();
  assert.notEqual(session.getSnapshot().phase, 'cancelled'); assert.equal(session.canLeave(), false);
});

test('malformed commit replies never claim durability', async () => {
  for (const reply of [undefined, {}, { status: 'durable' }, { status: 'durable', receipt: { ...receipt(original), id: 'different' } }]) {
    const repository = createDesktopEditRepository({ accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'test' }, async <T>() => reply as T);
    assert.equal((await repository.commit(original)).status, 'unknown');
  }
});

test('recovered durable operations Undo with an inverse; recovered unknown ones confirm the original first', async () => {
  for (const initial of ['durable', 'unknown'] as const) {
    const requests: EditBatch[] = [];
    const repository = { commit: async (batch: EditBatch): Promise<CommitResult> => { requests.push(batch); return { status: 'durable', receipt: receipt(batch) }; } };
    const session: BatchCommitSession = new BatchCommitSession(repository, { batch: original }, (): { batch: EditBatch } => ({ batch: inverse }), initial);
    session.requestUndo(); await session.flush();
    assert.deepEqual(requests.map(batch => batch.id), initial === 'durable' ? [inverse.id] : [original.id, inverse.id]);
    assert.equal(session.getSnapshot().phase, 'undone');
  }
});

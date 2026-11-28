import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';
import { EditIntentJournal } from '../src/runtime/edits/intentJournal.ts';
import { BatchCommitSession } from '../src/runtime/edits/batchCommitSession.ts';
import { DocumentEditSession } from '../src/features/reader/edit/DocumentEditSession.ts';
import { DocumentEditSessions } from '../src/features/reader/DocumentEditSessions.ts';
import type { EditIntentRecord } from '../src/runtime/edits/contracts.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const scope = { accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'intent' }, target = fixture.document.id;
const records: EditIntentRecord[] = fixture.intents;
async function repository() {
  const value = new DurableEditRepository(scope, new EditMemoryDatabase());
  await value.initialize(fixture.document); return value;
}

test('intent CAS is idempotent, scoped, immutable and monotonic; stale clears cannot erase another tab', async () => {
  const value = await repository();
  assert.deepEqual(await value.replaceIntent(target, records[0], null), { status: 'written' });
  assert.deepEqual(await value.replaceIntent(target, records[0], null), { status: 'written' });
  assert.deepEqual(await value.replaceIntent(target, records[1], null), { status: 'conflict' });
  assert.deepEqual(await value.readIntent(target), records[0]);
  assert.deepEqual(await value.pendingIntents(), [{ targetId: target, record: records[0] }]);
  for (let i = 1; i < records.length; i++) assert.deepEqual(await value.replaceIntent(target, records[i], records[i - 1].id), { status: 'written' });
  assert.deepEqual(await value.replaceIntent(target, null, records[0].id), { status: 'conflict' });
  const rollback = { ...structuredClone(records[0]), id: crypto.randomUUID() };
  await assert.rejects(value.replaceIntent(target, rollback, records[3].id), /intent-history-loss/);
  const reused = structuredClone(records[3]); reused.intent.dispatched = false;
  await assert.rejects(value.replaceIntent(target, reused, records[3].id));
  await assert.rejects(value.replaceIntent(crypto.randomUUID(), records[0], null), /intent-scope/);
  assert.deepEqual(await value.replaceIntent(target, null, records[3].id), { status: 'cleared' });
  assert.deepEqual(await value.replaceIntent(target, null, records[3].id), { status: 'cleared' });
});

test('lost journal responses replay the same mutation before a newer Undo flag or clear', async () => {
  const value = await repository(), writes: (EditIntentRecord | null)[] = [];
  let loseWrite = true, loseClear = true;
  const transport = { ...value, replaceIntent: async (targetId: string, record: EditIntentRecord | null, expected: string | null) => {
    writes.push(structuredClone(record)); const result = await value.replaceIntent(targetId, record, expected);
    if (record && loseWrite) { loseWrite = false; throw new Error('save-response-lost'); }
    if (!record && loseClear) { loseClear = false; throw new Error('clear-response-lost'); }
    return result;
  } };
  const journal = new EditIntentJournal(transport, target);
  await assert.rejects(journal.save(records[1].intent), /save-response-lost/);
  await journal.save(records[2].intent);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal((await value.readIntent(target))!.intent.undoRequested, true);
  await assert.rejects(journal.clear(), /clear-response-lost/);
  await journal.clear(); assert.equal(await value.readIntent(target), undefined);
});

test('journal failure prevents the batch write; another tab cannot overwrite an owned intent', async () => {
  const value = await repository(), first = new EditIntentJournal(value, target), stale = new EditIntentJournal(value, target);
  await Promise.all([first.load(), stale.load()]);
  await first.save(records[0].intent);
  await assert.rejects(stale.save(records[0].intent), /intent-owned/);
  let commits = 0;
  const session = new BatchCommitSession({ commit: async () => { commits++; throw new Error('must not dispatch'); } },
    records[0].intent.request as { batch: typeof fixture.batches[0] }, () => { throw new Error('must not invert'); }, 'new',
    { journal: { save: async () => { throw new Error('quota'); }, clear: async () => undefined } });
  await session.flush(); assert.equal(commits, 0); assert.equal(session.canLeave(), false);
});

test('prepared, uncertain, queued Undo, and inverse-response-loss journals recover through the same document session', async () => {
  for (const record of records) {
    const value = await repository();
    if (record.intent.dispatched) await value.commit(fixture.batches[0], record.intent.request.history);
    if (record.intent.inverse) await value.commit(record.intent.inverse.batch, record.intent.inverse.history);
    await value.replaceIntent(target, record, null);
    const recovered = new DocumentEditSession(value, target); assert.equal(await recovered.refresh(), true);
    assert.equal(recovered.canNavigate(), false);
    assert.equal(recovered.getSnapshot().document!.pages[0].annotations.length, 1);
    await recovered.retry(); assert.equal(recovered.canNavigate(), true);
    assert.equal(recovered.getSnapshot().document!.pages[0].annotations.length, record.intent.undoRequested ? 0 : 1);
    assert.equal(await value.readIntent(target), undefined);
    const state = await value.read(target);
    assert.equal(state.checkpoint.batches.length, record.intent.undoRequested ? 2 : 1);
    if (record.intent.inverse) assert.ok(state.heads.includes(record.intent.inverse.batch.id), 'recovery reused the durable inverse ID');
  }
});

test('Undo of a definitely unstarted recovered intent cancels without creating a batch', async () => {
  const value = await repository(), record = structuredClone(records[0]); record.intent.undoRequested = true;
  await value.replaceIntent(target, record, null);
  const recovered = new DocumentEditSession(value, target); await recovered.refresh(); await recovered.retry();
  assert.equal((await value.read(target)).checkpoint.batches.length, 0);
  assert.equal(recovered.getSnapshot().document!.pages[0].annotations.length, 0);
  assert.equal(await value.readIntent(target), undefined);
});

test('a journal clear failure keeps the transition guard until retry has confirmed the durable cleanup', async () => {
  const value = await repository(); let fail = true;
  const transport = { ...value, replaceIntent: async (targetId: string, record: EditIntentRecord | null, expected: string | null) => {
    if (!record && fail) throw new Error('clear-failed');
    return value.replaceIntent(targetId, record, expected);
  } };
  const session = new DocumentEditSession(transport, target); await session.refresh();
  const token = Symbol(); session.claimPage(fixture.document.pages[0].id, token);
  await session.editPage(fixture.document.pages[0].id, token, fixture.batches[0].changes);
  assert.equal(session.canNavigate(), false); assert.ok(await value.readIntent(target));
  fail = false; await session.retry(); assert.equal(session.canNavigate(), true); assert.equal(await value.readIntent(target), undefined);
});

test('Undo persists while the original response is pending; a recovered session wins without a second inverse', async () => {
  const value = await repository(); let release!: () => void, first = true;
  const transport = { ...value, commit: async (...args: Parameters<typeof value.commit>) => {
    const result = await value.commit(...args);
    if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); }
    return result;
  } };
  const source = new DocumentEditSession(transport, target); await source.refresh();
  const pageId = fixture.document.pages[0].id, token = Symbol(); source.claimPage(pageId, token);
  const saving = source.editPage(pageId, token, fixture.batches[0].changes);
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  const undoing = source.undo();
  while (!(await value.readIntent(target))?.intent.undoRequested) await new Promise(resolve => setTimeout(resolve, 0));
  const restart = new DocumentEditSession(value, target); await restart.refresh(); await restart.retry();
  assert.equal(restart.getSnapshot().document!.pages[0].annotations.length, 0);
  assert.equal((await value.read(target)).checkpoint.batches.length, 2);
  release(); await saving; await undoing;
  assert.equal((await value.read(target)).checkpoint.batches.length, 2, 'the old writer cannot append another inverse after losing journal ownership');
  assert.equal(source.canNavigate(), false); assert.match(source.getSnapshot().error, /intent-owned/);
});

test('scope registry discovers unopened document intents, retains one authority, and rejects stale commands after suspension', async () => {
  const value = await repository(); await value.replaceIntent(target, records[2], null);
  const registry = new DocumentEditSessions(value), session = registry.get(target);
  assert.equal(registry.get(target), session);
  assert.deepEqual(await session.editDocument([]), { status: 'refused', reason: 'session-inactive' });
  await registry.initialize();
  assert.equal(session.getSnapshot().ready, true); assert.equal((await registry.suspend()).status, 'refused');
  await session.retry(); assert.equal((await registry.suspend()).status, 'allowed');
  assert.deepEqual(await session.editDocument([]), { status: 'refused', reason: 'session-inactive' });
  await registry.resume(); assert.deepEqual(await session.editDocument([]), { status: 'unchanged' });
});

test('unhandled feature intents remain visible to the scope guard rather than being silently discarded', async () => {
  const value = await repository();
  await value.replaceIntent(scope.libraryId, { id: crypto.randomUUID(), intent: { request: { publication: fixture.publications[0].value }, dispatched: false, undoRequested: false } }, null);
  const registry = new DocumentEditSessions(value); await registry.initialize();
  assert.deepEqual(registry.getSnapshot().unhandledTargets, [scope.libraryId]);
  assert.equal((await registry.prepareLeave()).status, 'refused');
  assert.equal((await value.pendingIntents()).length, 1);
});

test('scope startup refreshes a previously read document when another tab has since left a recovery intent', async () => {
  const value = await repository(), registry = new DocumentEditSessions(value), session = registry.get(target);
  await session.refresh();
  await value.replaceIntent(target, records[2], null);
  await registry.initialize();
  assert.equal(session.canNavigate(), false); assert.equal(session.getSnapshot().phase, 'unknown');
  assert.equal((await registry.suspend()).status, 'refused');
  await session.retry(); assert.equal((await registry.suspend()).status, 'allowed');
});

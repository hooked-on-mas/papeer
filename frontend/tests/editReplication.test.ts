import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { EditReplication, type EditTransferPort } from '../src/runtime/edits/replication.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';
import { ConflictSession } from '../src/features/reader/ConflictSession.ts';
import type { ContentPublication, EditBatch, EditRecord } from '../src/runtime/edits/contracts.ts';
import type { StoredResource } from '../src/runtime/edits/ports.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const batch = (number: number): EditBatch => fixture.batches.find((batch: EditBatch) => batch.id.endsWith(String(number).padStart(12, '0')));
const scope = { accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'test' };
async function repository() {
  const value = new DurableEditRepository(scope, new EditMemoryDatabase());
  await value.initialize(fixture.document); return value;
}
test('upload response loss retains the outbox; pull/resend is idempotent and import receipts stay separate', async () => {
  const source = await repository(), destination = await repository();
  await source.commit(batch(201));
  const remote = new Map<string, EditRecord>(), imports: { batchId: string; peerId: string }[] = [];
  let loseReply = true;
  const transfer: EditTransferPort = {
    pull: async () => ({ edits: [...remote.values()], imports: [...imports] }),
    upload: async record => { remote.set(record.batch.id, record); if (loseReply) throw new Error('upload-response-lost'); },
    uploadResource: async () => { throw new Error('unexpected resource'); },
    downloadResource: async () => { throw new Error('unexpected resource'); },
    imported: async (batchId, peerId) => { imports.push({ batchId, peerId }); },
  };
  const sender = new EditReplication(source, transfer, 'source'), receiver = new EditReplication(destination, transfer, 'destination');
  await assert.rejects(sender.flush(), /upload-response-lost/);
  assert.equal((await source.pending()).length, 1);
  loseReply = false; await receiver.flush(); await sender.flush();
  assert.equal((await source.pending()).length, 0); assert.equal(remote.size, 1);
  assert.deepEqual((await destination.read(fixture.document.id)).heads, [batch(201).id]);
  assert.ok((await source.receipt(batch(201).id))?.importedBy.includes('destination'));
  const acknowledgements = imports.length; await receiver.flush(); assert.equal(imports.length, acknowledgements, 'do not create another receipt object on every poll');
});
test('logout during pull suspends import/upload while retaining durable pending data', async () => {
  const value = await repository(); await value.commit(batch(201));
  let release!: (value: { edits: EditRecord[]; imports: [] }) => void, uploads = 0;
  let started!: () => void; const pulling = new Promise<void>(resolve => { started = resolve; });
  const sender = new EditReplication(value, { pull: () => new Promise(resolve => { release = resolve; started(); }),
    upload: async () => { uploads++; }, imported: async () => undefined,
    uploadResource: async () => { throw new Error('unexpected resource'); },
    downloadResource: async () => { throw new Error('unexpected resource'); } }, 'peer');
  const first = sender.flush(), second = sender.flush(); assert.equal(first, second);
  await pulling; sender.suspend(); release({ edits: [{ batch: batch(203) }], imports: [] }); await first;
  assert.equal(uploads, 0); assert.equal((await value.pending()).length, 1);
  assert.deepEqual((await value.read(fixture.document.id)).heads, [batch(201).id]);
});
test('conflict checkout/keep does not adopt; a late head rejects adoption until the comparison is refreshed', async () => {
  const value = await repository(); await value.receive([batch(201), batch(202), batch(203), batch(204)]);
  const session = new ConflictSession(value, fixture.document.id, (snapshot, id, parents) => value.commit({
    kind: 'resolution', id, libraryId: value.scope.libraryId, targetId: fixture.document.id,
    parents: [...parents], snapshot: { ...snapshot, version: id },
  })); await session.refresh();
  const compared = session.compare(); session.checkout(batch(202).id); session.keepBoth();
  assert.equal((await value.read(fixture.document.id)).heads.length, 2); session.compare();
  await value.receive([batch(205)]);
  const rejected = await session.adopt(compared[0], crypto.randomUUID());
  assert.equal(rejected.status, 'aborted'); assert.match(session.getSnapshot().error, /heads-changed/);
  await session.refresh(); session.compare();
  assert.equal((await session.adopt(compared[0], crypto.randomUUID())).status, 'durable');
  assert.equal((await value.read(fixture.document.id)).heads.length, 1);
});

test('conflict comparison cannot write without the target authority', async () => {
  const value = await repository(); await value.receive([batch(201), batch(202), batch(203), batch(204)]);
  const session = new ConflictSession(value, fixture.document.id); await session.refresh();
  const compared = session.compare();
  await assert.rejects(() => session.adopt(compared[0], crypto.randomUUID()), /resolution-authority-required/);
  assert.equal((await value.read(fixture.document.id)).heads.length, 2);
});

test('creation transfers verified background before its whole publication; response loss never uploads a metadata-only batch', async () => {
  const inspect = { inspectPdf: async () => fixture.resource.metadata.pdfPages };
  const source = new DurableEditRepository(scope, new EditMemoryDatabase(), inspect), target = new DurableEditRepository(scope, new EditMemoryDatabase(), inspect);
  for (const repository of [source, target]) for (const key of ['document', 'markdown', 'library']) await repository.initialize(fixture[key]);
  const bytes = Uint8Array.from(readFileSync(new URL(`../../tests/fixtures/${fixture.resource.file}`, import.meta.url)));
  await source.storeResource({ id: fixture.resource.metadata.id, sha256: fixture.resource.metadata.sha256, mediaType: 'application/pdf', bytes });
  const publication: ContentPublication = fixture.publications[0].value;
  assert.equal((await source.publish(publication)).status, 'durable');
  const resources = new Map<string, StoredResource>(), publications = new Map<string, EditRecord>(), imports: { batchId: string; peerId: string }[] = [];
  const order: string[] = []; let loseReply = true, downloads = 0;
  const transfer: EditTransferPort = {
    pull: async () => ({ edits: [...publications.values()], imports: [...imports], resources: [...resources.values()].map(resource => resource.metadata) }),
    uploadResource: async resource => { order.push('resource'); resources.set(resource.metadata.id, structuredClone(resource)); },
    upload: async value => {
      assert.deepEqual(value.publication, publication, 'creation must include its complete content bundle');
      order.push('publication'); publications.set(value.batch.id, structuredClone(value)); if (loseReply) throw new Error('response lost');
    },
    downloadResource: async metadata => { downloads++; return structuredClone(resources.get(metadata.id)!); },
    imported: async (batchId, peerId) => { imports.push({ batchId, peerId }); },
  };
  const sender = new EditReplication(source, transfer, 'source'), receiver = new EditReplication(target, transfer, 'target');
  await assert.rejects(sender.flush(), /response lost/);
  assert.deepEqual(order, ['resource', 'publication']);
  assert.equal((await source.pendingPublications()).length, 1);
  await receiver.flush();
  assert.deepEqual((await target.read(publication.content!.id)).checkpoint.root, publication.content);
  assert.deepEqual((await target.read(scope.libraryId)).heads, [publication.libraryBatch.id]);
  assert.equal(downloads, 1);
  loseReply = false; await sender.flush(); await receiver.flush();
  assert.deepEqual(await source.pendingPublications(), []);
  assert.equal(downloads, 1, 'polls must not download and parse a durable PDF again');
  assert.ok((await source.receipt(publication.libraryBatch.id))?.importedBy.includes('target'));
});

test('failed/corrupt background import exposes no new item and can retry without a partial publication', async () => {
  const target = new DurableEditRepository(scope, new EditMemoryDatabase(), { inspectPdf: async () => fixture.resource.metadata.pdfPages });
  for (const key of ['document', 'markdown', 'library']) await target.initialize(fixture[key]);
  let corrupt = true;
  const bytes = Uint8Array.from(readFileSync(new URL(`../../tests/fixtures/${fixture.resource.file}`, import.meta.url)));
  const publication: ContentPublication = fixture.publications[0].value;
  const receiver = new EditReplication(target, {
    pull: async () => ({ edits: [{ batch: publication.libraryBatch, publication }], imports: [], resources: [fixture.resource.metadata] }),
    downloadResource: async () => ({ metadata: fixture.resource.metadata, bytes: corrupt ? Uint8Array.of(1) : bytes }),
    imported: async () => undefined, upload: async () => undefined, uploadResource: async () => undefined,
  }, 'target');
  await assert.rejects(receiver.flush(), /resource-hash/);
  await assert.rejects(target.read(publication.content!.id), /missing-target/);
  assert.deepEqual((await target.read(scope.libraryId)).heads, [fixture.library.version]);
  assert.equal(await target.receipt(publication.libraryBatch.id), undefined);
  corrupt = false; await receiver.flush();
  assert.deepEqual((await target.read(scope.libraryId)).heads, [publication.libraryBatch.id]);
});


test('cold duplicate import receipts and uncertain outcomes use durable state', async () => {
  for (const loss of ['none', 'before', 'after'] as const) {
    const value = await repository(); await value.commit(batch(201)); await value.acknowledgeImport(batch(201).id, 'known');
    const original = value.acknowledgeImport; const writes: string[] = []; const acknowledgements: string[][] = []; let fail = loss !== 'none';
    value.acknowledgeImport = async (id, peer) => {
      writes.push(peer); if (fail) { fail = false; if (loss === 'after') await original(id, peer); throw new Error('ack-outcome-unknown'); }
      await original(id, peer);
    };
    const transfer: EditTransferPort = {
      pull: async () => ({ edits: [], imports: [
        { batchId: batch(201).id, peerId: 'known' }, { batchId: batch(201).id, peerId: 'new' },
        { batchId: batch(202).id, peerId: 'missing' },
      ] }),
      acknowledgePull: async (_batches, receipts) => { acknowledgements.push(receipts); },
      upload: async () => undefined, imported: async () => undefined,
      uploadResource: async () => { throw new Error('unexpected resource'); },
      downloadResource: async () => { throw new Error('unexpected resource'); },
    };
    if (loss !== 'none') {
      await assert.rejects(new EditReplication(value, transfer, 'local').flush(), /ack-outcome-unknown/);
      assert.deepEqual(acknowledgements, []);
    }
    await new EditReplication(value, transfer, 'local').flush();
    assert.deepEqual(writes, loss === 'before' ? ['new', 'new'] : ['new']);
    assert.deepEqual((await value.receipt(batch(201).id))?.importedBy, ['known', 'new']);
    assert.deepEqual(acknowledgements, [[batch(201).id + ':known', batch(201).id + ':new']]);
    assert.equal(await value.receipt(batch(202).id), undefined);
    await new EditReplication(value, transfer, 'local').flush();
    assert.equal(writes.length, loss === 'before' ? 2 : 1);
    assert.deepEqual(acknowledgements[1], acknowledgements[0]);
  }
});

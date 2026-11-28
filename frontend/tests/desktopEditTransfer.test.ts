import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createDesktopEditTransfer } from '../src/adapters/desktop/editTransfer.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { EditReplication } from '../src/runtime/edits/replication.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';
import type { ContentPublication } from '../src/runtime/edits/contracts.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const bytes = Uint8Array.from(readFileSync(new URL(`../../tests/fixtures/${fixture.resource.file}`, import.meta.url)));

test('desktop transport uses the common publication/resource/receipt sender and preserves lost-response retries', async () => {
  const scope = { accountId: 'native', libraryId: fixture.libraryId, epoch: 'new' };
  const objects = new Map<string, unknown>(), calls: string[] = [];
  let bodyBase64 = '', loseResponse = true;
  const request = async <T>(path: string, raw: unknown): Promise<T> => {
    const body = raw as { scope: typeof scope; folderId: string; metadata: unknown; dataBase64: string; fileId: string; editId: string; value: { kind: string } };
    assert.deepEqual(body.scope, scope); assert.equal(body.folderId, 'folder');
    calls.push(path);
    let reply: unknown;
    switch (path) {
      case '/api/edits/drive/check-lease': break;
      case '/api/edits/drive/lease': reply = { leaseId: 'fixture-lease' }; break;
      case '/api/edits/drive/files': reply = [...objects.keys()].map(id => ({ id })); break;
      case '/api/edits/drive/read-json': reply = structuredClone(objects.get(body.fileId)); break;
      case '/api/edits/drive/read-resource': reply = { dataBase64: bodyBase64 }; break;
      case '/api/edits/drive/save-resource':
        bodyBase64 = body.dataBase64;
        objects.set('resource', { kind: 'resource', metadata: body.metadata, blobId: 'binary' });
        break;
      case '/api/edits/drive/save-json':
        objects.set(body.editId, structuredClone(body.value));
        if (loseResponse && body.value.kind === 'edit-record') throw new Error('response-lost');
        break;
      default: assert.fail('unexpected endpoint: ' + path);
    }
    return reply as T;
  };
  const source = new DurableEditRepository(scope, new EditMemoryDatabase(), { inspectPdf: async () => fixture.resource.metadata.pdfPages });
  const target = new DurableEditRepository(scope, new EditMemoryDatabase(), { inspectPdf: async () => fixture.resource.metadata.pdfPages });
  for (const repository of [source, target]) for (const key of ['document', 'markdown', 'library']) await repository.initialize(fixture[key]);
  const publication: ContentPublication = fixture.publications[0].value;
  await source.storeResource({ ...fixture.resource.metadata, bytes });
  assert.equal((await source.publish(publication)).status, 'durable');
  const first = new EditReplication(source, createDesktopEditTransfer(scope, 'folder', request), crypto.randomUUID());
  const second = new EditReplication(target, createDesktopEditTransfer(scope, 'folder', request), crypto.randomUUID());
  await assert.rejects(first.flush(), /response-lost/);
  assert.equal((await source.pendingPublications()).length, 1);
  assert.ok(calls.indexOf('/api/edits/drive/save-resource') < calls.indexOf('/api/edits/drive/save-json'));
  loseResponse = false;
  await second.flush(); await first.flush();
  assert.deepEqual((await target.read(publication.content!.id)).checkpoint.root, publication.content);
  assert.deepEqual((await target.readResource(fixture.resource.metadata.id))?.bytes, bytes);
  assert.deepEqual(await source.pendingPublications(), []);
  assert.equal(objects.size, 4, 'one resource, one publication, and one import receipt per peer');
  const reads = calls.filter(path => path.endsWith('/read-resource')).length;
  await second.flush();
  assert.equal(calls.filter(path => path.endsWith('/read-resource')).length, reads);
});

test('desktop resource reads reject a damaged native reply before exposing bytes', async () => {
  const transfer = createDesktopEditTransfer({ accountId: 'test', libraryId: fixture.libraryId, epoch: 'new' }, 'folder',
    async <T>(path: string): Promise<T> => {
      const value = path.endsWith('/lease') ? { leaseId: 'fixture-lease' } : path.endsWith('/files') ? [{ id: 'descriptor' }] : path.endsWith('/read-json')
        ? { kind: 'resource', metadata: fixture.resource.metadata, blobId: 'body' } : { dataBase64: btoa('wrong') };
      return value as T;
    });
  const result = await transfer.pull();
  await assert.rejects(transfer.downloadResource(result.resources![0]), /resource-hash/);
});

test('an unavailable initial identity lookup can retry, but an acquired lease never silently rebinds', async () => {
  let acquire = 0, changed = false;
  const transfer = createDesktopEditTransfer({ accountId: 'A', libraryId: fixture.libraryId, epoch: 'new' }, 'folder',
    async <T>(path: string, raw: unknown): Promise<T> => {
      if (path.endsWith('/lease')) {
        if (++acquire === 1) throw new Error('temporary-network');
        return { leaseId: 'A-generation-1' } as T;
      }
      assert.equal((raw as { leaseId: string }).leaseId, 'A-generation-1');
      if (changed) throw new Error('drive-auth-changed');
      return (path.endsWith('/files') ? [] : undefined) as T;
    });
  await assert.rejects(transfer.pull(), /temporary-network/);
  await transfer.pull();
  changed = true;
  await assert.rejects(transfer.pull(), /auth-changed/);
  await assert.rejects(transfer.pull(), /auth-changed/);
  assert.equal(acquire, 2);
});

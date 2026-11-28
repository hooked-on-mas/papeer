import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DriveSession } from '../src/web/drive.ts';
import { createDriveEditTransfer } from '../src/adapters/drive/editTransfer.ts';
import { DurableEditRepository, scopeKey } from '../src/runtime/edits/repository.ts';
import { resourceHash } from '../src/runtime/edits/contentPublication.ts';
import { EditReplication } from '../src/runtime/edits/replication.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const bytes = Uint8Array.from(readFileSync(new URL(`../../tests/fixtures/${fixture.resource.file}`, import.meta.url)));

test('Drive binary resource framing, immutable publication, retry, deduplication and scope are used by the shared sender', async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), originalFetch = globalThis.fetch;
  const scope = { accountId: 'fixture-account', libraryId: fixture.libraryId, epoch: 'new-dataset' };
  const namespace = await resourceHash(new TextEncoder().encode(scopeKey(scope)));
  const files = new Map<string, { metadata: { properties: Record<string, string>; [key: string]: unknown }; bytes: Buffer }>();
  let loseReply = true, binaryDownloads = 0;
  const uploads: string[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    google: { accounts: { oauth2: { initTokenClient: (options: { callback: (value: object) => void }) => ({
      requestAccessToken: () => options.callback({ access_token: 'fixture-token', expires_in: 100 }),
    }) } } },
  } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-token');
    assert.equal(url.href.includes('fixture-token'), false);
    if (init?.method === 'POST') {
      assert.equal(url.pathname, '/upload/drive/v3/files');
      const boundary = new Headers(init.headers).get('Content-Type')!.split('boundary=')[1];
      const raw = init.body instanceof Blob ? Buffer.from(await init.body.arrayBuffer()) : Buffer.from(String(init.body));
      const parts = raw.toString('latin1').split('--' + boundary);
      const payload = (part: string) => Buffer.from(part.slice(part.indexOf('\r\n\r\n') + 4, -2), 'latin1');
      const metadata = JSON.parse(payload(parts[1]).toString('utf8'));
      const data = payload(parts[2]);
      assert.deepEqual(metadata.parents, ['folder']);
      assert.equal(metadata.properties.scope, namespace);
      const id = 'file-' + files.size;
      files.set(id, { metadata, bytes: data });
      if (metadata.properties.papeer === 'edits-resource-v1') uploads.push('resource');
      else {
        const value = JSON.parse(data.toString('utf8')); uploads.push(value.kind);
        if (value.kind === 'edit-record' && loseReply) return new Response('', { status: 503 });
      }
      return Response.json({ id });
    }
    if (url.pathname === '/drive/v3/about') return Response.json({ user: { permissionId: scope.accountId } });
    assert.ok(url.pathname.startsWith('/drive/v3/files'));
    if (url.pathname === '/drive/v3/files') {
      const query = url.searchParams.get('q')!;
      assert.ok(query.includes(`key='scope' and value='${namespace}'`));
      const type = query.includes("value='edits-resource-v1'") ? 'edits-resource-v1' : 'edits-v1';
      const result = [...files].filter(([, value]) => value.metadata.properties.papeer === type)
        .map(([id, value]) => ({ id, size: String(value.bytes.byteLength), version: '1', properties: value.metadata.properties }));
      return Response.json({ files: result.reverse() }); // Duplicate Drive names have no reliable list order.
    }
    const file = files.get(url.pathname.split('/').pop()!); assert.ok(file);
    if (url.searchParams.has('fields')) return Response.json({ size: String(file.bytes.byteLength), properties: file.metadata.properties });
    assert.equal(url.searchParams.get('alt'), 'media');
    if (file.metadata.properties.papeer === 'edits-resource-v1') binaryDownloads++;
    return new Response(Uint8Array.from(file.bytes));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  });
  const session = new DriveSession(); await session.signIn();
  const inspect = { inspectPdf: async () => fixture.resource.metadata.pdfPages };
  const source = new DurableEditRepository(scope, new EditMemoryDatabase(), inspect), target = new DurableEditRepository(scope, new EditMemoryDatabase(), inspect);
  for (const repository of [source, target]) for (const key of ['document', 'markdown', 'library']) await repository.initialize(fixture[key]);
  await source.storeResource({ id: fixture.resource.metadata.id, sha256: fixture.resource.metadata.sha256, mediaType: 'application/pdf', bytes });
  const publication = fixture.publications[0].value;
  assert.equal((await source.publish(publication)).status, 'durable');
  const sourceTransfer = createDriveEditTransfer(session, scope, 'folder'), targetTransfer = createDriveEditTransfer(session, scope, 'folder');
  const sender = new EditReplication(source, sourceTransfer, crypto.randomUUID()), receiver = new EditReplication(target, targetTransfer, crypto.randomUUID());
  await assert.rejects(sender.flush(), /503/);
  assert.deepEqual(uploads, ['resource', 'resource', 'edit-record']);
  assert.equal((await source.pendingPublications()).length, 1);
  await receiver.flush();
  assert.deepEqual((await target.read(publication.content.id)).checkpoint.root, publication.content);
  assert.deepEqual((await target.readResource(fixture.resource.metadata.id))?.bytes, bytes);
  const downloads = binaryDownloads;
  await receiver.flush(); assert.equal(binaryDownloads, downloads, 'a poll must not redownload a durable background');
  loseReply = false; await sender.flush();
  assert.deepEqual(await source.pendingPublications(), []);
  assert.equal([...files.values()].filter(file => file.metadata.properties.papeer === 'edits-resource-v1').length, 1);
  const corrupt = [...files.values()].find(file => file.metadata.properties.papeer === 'edits-resource-v1')!;
  corrupt.bytes[0] ^= 1;
  const inputResource = (await source.readResource(fixture.resource.metadata.id))!;
  await sourceTransfer.uploadResource(inputResource); // Verify and replace a damaged immutable body without deleting it.
  assert.equal([...files.values()].filter(file => file.metadata.properties.papeer === 'edits-resource-v1').length, 2);
  const pulled = await targetTransfer.pull();
  assert.deepEqual((await targetTransfer.downloadResource(pulled.resources![0])).bytes, bytes);
  const requestsBefore = files.size;
  const otherLibrary = crypto.randomUUID();
  await assert.rejects(sourceTransfer.upload({ batch: { ...publication.libraryBatch, libraryId: otherLibrary, targetId: otherLibrary } }), /batch-scope/);
  assert.equal(files.size, requestsBefore);
  for (const file of files.values()) if (file.metadata.properties.papeer === 'edits-resource-v1') file.metadata.properties.scope = 'a'.repeat(64);
  await assert.rejects(targetTransfer.downloadResource(pulled.resources![0]), /resource-scope-or-version/);
  session.signOut(); await assert.rejects(targetTransfer.pull(), /ログイン/);
});

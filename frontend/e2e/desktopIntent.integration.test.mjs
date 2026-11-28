import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createDesktopEditRepository } from '../src/adapters/desktop/editRepository.ts';
import { DocumentEditSession } from '../src/features/reader/edit/DocumentEditSession.ts';
import { DocumentEditSessions } from '../src/features/reader/DocumentEditSessions.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { EditReplication } from '../src/runtime/edits/replication.ts';
import { createDriveEditTransfer } from '../src/adapters/drive/editTransfer.ts';
import { EditMemoryDatabase } from '../tests/support/editMemoryDatabase.ts';
import { prepareDatasetPublication, publishDataset, importPublishedDataset } from '../src/runtime/edits/datasetPublication.ts';
import { DatasetTransitionSession, activeDatasetScope } from '../src/runtime/edits/DatasetTransitionSession.ts';
import { convertLegacyAnnotationsPage } from '../src/migrations/legacyAnnotations.ts';
import { legacyInkFixture } from '../tests/support/legacyInkFixture.ts';
import { legacyBookmarkFixture } from '../tests/support/legacyBookmarkFixture.ts';
import { migrationStableId } from '../src/migrations/stableId.ts';
import { createDesktopLegacyBackup } from '../src/adapters/desktop/legacyBackup.ts';
import { captureLegacyBackup, readLegacyBackupEntry } from '../src/migrations/legacyBackup.ts';
import { createLegacyDriveBackup, legacyDriveBackupSource } from '../src/migrations/legacyDrive.ts';
import { createDesktopLegacyDriveRead } from '../src/adapters/desktop/legacyDrive.ts';
import { createDesktopLegacyBackupStore } from '../src/adapters/desktop/legacyBackupStore.ts';
import { createDesktopLegacyInputs } from '../src/adapters/desktop/legacyInputs.ts';
import { prepareMigrationInputs, captureMigrationInputs } from '../src/migrations/legacyInputs.ts';

test('multi-source migration plans cross real native HTTP, survive reply loss/restart and retain partial backup without accepting late device state', { timeout: 90_000 }, async t => {
  assert.equal(python.status, 0, python.stderr);
  const directory = await mkdtemp(path.join(tmpdir(), 'papeer-intent-http-')); let server;
  t.after(async () => {
    if (server) await stop(server.child);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('papeer-intent-http-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const library = path.join(directory, 'legacy-library'), device = path.join(directory, 'device'), token = crypto.randomUUID(), database = path.join(library, 'library.sqlite3');
  await mkdir(library); await mkdir(device); await writeFile(database, 'raw library SQL'); await writeFile(path.join(device, 'device-settings.json'), '{raw device settings');
  server = await serve(database, token, true, undefined, device);
  const request = (endpoint, body) => server.request(endpoint, body), peerId = crypto.randomUUID(), runId = crypto.randomUUID();
  await request('/api/edits/legacy-startup/hold', { hold: { version: 1, runId } });
  const ports = ['device', 'legacy'].map(area => createDesktopLegacyBackup(request, area));
  const sources = await Promise.all(ports.map(async port => (await port.inventory(crypto.randomUUID())).manifest.source));
  const catalog = { version: 1, runId, identity: { accountId: 'fixture', libraryId: fixture.libraryId }, peers: [{ id: peerId, sources }] };
  const found = ports.map((port, index) => ({ peerId, source: sources[index], port })), discover = async () => found;
  const store = createDesktopLegacyInputs(request);
  let lost = true;
  const uncertain = createDesktopLegacyInputs(async (endpoint, body) => {
    const result = await request(endpoint, body);
    if (endpoint.endsWith('/legacy-inputs/prepare') && lost) { lost = false; throw new Error('input-set-reply-lost'); } return result;
  });
  await assert.rejects(prepareMigrationInputs(catalog, discover, uncertain), /reply-lost/);
  const fixed = await store.inputs(runId); assert.ok(fixed);
  await stop(server.child); server = await serve(database, token, true, undefined, device);
  assert.deepEqual(await prepareMigrationInputs(catalog, discover, store, () => assert.fail('changed fixed backup IDs')), fixed);
  const capture = ports[1].capture; ports[1].capture = async () => { throw new Error('capture-disconnected'); };
  await assert.rejects(captureMigrationInputs(fixed, discover, store), /disconnected/);
  assert.deepEqual(await ports[0].load(fixed.inputs[0].plan.manifest.id), fixed.inputs[0].plan.manifest);
  assert.equal(await ports[1].load(fixed.inputs[1].plan.manifest.id), undefined);
  ports[1].capture = capture;
  await stop(server.child); server = await serve(database, token, true, undefined, device);
  await captureMigrationInputs(fixed, discover, store);
  await writeFile(path.join(device, 'device-settings.json'), 'late settings');
  await assert.rejects(captureMigrationInputs(fixed, discover, store), /source-changed/);
  await assert.rejects(captureMigrationInputs(fixed, async () => found.slice(0, 1), store), /coverage/);
  assert.deepEqual(await store.inputs(runId), fixed);
  assert.equal(readFileSync(database, 'utf8'), 'raw library SQL');
  assert.deepEqual((await readdir(library)).sort(), ['library.sqlite3']);
});

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/shared-edits.json'), 'utf8'));
const python = spawnSync('uv', ['run', 'python', '-c', 'import sys; print(sys.executable)'], { cwd: root, encoding: 'utf8', windowsHide: true });

test('durable native startup admission survives process restart and refuses old Library before recovery while raw backup remains available', { timeout: 90_000 }, async t => {
  assert.equal(python.status, 0, python.stderr);
  const directory = await mkdtemp(path.join(tmpdir(), 'papeer-intent-http-')); let server;
  t.after(async () => {
    if (server) await stop(server.child);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('papeer-intent-http-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const library = path.join(directory, 'legacy-library'), database = path.join(library, 'library.sqlite3'), token = crypto.randomUUID();
  await mkdir(library); await writeFile(database, 'raw DB: SQL must not open'); await writeFile(path.join(library, '.notebook-change.json'), 'pending source journal');
  server = await serve(database, token, true);
  const hold = { version: 1, runId: crypto.randomUUID() };
  assert.equal(await server.request('/api/edits/legacy-startup/read', {}), null);
  assert.deepEqual(await server.request('/api/edits/legacy-startup/hold', { hold }), hold);
  await stop(server.child); server = await serve(database, token, true);
  assert.deepEqual(await server.request('/api/edits/legacy-startup/read', {}), hold);
  assert.deepEqual((await readdir(library)).sort(), ['.notebook-change.json', 'library.sqlite3']);
  const blocked = await fetch(`http://127.0.0.1:${server.port}/api/papers`, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, 'legacy_migration_required');
  const settings = await fetch(`http://127.0.0.1:${server.port}/api/settings`, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(settings.status, 409, 'held settings must not run device/library migrations behind the Library guard');
  const backup = createDesktopLegacyBackup(server.request), plan = await backup.inventory(crypto.randomUUID());
  await captureLegacyBackup(backup, plan);
  assert.deepEqual(await readLegacyBackupEntry(backup, plan.manifest, ['library.sqlite3']), new TextEncoder().encode('raw DB: SQL must not open'));
  assert.equal(readFileSync(path.join(library, '.notebook-change.json'), 'utf8'), 'pending source journal');
  await assert.rejects(server.request('/api/edits/legacy-startup/hold', { hold: { ...hold, runId: crypto.randomUUID() } }), /409/);
  assert.deepEqual(await server.request('/api/edits/legacy-startup/read', {}), hold);
});

test('device input crosses the shared desktop backup port, retains raw state at response loss/restart and ignores credentials', { timeout: 90_000 }, async t => {
  assert.equal(python.status, 0, python.stderr);
  const directory = await mkdtemp(path.join(tmpdir(), 'papeer-intent-http-')); let server;
  t.after(async () => {
    if (server) await stop(server.child);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('papeer-intent-http-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const library = path.join(directory, 'legacy-library'), device = path.join(directory, 'device'), database = path.join(library, 'library.sqlite3'), token = crypto.randomUUID();
  await mkdir(library); await mkdir(device); await writeFile(database, 'legacy SQL must not open');
  const derived = spawnSync(python.stdout.trim(), ['-c', 'from pathlib import Path; from papeer.core.paths import library_key; import sys; print(library_key(Path(sys.argv[1])))', library], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(derived.status, 0, derived.stderr); const key = derived.stdout.trim();
  const expected = { 'device-settings.json': '{bad raw settings', [key + '.cloud-drive.json']: '{"manifest_id":"legacy-manifest"}',
    [key + '.future-record']: 'unknown keyed state', ['.' + key + '.json.pending.tmp']: 'interrupted device write' };
  for (const [name, value] of Object.entries(expected)) await writeFile(path.join(device, name), value);
  await writeFile(path.join(device, 'google-drive-credentials.dpapi'), 'must not copy credential');
  server = await serve(database, token, true, undefined, device);
  const request = (endpoint, body) => server.request(endpoint, body);
  const port = createDesktopLegacyBackup(request, 'device'), plan = await port.inventory(crypto.randomUUID());
  assert.equal(plan.manifest.source.kind, 'desktop-device');
  assert.deepEqual(plan.manifest.entries.map(entry => entry.key.join('/')).sort(), Object.keys(expected).sort());
  const uncertain = createDesktopLegacyBackup(async (endpoint, body) => {
    const result = await request(endpoint, body); if (endpoint.endsWith('/capture')) throw new Error('device-backup-response-lost'); return result;
  }, 'device');
  await assert.rejects(captureLegacyBackup(uncertain, plan), /device-backup-response-lost/);
  await stop(server.child); server = await serve(database, token, true, undefined, device);
  assert.deepEqual(await port.plan(plan.manifest.id), plan); assert.deepEqual(await port.load(plan.manifest.id), plan.manifest);
  for (const [name, value] of Object.entries(expected)) assert.deepEqual(await readLegacyBackupEntry(port, plan.manifest, [name]), new TextEncoder().encode(value));
  await writeFile(path.join(device, 'google-drive-credentials.dpapi'), 'rotated credential'); await port.assertCurrent(plan);
  await writeFile(path.join(device, key + '.late-record'), 'late durable state');
  await assert.rejects(port.assertCurrent(plan), /backup-source-changed/); assert.deepEqual(await port.load(plan.manifest.id), plan.manifest);
  assert.equal(readFileSync(database, 'utf8'), 'legacy SQL must not open');
});

test('shared raw Drive collector crosses native HTTP/files, retains a fixed plan and recovers publication response loss after process restart', { timeout: 90_000 }, async t => {
  assert.equal(python.status, 0, python.stderr);
  const directory = await mkdtemp(path.join(tmpdir(), 'papeer-intent-http-')); let server;
  t.after(async () => {
    if (server) await stop(server.child);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('papeer-intent-http-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const fixture = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/shared-legacy-drive.json'), 'utf8'));
  const input = path.join(directory, 'drive-source.json'), database = path.join(directory, 'legacy-library/library.sqlite3'), token = crypto.randomUUID();
  await mkdir(path.dirname(database)); await writeFile(database, 'legacy database must never open'); await writeFile(input, JSON.stringify(fixture));
  server = await serve(database, token, true, input);
  const request = (endpoint, body) => server.request(endpoint, body), source = await legacyDriveBackupSource(fixture.identity);
  const store = createDesktopLegacyBackupStore(source, request), io = createDesktopLegacyDriveRead(request);
  let writes = 0;
  const failing = { ...store, putObject: async (entry, bytes) => { if (++writes === 2) throw new Error('artifact-storage-failed'); await store.putObject(entry, bytes); } };
  const port = await createLegacyDriveBackup(fixture.identity, io, failing), plan = await port.inventory(crypto.randomUUID());
  await assert.rejects(captureLegacyBackup(port, plan), /artifact-storage-failed/);
  assert.deepEqual(await port.plan(plan.manifest.id), plan); assert.equal(await port.load(plan.manifest.id), undefined);
  await stop(server.child); server = await serve(database, token, true, input);
  const uncertain = { ...store, publish: async manifest => { await store.publish(manifest); throw new Error('publication-response-lost'); } };
  const lost = await createLegacyDriveBackup(fixture.identity, io, uncertain);
  await assert.rejects(captureLegacyBackup(lost, plan), /publication-response-lost/);
  await stop(server.child); server = await serve(database, token, true, input);
  const recovered = await createLegacyDriveBackup(fixture.identity, io, store);
  const manifest = await captureLegacyBackup(recovered, plan); assert.deepEqual(manifest, plan.manifest);
  for (const [id, object] of Object.entries(fixture.objects)) {
    if (fixture.excluded.includes(id)) { assert.equal(manifest.entries.some(entry => entry.key[1] === id), false); continue; }
    const metadata = JSON.parse(new TextDecoder().decode(await readLegacyBackupEntry(recovered, manifest, ['metadata', id])));
    assert.equal(metadata.version, '9007199254740993');
    if (object.dataBase64 !== null) assert.deepEqual(await readLegacyBackupEntry(recovered, manifest, ['bodies', id]), Uint8Array.from(Buffer.from(object.dataBase64, 'base64')));
  }
  await recovered.assertCurrent(plan);
  await stop(server.child);
  await writeFile(input, JSON.stringify({ identity: { ...fixture.identity, accountId: 'another-account' }, objects: {} }));
  server = await serve(database, token, true, input);
  assert.deepEqual(await recovered.load(manifest.id), manifest, 'completed local input survives loss of access to the original Drive');
  await assert.rejects(recovered.assertCurrent(plan), /backup-drive-account/);
  assert.equal(readFileSync(database, 'utf8'), 'legacy database must never open');
});

test('raw legacy backup and annotation conversion cross the native API/SQLite and remain recoverable after restart', { timeout: 90_000 }, async t => {
  assert.equal(python.status, 0, python.stderr);
  const directory = await mkdtemp(path.join(tmpdir(), 'papeer-intent-http-')); let server;
  t.after(async () => {
    if (server) await stop(server.child);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('papeer-intent-http-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const scope = { accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'legacy-ink' };
  const token = crypto.randomUUID(), legacy = path.join(directory, 'legacy-library'), database = path.join(legacy, 'library.sqlite3'), document = structuredClone(fixture.document);
  const native = (mode, input) => {
    const result = spawnSync(python.stdout.trim(), ['frontend/e2e/fixtures/legacyAnnotations.py', mode, legacy, ...(input ? [input] : [])], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const initial = native('create'), input = path.join(directory, 'legacy-annotations.json');
  await writeFile(input, JSON.stringify(initial.pages.map((page, index) => ({ ink: legacyInkFixture(page.widthPt, page.heightPt), bookmarks: legacyBookmarkFixture(initial.paperId, index + 1) }))));
  const source = native('populate', input);
  assert.equal(source.pages[0].bookmarks[0].rects, '[]', 'convert raw SQLite JSON columns, not a hand-built API projection');
  assert.ok(source.pages[1].bookmarks.some(row => row.id === '9223372036854775807'));
  server = await serve(database, token, true);
  const backup = createDesktopLegacyBackup((endpoint, body) => server.request(endpoint, body)), backupPlan = await backup.inventory(crypto.randomUUID());
  let replyLost = false;
  const uncertainBackup = createDesktopLegacyBackup(async (endpoint, body) => {
    const result = await server.request(endpoint, body);
    if (endpoint.endsWith('/legacy-backup/capture') && !replyLost) { replyLost = true; throw new Error('backup-response-lost'); }
    return result;
  });
  await assert.rejects(captureLegacyBackup(uncertainBackup, backupPlan), /backup-response-lost/);
  assert.deepEqual(await backup.plan(backupPlan.manifest.id), backupPlan);
  assert.deepEqual(await backup.load(backupPlan.manifest.id), backupPlan.manifest);
  await captureLegacyBackup(backup, backupPlan);
  assert.deepEqual(await readLegacyBackupEntry(backup, backupPlan.manifest, ['papers', source.paperId, 'notebook.json']),
    Uint8Array.from(readFileSync(path.join(legacy, 'papers', source.paperId, 'notebook.json'))));
  await backup.assertCurrent(backupPlan);
  const archived = native('backup-read', backupPlan.manifest.id);
  assert.deepEqual(archived, source, 'conversion reads verified backup input, without initializing or recovering the original Library');
  for (const [index, oldPage] of archived.pages.entries()) {
    const page = { ...document.pages[index], widthPt: oldPage.widthPt, heightPt: oldPage.heightPt,
      id: await migrationStableId(scope.libraryId, 'page', [archived.paperId, 'original', oldPage.sourcePageId]),
      background: { kind: 'paper', spec: { template: oldPage.spec.template, color: oldPage.spec.color } } };
    const result = await convertLegacyAnnotationsPage(page, oldPage.ink, oldPage.bookmarks, { libraryId: scope.libraryId, documentId: document.id,
      sourceDocumentId: archived.paperId, side: 'original', sourcePageId: oldPage.sourcePageId, sourcePageNumber: index + 1, sourceRevision: null });
    assert.equal(result.status, 'converted', JSON.stringify(result)); document.pages[index] = result.page;
  }
  await backup.assertCurrent(backupPlan);
  let repository = createDesktopEditRepository(scope, server.request); await repository.initialize(document);
  await stop(server.child); server = await serve(database, token, true);
  repository = createDesktopEditRepository(scope, server.request);
  const session = new DocumentEditSession(repository, document.id); await session.refresh();
  assert.deepEqual(session.getSnapshot().document, document, 'native acceptance must not coerce/drop geometry or preferred head length');
  const page = document.pages[1], owner = Symbol(); session.claimPage(page.id, owner);
  await session.editPage(page.id, owner, [{ type: 'delete', id: page.annotations[page.annotations.length - 1].id }]);
  assert.equal(session.getSnapshot().document.pages[1].annotations.length, page.annotations.length - 1);
  await session.undo(); assert.deepEqual(session.getSnapshot().document.pages[1].annotations, page.annotations);
  await stop(server.child); server = await serve(database, token, true);
  const recovered = new DocumentEditSession(createDesktopEditRepository(scope, server.request), document.id); await recovered.refresh();
  assert.equal(recovered.getSnapshot().canRedo, true); await recovered.redo();
  assert.equal(recovered.getSnapshot().document.pages[1].annotations.length, page.annotations.length - 1);
  assert.deepEqual(recovered.getSnapshot().document.pages[0].annotations, document.pages[0].annotations);
  assert.deepEqual(await backup.load(backupPlan.manifest.id), backupPlan.manifest, 'new tables cannot replace the captured raw backup');
  await backup.assertCurrent(backupPlan); // Target staging now writes a separate native DB.
  const after = await backup.inventory(crypto.randomUUID()); await captureLegacyBackup(backup, after);
  assert.equal(native('backup-read', after.manifest.id).sourceFingerprint, source.sourceFingerprint, 'conversion and canonical saves must preserve every legacy row and file');
  await backup.assertCurrent(backupPlan);
});

for (const phase of ['prepared', 'published', 'activated']) {
test(`dataset control survives native ${phase} response loss/process restart, copies outbox and quarantines rollback`, { timeout: 90_000 }, async t => {
  assert.equal(python.status, 0, python.stderr);
  const directory = await mkdtemp(path.join(tmpdir(), 'papeer-intent-http-')); let server;
  t.after(async () => {
    if (server) await stop(server.child);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('papeer-intent-http-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const token = crypto.randomUUID(), database = path.join(directory, 'library.sqlite3');
  const scope = { ...fixture.datasetManifest.scope, epoch: 'source' }, targetScope = { ...scope, epoch: 'target' };
  const objects = new Map(), bodies = new Map(), events = [];
  const storage = {
    async bindAccount() { return this; }, assertCurrent() {},
    sharedEditFiles: async ns => [...(objects.get(ns)?.keys() ?? [])].map(id => ({ id: ns + id })),
    annotation: async id => structuredClone(objects.get(id.slice(0, 64)).get(id.slice(64))),
    saveSharedEdit: async (ns, _folder, id, value) => {
      if (!objects.has(ns)) objects.set(ns, new Map());
      const values = objects.get(ns); if (values.has(id)) assert.deepEqual(values.get(id), value);
      values.set(id, structuredClone(value)); events.push(value.kind);
    },
    saveSharedResource: async (ns, _folder, resource) => {
      bodies.set(ns + resource.metadata.id, structuredClone(resource));
      if (!objects.has(ns)) objects.set(ns, new Map());
      objects.get(ns).set(resource.metadata.id, { kind: 'resource', metadata: resource.metadata, blobId: ns + resource.metadata.id });
    },
    sharedResource: async (ns, metadata) => structuredClone(bodies.get(ns + metadata.id).bytes),
  };
  const transfer = at => createDriveEditTransfer(storage, at, 'folder');
  const input = { ...fixture.resource.metadata, bytes: Uint8Array.from(readFileSync(path.join(root, 'tests/fixtures', fixture.resource.file))) };
  server = await serve(database, token);
  let source = createDesktopEditRepository(scope, server.request), target = createDesktopEditRepository(targetScope, server.request);
  await source.storeResource(input); await source.installCheckpoint(fixture.checkpoint);
  const sourcePlan = await prepareDatasetPublication(source, crypto.randomUUID());
  await new DatasetTransitionSession(source, transfer(scope), crypto.randomUUID(), async () => true).start(sourcePlan);
  const markdown = fixture.batches.find(batch => batch.kind === 'markdown');
  assert.equal((await source.commit(markdown)).status, 'durable'); const oldPeer = crypto.randomUUID(); await source.acknowledgeImport(markdown.id, oldPeer);
  await target.storeResource(input); await target.installCheckpoint(await source.checkpoint());
  const plan = await prepareDatasetPublication(target, crypto.randomUUID()); let lost = false;
  const uncertain = createDesktopEditRepository(targetScope, async (endpoint, body) => {
    const result = await server.request(endpoint, body);
    if (endpoint.endsWith('/replace-dataset-control') && body.record.transition.phase === phase && !lost) { lost = true; throw new Error('control-response-lost'); }
    return result;
  });
  await assert.rejects(new DatasetTransitionSession(uncertain, transfer(targetScope), crypto.randomUUID(), async () => true).start(plan), /control-response-lost/);
  assert.equal((await target.datasetControl()).transition.phase, phase);
  const sent = events.filter(kind => kind === 'dataset-manifest').length;
  await stop(server.child); server = await serve(database, token);
  source = createDesktopEditRepository(scope, server.request); target = createDesktopEditRepository(targetScope, server.request);
  const recovery = new DatasetTransitionSession(target, transfer(targetScope), crypto.randomUUID(), async () => true);
  await recovery.resume(); assert.deepEqual(await activeDatasetScope(source), targetScope);
  assert.deepEqual((await target.datasetControl()).transition.publication, plan);
  assert.equal(events.filter(kind => kind === 'dataset-manifest').length, sent + (phase === 'prepared' ? 1 : 0));
  assert.equal((await target.receipt(markdown.id)).upload, 'pending'); assert.ok((await target.receipt(markdown.id)).importedBy.includes(oldPeer));
  assert.equal((await source.commit(markdown)).status, 'aborted');
  const extra = { kind: 'markdown', id: crypto.randomUUID(), libraryId: scope.libraryId, targetId: fixture.markdown.id, parents: [markdown.id], content: 'new epoch data', imageResources: [] };
  assert.equal((await target.commit(extra)).status, 'durable'); await recovery.rollback();
  assert.deepEqual(await activeDatasetScope(target), scope);
  assert.equal((await source.read(fixture.markdown.id)).heads[0], markdown.id); assert.equal((await target.read(fixture.markdown.id)).heads[0], extra.id);
  assert.equal((await target.pendingRecords()).length, 2); assert.equal((await source.pendingRecords()).length, 1);
  assert.equal((await target.commit(extra)).status, 'aborted');
});
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close'); child.kill(); await closed;
}

test('completed dataset crosses the common transfer into SQLite and recovers an install response lost before process restart', { timeout: 90_000 }, async t => {
  assert.equal(python.status, 0, python.stderr);
  const directory = await mkdtemp(path.join(tmpdir(), 'papeer-intent-http-'));
  let server;
  t.after(async () => {
    if (server) await stop(server.child);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('papeer-intent-http-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const scope = fixture.datasetManifest.scope, token = crypto.randomUUID(), database = path.join(directory, 'library.sqlite3');
  const source = new DurableEditRepository(scope, new EditMemoryDatabase(), { inspectPdf: async () => fixture.resource.metadata.pdfPages });
  await source.storeResource({ ...fixture.resource.metadata, bytes: Uint8Array.from(readFileSync(path.join(root, 'tests/fixtures', fixture.resource.file))) });
  await source.installCheckpoint(fixture.checkpoint);
  const publication = await prepareDatasetPublication(source, fixture.datasetManifest.id);
  assert.deepEqual(publication.manifest, fixture.datasetManifest, 'Python/TypeScript content hashes must agree');
  const objects = new Map(), resources = new Map(), events = [];
  const transfer = createDriveEditTransfer({
    async bindAccount() { return this; }, assertCurrent() {},
    sharedEditFiles: async () => [...objects.keys()].reverse().map(id => ({ id })),
    annotation: async id => structuredClone(objects.get(id)),
    saveSharedEdit: async (_namespace, _folder, id, value) => { objects.set(id, structuredClone(value)); events.push(value.kind); },
    saveSharedResource: async (_namespace, _folder, resource) => {
      resources.set(resource.metadata.id, structuredClone(resource)); events.push('resource');
      objects.set(resource.metadata.id, { kind: 'resource', metadata: resource.metadata, blobId: resource.metadata.id });
    },
    sharedResource: async (_namespace, metadata) => structuredClone(resources.get(metadata.id).bytes),
  }, scope, 'folder');
  await publishDataset(publication, source, transfer);
  assert.deepEqual(events, ['resource', 'repository-checkpoint', 'dataset-manifest']);
  server = await serve(database, token);
  let lost = false;
  let repository = createDesktopEditRepository(scope, async (endpoint, body) => {
    const result = await server.request(endpoint, body);
    if (endpoint.endsWith('/install-dataset') && !lost) { lost = true; throw new Error('install-response-lost'); }
    return result;
  });
  const peer = crypto.randomUUID();
  await assert.rejects(importPublishedDataset(repository, transfer, publication.manifest.id, peer), /install-response-lost/);
  assert.deepEqual(await repository.installedDatasets(), [publication.manifest]);
  await stop(server.child); server = await serve(database, token);
  repository = createDesktopEditRepository(scope, server.request);
  await importPublishedDataset(repository, transfer, publication.manifest.id, peer);
  assert.deepEqual(await repository.checkpoint(), publication.checkpoint);
  assert.equal((await repository.read(fixture.document.id)).waiting.length, 1);
  assert.deepEqual(await repository.pendingRecords(), []);
  for (const { batch } of publication.checkpoint.edits) assert.ok((await repository.receipt(batch.id)).importedBy.includes(peer));
  assert.deepEqual(await createDesktopEditRepository({ ...scope, accountId: 'other' }, server.request).installedDatasets(), []);
});

test('ordinary common replication crosses native HTTP/SQLite, retains history at restart and returns Undo to the other host', { timeout: 90_000 }, async t => {
  assert.equal(python.status, 0, python.stderr);
  const directory = await mkdtemp(path.join(tmpdir(), 'papeer-intent-http-'));
  let server;
  t.after(async () => {
    if (server) await stop(server.child);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('papeer-intent-http-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const scope = { accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'ordinary-records' }, token = crypto.randomUUID();
  const database = path.join(directory, 'library.sqlite3'), objects = new Map();
  server = await serve(database, token);
  const source = new DurableEditRepository(scope, new EditMemoryDatabase()); await source.initialize(fixture.document);
  let target = createDesktopEditRepository(scope, server.request); await target.initialize(fixture.document);
  const storage = {
    async bindAccount() { return this; }, assertCurrent() {},
    sharedEditFiles: async () => [...objects.keys()].reverse().map(id => ({ id })),
    annotation: async id => structuredClone(objects.get(id)),
    saveSharedEdit: async (_namespace, _folder, id, value) => {
      if (objects.has(id)) assert.deepEqual(value, objects.get(id));
      objects.set(id, structuredClone(value));
    },
    sharedResource: async () => assert.fail('paper only'), saveSharedResource: async () => assert.fail('paper only'),
  };
  const transfer = createDriveEditTransfer(storage, scope, 'folder');
  const sender = new EditReplication(source, transfer, crypto.randomUUID());
  let receiver = new EditReplication(target, transfer, crypto.randomUUID());
  const sourceSession = new DocumentEditSession(source, fixture.document.id); await sourceSession.refresh();
  const owner = Symbol(), pageId = fixture.document.pages[0].id;
  sourceSession.claimPage(pageId, owner);
  await sourceSession.editPage(pageId, owner, fixture.batches[0].changes);
  await sender.flush(); await receiver.flush();
  assert.equal((await target.read(fixture.document.id)).history.length, 1);
  await stop(server.child); server = await serve(database, token);
  target = createDesktopEditRepository(scope, server.request);
  receiver = new EditReplication(target, transfer, crypto.randomUUID());
  const recovered = new DocumentEditSession(target, fixture.document.id); await recovered.refresh();
  assert.equal(recovered.getSnapshot().canUndo, true); await recovered.undo();
  const pending = await target.pendingRecords();
  assert.equal(pending.length, 1); assert.equal(pending[0].history.action.kind, 'undo');
  await receiver.flush(); await sender.flush();
  const restored = new DocumentEditSession(source, fixture.document.id); await restored.refresh();
  assert.equal(restored.getSnapshot().document.pages[0].annotations.length, 0);
  assert.equal(restored.getSnapshot().canRedo, true); await restored.redo();
  await sender.flush(); await receiver.flush();
  const native = new DocumentEditSession(target, fixture.document.id); await native.refresh();
  assert.equal(native.getSnapshot().document.pages[0].annotations.length, 1);
  assert.equal((await target.read(fixture.document.id)).history.length, 3);
  assert.deepEqual(await target.pendingRecords(), []);
  assert.ok([...objects.values()].every(value => value.kind !== 'repository-checkpoint'));
});
async function serve(database, token, separateEdits = false, driveFixture, deviceFixture) {
  const child = spawn(python.stdout.trim(), [path.join(root, 'frontend/e2e/fixtures/editApi.py'), database, token,
    ...(separateEdits || driveFixture || deviceFixture ? [separateEdits ? 'separate-edits' : 'fixture-edits'] : []),
    ...(driveFixture || deviceFixture ? [driveFixture ?? '-'] : []), ...(deviceFixture ? [deviceFixture] : [])],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '', text = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('native API start timed out: ' + stderr)), 20_000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', () => { clearTimeout(timer); reject(new Error('native API exited: ' + stderr)); });
      child.stdout.on('data', chunk => {
        text += chunk;
        if (text.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(text.split('\n')[0]).port); }
      });
    });
    const request = async (endpoint, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`native ${response.status}: ${await response.text()}`);
      return response.json();
    };
    for (let attempt = 0; ; attempt++) {
      try { await request('/api/edits/intent', { scope: { accountId: 'fixture', libraryId: fixture.libraryId, epoch: 'ready' }, targetId: fixture.document.id }); break; }
      catch (error) { if (attempt >= 100) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    return { child, request, port };
  } catch (error) { await stop(child); throw error; }
}

for (const mode of ['original-response', 'inverse-response']) {
test(`native HTTP journal survives sidecar restart after ${mode} loss and queued Undo`, { timeout: 90_000 }, async t => {
  assert.equal(python.status, 0, python.stderr);
  const directory = await mkdtemp(path.join(tmpdir(), 'papeer-intent-http-'));
  let server;
  t.after(async () => {
    if (server) await stop(server.child);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('papeer-intent-http-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const token = crypto.randomUUID(), scope = { accountId: 'fixture', libraryId: fixture.libraryId, epoch: mode };
  server = await serve(path.join(directory, 'library.sqlite3'), token);
  let journalReplyLost = true, commits = 0, release, dispatchReached;
  const dispatch = new Promise(resolve => { dispatchReached = resolve; });
  const transport = async (endpoint, body) => {
    if (endpoint.endsWith('/commit')) {
      commits++;
      if (commits === 2 && mode === 'original-response') {
        dispatchReached(); await new Promise(resolve => { release = resolve; }); throw new Error('old-connection-closed');
      }
    }
    const result = await server.request(endpoint, body);
    if (endpoint.endsWith('/replace-intent') && body.record && journalReplyLost) {
      journalReplyLost = false; throw new Error('journal-response-lost');
    }
    if (endpoint.endsWith('/commit') && (commits === 1 || (commits === 3 && mode === 'inverse-response'))) throw new Error('batch-response-lost');
    return result;
  };
  const repository = createDesktopEditRepository(scope, transport);
  await repository.initialize(fixture.document);
  const session = new DocumentEditSession(repository, fixture.document.id); await session.refresh();
  const tokenOwner = Symbol(); session.claimPage(fixture.document.pages[0].id, tokenOwner);
  await session.editPage(fixture.document.pages[0].id, tokenOwner, fixture.batches[0].changes);
  assert.equal(session.getSnapshot().phase, 'aborted'); assert.equal(commits, 0, 'no batch before its journal is confirmed');
  await session.retry(); assert.equal(session.getSnapshot().phase, 'unknown');
  const undo = session.undo();
  if (mode === 'original-response') await dispatch; else await undo;
  const retained = await repository.readIntent(fixture.document.id);
  assert.equal(retained.intent.undoRequested, true);
  const inverseId = retained.intent.inverse?.batch.id;
  if (mode === 'inverse-response') assert.ok(inverseId);
  await stop(server.child);
  server = await serve(path.join(directory, 'library.sqlite3'), token);
  const recoveredRepository = createDesktopEditRepository(scope, server.request), registry = new DocumentEditSessions(recoveredRepository);
  await registry.initialize(); const recovered = registry.get(fixture.document.id);
  assert.equal(recovered.canNavigate(), false); await recovered.retry();
  assert.equal(recovered.getSnapshot().document.pages[0].annotations.length, 0);
  assert.equal(recovered.canNavigate(), true); assert.equal(await recoveredRepository.readIntent(fixture.document.id), undefined);
  const state = await recoveredRepository.read(fixture.document.id);
  assert.equal(state.checkpoint.batches.length, 2);
  if (inverseId) assert.equal(state.heads[0], inverseId);
  if (release) { release(); await undo; }
  await stop(server.child);
});
}

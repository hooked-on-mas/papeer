import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareNewProviderLibrary } from '../../../src/runtime/edits/provider/prepareProviderOwnerPlan.ts';
import { assertProviderOwnerPlan, providerOwnerRequestSha256 } from '../../../src/runtime/edits/provider/providerOwnerPlan.ts';
import { prepareProviderInstall } from '../../../src/runtime/edits/provider/providerInstallPlan.ts';
import { createBoundDriveEditTransfer, createDriveEditTransfer, type DriveEditStorage } from '../../../src/adapters/drive/editTransfer.ts';
import { readPublishedDataset } from '../../../src/runtime/edits/datasetPublication.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = (title = 'Cloud library') => ({ ownerNamespace: id(1), principalDigest: 'a'.repeat(64), requestId: id(2), title,
  providerIds: { folderId: 'opaqueGoogleFolder', checkpointFileId: 'opaqueGoogleCheckpoint', manifestFileId: 'opaqueGoogleManifest', descriptorFileId: 'opaqueGoogleDescriptor' } });
const plan = (title?: string) => { let n = 100; return prepareNewProviderLibrary(input(title), () => id(n++)); };

test('retained CREATE uses actual provider IDs, canonical checkpoint hash and no fabricated binding/version', async () => {
  const prepared = await plan();
  assert.equal(prepared.binding, null); assert.equal(prepared.descriptor.version, null);
  assert.deepEqual(prepared.createObjects, { folderObjectId: prepared.createObjects!.folderObjectId, ...input().providerIds });
  assert.equal(prepared.intent.requestSha256, await providerOwnerRequestSha256(prepared));
  assert.equal(prepared.intent.phase, 'prepared');
  await assert.rejects(prepareProviderInstall(prepared, []), /provider-not-published/);
  // Synthetic data transition for the pure Core evaluator, not a host admission capability.
  prepared.binding = { version: 1, id: prepared.intent.bindingId, provider: 'google-drive', principalDigest: prepared.principalDigest,
    scope: prepared.intent.scope, descriptorId: prepared.descriptor.id, descriptorVersion: '1', descriptorSha256: prepared.descriptor.sha256, state: 'preparing' };
  prepared.intent.phase = 'published';
  const installation = await prepareProviderInstall(prepared, []);
  assert.ok(installation.mutations.some(mutation => mutation.kind === 'put-root' && mutation.root.kind === 'library'));
  assert.ok(installation.mutations.some(mutation => mutation.kind === 'put-dataset'));
  assert.ok(installation.mutations.some(mutation => mutation.kind === 'remember-checkpoint'));
  assert.ok(installation.mutations.every(mutation => mutation.kind !== 'put-control'));
  assert.equal(installation.profile.remote?.kind, 'drive');
});

test('shared title policy counts Unicode codepoints and Python whitespace', async () => {
  await plan('😀'.repeat(200)); await assert.rejects(plan('😀'.repeat(201)));
  assert.equal((await plan('\ufeff')).title, '\ufeff');
  assert.equal((await plan('\u0085title\u001c')).title, 'title');
  const prepared = await plan(); prepared.title = '\u0085title';
  await assert.rejects(assertProviderOwnerPlan(prepared));
});

test('retained request commitment binds publication/title/actual IDs but not observed binding or UI acknowledgement', async () => {
  const prepared = await plan(), before = await providerOwnerRequestSha256(prepared);
  const acknowledged = structuredClone(prepared); acknowledged.acknowledged = true;
  assert.equal(await providerOwnerRequestSha256(acknowledged), before);
  const changed = structuredClone(prepared); changed.createObjects!.descriptorFileId = 'anotherActualId';
  await assert.rejects(assertProviderOwnerPlan(changed));
  const tampered = structuredClone(prepared); tampered.publication.checkpoint.roots[0].version = id(999);
  await assert.rejects(assertProviderOwnerPlan(tampered));
});

test('already principal-bound transfer preserves canonical envelopes without Google account rebinding', async () => {
  const prepared = await plan(); let binds = 0, checks = 0;
  const objects: Array<{ id: string; value: unknown }> = [];
  const storage: DriveEditStorage = {
    bindAccount: async () => { binds++; throw new Error('canonical-UUID-must-not-bind-Google'); }, assertCurrent: () => { checks++; },
    sharedEditFiles: async () => objects.map(row => ({ id: row.id, version: '1', kind: (row.value as {kind: string}).kind })),
    annotation: async id => structuredClone(objects.find(row => row.id === id)!.value),
    saveSharedEdit: async (_namespace, _folder, id, value) => { objects.push({ id, value: structuredClone(value) }); },
    sharedResource: async () => { throw new Error('unused'); }, saveSharedResource: async () => { throw new Error('unused'); },
  };
  const transfer = createBoundDriveEditTransfer(storage, prepared.intent.scope, prepared.folderId);
  await transfer.uploadCheckpoint(prepared.publication.checkpoint, prepared.publication.checkpointObjectId);
  await transfer.uploadDatasetManifest(prepared.publication.manifest);
  assert.deepEqual(objects.map(row => Object.keys(row.value as object).sort()), [['checkpoint','kind'],['kind','manifest']]);
  const read = await readPublishedDataset(prepared.intent.scope, transfer, prepared.publication.manifest.id);
  assert.deepEqual(read, { manifest: prepared.publication.manifest, checkpoint: prepared.publication.checkpoint });
  assert.equal(binds, 0); assert.ok(checks >= 4);
});

test('legacy transfer snapshots the caller scope before its existing strict account-bind retry', async () => {
  const prepared = await plan(), scope = { ...prepared.intent.scope }, accounts: string[] = [];
  const receiver: DriveEditStorage = { bindAccount: async account => {
    accounts.push(account); if (accounts.length === 1) throw new Error('first-identity-lookup-failed'); return receiver;
  }, assertCurrent: () => {}, sharedEditFiles: async () => [], annotation: async () => undefined,
  saveSharedEdit: async () => {}, sharedResource: async () => new Uint8Array(), saveSharedResource: async () => {} };
  const transfer = createDriveEditTransfer(receiver, scope, prepared.folderId);
  scope.accountId = id(999);
  await assert.rejects(transfer.pull()); await transfer.pull();
  assert.deepEqual(accounts, [prepared.intent.scope.accountId, prepared.intent.scope.accountId]);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { verifyCompositionResourceClosure, collectCompositionResources, type PhysicalCompositionResource, type FixtureResourceFile } from '../e2e/support/compositionResources.ts';
import type { ResourceMetadata } from '../src/runtime/edits/contracts.ts';

const id = '00000000-0000-4000-8000-000000000001', extraId = '00000000-0000-4000-8000-000000000002';
const bytes = Uint8Array.from([0, 128, 255, 10]);
const metadata: ResourceMetadata = { id, mediaType: 'application/pdf', byteLength: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex') };
const physical = (envelopeId = 'envelope-1', blobId = 'blob-1', value = metadata, body: Uint8Array | undefined = bytes): PhysicalCompositionResource =>
  ({ envelopeId, envelope: { kind: 'resource', metadata: value, blobId }, bytes: body });
const actual = async () => ({ metadata, bytes });
const observe = () => {};

test('all identical physical envelopes and blob IDs must verify before one logical resource is accepted', async () => {
  let reads = 0, evidence: unknown;
  const values = [physical(), physical('envelope-2'), physical('envelope-3', 'blob-2'), physical('envelope-4', 'blob-3')];
  assert.deepEqual(await verifyCompositionResourceClosure(values, [id], async () => { reads++; return actual(); }, value => { evidence = value; }), [metadata]);
  assert.equal(reads, 1);
  assert.deepEqual(evidence, { physical: 4, checked: 4, dropped: 0, entries: values.map((_, index) => ({
    envelope: 'r' + (index + 1), blob: ['b1', 'b1', 'b2', 'b3'][index], logicalId: id, byteLength: 4, sha256: metadata.sha256 })) });
});

test('missing, altered and malformed physical representations never disappear during collapse', async () => {
  for (const bad of [
    { ...physical('missing'), bytes: undefined }, physical('other', 'blob-2', { ...metadata, byteLength: 3 }),
    physical('other', 'blob-2', { ...metadata, sha256: '0'.repeat(64) }),
    physical('other', 'blob-2', { ...metadata, mediaType: 'image/png' }),
    physical('other', 'blob-2', metadata, Uint8Array.from([0, 128, 255, 11])),
    { ...physical('empty-blob'), envelope: { kind: 'resource', metadata, blobId: '' } },
    { ...physical('extra-key'), envelope: { kind: 'resource', metadata, blobId: 'blob-1', extra: true } },
  ]) {
    let evidence: { checked: number } | undefined;
    await assert.rejects(verifyCompositionResourceClosure([physical(), bad], [id], actual, value => { evidence = value; }));
    assert.ok(evidence); assert.ok(evidence.checked < 2);
  }
});

test('extra logical IDs, missing expected resources and absent or corrupt admitted bytes fail exactly', async () => {
  await assert.rejects(verifyCompositionResourceClosure([physical('extra', 'blob-extra', { ...metadata, id: extraId })], [id], async () => ({ metadata: { ...metadata, id: extraId }, bytes }), observe));
  await assert.rejects(verifyCompositionResourceClosure([], [id], actual, observe));
  await assert.rejects(verifyCompositionResourceClosure([physical()], [], actual, observe));
  await assert.rejects(verifyCompositionResourceClosure([physical()], [id], async () => undefined, observe));
  await assert.rejects(verifyCompositionResourceClosure([physical()], [id], async () => ({ metadata, bytes: Uint8Array.from([4]) }), observe));
  await assert.rejects(verifyCompositionResourceClosure([physical()], [id], async () => ({ metadata: { ...metadata, mediaType: 'image/png' }, bytes }), observe));
  assert.deepEqual(await verifyCompositionResourceClosure([], [], actual, observe), []);
});


test('resource-shaped JSON attachments are not envelopes; malformed canonical markers cannot hide', () => {
  const namespace = 'a'.repeat(64), parentId = 'actual-folder';
  const blob = { id: 'blob-1', body: Buffer.from(bytes).toString('utf8'), bytes,
    properties: { papeer: 'edits-resource-v1', scope: namespace, sha256: metadata.sha256 }, parents: [parentId],
    mimeType: 'application/octet-stream', size: String(bytes.byteLength) };
  const attachment = { id: 'json-attachment', body: JSON.stringify({ kind: 'resource', metadata, blobId: 'not-an-envelope' }), bytes };
  const envelope = { id: 'envelope-1', body: JSON.stringify({ kind: 'resource', metadata, blobId: blob.id }), bytes: new Uint8Array(),
    properties: { papeer: 'edits-v1', editKind: 'resource', scope: namespace }, parents: [parentId] };
  const files = new Map<string, FixtureResourceFile>([[blob.id, blob], [envelope.id, envelope], [attachment.id, attachment]]);
  assert.deepEqual(collectCompositionResources(files, namespace, parentId), [physical()]);
  assert.deepEqual(collectCompositionResources(new Map<string, FixtureResourceFile>([[attachment.id, attachment]]), namespace, parentId), []);
  for (const bad of [
    { ...envelope, body: '{' }, { ...envelope, body: JSON.stringify({ kind: 'edit-record' }) },
    { ...envelope, properties: { ...envelope.properties, editKind: 'edit-record' } },
    { ...envelope, properties: { ...envelope.properties, scope: 'b'.repeat(64) } },
    { ...envelope, parents: ['wrong-folder'] },
  ]) assert.throws(() => collectCompositionResources(new Map<string, FixtureResourceFile>([[blob.id, blob], [bad.id, bad]]), namespace, parentId));
});


test('resource pointers cannot substitute missing or foreign canonical blobs even with identical bytes', () => {
  const namespace = 'a'.repeat(64), parentId = 'actual-folder';
  const blob = { id: 'blob-1', body: '', bytes, properties: { papeer: 'edits-resource-v1', scope: namespace, sha256: metadata.sha256 },
    parents: [parentId], mimeType: 'application/octet-stream', size: String(bytes.byteLength) };
  const envelope = { id: 'envelope-1', body: JSON.stringify({ kind: 'resource', metadata, blobId: blob.id }), bytes,
    properties: { papeer: 'edits-v1', editKind: 'resource', scope: namespace }, parents: [parentId] };
  assert.throws(() => collectCompositionResources(new Map<string, FixtureResourceFile>([[envelope.id, envelope]]), namespace, parentId));
  for (const bad of [
    { ...blob, properties: { ...blob.properties, papeer: 'other' } },
    { ...blob, properties: { ...blob.properties, scope: 'b'.repeat(64) } },
    { ...blob, properties: { ...blob.properties, sha256: '0'.repeat(64) } },
    { ...blob, parents: ['wrong-folder'] }, { ...blob, mimeType: 'application/json' }, { ...blob, size: '9' },
  ]) assert.throws(() => collectCompositionResources(new Map<string, FixtureResourceFile>([[envelope.id, envelope], [bad.id, bad]]), namespace, parentId));
});

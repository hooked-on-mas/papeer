import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page, ResourceMetadata } from '../../../src/runtime/edits/contracts.ts';
import { resourceHash } from '../../../src/runtime/edits/contentPublication.ts';
import { assertCanonicalPdfDocument, assertCanonicalPdfPage, assertCanonicalPdfResource,
  canonicalPdfResourceBinding, readCanonicalPdfResource, readCanonicalPdfResourceBytes } from '../../../src/features/reader/pdf/canonicalPdfResource.ts';

async function setup() {
  const scope = { accountId: 'comparison-pdf', libraryId: crypto.randomUUID(), epoch: 'one' };
  const bytes = Uint8Array.from([37, 80, 68, 70]), sha256 = await resourceHash(bytes), id = crypto.randomUUID();
  const page: Page = { id: crypto.randomUUID(), backgroundRevision: crypto.randomUUID(), lifecycleVersion: crypto.randomUUID(),
    annotationVersion: crypto.randomUUID(), widthPt: 600, heightPt: 800,
    background: { kind: 'pdf', resourceId: id, sourceRevision: sha256, pdfPage: 2 }, annotations: [] };
  const metadata: ResourceMetadata = { id, sha256, byteLength: bytes.length, mediaType: 'application/pdf',
    pdfPages: [{ widthPt: 900, heightPt: 500 }, { widthPt: 600, heightPt: 800 }] };
  const binding = canonicalPdfResourceBinding(scope, page);
  return { scope, page, bytes, metadata, binding };
}

test('PDF resource verification fixes every identity and returns independent validated bytes and metadata', async () => {
  const f = await setup(), before = structuredClone(f.binding);
  const value = await readCanonicalPdfResource(f.binding, { scope: f.scope,
    readResource: async id => { assert.equal(id, f.metadata.id); return { metadata: f.metadata, bytes: f.bytes }; } });
  assert.deepEqual(value, { metadata: f.metadata, bytes: f.bytes });
  assert.notStrictEqual(value.bytes, f.bytes); assert.notStrictEqual(value.metadata, f.metadata);
  assert.ok(Object.isFrozen(f.binding)); assert.ok(Object.isFrozen(f.binding.scope));
  f.page.backgroundRevision = crypto.randomUUID(); f.scope.epoch = 'two';
  assert.deepEqual(f.binding, before);
});

test('resource IDs, source hashes, MIME, lengths, physical page indices and dimensions must all match', async () => {
  const f = await setup(); assert.doesNotThrow(() => assertCanonicalPdfResource(f.binding, f.metadata, f.bytes.length));
  for (const metadata of [
    { ...f.metadata, id: crypto.randomUUID() }, { ...f.metadata, sha256: 'b'.repeat(64) },
    { ...f.metadata, mediaType: 'image/png', pdfPages: undefined }, { ...f.metadata, byteLength: 99 },
    { ...f.metadata, pdfPages: undefined }, { ...f.metadata, pdfPages: [{ widthPt: 600, heightPt: 800 }] },
    { ...f.metadata, pdfPages: [{ widthPt: 900, heightPt: 500 }, { widthPt: 800, heightPt: 600 }] },
  ]) assert.throws(() => assertCanonicalPdfResource(f.binding, metadata, f.bytes.length));
  for (const pdfPage of [0, -1, 1.5, 3]) assert.throws(() => assertCanonicalPdfResource({ ...f.binding, pdfPage }, f.metadata, f.bytes.length));
  for (const widthPt of [NaN, 0, Infinity]) assert.throws(() => assertCanonicalPdfResource({ ...f.binding, widthPt }, f.metadata, f.bytes.length));
});

test('missing resources and corrupt same-length bytes never reach a renderer', async () => {
  const f = await setup();
  await assert.rejects(readCanonicalPdfResource(f.binding, { scope: f.scope, readResource: async () => undefined }), /pdf-resource-missing/);
  const corrupt = Uint8Array.from(f.bytes); corrupt[0]++;
  await assert.rejects(readCanonicalPdfResource(f.binding, { scope: f.scope,
    readResource: async () => ({ bytes: corrupt, metadata: f.metadata }) }), /pdf-resource-hash/);
});

test('scope mismatch rejects before reading and scope changes while reading reject after the read', async () => {
  const f = await setup(); let reads = 0;
  await assert.rejects(readCanonicalPdfResource(f.binding, { scope: { ...f.scope, accountId: 'other' },
    readResource: async () => { reads++; return undefined; } }), /pdf-resource-scope/);
  assert.equal(reads, 0);
  await assert.rejects(readCanonicalPdfResource(f.binding, { scope: f.scope, readResource: async () => {
    f.scope.epoch = 'changed'; return { bytes: f.bytes, metadata: f.metadata };
  } }), /pdf-resource-scope/);
});

test('a caller cannot redirect a delayed request by mutating its binding or returned resource buffers', async () => {
  const f = await setup(), binding = structuredClone(f.binding); let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const pending = readCanonicalPdfResource(binding, { scope: f.scope, readResource: async id => {
    assert.equal(id, f.metadata.id); await wait; return { bytes: f.bytes, metadata: f.metadata };
  } });
  const changed = binding as { resourceId: string; sourceRevision: string; pdfPage: number };
  changed.resourceId = crypto.randomUUID(); changed.sourceRevision = 'f'.repeat(64); changed.pdfPage = 1;
  release(); assert.deepEqual((await pending).metadata, f.metadata);
});

test('paper pages and invalid physical PDF bindings are refused before resource lookup', async () => {
  const f = await setup();
  assert.throws(() => canonicalPdfResourceBinding(f.scope, { ...f.page, background: { kind: 'paper', spec: { template: 'blank', color: 'white' } } }), /pdf-resource-required/);
  const background = f.page.background;
  if (background.kind !== 'pdf') throw new Error('pdf fixture');
  assert.throws(() => canonicalPdfResourceBinding(f.scope, { ...f.page, background: { ...background, sourceRevision: 'logical-revision' } }), /pdf-page-invalid/);
  assert.throws(() => canonicalPdfResourceBinding(f.scope, { ...f.page, background: { ...background, pdfPage: 0 } }), /pdf-page-invalid/);
});

test('resource proof survives invalid starting page dimensions and admits a valid page without another read', async () => {
  const f = await setup(); let reads = 0;
  const identity = { scope: f.binding.scope, resourceId: f.binding.resourceId, sourceRevision: f.binding.sourceRevision };
  const proof = await readCanonicalPdfResourceBytes(identity, { scope: f.scope, readResource: async () => {
    reads++; return { metadata: f.metadata, bytes: f.bytes };
  } });
  for (const widthPt of [0, NaN, 701]) {
    assert.throws(() => assertCanonicalPdfResource({ ...f.binding, widthPt }, proof.metadata, proof.bytes.length), /pdf-page-mismatch/);
  }
  const next = canonicalPdfResourceBinding(f.scope, { ...f.page, id: crypto.randomUUID(), widthPt: 900, heightPt: 500,
    background: { kind: 'pdf', resourceId: identity.resourceId, sourceRevision: identity.sourceRevision, pdfPage: 1 } });
  assert.doesNotThrow(() => assertCanonicalPdfResource(next, proof.metadata, proof.bytes.length));
  assert.doesNotThrow(() => assertCanonicalPdfResource(f.binding, proof.metadata, proof.bytes.length));
  assert.equal(reads, 1);
  await assert.rejects(readCanonicalPdfResource({ ...f.binding, widthPt: 701 }, { scope: f.scope,
    readResource: async () => ({ metadata: f.metadata, bytes: f.bytes }) }), /pdf-page-mismatch/);
});

test('resource-only verification fixes identity before awaiting and owns returned metadata and bytes', async () => {
  const f = await setup();
  const identity = { scope: { ...f.scope }, resourceId: f.metadata.id, sourceRevision: f.metadata.sha256 };
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const pending = readCanonicalPdfResourceBytes(identity, { scope: f.scope, readResource: async id => {
    assert.equal(id, f.metadata.id); await waiting; return { metadata: f.metadata, bytes: f.bytes };
  } });
  identity.scope.epoch = 'redirected'; identity.resourceId = crypto.randomUUID(); identity.sourceRevision = 'a'.repeat(64);
  release();
  const proof = await pending;
  assert.deepEqual(proof, { metadata: f.metadata, bytes: f.bytes });
  f.bytes[0]++; f.metadata.pdfPages![0].widthPt++;
  assert.notEqual(proof.bytes[0], f.bytes[0]);
  assert.notEqual(proof.metadata.pdfPages![0].widthPt, f.metadata.pdfPages![0].widthPt);
});

test('resource-only verification retains descriptor, MIME, length, source-hash and scope rejection', async () => {
  const f = await setup();
  const resource = { metadata: f.metadata, bytes: f.bytes };
  for (const metadata of [
    { ...f.metadata, id: crypto.randomUUID() }, { ...f.metadata, sha256: 'b'.repeat(64) },
    { ...f.metadata, mediaType: 'image/png', pdfPages: undefined }, { ...f.metadata, byteLength: f.bytes.length + 1 },
    { ...f.metadata, pdfPages: undefined },
  ]) await assert.rejects(readCanonicalPdfResourceBytes(f.binding, { scope: f.scope,
    readResource: async () => ({ ...resource, metadata }) }));
  const corrupt = Uint8Array.from(f.bytes); corrupt[0]++;
  await assert.rejects(readCanonicalPdfResourceBytes(f.binding, { scope: f.scope,
    readResource: async () => ({ metadata: f.metadata, bytes: corrupt }) }), /pdf-resource-hash/);
  await assert.rejects(readCanonicalPdfResourceBytes(f.binding, { scope: f.scope, readResource: async () => {
    f.scope.epoch = 'changed'; return resource;
  } }), /pdf-resource-scope/);
});

test('actual document inspection checks metadata count and rejects invalid counts', async () => {
  const f = await setup();
  assert.doesNotThrow(() => assertCanonicalPdfDocument(f.binding, f.metadata, 2));
  for (const numPages of [0, -1, 1, 3, 1.5, NaN, Infinity])
    assert.throws(() => assertCanonicalPdfDocument(f.binding, f.metadata, numPages), /pdf-document-inspection-mismatch/);
  assert.throws(() => assertCanonicalPdfDocument({ ...f.binding, pdfPage: 3 }, f.metadata, 2));
  assert.throws(() => assertCanonicalPdfDocument(f.binding, { ...f.metadata, sha256: 'a'.repeat(64) }, 2), /pdf-resource-mismatch/);
});

test('actual page inspection checks physical identity and finite positive natural dimensions at millipoint tolerance', async () => {
  const f = await setup();
  const actual = (pageNumber = 2, width = 600, height = 800) => ({ pageNumber, getViewport: ({ scale }: { scale: number }) => {
    assert.equal(scale, 1); return { width, height };
  } });
  assert.doesNotThrow(() => assertCanonicalPdfPage(f.binding, actual()));
  assert.doesNotThrow(() => assertCanonicalPdfPage(f.binding, actual(2, 600.0005, 799.9995)));
  for (const pageNumber of [0, 1, 3, NaN])
    assert.throws(() => assertCanonicalPdfPage(f.binding, actual(pageNumber)), /pdf-page-inspection-mismatch/);
  for (const width of [0, -1, NaN, Infinity, 600.002])
    assert.throws(() => assertCanonicalPdfPage(f.binding, actual(2, width)), /pdf-page-inspection-mismatch/);
  for (const height of [0, -1, NaN, Infinity, 799.998])
    assert.throws(() => assertCanonicalPdfPage(f.binding, actual(2, 600, height)), /pdf-page-inspection-mismatch/);
  assert.throws(() => assertCanonicalPdfPage({ ...f.binding, widthPt: NaN }, actual()), /pdf-page-inspection-mismatch/);
});

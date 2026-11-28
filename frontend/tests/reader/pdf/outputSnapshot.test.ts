import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SnapshotSession } from '../../../src/features/reader/output/SnapshotSession.ts';
import type { DocumentEditState } from '../../../src/features/reader/edit/DocumentEditSession.ts';
import type { DocumentSnapshot, Page } from '../../../src/runtime/edits/contracts.ts';
import { resourceHash } from '../../../src/runtime/edits/contentPublication.ts';

async function fixture() {
  const bytes = new TextEncoder().encode('snapshot-test-resource'), sha256 = await resourceHash(bytes), resourceId = crypto.randomUUID();
  const page = (n: number): Page => ({ id: crypto.randomUUID(), backgroundRevision: crypto.randomUUID(), lifecycleVersion: crypto.randomUUID(),
    annotationVersion: crypto.randomUUID(), widthPt: 200 + n, heightPt: 300 + n,
    background: { kind: 'pdf', resourceId, sourceRevision: sha256, pdfPage: n }, annotations: [] });
  const document: DocumentSnapshot = { kind: 'document', id: crypto.randomUUID(), version: crypto.randomUUID(), pages: [page(1), page(2)], deletedPages: [] };
  const state: DocumentEditState = { ready: true, document, selectedVersion: document.version, heads: [document.version], phase: 'aborted',
    error: 'disk unavailable', canUndo: false, canRedo: false, affectedPages: [document.pages[1].id], inputActive: false, surfaces: {} };
  const scope = { accountId: 'snapshot', libraryId: crypto.randomUUID(), epoch: 'one' };
  let active = true, blocked = false, reads = 0;
  const resource = { bytes, metadata: { id: resourceId, sha256, mediaType: 'application/pdf', byteLength: bytes.length,
    pdfPages: document.pages.map(p => ({ widthPt: p.widthPt, heightPt: p.heightPt })) } };
  const repository = { scope, readResource: async () => { reads++; return resource; } };
  const session = new SnapshotSession({ repository, state: () => state, active: () => active, inputBlocked: () => blocked });
  return { session, state, resource, repository, reads: () => reads, active: (v: boolean) => { active = v; }, blocked: (v: boolean) => { blocked = v; } };
}

test('snapshot fixes all pages and confirmed nondurable local content before any asynchronous acquisition', async () => {
  const f = await fixture(), expected = structuredClone(f.state.document!);
  const captured = f.session.capture();
  f.state.document!.pages[1].heightPt = 900; f.state.document!.version = crypto.randomUUID(); f.state.phase = 'idle';
  assert.deepEqual(captured.snapshot, expected); assert.equal(captured.persistence, 'aborted');
  assert.equal(Object.isFrozen(captured.snapshot.pages[1]), true);
  const resources = await f.session.resources(captured, new AbortController().signal);
  assert.equal(f.reads(), 1, 'one immutable resource serves both visible and nonvisible pages');
  assert.deepEqual(resources[0].bytes, f.resource.bytes);
});

test('active gesture or draft blocks capture without reading resources', async () => {
  const f = await fixture(); f.blocked(true); assert.throws(() => f.session.capture(), /input-pending/);
  f.blocked(false); f.state.inputActive = true; assert.throws(() => f.session.capture(), /input-pending/);
  assert.equal(f.reads(), 0);
});

test('chosen conflict branch stays explicit and cannot be silently replaced after capture', async () => {
  const f = await fixture(); f.state.heads.push(crypto.randomUUID());
  const captured = f.session.capture(); f.state.heads = [crypto.randomUUID()];
  assert.equal(captured.heads.length, 2); assert.equal(captured.sourceVersion, captured.snapshot.version);
});

test('resource corruption and stale physical dimensions fail without partial output', async () => {
  const f = await fixture(), captured = f.session.capture();
  f.resource.bytes[0] ^= 1;
  await assert.rejects(f.session.resources(captured, new AbortController().signal), /resource-missing/);
  f.resource.bytes[0] ^= 1; f.resource.metadata.pdfPages[1].widthPt++;
  await assert.rejects(f.session.resources(captured, new AbortController().signal), /resource-stale/);
});

test('scope switch, host loss, and cancellation fence an in-flight output', async () => {
  const f = await fixture(), captured = f.session.capture(), signal = new AbortController();
  f.repository.scope.epoch = 'two'; assert.throws(() => f.session.assertActive(captured, signal.signal), /scope-changed/);
  f.repository.scope.epoch = 'one'; f.active(false); assert.throws(() => f.session.assertActive(captured, signal.signal), /scope-changed/);
  f.active(true); signal.abort(); await assert.rejects(f.session.resources(captured, signal.signal), /abort/i);
});

test('translated output follows exact mapping, refuses ambiguity and skips missing only by explicit option', async () => {
  const f = await fixture(), doc = f.state.document!, translated = { ...structuredClone(doc.pages[0]), id: crypto.randomUUID() };
  doc.translation = { revision: crypto.randomUUID(), pages: [translated], bindings: [{ original: { pageId: doc.pages[0].id,
    backgroundRevision: doc.pages[0].backgroundRevision }, candidates: [{ pageId: translated.id, backgroundRevision: translated.backgroundRevision }] }] };
  assert.throws(() => f.session.capture({ pool: 'translated' }), /translation-missing/);
  assert.deepEqual(f.session.capture({ pool: 'translated', translatedOnly: true }).snapshot.pages.map(page => page.id), [translated.id]);
  doc.translation.bindings[0].candidates.push({ ...doc.translation.bindings[0].candidates[0] });
  assert.throws(() => f.session.capture({ pool: 'translated', translatedOnly: true }), /translation-ambiguous/);
});

test('resource metadata budget rejects a large export before allocating the resource body', async () => {
  const f = await fixture();
  const guarded = new SnapshotSession({ repository: { ...f.repository, resourceMetadata: async () => ({ ...f.resource.metadata, byteLength: 129 * 1024 * 1024 }) },
    state: () => f.state, active: () => true, inputBlocked: () => false });
  await assert.rejects(guarded.resources(guarded.capture(), new AbortController().signal), /resource-limit/);
  assert.equal(f.reads(), 0);
});

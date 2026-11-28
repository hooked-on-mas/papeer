import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveCitationLocation } from '../../../src/features/reader/navigation/citationLocation.ts';
import type { CitationTarget } from '../../../src/runtime/markdown/markdownCitations.ts';
import type { DocumentSnapshot, Page } from '../../../src/runtime/edits/contracts.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const libraryId: string = fixture.libraryId;
const document = (): DocumentSnapshot => structuredClone(fixture.translation.root);
const citation = (doc: DocumentSnapshot, page: Page = doc.pages[0], surface: CitationTarget['surface'] = 'original'): CitationTarget => ({
  libraryId, documentId: doc.id, pageId: page.id, backgroundRevision: page.backgroundRevision, surface,
});

test('reorder preserves logical target and converts physical page points without changing the snapshot', () => {
  const doc = document(), page = doc.pages[0];
  const target = { ...citation(doc), anchor: { xPt: page.widthPt / 4, yPt: page.heightPt / 2 } };
  doc.pages.reverse(); const before = structuredClone(doc);
  const result = resolveCitationLocation(target, { libraryId, document: doc });
  assert.equal(result.status, 'resolved');
  if (result.status !== 'resolved') return;
  assert.equal(result.page, page); assert.deepEqual(result.place, { x: .25, y: .5 }); assert.deepEqual(doc, before);
});

test('deleted, absent and same-ordinal replacement pages never silently retarget a citation', () => {
  const doc = document(), target = citation(doc), old = doc.pages.shift()!;
  doc.deletedPages.push(old);
  assert.deepEqual(resolveCitationLocation(target, { libraryId, document: doc }), { status: 'unresolved', reason: 'deleted' });
  doc.deletedPages = [];
  doc.pages.unshift({ ...old, id: crypto.randomUUID() });
  assert.deepEqual(resolveCitationLocation(target, { libraryId, document: doc }), { status: 'unresolved', reason: 'missing' });
});

test('library/document identity and the exact background revision are required', () => {
  const doc = document(), target = citation(doc);
  assert.deepEqual(resolveCitationLocation({ ...target, libraryId: crypto.randomUUID() }, { libraryId, document: doc }), { status: 'unresolved', reason: 'library-mismatch' });
  assert.deepEqual(resolveCitationLocation({ ...target, documentId: crypto.randomUUID() }, { libraryId, document: doc }), { status: 'unresolved', reason: 'document-mismatch' });
  doc.pages[0].backgroundRevision = crypto.randomUUID();
  assert.deepEqual(resolveCitationLocation(target, { libraryId, document: doc }), { status: 'unresolved', reason: 'background-changed' });
});

test('translated targets resolve their actual page independently of correspondence mappings', () => {
  const doc = document(), translated = doc.translation!.pages[0], target = citation(doc, translated, 'translated');
  doc.translation!.bindings = [];
  assert.deepEqual(resolveCitationLocation(target, { libraryId, document: doc }), { status: 'resolved', page: translated, place: null });
  assert.deepEqual(resolveCitationLocation({ ...target, surface: 'original' }, { libraryId, document: doc }), { status: 'unresolved', reason: 'wrong-surface' });
  assert.deepEqual(resolveCitationLocation({ ...citation(doc), surface: 'translated' }, { libraryId, document: doc }), { status: 'unresolved', reason: 'wrong-surface' });
  doc.translation!.pages.shift(); doc.deletedPages.push(translated);
  assert.deepEqual(resolveCitationLocation(target, { libraryId, document: doc }), { status: 'unresolved', reason: 'deleted' });
  doc.deletedPages = []; delete doc.translation;
  assert.deepEqual(resolveCitationLocation(target, { libraryId, document: doc }), { status: 'unresolved', reason: 'missing' });
});

test('anchor absence, edges and invalid coordinates are distinct without clamping', () => {
  const doc = document(), target = citation(doc), page = doc.pages[0];
  for (const [xPt, yPt, expected] of [[0, 0, { x: 0, y: 0 }], [page.widthPt, page.heightPt, { x: 1, y: 1 }]] as const) {
    const result = resolveCitationLocation({ ...target, anchor: { xPt, yPt } }, { libraryId, document: doc });
    assert.equal(result.status, 'resolved'); if (result.status === 'resolved') assert.deepEqual(result.place, expected);
  }
  for (const anchor of [{ xPt: -1, yPt: 0 }, { xPt: 0, yPt: -1 }, { xPt: page.widthPt + .01, yPt: 0 },
    { xPt: 0, yPt: page.heightPt + .01 }, { xPt: NaN, yPt: 0 }, { xPt: 0, yPt: Infinity }]) {
    assert.deepEqual(resolveCitationLocation({ ...target, anchor }, { libraryId, document: doc }), { status: 'unresolved', reason: 'anchor-outside' });
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { DocumentSnapshot } from '../../../src/runtime/edits/contracts.ts';
import { projectCanonicalAnnotations } from '../../../src/features/library/annotations/canonicalAnnotationBrowser.ts';
import { resolveAnnotationLocation } from '../../../src/features/reader/navigation/annotationLocation.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
function setup(translated = false) {
  const document: DocumentSnapshot = structuredClone(fixture.translation.root);
  for (const page of [...document.pages, ...document.translation!.pages]) page.annotations = [];
  const page = translated ? document.translation!.pages[0] : document.pages[0];
  page.annotations = [{ kind: 'sticky', id: crypto.randomUUID(), text: 'exact', anchor: { x: 12, y: 24 }, color: null,
    metadata: { label: 'label', createdAt: null } }];
  const context = { libraryId: fixture.libraryId as string, document };
  const row = projectCanonicalAnnotations([{ ...context, title: 'title' }])[0];
  return { context, request: { version: document.version, row, target: row.target }, page };
}
test('exact version, payload, physical anchor and actual surface resolve without ordinal dependence', () => {
  for (const translated of [false, true]) {
    const { context, request, page } = setup(translated);
    context.document.pages.reverse();
    const result = resolveAnnotationLocation(request, context);
    assert.equal(result.status, 'resolved');
    if (result.status === 'resolved') assert.deepEqual(result.place, { x: 12 / page.widthPt, y: 24 / page.heightPt });
    const changed = structuredClone(context); changed.document.version = crypto.randomUUID();
    assert.equal(resolveAnnotationLocation(request, changed).status, 'unresolved');
  }
});
test('changed annotation fields and spoofed target are refused instead of navigating another anchor', () => {
  const { context, request, page } = setup();
  const spoofed = structuredClone(request); spoofed.target = { ...spoofed.target, anchor: { xPt: 100, yPt: 200 } };
  assert.equal(resolveAnnotationLocation(spoofed, context).status, 'unresolved');
  const note = page.annotations[0]; assert.equal(note.kind, 'sticky');
  if (note.kind !== 'sticky') return;
  note.metadata.label = 'remote';
  assert.deepEqual(resolveAnnotationLocation(request, context), { status: 'unresolved', reason: 'annotation-changed' });
  page.annotations = [];
  assert.equal(resolveAnnotationLocation(request, context).status, 'unresolved');
});
test('background replacement, deleted page, orphan and ambiguous translation refuse exact rows', () => {
  const { context, request, page } = setup();
  page.backgroundRevision = crypto.randomUUID();
  assert.equal(resolveAnnotationLocation(request, context).status, 'unresolved');
  context.document.pages = []; context.document.deletedPages.push(page);
  assert.equal(resolveAnnotationLocation(request, context).status, 'unresolved');
  for (const ambiguous of [false, true]) {
    const translated = setup(true);
    if (ambiguous) translated.context.document.translation!.bindings[0].candidates.push({
      pageId: translated.context.document.translation!.pages[1].id,
      backgroundRevision: translated.context.document.translation!.pages[1].backgroundRevision,
    });
    else translated.context.document.translation!.bindings = [];
    assert.equal(resolveAnnotationLocation(translated.request, translated.context).status, 'unresolved');
  }
});

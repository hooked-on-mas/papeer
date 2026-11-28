import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page, StickyNote, TextHighlight } from '../../../src/runtime/edits/contracts.ts';
import { beginCanonicalAnnotationDraft, canonicalAnnotationDraftChanges, updateCanonicalAnnotationDraft,
  type AnnotationDraftPatch, type AnnotationDraftStart, type AnnotationHighlightSeed } from '../../../src/features/reader/annotations/canonicalAnnotationOperations.ts';

const sticky = (): StickyNote => ({ kind: 'sticky', id: crypto.randomUUID(), text: 'original', anchor: { x: 72, y: 144 },
  color: null, quote: 'exact retained quote', metadata: { label: 'old', createdAt: null } });
function fixture() {
  const original = sticky();
  const page: Page = { id: crypto.randomUUID(), backgroundRevision: crypto.randomUUID(), lifecycleVersion: crypto.randomUUID(),
    annotationVersion: crypto.randomUUID(), widthPt: 600, heightPt: 800,
    background: { kind: 'paper', spec: { template: 'blank', color: 'white' } }, annotations: [original, sticky()] };
  const baseVersion = crypto.randomUUID(), identity = { id: crypto.randomUUID(), createdAt: '2026-10-27T12:34:56.789Z' };
  return { page, original, baseVersion, identity,
    draft: beginCanonicalAnnotationDraft(page, baseVersion, crypto.randomUUID(), { kind: 'edit-sticky', annotation: original }, identity) };
}

test('sticky creation fixes identity, UTC, null color and page expectation without changing the source page', () => {
  const f = fixture(), before = structuredClone(f.page), draft = beginCanonicalAnnotationDraft(f.page, f.baseVersion, crypto.randomUUID(),
    { kind: 'create-sticky', anchor: { x: 90, y: 120 } }, f.identity);
  assert.deepEqual(draft.initial, { kind: 'sticky', id: f.identity.id, text: '', anchor: { x: 90, y: 120 }, color: null,
    metadata: { label: '', createdAt: f.identity.createdAt } });
  assert.deepEqual(canonicalAnnotationDraftChanges(f.page, f.baseVersion, draft), [{ type: 'create', annotation: draft.initial }]);
  assert.deepEqual(f.page, before); assert.notStrictEqual(draft.page, f.page);
});

test('field-limited sticky updates preserve quote, unknown timestamp, identity and every unrelated annotation', () => {
  const f = fixture(), before = structuredClone(f.page);
  const next = updateCanonicalAnnotationDraft(f.draft, { text: 'changed', label: 'new category', anchor: { x: 99, y: 33 } });
  assert.deepEqual(next.dirtyFields, ['text', 'label', 'anchor']);
  assert.equal(next.annotation.color, null); assert.equal(next.annotation.quote, f.original.quote);
  assert.equal(next.annotation.metadata.createdAt, null); assert.equal(next.annotation.id, f.original.id);
  assert.deepEqual(canonicalAnnotationDraftChanges(f.page, f.baseVersion, next), [{ type: 'update', annotation: next.annotation }]);
  assert.deepEqual(f.page, before); assert.deepEqual(f.draft.annotation, f.original);
  const reverted = updateCanonicalAnnotationDraft(next, { text: f.original.text, label: f.original.metadata.label, anchor: f.original.anchor });
  assert.deepEqual(reverted.dirtyFields, []); assert.deepEqual(canonicalAnnotationDraftChanges(f.page, f.baseVersion, reverted), []);
});

test('delete targets only the retained annotation; deleting an uncommitted creation is a no-op', () => {
  const f = fixture(), deleted = updateCanonicalAnnotationDraft(f.draft, { deleted: true });
  assert.deepEqual(canonicalAnnotationDraftChanges(f.page, f.baseVersion, deleted), [{ type: 'delete', id: f.original.id }]);
  const created = beginCanonicalAnnotationDraft(f.page, f.baseVersion, crypto.randomUUID(), { kind: 'create-sticky', anchor: { x: 1, y: 2 } }, f.identity);
  assert.deepEqual(canonicalAnnotationDraftChanges(f.page, f.baseVersion, updateCanonicalAnnotationDraft(created, { deleted: true })), []);
});

test('unknown form fields, malformed values and forged protected fields or dirty claims are refused', () => {
  const f = fixture();
  for (const patch of [{ id: crypto.randomUUID() }, { quote: 'replace quote' }, { metadata: { createdAt: 'now' } },
    { kind: 'highlight' }, { pageId: crypto.randomUUID() }, { text: undefined }, { anchor: { x: NaN, y: 0 } }, { deleted: 'yes' }])
    assert.throws(() => updateCanonicalAnnotationDraft(f.draft, patch as AnnotationDraftPatch));
  for (const forged of [
    { ...f.draft, annotation: { ...f.original, quote: 'forged' } },
    { ...f.draft, annotation: { ...f.original, metadata: { ...f.original.metadata, createdAt: f.identity.createdAt } } },
    { ...f.draft, dirtyFields: ['text'] as const },
    { ...f.draft, annotation: { ...f.original, id: crypto.randomUUID() } },
  ]) assert.throws(() => canonicalAnnotationDraftChanges(f.page, f.baseVersion, forged));
});

test('changed base, background, page lifecycle, original payload and false edit candidates retain no overwrite path', () => {
  const f = fixture();
  assert.throws(() => beginCanonicalAnnotationDraft(f.page, f.baseVersion, crypto.randomUUID(),
    { kind: 'edit-sticky', annotation: { ...f.original, text: 'unconfirmed caller value' } }, f.identity));
  assert.throws(() => canonicalAnnotationDraftChanges(f.page, crypto.randomUUID(), f.draft));
  for (const page of [
    { ...f.page, backgroundRevision: crypto.randomUUID() }, { ...f.page, lifecycleVersion: crypto.randomUUID() },
    { ...f.page, annotationVersion: crypto.randomUUID() },
    { ...f.page, annotations: f.page.annotations.map(value => value.id === f.original.id ? { ...f.original, color: 'red' } : value) },
  ]) assert.throws(() => canonicalAnnotationDraftChanges(page, f.baseVersion, f.draft));
});

const highlightSeed = (page: Page): AnnotationHighlightSeed => ({ quote: 'exact selected text', range: { kind: 'unindexed' },
  backgroundRevision: page.backgroundRevision, anchor: { x: 72, y: 144 },
  quads: [[{ x: 72, y: 144 }, { x: 172, y: 144 }, { x: 172, y: 156 }, { x: 72, y: 156 }],
    [{ x: 72, y: 164 }, { x: 120, y: 164 }, { x: 120, y: 176 }, { x: 72, y: 176 }]] });
const pdfPage = (page: Page): Page => ({ ...page, background: { kind: 'pdf', resourceId: crypto.randomUUID(),
  sourceRevision: 'a'.repeat(64), pdfPage: 1 } });
const highlight = (page: Page, indexed = false): TextHighlight => ({ kind: 'highlight', id: crypto.randomUUID(), text: 'comment',
  ...highlightSeed(page), range: indexed ? { kind: 'indexed', start: 3, end: 22 } : { kind: 'unindexed' },
  quads: highlightSeed(page).quads.map(quad => quad.map(point => ({ ...point }))),
  color: '#60a5fa', metadata: { label: 'existing', createdAt: null } });

test('PDF highlight creation copies only canonical seed values and fixes identity, UTC and form defaults', () => {
  const f = fixture(), page = pdfPage(f.page), seed = highlightSeed(page), before = structuredClone(seed);
  const draft = beginCanonicalAnnotationDraft(page, f.baseVersion, crypto.randomUUID(), { kind: 'create-highlight', seed }, f.identity);
  assert.deepEqual(draft.initial, { kind: 'highlight', id: f.identity.id, text: '', color: '#facc15',
    ...before, metadata: { label: '', createdAt: f.identity.createdAt } });
  assert.deepEqual(canonicalAnnotationDraftChanges(page, f.baseVersion, draft), [{ type: 'create', annotation: draft.initial }]);
  assert.ok(draft.annotation.kind === 'highlight');
  assert.notStrictEqual(draft.annotation.anchor, seed.anchor); assert.notStrictEqual(draft.annotation.quads, seed.quads);
  assert.notStrictEqual(draft.annotation.range, seed.range); assert.deepEqual(seed, before);
  assert.deepEqual(canonicalAnnotationDraftChanges(page, f.baseVersion, updateCanonicalAnnotationDraft(draft, { deleted: true })), []);
});

test('existing paper/PDF highlights preserve indexed/unindexed ranges, quads, quote and background on form edits and anchor moves', () => {
  for (const indexed of [false, true]) for (const pdf of [false, true]) {
    const f = fixture(), page = pdf ? pdfPage(f.page) : f.page, original = highlight(page, indexed);
    page.annotations.push(original); const before = structuredClone(page);
    const draft = beginCanonicalAnnotationDraft(page, f.baseVersion, crypto.randomUUID(), { kind: 'edit-highlight', annotation: original }, f.identity);
    const next = updateCanonicalAnnotationDraft(draft, { text: 'new comment', label: 'new topic', color: '#f87171', anchor: { x: 200, y: 300 } });
    assert.deepEqual(next.dirtyFields, ['text', 'label', 'color', 'anchor']);
    assert.deepEqual(next.annotation, { ...original, text: 'new comment', color: '#f87171', anchor: { x: 200, y: 300 },
      metadata: { ...original.metadata, label: 'new topic' } });
    assert.deepEqual(canonicalAnnotationDraftChanges(page, f.baseVersion, next), [{ type: 'update', annotation: next.annotation }]);
    assert.deepEqual(canonicalAnnotationDraftChanges(page, f.baseVersion, updateCanonicalAnnotationDraft(draft, { deleted: true })), [{ type: 'delete', id: original.id }]);
    assert.deepEqual(page, before);
  }
});

test('new highlight seed refuses a structurally valid indexed range without changing the source page', () => {
  const f = fixture(), page = pdfPage(f.page), before = structuredClone(page);
  const input = { kind: 'create-highlight', seed: { ...highlightSeed(page), range: { kind: 'indexed', start: 3, end: 22 } } };
  assert.throws(() => beginCanonicalAnnotationDraft(page, f.baseVersion, crypto.randomUUID(), input as unknown as AnnotationDraftStart, f.identity),
    /annotation-highlight-unindexed-required/);
  assert.deepEqual(page, before);
});

test('highlight rejects null color and immutable form claims while sticky null color remains valid', () => {
  const f = fixture(), page = pdfPage(f.page), original = highlight(page, true); page.annotations.push(original);
  const draft = beginCanonicalAnnotationDraft(page, f.baseVersion, crypto.randomUUID(), { kind: 'edit-highlight', annotation: original }, f.identity);
  for (const patch of [{ color: null }, { quote: 'changed' }, { range: { kind: 'unindexed' } }, { quads: [] },
    { backgroundRevision: crypto.randomUUID() }, { id: crypto.randomUUID() }, { createdAt: null }])
    assert.throws(() => updateCanonicalAnnotationDraft(draft, patch as AnnotationDraftPatch));
  for (const annotation of [
    { ...original, quote: 'forged' }, { ...original, range: { kind: 'unindexed' as const } },
    { ...original, quads: original.quads.slice(1) }, { ...original, backgroundRevision: crypto.randomUUID() },
    { ...original, metadata: { ...original.metadata, createdAt: f.identity.createdAt } },
  ]) assert.throws(() => canonicalAnnotationDraftChanges(page, f.baseVersion, { ...draft, annotation }));
  assert.equal(updateCanonicalAnnotationDraft(f.draft, { color: null }).annotation.color, null);
});

test('highlight starts reject paper creation, malformed canonical geometry, protected seed keys and wrong edit kinds', () => {
  const f = fixture(), page = pdfPage(f.page), seed = highlightSeed(page);
  assert.throws(() => beginCanonicalAnnotationDraft(f.page, f.baseVersion, crypto.randomUUID(), { kind: 'create-highlight', seed }, f.identity));
  for (const invalid of [
    { ...seed, quads: [] }, { ...seed, quads: [[{ x: 1, y: 2 }]] },
    { ...seed, quads: [[{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }]] },
    { ...seed, anchor: { x: NaN, y: 0 } }, { ...seed, backgroundRevision: crypto.randomUUID() },
    { ...seed, range: { kind: 'indexed', start: 10, end: 2 } }, { ...seed, range: { kind: 'indexed', start: 1.5, end: 10 } },
    { ...seed, quote: undefined }, { ...seed, renderToken: {} }, { ...seed, id: f.identity.id },
    { ...seed, createdAt: f.identity.createdAt }, { ...seed, color: '#f87171' },
  ]) assert.throws(() => beginCanonicalAnnotationDraft(page, f.baseVersion, crypto.randomUUID(),
    { kind: 'create-highlight', seed: invalid } as AnnotationDraftStart, f.identity));
  const original = highlight(page); page.annotations.push(original);
  for (const input of [{ kind: 'edit-highlight', annotation: f.original }, { kind: 'edit-sticky', annotation: original },
    { kind: 'edit-highlight', annotation: { ...original, quote: 'changed candidate' } }])
    assert.throws(() => beginCanonicalAnnotationDraft(page, f.baseVersion, crypto.randomUUID(), input as AnnotationDraftStart, f.identity));
});

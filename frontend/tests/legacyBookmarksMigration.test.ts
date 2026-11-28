import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Page, PageAnnotation } from '../src/runtime/edits/contracts.ts';
import { assertSnapshot } from '../src/runtime/edits/editModel.ts';
import { resizePaper } from '../src/runtime/edits/pageCoordinates.ts';
import { editContentHash } from '../src/runtime/edits/editContentHash.ts';
import { validAnnotationTimestamp } from '../src/runtime/edits/annotationTime.ts';
import { convertLegacyBookmarksPage, type LegacyBookmarkContext } from '../src/migrations/legacyBookmarks.ts';
import { convertLegacyAnnotationsPage } from '../src/migrations/legacyAnnotations.ts';
import { legacyBookmarkFixture } from './support/legacyBookmarkFixture.ts';
import { legacyInkFixture } from './support/legacyInkFixture.ts';
const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const page = (): Page => structuredClone(fixture.document.pages[0]);
const context = (): LegacyBookmarkContext => ({ libraryId: fixture.libraryId, documentId: fixture.document.id,
  sourceDocumentId: 'old-paper', side: 'original', sourcePageId: 'stable-old-page', sourcePageNumber: 1, sourceRevision: null });
const snapshot = (annotation: PageAnnotation) => ({ ...fixture.document, pages: [{ ...page(), annotations: [annotation] }] });

test('both runtimes use the same indexed/unindexed, metadata, date and malformed annotation corpus', () => {
  for (const value of fixture.annotations.valid) assert.doesNotThrow(() => assertSnapshot(snapshot(value)));
  for (const { name, annotation } of fixture.annotations.invalid) assert.throws(() => assertSnapshot(snapshot(annotation)), /./, name);
  for (const value of ['0001-01-01T00:00:00Z', '2000-02-29T23:59:59.999999Z', '2026-10-25T12:34:56.0Z']) assert.equal(validAnnotationTimestamp(value), true);
});

for (const [widthPt, heightPt] of [[612, 792], [842, 595]]) {
test(`bookmarks preserve full text, classification, timestamps, navigation anchors and physical quads (${widthPt}×${heightPt})`, async () => {
  const target = { ...page(), widthPt, heightPt }, source = legacyBookmarkFixture(), before = structuredClone(source);
  const result = await convertLegacyBookmarksPage(target, source, context());
  assert.equal(result.status, 'converted', JSON.stringify(result)); if (result.status !== 'converted') return;
  assert.deepEqual(source, before); assert.deepEqual(target.annotations, []);
  for (const [index, value] of result.page.annotations.entries()) {
    const old = source[index]; assert.ok(value.kind !== 'ink');
    assert.equal(value.text, old.note); assert.equal(value.quote, old.quote); assert.equal(value.metadata.label, old.label);
    assert.equal(value.metadata.createdAt, old.created_at.replace(' ', 'T') + 'Z');
    assert.deepEqual(value.anchor, { x: old.anchor_x * widthPt, y: old.anchor_y * heightPt });
    assert.equal(result.mappings[index].sourceFingerprint, await editContentHash(old));
    if (value.kind === 'highlight') {
      assert.deepEqual(value.range, { kind: 'unindexed' }); assert.equal('start' in value, false); assert.equal('end' in value, false);
      assert.equal(value.backgroundRevision, target.backgroundRevision);
      assert.deepEqual(value.quads, (JSON.parse(old.rects) as number[][]).map(([x, y, w, h]) => [{ x: x * widthPt, y: y * heightPt }, { x: (x + w) * widthPt, y: y * heightPt },
        { x: (x + w) * widthPt, y: (y + h) * heightPt }, { x: x * widthPt, y: (y + h) * heightPt }]));
    } else assert.equal(value.color, null, 'the source has category styling, not an explicit chosen color');
  }
  assert.deepEqual(result.page.annotations.slice(2).map(a => { assert.ok(a.kind === 'highlight'); return a.color; }), ['#facc15', '#4ade80', '#60a5fa', '#f472b6', '#c084fc']);
  const fitted = resizePaper(result.page, widthPt / 2, heightPt / 2, crypto.randomUUID(), true);
  fitted.annotations.forEach((value, index) => {
    assert.ok(value.kind !== 'ink'); const before = result.page.annotations[index]; assert.ok(before.kind !== 'ink');
    assert.deepEqual(value.anchor, { x: before.anchor.x / 2, y: before.anchor.y / 2 });
    assert.deepEqual(value.metadata, before.metadata); if (value.kind === 'highlight') assert.deepEqual(value.range, { kind: 'unindexed' });
  });
});
}

test('one conversion entry captures all annotation families before awaiting and preserves family order', async () => {
  const target = page(), ink = legacyInkFixture(target.widthPt, target.heightPt), bookmarks = legacyBookmarkFixture();
  const expected = structuredClone(bookmarks), pending = convertLegacyAnnotationsPage(target, ink, bookmarks, context());
  bookmarks[0].note = 'later'; bookmarks[2].rects = 'later'; ink[0].points[0][0] = .9;
  const result = await pending; assert.equal(result.status, 'converted', JSON.stringify(result)); if (result.status !== 'converted') return;
  assert.equal(result.page.annotations.length, ink.length + bookmarks.length);
  assert.ok(result.page.annotations.slice(0, ink.length).every(value => value.kind === 'ink'));
  const sticky = result.page.annotations[ink.length]; assert.ok(sticky.kind === 'sticky'); assert.equal(sticky.text, expected[0].note);
  assert.deepEqual(result.mappings.map(m => m.kind), [...ink.map(() => 'ink'), ...bookmarks.map(() => 'bookmark')]);
});

test('stable bookmark IDs retain int64 identity, isolate page/side and do not depend on content or row order', async () => {
  const source = legacyBookmarkFixture(), first = await convertLegacyBookmarksPage(page(), source, context());
  const reversed = await convertLegacyBookmarksPage(page(), [...source].reverse(), context());
  assert.deepEqual([...first.mappings].reverse(), reversed.mappings);
  const changed = await convertLegacyBookmarksPage(page(), [{ ...source[0], id: '1', note: 'changed' }], context());
  assert.equal(changed.mappings[0].targetId, first.mappings[0].targetId); assert.notEqual(changed.mappings[0].sourceFingerprint, first.mappings[0].sourceFingerprint);
  const translated = await convertLegacyBookmarksPage(page(), [{ ...source[0], side: 'translated' }], { ...context(), side: 'translated' });
  assert.notEqual(translated.mappings[0].targetId, first.mappings[0].targetId);
  assert.equal(first.mappings[1].source[first.mappings[1].source.length - 1], '9223372036854775807');
});

test('unsafe identities, unknown fields, invalid dates/ranges/colors and mismatched source rows block the whole page', async () => {
  const source = legacyBookmarkFixture(), note = source[0], highlight = source[2];
  const invalid = [
    { ...note, id: Number.MAX_SAFE_INTEGER + 1 }, { ...note, id: '9223372036854775808' }, { ...note, id: '01' }, { ...note, id: '1\n' },
    { ...note, paper_title: 'derived API field' }, { ...note, created_at: '2025-02-29 00:00:00' }, { ...note, created_at: '' },
    { ...note, created_at: '2024-02-29 12:34:56\n' }, { ...note, label: '😀'.repeat(41) }, { ...note, note: 'x'.repeat(1001) },
    { ...note, anchor_x: NaN }, { ...note, color: 'yellow' }, { ...note, side: 'translated' }, { ...note, page: 2 }, { ...note, paper_id: 'wrong' },
    { ...highlight, color: 'toString' }, { ...highlight, quote: '' }, { ...highlight, rects: '[]' }, { ...highlight, rects: JSON.stringify([[.9, .1, .5, .1]]) },
    { ...highlight, rects: JSON.stringify(Array.from({ length: 401 }, () => [.1, .1, .1, .1])) },
    { ...highlight, rects: '[[NaN,0,0.1,0.1]]' }, { ...highlight, rects: '{}' }, { ...highlight, rects: [] },
  ];
  for (const bad of invalid) {
    const result = await convertLegacyBookmarksPage(page(), [source[1], bad], context());
    assert.equal(result.status, 'blocked', JSON.stringify(bad)); assert.equal('page' in result, false);
  }
  const duplicate = await convertLegacyBookmarksPage(page(), [note, { ...note, id: '1' }], context());
  assert.equal(duplicate.status, 'blocked'); if (duplicate.status === 'blocked') assert.match(duplicate.issues[0].detail, /duplicate-bookmark-id/);
});

test('invalid ink/bookmarks are both reported and combined limits cannot expose a partially converted page', async () => {
  const source = legacyBookmarkFixture(), target = page();
  const invalid = await convertLegacyAnnotationsPage(target, [{}], [{ ...source[0], created_at: 'bad' }], context());
  assert.equal(invalid.status, 'blocked'); if (invalid.status === 'blocked') assert.equal(invalid.issues.length, 2);
  const dots = Array.from({ length: 3000 }, (_, index) => ({ id: String(index), color: '#123456', width: .002, points: [[.1, .2]] }));
  const combined = await convertLegacyAnnotationsPage(target, dots, [source[0]], context());
  assert.equal(combined.status, 'blocked'); if (combined.status === 'blocked') assert.equal(combined.issues[0].code, 'invalid-target-page');
  assert.equal('page' in combined, false);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { DocumentSnapshot, StickyNote, TextHighlight } from '../../../src/runtime/edits/contracts.ts';
import { projectCanonicalAnnotations, filterCanonicalAnnotations, freezeAnnotationExport } from '../../../src/features/library/annotations/canonicalAnnotationBrowser.ts';
import { formatMarkdownCitationUri } from '../../../src/runtime/markdown/markdownCitations.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const id = (value: number) => `10000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const sticky = (value: number, text: string, createdAt: string | null = null): StickyNote => ({
  kind: 'sticky', id: id(value), text, anchor: { x: 12.5, y: 27.25 }, color: null,
  metadata: { label: '分類Ａ', createdAt },
});
function source() {
  const document: DocumentSnapshot = structuredClone(fixture.translation.root);
  for (const page of [...document.pages, ...document.translation!.pages]) page.annotations = [];
  return { libraryId: fixture.libraryId as string, title: '資料Ａ', document };
}

test('projection retains heads and exact variants across surfaces without inventing mappings or tombstone rows', () => {
  const a = source(); a.document.pages[0].annotations = [sticky(1, 'same')];
  a.document.translation!.pages[0].annotations = [sticky(2, 'orphan')];
  a.document.translation!.bindings = [];
  const b = structuredClone(a); b.document.version = id(40);
  const c = structuredClone(a); c.document.version = id(41);
  (c.document.pages[0].annotations[0] as StickyNote).text = 'different';
  c.document.deletedPages.push({ ...structuredClone(c.document.pages[0]), id: id(90), annotations: [sticky(3, 'deleted')] });
  const rows = projectCanonicalAnnotations([c, b, a]);
  assert.equal(rows.length, 3);
  const same = rows.find(row => row.annotation.text === 'same')!;
  assert.deepEqual(same.sourceVersions, [a.document.version, b.document.version].sort());
  assert.notEqual(same.key, rows.find(row => row.annotation.text === 'different')!.key);
  const translated = rows.find(row => row.surface === 'translated')!;
  assert.equal(translated.pageId, a.document.translation!.pages[0].id);
  assert.deepEqual(translated.target.anchor, { xPt: 12.5, yPt: 27.25 });
  assert.equal(translated.target.backgroundRevision, a.document.translation!.pages[0].backgroundRevision);
  assert.deepEqual(rows, projectCanonicalAnnotations([a, b, c]));
  (a.document.pages[0].annotations[0] as StickyNote).text = 'later mutation';
  assert.equal(same.annotation.text, 'same');
  assert.equal(Object.isFrozen(same.annotation.metadata), true);
});

test('NFKC multiword AND combines title, quote, text and label; exact filters never alter stored content', () => {
  const a = source();
  a.document.pages[0].annotations = [sticky(1, 'ＡＢＣ 本文')];
  const highlight: TextHighlight = { kind: 'highlight', id: id(2), backgroundRevision: a.document.translation!.pages[0].backgroundRevision,
    range: { kind: 'unindexed' }, quote: 'Quoted ＡＢＣ', text: '本文', anchor: { x: 5, y: 6 },
    quads: [[{ x: 5, y: 6 }, { x: 20, y: 6 }, { x: 20, y: 15 }, { x: 5, y: 15 }]],
    color: '#ff0', metadata: { label: '分類Ａ', createdAt: null } };
  a.document.translation!.pages[0].annotations = [highlight];
  const b = source(); b.document.id = id(80); b.title = '別資料'; b.document.pages[0].annotations = [sticky(3, 'ABC')];
  const rows = projectCanonicalAnnotations([a, b]);
  const result = filterCanonicalAnnotations(rows, { documentId: a.document.id, surface: 'translated', kind: 'highlight',
    label: '分類Ａ', query: '資料a quoted abc 分類a' });
  assert.equal(result.length, 1); assert.equal(result[0].annotation.quote, 'Quoted ＡＢＣ');
  assert.equal(filterCanonicalAnnotations(rows, { query: 'ABC absent' }).length, 0);
  assert.equal(filterCanonicalAnnotations(rows, { label: '分類A' }).length, 0, 'classification matches its exact stored value');
});

test('creation ordering preserves microseconds and places unknown time last in either direction', () => {
  const a = source();
  a.document.pages[0].annotations = [sticky(1, 'unknown'), sticky(2, 'later', '2026-10-26T01:02:03.000002Z'),
    sticky(3, 'earlier', '2026-10-26T01:02:03.000001Z'), sticky(4, 'whole', '2026-10-26T01:02:03Z')];
  const rows = projectCanonicalAnnotations([a]);
  assert.deepEqual(filterCanonicalAnnotations(rows, { sort: 'created-ascending' }).map(row => row.annotation.text), ['whole', 'earlier', 'later', 'unknown']);
  assert.deepEqual(filterCanonicalAnnotations(rows, { sort: 'created-descending' }).map(row => row.annotation.text), ['later', 'earlier', 'whole', 'unknown']);
  assert.deepEqual(a.document.pages[0].annotations.map(annotation => annotation.id), [id(1), id(2), id(3), id(4)]);
});

test('fixed export captures all filtered rows in order as one safe Markdown payload with exact citations', () => {
  const a = source(); a.document.pages[0].annotations = [sticky(1, '<script>bad()</script>\n![remote](https://invalid/image)')];
  a.document.translation!.pages[1].annotations = [{ ...sticky(2, '訳文本文'), quote: '引用本文' }];
  const rows = filterCanonicalAnnotations(projectCanonicalAnnotations([a]));
  const exported = freezeAnnotationExport(rows);
  assert.equal(exported.rows.length, 2);
  assert.equal(exported.markdown.includes('<script>'), false);
  assert.equal(exported.markdown.includes('![remote]'), false);
  for (const row of rows) assert.ok(exported.markdown.includes(formatMarkdownCitationUri(row.target)));
  assert.ok(exported.markdown.indexOf(formatMarkdownCitationUri(rows[0].target)) < exported.markdown.indexOf(formatMarkdownCitationUri(rows[1].target)));
  assert.equal(exported.rows[1].target.surface, 'translated');
  assert.deepEqual(exported.rows[1].sourceVersions, [a.document.version]);
  assert.equal(Object.isFrozen(exported.rows[0].target.anchor), true);
  a.document.pages[0].annotations = [];
  assert.equal(exported.rows.length, 2); assert.equal(freezeAnnotationExport([]).markdown, '');
});

test('reordering retains stable identity while background replacement and payload changes remain distinct', () => {
  const a = source(); a.document.pages[0].annotations = [sticky(1, 'note')];
  const original = projectCanonicalAnnotations([a])[0];
  a.document.pages.reverse();
  const reordered = projectCanonicalAnnotations([a])[0];
  assert.equal(reordered.key, original.key); assert.notEqual(reordered.pageIndex, original.pageIndex);
  const page = a.document.pages.find(page => page.id === original.pageId)!;
  page.backgroundRevision = id(70);
  assert.notEqual(projectCanonicalAnnotations([a])[0].key, original.key);
});

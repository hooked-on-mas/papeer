import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { convertLegacyInkPage, type LegacyInk, type LegacyInkContext } from '../src/migrations/legacyInk.ts';
import { migrationStableId } from '../src/migrations/stableId.ts';
import { editContentHash } from '../src/runtime/edits/editContentHash.ts';
import { geometryPoints, transformInkPoint } from '../src/runtime/edits/annotationGeometry.ts';
import { type Page, type InkObject, EDIT_LIMITS } from '../src/runtime/edits/contracts.ts';
import { textUnits } from '../src/features/ink/inkGeometry.ts';
import { legacyInkFixture } from './support/legacyInkFixture.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const page = (): Page => structuredClone(fixture.document.pages[0]);
const context = (): LegacyInkContext => ({ libraryId: fixture.libraryId, documentId: fixture.document.id,
  sourceDocumentId: 'old-paper', side: 'original', sourcePageId: '1', sourceRevision: null });
const basic = (): LegacyInk => ({ id: 'old', color: '#123456', width: .002, points: [[.2, .3], [.4, .5]] });
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('migration IDs match frozen Python-hashed golden vectors, including Unicode and ambiguous delimiters', async () => {
  const vectors = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-migration-ids.json', import.meta.url), 'utf8'));
  for (const value of vectors) {
    assert.equal(await editContentHash(['paper-desk-migration-v1', value.libraryId, value.kind, value.source]), value.hash);
    assert.equal(await migrationStableId(value.libraryId, value.kind, value.source), value.targetId);
  }
});

for (const [widthPt, heightPt] of [[612, 792], [842, 595], [200, 1400]]) {
test(`all seven legacy kinds retain physical geometry, styles, text layout and arrow editing size (${widthPt}×${heightPt})`, async () => {
  const target = { ...page(), widthPt, heightPt }, source = legacyInkFixture(widthPt, heightPt), before = structuredClone(source);
  const result = await convertLegacyInkPage(target, source, context());
  assert.equal(result.status, 'converted', JSON.stringify(result)); if (result.status !== 'converted') return;
  assert.deepEqual(source, before); assert.deepEqual(target.annotations, []);
  assert.equal(result.page.annotations.length, source.length);
  for (const [i, old] of source.entries()) {
    const ink = result.page.annotations[i] as InkObject;
    const restored = geometryPoints(ink.geometry).map(point => transformInkPoint(ink, point));
    const expected = old.kind === 'rectangle' ? old.points.slice(0, 4) : old.points;
    assert.equal(restored.length, expected.length);
    restored.forEach((point, index) => { near(point.x, expected[index][0] * widthPt); near(point.y, expected[index][1] * heightPt); });
    near(ink.style.widthPt, old.width * widthPt); assert.equal(ink.style.color, old.color);
    assert.equal(ink.style.opacity, old.kind === 'highlighter' ? .3 : 1);
    assert.equal(ink.style.highlighter, old.kind === 'highlighter');
    assert.equal(result.mappings[i].sourceFingerprint, await editContentHash(old));
    if (ink.geometry.kind === 'text') {
      assert.equal(ink.geometry.text, old.text); const lines = old.text!.split('\n');
      near(ink.geometry.fontSizePt, Math.hypot((old.points[3][0] - old.points[0][0]) * widthPt, (old.points[3][1] - old.points[0][1]) * heightPt) / (lines.length * 1.3));
      near(ink.geometry.widthPt, Math.max(1, ...lines.map(textUnits)) * ink.geometry.fontSizePt);
      near(ink.transform.scaleX, 1.4);
    }
    if (ink.geometry.kind === 'arrow') {
      near(ink.geometry.preferredHeadLengthPt!, (old.arrowHeadLength ?? .025) * widthPt);
      assert.ok(ink.geometry.headLengthPt <= ink.geometry.preferredHeadLengthPt! + 1e-7);
      if (old.id === 'short-arrow') assert.ok(ink.geometry.headLengthPt < ink.geometry.preferredHeadLengthPt!);
    }
  }
});
}

test('source keys generate stable IDs across retries/order/changed data and isolate library/side/page identities', async () => {
  const source = [basic(), { ...basic(), id: 'second' }];
  const first = await convertLegacyInkPage(page(), source, context());
  const second = await convertLegacyInkPage(page(), [...source].reverse(), context());
  assert.deepEqual([...first.mappings].reverse(), second.mappings);
  const changed = await convertLegacyInkPage(page(), [{ ...basic(), color: '#654321' }], context());
  assert.equal(changed.mappings[0].targetId, first.mappings[0].targetId);
  assert.notEqual(changed.mappings[0].sourceFingerprint, first.mappings[0].sourceFingerprint);
  for (const patch of [{ side: 'translated' as const }, { sourcePageId: '2' }, { sourceDocumentId: 'another' }, { libraryId: fixture.document.id }]) {
    const other = await convertLegacyInkPage(page(), [basic()], { ...context(), ...patch });
    assert.notEqual(other.mappings[0].targetId, first.mappings[0].targetId);
  }
  assert.notEqual(await migrationStableId(fixture.libraryId, 'ink', ['a/b', 'c']), await migrationStableId(fixture.libraryId, 'ink', ['a', 'b/c']));
  assert.notEqual(await migrationStableId(fixture.libraryId, 'page', ['a']), await migrationStableId(fixture.libraryId, 'ink', ['a']));
  await assert.rejects(migrationStableId('invalid', 'ink', ['a']));
  await assert.rejects(migrationStableId(fixture.libraryId, '', ['a']));
});

test('the converter captures immutable inputs before any asynchronous hashing', async () => {
  const target = page(), source = [basic()], ctx = context();
  const pending = convertLegacyInkPage(target, source, ctx);
  target.widthPt = 1; source[0].points[0][0] = .9; source.push({ ...basic(), id: 'late' }); ctx.sourcePageId = 'late';
  const result = await pending; assert.equal(result.status, 'converted'); if (result.status !== 'converted') return;
  const ink = result.page.annotations[0] as InkObject;
  assert.equal(result.page.annotations.length, 1); assert.equal(result.mappings[0].source[2], '1');
  assert.equal(ink.geometry.kind, 'path'); if (ink.geometry.kind === 'path') near(ink.geometry.points[0].x, .2 * page().widthPt);
});

test('null native optional metadata and zero visible arrow heads remain representable', async () => {
  const result = await convertLegacyInkPage(page(), [
    { ...basic(), text: null, arrowHeadLength: null },
    { ...basic(), id: 'zero-head', kind: 'arrow', arrowHeadLength: .025, points: [[.2, .3], [.4, .5], [.4, .5], [.4, .5], [.4, .5]] },
  ], context());
  assert.equal(result.status, 'converted', JSON.stringify(result)); if (result.status !== 'converted') return;
  assert.equal((result.page.annotations[1] as InkObject).geometry.kind, 'arrow');
});

test('PDF migration requires the exact captured resource revision and never substitutes original for translation', async () => {
  const target: Page = structuredClone(fixture.publications[0].value.content.pages[0]);
  assert.equal(target.background.kind, 'pdf'); if (target.background.kind !== 'pdf') return;
  const ctx = { ...context(), sourceRevision: target.background.sourceRevision, side: 'translated' as const };
  const good = await convertLegacyInkPage(target, [basic()], ctx); assert.equal(good.status, 'converted');
  const bad = await convertLegacyInkPage(target, [basic()], { ...ctx, sourceRevision: 'f'.repeat(64) });
  assert.equal(bad.status, 'blocked'); if (bad.status === 'blocked') assert.match(bad.issues[0].detail, /background-mismatch/);
});

test('every invalid source row blocks the whole page and reports its key without modifying inputs', async () => {
  const source = [basic(), { ...basic(), id: 'unknown', extra: true }, { ...basic(), id: 'bad-point', points: [[NaN, .2]] },
    { ...basic(), id: 'bad-line', kind: 'line', points: [[.2, .2], [.2, .2]] },
    { ...basic(), id: 'bad-arrow', kind: 'arrow' }, null, { ...basic(), id: 'bad-text', kind: 'text', text: '' },
    { ...basic(), id: 'bad-width', width: .09 }, { ...basic(), id: 'bad-color', color: '#123456\n' }, { ...basic(), id: 'old' }];
  const before = structuredClone(source), result = await convertLegacyInkPage(page(), source, context());
  assert.equal(result.status, 'blocked'); if (result.status !== 'blocked') return;
  assert.equal(result.issues.length, source.length - 1); assert.equal('page' in result, false);
  assert.deepEqual(result.issues.map(issue => issue.source[issue.source.length - 1]), ['unknown', 'bad-point', 'bad-line', 'bad-arrow', 'row:5', 'bad-text', 'bad-width', 'bad-color', 'old']);
  assert.deepEqual(source, before);
});

test('nonrepresentable ellipse/box/arrow points are reported instead of silently flattening or changing their shape', async () => {
  const source = legacyInkFixture(page().widthPt, page().heightPt).filter(stroke => ['ellipse', 'rectangle', 'arrow'].includes(stroke.id));
  source.forEach(stroke => { stroke.points[2][0] += .001; });
  const result = await convertLegacyInkPage(page(), source, context());
  assert.equal(result.status, 'blocked'); if (result.status === 'blocked') assert.equal(result.issues.length, 3);
});

test('empty/malformed pages and over-limit targets are blocked even when there is no ink to hash', async () => {
  assert.equal((await convertLegacyInkPage(page(), [], null as unknown as LegacyInkContext)).status, 'blocked');
  for (const [target, strokes, ctx] of [
    [page(), [], { ...context(), libraryId: 'invalid' }], [page(), {}, context()],
    [{ ...page(), widthPt: 0 }, [], context()], [page(), [], { ...context(), sourceRevision: 'bad' }],
    [page(), [() => 1], context()], [page(), Array.from({ length: EDIT_LIMITS.objects + 1 }, (_, i) => ({ ...basic(), id: String(i) })), context()],
  ] as const) {
    const result = await convertLegacyInkPage(target, strokes, ctx);
    assert.equal(result.status, 'blocked'); assert.equal('page' in result, false);
  }
  assert.equal((await convertLegacyInkPage(page(), [], context())).status, 'converted');
});


test('synthetic frozen notebook entry projects stable paper and real legacy ink without mutating its source', async () => {
  const { projectLegacyNotebookEntry } = await import('../src/migrations/legacyNotebookProjection.ts');
  const { resourceHash } = await import('../src/runtime/edits/contentPublication.ts');
  const notebook = { version: 1, revision: 1, pages: [{ id: '0123456789abcdef0123456789abcdef', size: 'A4', orientation: 'portrait', width_mm: 210, height_mm: 297, template: 'ruled7', color: 'white' }] };
  const bytes = new TextEncoder().encode(JSON.stringify(notebook));
  const ink = legacyInkFixture(210 * 72 / 25.4, 297 * 72 / 25.4);
  const input = { libraryId: fixture.libraryId, sourceDocumentId: 'fedcba9876543210fedcba9876543210', entry: { sha256: await resourceHash(bytes), byteLength: bytes.byteLength }, bytes, annotations: [{ pageId: notebook.pages[0].id, ink, bookmarks: [] }] };
  const before = structuredClone(input), first = await projectLegacyNotebookEntry(input), second = await projectLegacyNotebookEntry(input);
  assert.deepEqual(input, before); assert.deepEqual(first, second);
  assert.equal(first.document.pages.length, 1); assert.equal(first.document.pages[0].background.kind, 'paper');
  assert.equal(first.document.pages[0].annotations.length, ink.length); assert.equal(first.provenance.notebookSha256, input.entry.sha256);
  assert.deepEqual(first.incomplete, ['library-metadata','other-source-coverage','publication-and-activation']);
  const changed = structuredClone(input); changed.annotations[0].ink[0].color = '#abcdef';
  const changedProjection = await projectLegacyNotebookEntry(changed);
  assert.notEqual(changedProjection.document.version, first.document.version);
  assert.notEqual(changedProjection.provenance.annotationDataSha256, first.provenance.annotationDataSha256);
  // Named properties on an Array are consumed like a record but omitted by the array hash.
  const arrayRow = Object.assign([], {
    pageId: input.annotations[0].pageId,
    ink: structuredClone(input.annotations[0].ink),
    bookmarks: structuredClone(input.annotations[0].bookmarks),
  });
  const malformed = { ...input, annotations: [arrayRow] } as unknown as typeof input;
  await assert.rejects(projectLegacyNotebookEntry(malformed), /notebook-annotation-coverage-unsupported/);
  const invalid = structuredClone(input); invalid.bytes[0] ^= 1;
  await assert.rejects(projectLegacyNotebookEntry(invalid), /notebook-entry-mismatch/);
});


test('notebook projection preserves page order and refuses unsupported or incomplete input', async () => {
  const { projectLegacyNotebookEntry } = await import('../src/migrations/legacyNotebookProjection.ts');
  const { resourceHash } = await import('../src/runtime/edits/contentPublication.ts');
  const { legacyBookmarkFixture } = await import('./support/legacyBookmarkFixture.ts');
  const sourceDocumentId = 'fedcba9876543210fedcba9876543210';
  const firstId = '0123456789abcdef0123456789abcdef', secondId = '1123456789abcdef0123456789abcdef';
  const first = { id: firstId, size: 'A4', orientation: 'portrait', width_mm: 210, height_mm: 297, template: 'ruled7', color: 'white' };
  const second = { id: secondId, size: 'A5', orientation: 'landscape', width_mm: 210, height_mm: 148, template: 'grid5', color: 'cream' };
  const notebook = { version: 1, revision: 2, pages: [first, second] };
  const encode = async (value: unknown) => { const bytes = new TextEncoder().encode(JSON.stringify(value)); return { bytes, entry: { sha256: await resourceHash(bytes), byteLength: bytes.length } }; };
  const annotations = [{ pageId: firstId, ink: legacyInkFixture(210 * 72 / 25.4, 297 * 72 / 25.4), bookmarks: legacyBookmarkFixture(sourceDocumentId, 1) },
    { pageId: secondId, ink: [], bookmarks: [] }];
  const input = { libraryId: fixture.libraryId, sourceDocumentId, ...await encode(notebook), annotations };
  const before = structuredClone(input), projected = await projectLegacyNotebookEntry(input);
  assert.deepEqual(input, before);
  assert.deepEqual(projected.pageMappings.map(value => value.sourcePageId), [firstId, secondId]);
  assert.deepEqual(projected.document.pages.map(value => value.id), projected.pageMappings.map(value => value.targetPageId));
  assert.equal(projected.document.pages[1].widthPt, 210 * 72 / 25.4);
  const changed = structuredClone(input); changed.annotations[0].bookmarks[0].note = 'changed';
  assert.notEqual((await projectLegacyNotebookEntry(changed)).document.version, projected.document.version);
  for (const value of [
    { ...notebook, unknown: true },
    { ...notebook, pages: [first, { ...second, id: firstId }] },
    { ...notebook, pages: [first, { ...second, width_mm: 209 }] },
  ]) {
    // Match annotation coverage so duplicate page IDs reach the page validator.
    const matchingAnnotations = input.annotations.map((annotation, index) => ({
      ...annotation, pageId: value.pages[index].id,
    }));
    await assert.rejects(projectLegacyNotebookEntry({ ...input, ...await encode(value), annotations: matchingAnnotations }),
      /notebook-(shape|page|geometry)-unsupported/);
  }
  await assert.rejects(projectLegacyNotebookEntry({ ...input, annotations: [annotations[0]] }), /notebook-shape-unsupported/);
  await assert.rejects(projectLegacyNotebookEntry({ ...input, annotations: [annotations[1], annotations[0]] }), /notebook-annotation-coverage-unsupported/);
  assert.deepEqual(input, before);
});

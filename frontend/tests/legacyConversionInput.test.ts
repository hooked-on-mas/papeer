import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { editContentHash } from '../src/runtime/edits/editContentHash.ts';
import {
  assertConversionInputManifest, projectConversionInputNotebooks, type ConversionInputManifest, type NotebookExtraction,
} from '../src/migrations/legacyConversionInput.ts';
import { legacyBookmarkFixture } from './support/legacyBookmarkFixture.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const hex = (seed: string) => createHash('sha256').update(seed).digest('hex');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stroke = (name: string) => ({ id: name, color: '#123456', width: .002, points: [[.2, .3], [.4, .5]] });
const A = 'a'.repeat(32), B = 'b'.repeat(32);
const pageId = (note: string, number: number) => note[0].repeat(31) + String(number);

type Layout = { note: string; pages: number; ink: Record<number, number>; notes: Record<number, number>; highlights: Record<number, number> };
// Same shapes as the Python main fixture: A has 2 pages (note on 1; 2 strokes and a highlight on 2), B has 3 pages
// (1 stroke on 1, 2 strokes on 3, two notes on 2).
const layouts: Layout[] = [
  { note: A, pages: 2, ink: { 2: 2 }, notes: { 1: 1 }, highlights: { 2: 1 } },
  { note: B, pages: 3, ink: { 1: 1, 3: 2 }, notes: { 2: 2 }, highlights: {} },
];

function extraction(layout: Layout): NotebookExtraction {
  const pages = Array.from({ length: layout.pages }, (_, index) => ({ id: pageId(layout.note, index + 1), size: 'A4', orientation: 'portrait',
    width_mm: 210, height_mm: 297, template: 'blank', color: 'white' }));
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, revision: 1, pages }));
  let nextId = 1;
  const marks = legacyBookmarkFixture(layout.note, 1);
  const note = marks.find(mark => mark.kind === 'note')!, highlight = marks.find(mark => mark.kind === 'highlight')!;
  return {
    libraryId: fixture.libraryId, sourceDocumentId: layout.note, entry: { sha256: sha(bytes), byteLength: bytes.byteLength }, bytes,
    annotations: pages.map((page, index) => ({
      pageId: page.id,
      ink: Array.from({ length: layout.ink[index + 1] ?? 0 }, (_, count) => stroke(`s${index}-${count}`)),
      bookmarks: [
        ...Array.from({ length: layout.notes[index + 1] ?? 0 }, () => ({ ...note, id: nextId++, page: index + 1 })),
        ...Array.from({ length: layout.highlights[index + 1] ?? 0 }, () => ({ ...highlight, id: nextId++, page: index + 1 })),
      ],
    })),
  };
}

function notebookEntry(layout: Layout, value: NotebookExtraction): ConversionInputManifest['notebooks'][number] {
  const ids = value.annotations.map(item => item.pageId);
  const ink = value.annotations.flatMap((item, index) => (item.ink as unknown[]).length
    ? [{ side: 'original', page: index + 1, pageId: item.pageId, strokeCount: (item.ink as unknown[]).length }] : []);
  const bookmarks = value.annotations.flatMap((item, index) => (item.bookmarks as { id: number; kind: string }[]).map(mark =>
    ({ id: String(mark.id), page: index + 1, side: 'original', kind: mark.kind, pageId: item.pageId })));
  return { sourceDocumentId: layout.note, notebookEntry: { ...value.entry }, pageIds: ids,
    rows: { pages: ids.map((id, index) => ({ number: index + 1, pageId: id })), ink, bookmarks },
    status: 'extracted', reason: null, coverage: { pageRows: ids.length, inkRows: ink.length, bookmarkRows: bookmarks.length },
    incomplete: ['page-text-not-converted'] };
}

async function seal(manifest: ConversionInputManifest): Promise<ConversionInputManifest> {
  const { manifestSha256: _old, ...body } = manifest;
  return { ...body, manifestSha256: await editContentHash(body) };
}

async function scenario() {
  const extractions = new Map(layouts.map(layout => [layout.note, extraction(layout)]));
  const manifest = await seal({
    version: 1, scope: 'native-legacy-conversion-input-v1', runId: randomUUID(), peerId: randomUUID(), libraryId: fixture.libraryId,
    journalRecordSha256: hex('record'), selectionSha256: hex('selection'), inputSetSha256: hex('inputs'),
    sources: (['desktop-library', 'canonical', 'device'] as const).map(kind => ({ kind, sourceId: hex('source-' + kind), backupId: randomUUID(),
      planSha256: hex('plan-' + kind), observationSha256: hex('observation-' + kind), inventorySha256: hex('inventory-' + kind), entryCount: 12, totalBytes: 3456 })),
    inventory: { reportSha256: hex('report'), summary: { supported: 40, retainedBlocking: 6, unknown: 0, blockingReasons: ['messages-not-converted'] } },
    sqlite: { journalMode: 'rollback', walEntries: [], walComplete: true, userVersion: 9, quickCheck: 'ok', notebooksListable: true },
    notebooks: layouts.map(layout => notebookEntry(layout, extractions.get(layout.note)!)),
    wholeLibrary: { status: 'refused', reasons: ['messages-not-converted', 'uncollected-source'] }, manifestSha256: '0'.repeat(64),
  });
  return { manifest, extractions };
}
const code = (name: string) => (error: unknown) => error instanceof Error && error.message === name;

test('both extracted Notebooks convert, the counts match the manifest, and the whole Library stays refused', async () => {
  const { manifest, extractions } = await scenario();
  const before = structuredClone({ manifest, extractions: [...extractions] });
  const result = await projectConversionInputNotebooks(manifest, extractions);
  assert.deepEqual(result.notebooks.map(item => item.status), ['converted', 'converted']);
  const [a, b] = result.notebooks;
  assert.ok(a.status === 'converted' && b.status === 'converted');
  if (a.status !== 'converted' || b.status !== 'converted') return;
  assert.deepEqual(a.counts, { pages: 2, ink: 2, sticky: 1, highlight: 1 });
  assert.deepEqual(b.counts, { pages: 3, ink: 3, sticky: 2, highlight: 0 });
  assert.deepEqual(a.pageMappings.map(item => item.sourcePageId), manifest.notebooks[0].pageIds);
  assert.deepEqual(b.pageMappings.map(item => item.sourcePageId), manifest.notebooks[1].pageIds);
  assert.deepEqual(a.document.pages.map(page => page.annotations.map(item => item.kind)), [['sticky'], ['ink', 'ink', 'highlight']]);
  assert.deepEqual(result.wholeLibrary, { status: 'refused', reasons: ['messages-not-converted', 'uncollected-source'] });
  assert.deepEqual(structuredClone({ manifest, extractions: [...extractions] }), before);     // inputs are never changed
});

test('the manifest shape is checked exactly: unknown keys, wrong types, duplicates, bad hashes, negative counts and an accepted whole Library', async () => {
  const mutations: [string, (manifest: Record<string, any>) => void][] = [
    ['unknown top-level key', manifest => { manifest.extra = 1; }],
    ['missing key', manifest => { delete manifest.peerId; }],
    ['scope', manifest => { manifest.scope = 'native-legacy-conversion-input-v2'; }],
    ['version', manifest => { manifest.version = 2; }],
    ['id that is not an Id', manifest => { manifest.runId = 'not-an-id'; }],
    ['duplicate page id', manifest => { manifest.notebooks[0].pageIds[1] = manifest.notebooks[0].pageIds[0]; }],
    ['duplicate notebook', manifest => { manifest.notebooks[1] = structuredClone(manifest.notebooks[0]); }],
    ['hash that is not 64 lowercase hex digits', manifest => { manifest.sources[0].planSha256 = 'A'.repeat(64); }],
    ['short hash', manifest => { manifest.inputSetSha256 = 'a'.repeat(63); }],
    ['negative count', manifest => { manifest.sources[1].entryCount = -1; }],
    ['non-integer count', manifest => { manifest.sources[1].totalBytes = 1.5; }],
    ['source order', manifest => { manifest.sources.reverse(); }],
    ['duplicate backup id', manifest => { manifest.sources[1].backupId = manifest.sources[0].backupId; }],
    ['unknown key in a notebook', manifest => { manifest.notebooks[0].extra = true; }],
    ['unknown key in a row', manifest => { manifest.notebooks[0].rows.ink[0].extra = true; }],
    ['negative stroke count', manifest => { manifest.notebooks[0].rows.ink[0].strokeCount = -1; }],
    ['coverage that disagrees with the rows', manifest => { manifest.notebooks[0].coverage.inkRows = 5; }],
    ['row naming a page that is not in the Notebook', manifest => { manifest.notebooks[0].rows.ink[0].pageId = 'c'.repeat(32); }],
    ['extracted Notebook that carries a reason', manifest => { manifest.notebooks[0].reason = 'some-reason'; }],
    ['blocked Notebook that still has coverage', manifest => { manifest.notebooks[0].status = 'blocked'; manifest.notebooks[0].reason = 'x'; }],
    ['status', manifest => { manifest.notebooks[0].status = 'converted'; }],
    ['whole Library accepted', manifest => { manifest.wholeLibrary.status = 'accepted'; }],
    ['whole Library reasons empty', manifest => { manifest.wholeLibrary.reasons = []; }],
    ['whole Library reasons without the uncollected sources', manifest => { manifest.wholeLibrary.reasons = ['messages-not-converted']; }],
    ['whole Library reasons unsorted', manifest => { manifest.wholeLibrary.reasons.reverse(); }],
    ['whole Library reasons that the inventory does not give', manifest => { manifest.wholeLibrary.reasons = ['invented-reason', 'messages-not-converted', 'uncollected-source']; }],
    ['unknown key in whole Library', manifest => { manifest.wholeLibrary.accepted = false; }],
    ['Notebooks without a listable database', manifest => { manifest.sqlite.notebooksListable = false; }],
    ['Notebooks without a database', manifest => { manifest.sqlite = null; }],
    ['wal entry that is not a companion file', manifest => { manifest.sqlite.walEntries = ['other']; }],
  ];
  for (const [name, mutate] of mutations) {
    const { manifest, extractions } = await scenario();
    const changed: Record<string, any> = structuredClone(manifest);
    mutate(changed);
    await assert.rejects(projectConversionInputNotebooks(await seal(changed as ConversionInputManifest), extractions), code('conversion-input-manifest-invalid'), name);
  }
  const { manifest } = await scenario();
  assert.doesNotThrow(() => assertConversionInputManifest(manifest));
  assert.throws(() => assertConversionInputManifest(null), code('conversion-input-manifest-invalid'));
  assert.throws(() => assertConversionInputManifest([]), code('conversion-input-manifest-invalid'));
  assert.throws(() => assertConversionInputManifest(Object.create({ inherited: 1 })), code('conversion-input-manifest-invalid'));
});

test('a manifest whose hash is not the content hash of the rest is refused', async () => {
  const { manifest, extractions } = await scenario();
  const edited = structuredClone(manifest);
  edited.sources[0].totalBytes += 1;                                       // not re-sealed
  await assert.rejects(projectConversionInputNotebooks(edited, extractions), code('conversion-input-manifest-invalid'));
  await assert.rejects(projectConversionInputNotebooks({ ...manifest, manifestSha256: 'f'.repeat(64) }, extractions), code('conversion-input-manifest-invalid'));
  await assert.rejects(projectConversionInputNotebooks(() => 1, extractions), code('conversion-input-manifest-invalid'));
});

test('an extraction that is not the verified entry of the manifest is refused', async () => {
  const cases: [string, (value: NotebookExtraction) => void][] = [
    ['entry hash', value => { value.entry.sha256 = hex('other'); }],
    ['entry length', value => { value.entry.byteLength += 1; }],
    ['bytes with the same length', value => { value.bytes[value.bytes.length - 3] ^= 1; }],
    ['bytes of another length', value => { value.bytes = value.bytes.slice(1); }],
    ['library id', value => { value.libraryId = randomUUID(); }],
    ['source document id', value => { value.sourceDocumentId = B; }],
  ];
  for (const [name, mutate] of cases) {
    const { manifest, extractions } = await scenario();
    mutate(extractions.get(A)!);
    await assert.rejects(projectConversionInputNotebooks(manifest, extractions), code('conversion-input-entry-mismatch'), name);
  }
  const { manifest, extractions } = await scenario();
  (extractions.get(A) as unknown as Record<string, unknown>).coverage = {};
  await assert.rejects(projectConversionInputNotebooks(manifest, extractions), code('conversion-input-entry-mismatch'), 'extra key');
});

test('a count that differs from the manifest is refused, in the extraction and in the manifest alike', async () => {
  const fromExtraction: [string, (value: NotebookExtraction) => void][] = [
    ['one stroke fewer', value => { (value.annotations[1].ink as unknown[]).pop(); }],
    ['one stroke more', value => { (value.annotations[1].ink as unknown[]).push({ ...stroke('late') }); }],
    ['one bookmark fewer', value => { (value.annotations[0].bookmarks as unknown[]).pop(); }],
    ['one highlight fewer', value => { (value.annotations[1].bookmarks as unknown[]).pop(); }],
  ];
  for (const [name, mutate] of fromExtraction) {
    const { manifest, extractions } = await scenario();
    mutate(extractions.get(A)!);
    await assert.rejects(projectConversionInputNotebooks(manifest, extractions), code('conversion-input-count-mismatch'), name);
  }
  const fromManifest: [string, (notebook: Record<string, any>) => void][] = [
    ['stroke count in a row', notebook => { notebook.rows.ink[0].strokeCount += 1; }],
    ['a note counted as a highlight', notebook => { notebook.rows.bookmarks[0].kind = 'highlight'; }],
    ['a bookmark row moved to another page', notebook => { notebook.rows.bookmarks[0].pageId = notebook.pageIds[1]; notebook.rows.bookmarks[0].page = 2; }],
    // Same totals, different page: only the per-page highlight check catches this (the totals of sticky and highlight stay equal).
    ['a highlight row moved to another page', notebook => {
      const row = notebook.rows.bookmarks.find((item: any) => item.kind === 'highlight');
      assert.equal(row.page, 2); row.pageId = notebook.pageIds[0]; row.page = 1;
    }],
  ];
  for (const [name, mutate] of fromManifest) {
    const { manifest, extractions } = await scenario();
    const changed: Record<string, any> = structuredClone(manifest);
    mutate(changed.notebooks[0]);
    await assert.rejects(projectConversionInputNotebooks(await seal(changed as ConversionInputManifest), extractions), code('conversion-input-count-mismatch'), name);
  }
});

test('page ids in the notebook file must be the pages that the manifest lists', async () => {
  const { manifest, extractions } = await scenario();
  const changed: Record<string, any> = structuredClone(manifest);
  const book = changed.notebooks[0];
  book.pageIds.reverse();                                                  // the manifest now disagrees with notebook.json about the order
  book.rows.pages.forEach((row: any, index: number) => { row.pageId = book.pageIds[index]; });
  book.rows.ink.forEach((row: any) => { row.pageId = book.pageIds[row.page - 1]; });
  book.rows.bookmarks.forEach((row: any) => { row.pageId = book.pageIds[row.page - 1]; });
  await assert.rejects(projectConversionInputNotebooks(await seal(changed as ConversionInputManifest), extractions), code('conversion-input-count-mismatch'));
});

test('a Notebook that the manifest calls blocked is never converted, and an extraction for it is refused', async () => {
  const { manifest, extractions } = await scenario();
  const changed: Record<string, any> = structuredClone(manifest);
  Object.assign(changed.notebooks[1], { status: 'blocked', reason: 'legacy-notebook-recovery-pending', coverage: null, incomplete: [] });
  changed.wholeLibrary.reasons = ['messages-not-converted', 'notebook-extraction-blocked', 'uncollected-source'];
  const sealed = await seal(changed as ConversionInputManifest);
  const only = new Map([[A, extractions.get(A)!]]);
  const result = await projectConversionInputNotebooks(sealed, only);
  assert.deepEqual(result.notebooks.map(item => [item.sourceDocumentId, item.status]), [[A, 'converted'], [B, 'blocked']]);
  assert.equal(result.notebooks[1].status === 'blocked' && result.notebooks[1].reason, 'legacy-notebook-recovery-pending');
  assert.equal('document' in result.notebooks[1], false);
  assert.deepEqual(result.wholeLibrary, { status: 'refused', reasons: ['messages-not-converted', 'notebook-extraction-blocked', 'uncollected-source'] });
  await assert.rejects(projectConversionInputNotebooks(sealed, extractions), code('conversion-input-extraction-unexpected'));
  // The reason that a blocked Notebook adds to the whole-Library list is required, not optional.
  const forgotten: Record<string, any> = structuredClone(changed);
  forgotten.wholeLibrary.reasons = ['messages-not-converted', 'uncollected-source'];
  await assert.rejects(projectConversionInputNotebooks(await seal(forgotten as ConversionInputManifest), only), code('conversion-input-manifest-invalid'));
});

test('an extracted Notebook without its extraction, or an extraction nobody asked for, is refused', async () => {
  const { manifest, extractions } = await scenario();
  await assert.rejects(projectConversionInputNotebooks(manifest, new Map([[A, extractions.get(A)!]])), code('conversion-input-extraction-missing'));
  const extra = new Map(extractions);
  extra.set('c'.repeat(32), extraction({ ...layouts[0], note: 'c'.repeat(32) }));
  await assert.rejects(projectConversionInputNotebooks(manifest, extra), code('conversion-input-extraction-unexpected'));
});

test('a stroke that the converter cannot represent blocks that Notebook with a closed code instead of converting part of it', async () => {
  const { manifest, extractions } = await scenario();
  (extractions.get(A)!.annotations[1].ink as { color: string }[])[0].color = 'red';           // same counts, invalid source stroke
  const result = await projectConversionInputNotebooks(manifest, extractions);
  assert.deepEqual(result.notebooks.map(item => item.status), ['blocked', 'converted']);
  assert.match((result.notebooks[0] as { reason: string }).reason, /^[a-z0-9-]{1,96}$/);
  assert.equal('document' in result.notebooks[0], false);
});

test('inputs changed after the call started do not reach the checks', async () => {
  const { manifest, extractions } = await scenario();
  const pending = projectConversionInputNotebooks(manifest, extractions);
  manifest.notebooks[0].rows.ink[0].strokeCount = 9;
  (manifest.wholeLibrary as { status: string }).status = 'accepted';
  (extractions.get(A)!.annotations[1].ink as unknown[]).pop();
  const result = await pending;
  assert.deepEqual(result.notebooks.map(item => item.status), ['converted', 'converted']);
  assert.equal(result.wholeLibrary.status, 'refused');
});

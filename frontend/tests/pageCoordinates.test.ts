import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pdfPageCoordinates, transformPoint, resizePaper } from '../src/runtime/edits/pageCoordinates.ts';
import { deletedContent } from '../src/features/library/recovery/deletedContent.ts';
import { EditGraph } from '../src/runtime/edits/editGraph.ts';
import { readFileSync } from 'node:fs';
import type { EditBatch, DocumentSnapshot, LibrarySnapshot } from '../src/runtime/edits/contracts.ts';
const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const id = (value: number) => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const batch = (value: number): EditBatch => fixture.batches.find((edit: EditBatch) => edit.id === id(value));

test('canonical CropBox/UserUnit/Rotate coordinates round-trip independently of CSS size or DPR', () => {
  for (const rotation of [0, 90, 180, 270, -90, 450]) for (const unit of [.5, 1, 2]) {
    const viewport = pdfPageCoordinates([20, -10, 220, 290], unit, rotation);
    const points = [{ x: 20, y: -10 }, { x: 220, y: -10 }, { x: 220, y: 290 }, { x: 20, y: 290 }];
    for (const point of points) {
      const rendered = transformPoint(viewport.fromPdf, point), back = transformPoint(viewport.toPdf, rendered);
      assert.ok(rendered.x >= 0 && rendered.y >= 0 && rendered.x <= viewport.widthPt && rendered.y <= viewport.heightPt);
      assert.ok(Math.abs(back.x - point.x) < 1e-9 && Math.abs(back.y - point.y) < 1e-9);
    }
  }
});
test('paper resize preserves physical coordinates, rejects overflow and uniformly fits shapes/highlights/anchors', () => {
  const graph = new EditGraph({ version: 1, libraryId: fixture.libraryId, root: fixture.document, batches: [batch(201)] });
  const page = (graph.snapshot(id(201)) as DocumentSnapshot).pages[0];
  assert.throws(() => resizePaper(page, 40, 40, id(600)), /paper-content-overflow/);
  const fitted = resizePaper(page, 306, 396, id(600), true), ink = fitted.annotations[0];
  assert.ok(ink.kind === 'ink'); assert.equal(ink.transform.scaleX, .5); assert.equal(ink.transform.scaleY, .5);
  assert.equal(ink.transform.x, 10); assert.equal(ink.style.widthPt * ink.transform.scaleX, 1);
  const unchanged = resizePaper(page, 700, 900, id(601));
  assert.deepEqual(unchanged.annotations, page.annotations);
});
test('deletion recovery exposes late child edits and keeps content reachable after catalog restore', () => {
  const catalog = new EditGraph({ version: 1, libraryId: fixture.libraryId, root: fixture.library, batches: [batch(301)] });
  const document = new EditGraph({ version: 1, libraryId: fixture.libraryId, root: fixture.document, batches: [] });
  const md = new EditGraph({ version: 1, libraryId: fixture.libraryId, root: fixture.markdown, batches: [] });
  const graphs = new Map([[document.root.id, document], [md.root.id, md]]);
  assert.ok(deletedContent(catalog.snapshot(id(301)) as LibrarySnapshot, graphs).every(row => row.state === 'observed'));
  md.receive([batch(502)]);
  const rows = deletedContent(catalog.snapshot(id(301)) as LibrarySnapshot, graphs);
  assert.equal(rows.find(row => row.itemId === md.root.id)?.state, 'unobserved');
  catalog.receive([batch(302)]);
  assert.deepEqual(deletedContent(catalog.snapshot(id(302)) as LibrarySnapshot, graphs), []);
  assert.equal(md.snapshot(id(502))?.kind === 'markdown' && (md.snapshot(id(502)) as { content: string }).content, 'remote');
});

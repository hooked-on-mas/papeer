import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalPdfCapturePlan } from '../../../src/features/reader/pdf/canonicalPdfCapturePlan.ts';
import type { Page } from '../../../src/runtime/edits/contracts.ts';
const id = '00000000-0000-4000-8000-000000000001', sha256 = 'a'.repeat(64);
const page: Page = { id, backgroundRevision: id, lifecycleVersion: id, annotationVersion: id, widthPt: 600, heightPt: 800,
  annotations: [], background: { kind: 'pdf', resourceId: id, sourceRevision: sha256, pdfPage: 1 } };
test('capture area is converted from physical points independently of display zoom', () => {
  assert.deepEqual(canonicalPdfCapturePlan(page, { x: .25, y: .5, width: .5, height: .25 }),
    { width: 600, height: 400, scale: 2, xPt: 150, yPt: 400, widthPt: 300, heightPt: 200 });
});
test('capture bounds and allocations are bounded, including extreme physical sizes', () => {
  for (const width of [0, -1, NaN, Infinity, 1.01]) assert.throws(() => canonicalPdfCapturePlan(page, { x: 0, y: 0, width, height: 1 }));
  for (const size of [1e7, 1e150]) {
    const plan = canonicalPdfCapturePlan({ ...page, widthPt: size, heightPt: size }, { x: 0, y: 0, width: 1, height: 1 });
    assert.ok(plan.width * plan.height <= 4_000_000); assert.ok(plan.width > 0 && plan.height > 0);
  }
  assert.throws(() => canonicalPdfCapturePlan(page, { x: 0, y: 0, width: 1, height: 1 }, 4_000_001));
});

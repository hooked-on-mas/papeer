import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import type { InkObject, Page } from '../src/runtime/edits/contracts.ts';
import { annotationPoints, geometryPoints, transformInkPoint } from '../src/runtime/edits/annotationGeometry.ts';
import { assertSnapshot } from '../src/runtime/edits/editModel.ts';
import { resizePaper } from '../src/runtime/edits/pageCoordinates.ts';
const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const ink = (): InkObject => structuredClone(fixture.batches[0].changes[0].annotation);
const snapshot = (annotation: InkObject) => ({ ...structuredClone(fixture.document), pages: [{ ...fixture.document.pages[0], annotations: [annotation] }] });

test('rotated anisotropic ellipse uses exact curve bounds rather than empty bounding-box corners', () => {
  const ellipse = ink(), angle = Math.PI / 4;
  ellipse.geometry = { kind: 'ellipse', widthPt: 100, heightPt: 20 };
  ellipse.transform = { x: 50 - Math.cos(angle) * 50 + Math.sin(angle) * 10,
    y: 50 - Math.sin(angle) * 50 - Math.cos(angle) * 10, rotationRad: angle, scaleX: 1, scaleY: 1 };
  const points = annotationPoints(ellipse), radius = Math.sqrt(1300);
  for (const axis of ['x', 'y'] as const) {
    assert.ok(Math.abs(Math.min(...points.map(point => point[axis])) - (50 - radius)) < 1e-9);
    assert.ok(Math.abs(Math.max(...points.map(point => point[axis])) - (50 + radius)) < 1e-9);
  }
  const page: Page = { ...fixture.document.pages[0], widthPt: 100, heightPt: 100, annotations: [ellipse] };
  assert.deepEqual(resizePaper(page, 90, 90, crypto.randomUUID()).annotations[0], ellipse);
  assert.throws(() => resizePaper(page, 80, 80, crypto.randomUUID()), /paper-content-overflow/);
  // Non-uniform positive scale is still an ellipse; every dense curve sample lies inside exact extrema.
  ellipse.transform.scaleX = 1.7; ellipse.transform.scaleY = .6;
  const extrema = annotationPoints(ellipse), dense = Array.from({ length: 5000 }, (_, i) => {
    const a = i * 2 * Math.PI / 5000; return transformInkPoint(ellipse, { x: 50 * (1 + Math.cos(a)), y: 10 * (1 + Math.sin(a)) });
  });
  for (const axis of ['x', 'y'] as const) {
    const lower = Math.min(...extrema.map(p => p[axis])), upper = Math.max(...extrema.map(p => p[axis]));
    assert.ok(dense.every(p => p[axis] >= lower - 1e-9 && p[axis] <= upper + 1e-9));
    assert.ok(Math.abs(Math.min(...dense.map(p => p[axis])) - lower) < .0001);
  }
});

test('arrow wings participate in page overflow and both heads retrace to the shaft', () => {
  const arrow = ink(); arrow.transform = { x: 0, y: 0, rotationRad: 0, scaleX: 1, scaleY: 1 };
  arrow.geometry = { kind: 'arrow', start: { x: 95, y: 5 }, end: { x: 95, y: 60 }, head: 'end', headLengthPt: 20, preferredHeadLengthPt: 40 };
  const page: Page = { ...fixture.document.pages[0], widthPt: 120, heightPt: 100, annotations: [arrow] };
  assert.ok(annotationPoints(arrow).some(p => p.x > 100));
  assert.throws(() => resizePaper(page, 100, 100, crypto.randomUUID()), /paper-content-overflow/);
  const fitted = resizePaper(page, 100, 100, crypto.randomUUID(), true);
  assert.ok(annotationPoints(fitted.annotations[0]).every(p => p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100));
  arrow.geometry.head = 'both'; const points = geometryPoints(arrow.geometry);
  assert.equal(points.length, 8); assert.deepEqual(points[1], arrow.geometry.start); assert.deepEqual(points[3], arrow.geometry.start);
  assert.deepEqual(points[4], arrow.geometry.end); assert.deepEqual(points[6], arrow.geometry.end);
});

test('canonical validation rejects missing/inconsistent arrow head size and transformed non-finite wings', () => {
  const arrow = ink(); arrow.geometry = { kind: 'arrow', start: { x: 5, y: 10 }, end: { x: 50, y: 10 }, head: 'both', headLengthPt: 20, preferredHeadLengthPt: 25 };
  assert.doesNotThrow(() => assertSnapshot(snapshot(arrow)));
  arrow.geometry.preferredHeadLengthPt = 19; assert.throws(() => assertSnapshot(snapshot(arrow)), /arrow-head-preference/);
  arrow.geometry.preferredHeadLengthPt = 1e308; arrow.geometry.headLengthPt = 1e308; arrow.transform.scaleX = 4;
  assert.throws(() => assertSnapshot(snapshot(arrow)), /non-finite-geometry/);
  const missing = structuredClone(arrow) as unknown as { geometry: Record<string, unknown> }; delete missing.geometry.headLengthPt;
  assert.throws(() => assertSnapshot(snapshot(missing as unknown as InkObject)));
});

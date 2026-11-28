import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CanonicalEraseCursor } from '../../../src/features/reader/ink/canonicalEraseCursor.ts';
import { applyCanonicalInkOperation } from '../../../src/features/reader/ink/canonicalInkOperations.ts';
import type { InkObject, Page, PageAnnotation } from '../../../src/runtime/edits/contracts.ts';
import type { Point } from '../../../src/features/ink/inkGeometry.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const seed = 'a0000000-0000-4000-8000-000000000001';
const id = (i: number) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
function makePage(count = 8, pointCount = 20): Page {
  const ink: InkObject[] = Array.from({ length: count }, (_, i) => ({ kind: 'ink', id: id(i),
    geometry: { kind: 'path', points: Array.from({ length: pointCount }, (_, j) => ({ x: j * 420 / (pointCount - 1), y: Math.sin(j * 3.17) * .013 })) },
    style: { color: '#123456', widthPt: 1.234, opacity: .317, highlighter: i % 2 === 0 },
    transform: { x: 80, y: 130 + i * 2, rotationRad: .071, scaleX: 1.17, scaleY: .83 } }));
  const sticky: PageAnnotation = { kind: 'sticky', id: id(count), text: 'untouched', anchor: { x: 50, y: 50 }, color: null, metadata: { label: 'raw', createdAt: null } };
  const text: InkObject = { ...ink[0], id: id(count + 1), geometry: { kind: 'text', widthPt: 80, heightPt: 24, text: 'Font', fontSizePt: 15, fontFamily: 'serif' }, transform: { ...ink[0].transform, y: 500 } };
  return { ...structuredClone(fixture.document.pages[0]), widthPt: 600, heightPt: 900, annotations: [...ink.slice(0, 3), sticky, ...ink.slice(3), text] };
}
function makePath(count = 24): Point[] {
  return Array.from({ length: count }, (_, i): Point => [.22 + .6 * ((i * 7) % count) / count, .16 + .04 * ((i * 3) % 7) / 7]);
}
const defaults = { radius: .006, partial: true, highlightOnly: false, fragmentIdSeed: seed };

test('incremental erasure matches the canonical one-shot reducer for every-point and batched previews', () => {
  const page = makePage(), path = makePath(), before = structuredClone(page);
  for (const partial of [true, false]) for (const highlightOnly of [true, false]) {
    const options = { ...defaults, partial, highlightOnly };
    for (const size of [1, 10, 20]) {
      const cursor = new CanonicalEraseCursor(page, options);
      for (let end = size; end < path.length + size; end += size) {
        const prefix = path.slice(0, end);
        cursor.append(prefix);
        const expected = applyCanonicalInkOperation(page, { type: 'erase', ...options, path: prefix }).annotations;
        assert.deepEqual(cursor.getAnnotations(), expected, `partial=${partial} high=${highlightOnly} partition=${size} end=${end}`);
      }
    }
  }
  assert.deepEqual(page, before);
});

test('duplicates, no-op appends and final fragment IDs preserve stacking and all original attributes', () => {
  const page = makePage(), path = makePath(), options = defaults;
  const cursor = new CanonicalEraseCursor(page, options), repeated = path.flatMap(point => [point, [...point] as Point, point]);
  for (let end = 1; end <= repeated.length; end++) cursor.append(repeated.slice(0, end));
  const actual = cursor.getAnnotations(), expected = applyCanonicalInkOperation(page, { type: 'erase', ...options, path }).annotations;
  assert.deepEqual(actual, expected);
  cursor.append(repeated); assert.equal(cursor.getAnnotations(), actual);
  assert.ok(actual.length > page.annotations.length, 'fixture creates additional fragments across multiple originals');
  for (const original of page.annotations) {
    const surviving = actual.find(value => value.id === original.id);
    if (original.kind !== 'ink') assert.deepEqual(surviving, original);
    else if (surviving?.kind === 'ink') {
      assert.deepEqual(surviving.style, original.style); assert.deepEqual(surviving.transform, original.transform);
      if (original.geometry.kind === 'text') assert.deepEqual(surviving.geometry, original.geometry);
    }
  }
});

test('invalid full-path prefixes and non-finite suffixes are rejected before any mutation', () => {
  const page = makePage(), path = makePath(), cursor = new CanonicalEraseCursor(page, defaults);
  cursor.append(path.slice(0, 5)); const before = structuredClone(cursor.getAnnotations());
  const invalid: Point[][] = [path.slice(0, 4), [[.9, .9], ...path.slice(1, 8)], [...path.slice(0, 6), [NaN, .2]], [...path.slice(0, 7), [.2, Infinity]]];
  for (const input of invalid) {
    assert.throws(() => cursor.append(input)); assert.deepEqual(cursor.getAnnotations(), before);
  }
  cursor.append(path);
  assert.deepEqual(cursor.getAnnotations(), applyCanonicalInkOperation(page, { type: 'erase', ...defaults, path }).annotations);
});

test('the cursor captures its page and path base without sharing caller mutations', () => {
  const page = makePage(), original = structuredClone(page), path = makePath(), prefix = structuredClone(path.slice(0, 5));
  const cursor = new CanonicalEraseCursor(page, defaults); cursor.append(prefix);
  prefix[0][0] = .999; page.annotations.splice(0, 1); page.widthPt = 900;
  cursor.append(path);
  assert.deepEqual(cursor.getAnnotations(), applyCanonicalInkOperation(original, { type: 'erase', ...defaults, path }).annotations);
});

test('incremental geometry benchmark: 320 paths × 20 points, 120 distinct samples', { skip: process.env.PAPER_DESK_ERASE_BENCH !== '1' }, context => {
  const page = makePage(320, 20), path = makePath(120);
  const baselineStart = performance.now();
  let expected: PageAnnotation[] = [];
  for (let i = 1; i <= path.length; i++) expected = applyCanonicalInkOperation(page, { type: 'erase', ...defaults, path: path.slice(0, i) }).annotations;
  const baselineMs = performance.now() - baselineStart;
  const cursorStart = performance.now(), cursor = new CanonicalEraseCursor(page, defaults);
  for (let i = 1; i <= path.length; i++) { cursor.append(path.slice(0, i)); cursor.getAnnotations(); }
  const cursorMs = performance.now() - cursorStart;
  assert.deepEqual(cursor.getAnnotations(), expected);
  context.diagnostic(JSON.stringify({ paths: 320, pointsPerPath: 20, distinctSamples: 120, baselineMs, cursorMs, speedup: baselineMs / cursorMs }));
});

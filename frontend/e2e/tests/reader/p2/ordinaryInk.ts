import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import type { DocumentSnapshot, EditBatch, InkObject, PageAnnotation } from '../../../../src/runtime/edits/contracts.ts';
import { applyBatch } from '../../../../src/runtime/edits/editModel.ts';
import { committed, durable, inks } from './ordinaryStorage.ts';
import { gesture } from './ordinaryWeb.ts';

/** Shared readers for the ordinary-Web ink tests of B14-3b (F10 restyle, F11 clipboard). Observation only: real DOM and the real IndexedDB edit log. */
export const W = 595.28, H = 841.89; // the notebook's blank A4 page in pt (also asserted against the stored root)
export type Committed = Awaited<ReturnType<typeof committed>>;
export type Frame = { x: number; y: number; width: number; height: number };

export const near = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);

/** The head document state replayed from the stored edit log (one linear chain; every stored batch must be consumed). */
export function snapshotOf(observed: Committed): DocumentSnapshot {
  assert.equal(observed.root.kind, 'document');
  let current = observed.root as DocumentSnapshot; const rest = [...observed.edits];
  while (rest.length) {
    const index = rest.findIndex(edit => edit.batch.parents.length === 1 && edit.batch.parents[0] === current.version);
    assert.ok(index >= 0, 'the stored edits form one complete linear history');
    current = applyBatch(current, rest.splice(index, 1)[0].batch) as DocumentSnapshot;
  }
  return current;
}
export function inkOf(snapshot: DocumentSnapshot, pageIndex = 0): InkObject[] {
  return snapshot.pages[pageIndex].annotations.map((value: PageAnnotation) => { assert.equal(value.kind, 'ink'); return value as InkObject; });
}
/** The newest stored batch (the one no other batch names as its parent). */
export function headBatch(observed: Committed): EditBatch {
  const parents = new Set(observed.edits.map(edit => edit.batch.parents[0]));
  const heads = observed.edits.filter(edit => !parents.has(edit.batch.id));
  assert.equal(heads.length, 1, 'exactly one head batch');
  return heads[0].batch;
}
/** The head batch's annotation changes as `[type, id]` pairs sorted by id (delete: the id; create/update: the annotation id). */
export function lastChanges(observed: Committed): (readonly [string, string])[] {
  const batch = headBatch(observed); assert.equal(batch.kind, 'page');
  if (batch.kind !== 'page') return [];
  return sortedPairs(batch.changes.map(change => [change.type, change.type === 'delete' ? change.id : change.type === 'order' ? '' : change.annotation.id] as const));
}
export const sortedPairs = (pairs: (readonly [string, string])[]) => [...pairs].sort((x, y) => x[1] < y[1] ? -1 : 1);
export const byId = (values: InkObject[], id: string) => { const found = values.find(value => value.id === id); assert.ok(found, `annotation ${id} exists`); return found; };
export const rectOf = (annotation: InkObject) => {
  const g = annotation.geometry; assert.equal(g.kind, 'rect');
  if (g.kind !== 'rect') throw new Error('rect geometry expected');
  return g;
};

/** The selection frame the layer draws, as a fraction of the page layer, or null when nothing is selected. */
export async function selection(page: Page): Promise<Frame | null> {
  return page.evaluate(() => {
    const frame = document.querySelector('[data-ink-selection] rect'), svg = document.querySelector('svg[aria-label="ノート書き込みレイヤー"]');
    if (!frame || !svg) return null;
    const height = Number(svg.getAttribute('viewBox')!.split(' ')[3]), n = (name: string) => Number(frame.getAttribute(name));
    return { x: (n('x') + 3) / 1000, y: (n('y') + 3) / height, width: (n('width') - 6) / 1000, height: (n('height') - 6) / height };
  });
}
export async function expectSelection(page: Page, expected: Frame | null, tolerance: number, what: string) {
  const frame = await selection(page);
  if (!expected) { assert.equal(frame, null, `${what}: nothing is selected`); return; }
  assert.ok(frame, `${what}: a selection frame is drawn`);
  for (const key of ['x', 'y', 'width', 'height'] as const) near(frame[key], expected[key], tolerance, `${what} ${key}`);
}
/** What the real SVG draws for one ink: the stroke colour and width attributes of its drawing group, and the group's opacity. */
export async function drawn(page: Page, id: string) {
  return page.evaluate(id => {
    const group = document.querySelector(`[data-ink-id="${id}"] g[stroke]`), outer = group?.parentElement;
    if (!group || !outer) throw new Error(`ink ${id} is not drawn`);
    return { stroke: group.getAttribute('stroke'), strokeWidth: Number(group.getAttribute('stroke-width')), opacity: Number(outer.getAttribute('opacity')) };
  }, id);
}

export const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
export async function drawRect(page: Page, documentId: string, known: string[], editCount: number, from: [number, number], to: [number, number]) {
  await page.getByLabel('描画の種類', { exact: true }).selectOption('rectangle');
  await gesture(page, [from, to]);
  await page.waitForFunction(expected => document.querySelectorAll('[data-ink-id]').length === expected, known.length + 1);
  const id = (await inks(page)).map(value => value.id).find(value => !known.includes(value))!;
  await durable(page, documentId, [...known, id], editCount);
  return id;
}
/** `durable` without the DOM id check: exactly `count` stored edits, none pending, all durable (for steps that change the page list). */
export async function durableCount(page: Page, documentId: string, count: number) {
  const deadline = Date.now() + 30_000;
  await page.getByRole('status').filter({ hasText: /^端末保存済み/ }).first().waitFor();
  let observation = await committed(page, documentId);
  while (observation.edits.length !== count || observation.pendingIntents !== 0 || observation.edits.some(edit => !edit.receipt.durable)) {
    assert.ok(Date.now() < deadline, `durability not observed: ${JSON.stringify({ edits: observation.edits.length, pending: observation.pendingIntents })}`);
    await delay(50); observation = await committed(page, documentId);
  }
  return observation;
}

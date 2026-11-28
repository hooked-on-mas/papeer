import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import type { InkObject } from '../../../../src/runtime/edits/contracts.ts';
import { W, H, button } from './ordinaryInk.ts';

/** Shared readers for the ordinary-Web text tests of B14-3c (F07). Observation and mouse gestures only: real DOM, real IndexedDB edit log (read through ordinaryInk.ts / ordinaryStorage.ts). */
export const FONT_PT = .025 * W; // a new text's font size: 2.5% of the page width = 14.882 pt
export const LINE = 1.3; // line height in font sizes

export const textbox = (page: Page) => page.getByRole('textbox', { name: '書き込みテキスト', exact: true });

/** The text geometry of an ink object (asserts it is a text). */
export function textGeometry(annotation: InkObject) {
  const g = annotation.geometry; assert.equal(g.kind, 'text');
  if (g.kind !== 'text') throw new Error('text geometry expected');
  return g;
}
/** The page-space centre of a text's frame, as a fraction of the page, from its stored transform (rotation and scale included). */
export function centerFraction(annotation: InkObject): [number, number] {
  const g = textGeometry(annotation), t = annotation.transform, c = Math.cos(t.rotationRad), s = Math.sin(t.rotationRad);
  const x = g.widthPt * t.scaleX / 2, y = g.heightPt * t.scaleY / 2;
  return [(t.x + c * x - s * y) / W, (t.y + s * x + c * y) / H];
}
/** The text frame as a fraction of the page when it is not rotated. */
export function frameFraction(annotation: InkObject) {
  const g = textGeometry(annotation), t = annotation.transform; assert.equal(t.rotationRad, 0);
  return { x: t.x / W, y: t.y / H, width: g.widthPt * t.scaleX / W, height: g.heightPt * t.scaleY / H };
}
/** What the real SVG draws for one text: one entry per line (content, fill, font size attribute). */
export async function drawnText(page: Page, id: string) {
  return page.evaluate(id => {
    const group = document.querySelector(`[data-ink-id="${id}"]`);
    if (!group) throw new Error(`ink ${id} is not drawn`);
    return [...group.querySelectorAll('text')].map(line => ({ text: line.textContent, fill: line.getAttribute('fill'), fontSize: Number(line.getAttribute('font-size')) }));
  }, id);
}
/** The page layer's viewport point for a fraction of the page (after scrolling the layer into view). */
async function layerPoint(page: Page, at: [number, number]) {
  const layer = page.getByLabel('ノート書き込みレイヤー', { exact: true });
  await layer.scrollIntoViewIfNeeded();
  const box = await layer.boundingBox(); assert.ok(box && box.width > 0 && box.height > 0);
  return { x: box.x + box.width * at[0], y: box.y + box.height * at[1] };
}
export async function doubleClickAt(page: Page, at: [number, number]) {
  const point = await layerPoint(page, at);
  await page.mouse.dblclick(point.x, point.y);
}
/** A rotation or resize handle's centre as a fraction of the page layer, read from the SVG attributes. */
export async function handleOf(page: Page, name: string): Promise<[number, number]> {
  return page.evaluate(name => {
    const element = document.querySelector(`[data-ink-handle="${name}"]`), svg = document.querySelector('svg[aria-label="ノート書き込みレイヤー"]');
    if (!element || !svg) throw new Error(`handle ${name} absent`);
    return [Number(element.getAttribute('cx')) / 1000, Number(element.getAttribute('cy')) / Number(svg.getAttribute('viewBox')!.split(' ')[3])] as [number, number];
  }, name);
}
/** Is the 範囲選択 tool the pressed one (a confirmed text switches to it and selects the text)? */
export const regionPressed = async (page: Page) => (await button(page, '範囲選択').getAttribute('aria-pressed')) === 'true';

import type { InkStroke } from '../features/ink/inkGeometry.ts';

export type InkHistoryEdit = { action: 'add' | 'remove'; strokes: InkStroke[] };
export type PageHistory = { undo: InkHistoryEdit[]; redo: InkHistoryEdit[] };

/** Restoring ink allocates fresh IDs because deleted IDs remain tombstoned. Every
 * reference to that logical stroke, in either stack, must follow the fresh ID. */
export function moveInkHistory(page: PageHistory, direction: 'undo' | 'redo', restored?: InkStroke[]): PageHistory {
  const source = page[direction], entry = source[source.length - 1];
  if (!entry) return page;
  const replacements = new Map(entry.strokes.map((stroke, index) => [stroke.id, restored?.[index] ?? stroke]));
  const remap = (edit: InkHistoryEdit): InkHistoryEdit => ({ ...edit, strokes: edit.strokes.map(stroke => replacements.get(stroke.id) ?? stroke) });
  const target = direction === 'undo' ? 'redo' : 'undo';
  return { ...page, [direction]: source.slice(0, -1).map(remap), [target]: [...page[target], entry].map(remap) };
}

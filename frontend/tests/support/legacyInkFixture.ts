import type { InkStroke } from '../../src/features/ink/inkGeometry.ts';
import { fitInk, shapePoints, textPoints, transformInk, reshapeShape } from '../../src/features/ink/inkGeometry.ts';

/** Saved source geometry is produced by the actual legacy drawing/handle implementation. */
export function legacyInkFixture(width: number, height: number): InkStroke[] {
  const ratio = height / width, style = { color: '#1256aB', width: .003 };
  const shape = (kind: 'line' | 'arrow' | 'rectangle' | 'ellipse'): InkStroke => ({ ...style, id: kind, kind,
    points: shapePoints(kind, [.35, .35], [.55, .50], ratio) });
  const shapes = transformInk(['line', 'arrow', 'rectangle', 'ellipse'].map(kind => shape(kind as Parameters<typeof shape>[0])), [.45, .43], .8, .57, [.05, .03], ratio);
  const text = 'PDFと日本語😀\nAé\n', frame = textPoints(text, [.30, .55], .025, ratio);
  // Old text frames can have a width independent of their inferred font size.
  const stretched = frame.map(([x, y]): [number, number] => [.30 + (x - .30) * 1.4, y]);
  const shortArrow = shape('arrow'); shortArrow.id = 'short-arrow';
  const shortened = reshapeShape(shortArrow, { part: 'handle', index: 1 }, shortArrow.points[1], [.355, .355], ratio);
  const edgeArrow = shape('arrow'); edgeArrow.id = 'edge-arrow';
  const edge = reshapeShape(edgeArrow, { part: 'handle', index: 1 }, edgeArrow.points[1], [0, 0], ratio);
  return [
    { ...style, id: 'pen', points: [[.05, .06], [.07, .08], [.09, .075]] },
    { ...style, id: 'dot', kind: 'pen', points: [[.1, .1]] },
    { ...style, id: 'highlighter', kind: 'highlighter', width: .015, points: [[.15, .2], [.60, .2]] },
    ...shapes,
    ...fitInk(transformInk([{ ...style, id: 'text', kind: 'text', text, points: stretched }], [.45, .60], 1.1, -.31, [0, 0], ratio), ratio),
    shortened, edge,
  ];
}

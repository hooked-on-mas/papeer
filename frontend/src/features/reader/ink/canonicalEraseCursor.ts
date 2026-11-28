import { validateId, validatePage, type InkObject, type Page, type PageAnnotation, type Point as LocalPoint } from '../../../runtime/edits/contracts.ts';
import { transformInkPoint } from '../../../runtime/edits/annotationGeometry.ts';
import { assertPage } from '../../../runtime/edits/editModel.ts';
import { projectInkObject } from './canonicalInk.ts';
import { hitInk, type InkStroke, type Point } from '../../ink/inkGeometry.ts';

export type CanonicalEraseOptions = { radius: number; partial: boolean; highlightOnly: boolean; fragmentIdSeed: string };
type Piece = { points: LocalPoint[]; projection: InkStroke };
type Group = { original: PageAnnotation; projection?: InkStroke; pieces?: Piece[]; gone: boolean };

/** Circle cuts use world-space distances and interpolate the original local path. */
function cutPath(annotation: InkObject, points: LocalPoint[], at: Point, radius: number, page: Page): LocalPoint[][] {
  const center = { x: at[0] * page.widthPt, y: at[1] * page.heightPt };
  const r = radius * page.widthPt + annotation.style.widthPt * Math.max(annotation.transform.scaleX, annotation.transform.scaleY) / 2;
  if (points.length === 1) {
    const p = transformInkPoint(annotation, points[0]);
    return Math.hypot(p.x - center.x, p.y - center.y) <= r ? [] : [points];
  }
  const pieces: LocalPoint[][] = []; let current: LocalPoint[] = [];
  const flush = () => { if (current.length) pieces.push(current); current = []; };
  for (let i = 1; i < points.length; i++) {
    const a = transformInkPoint(annotation, points[i - 1]), b = transformInkPoint(annotation, points[i]);
    const dx = b.x - a.x, dy = b.y - a.y, ax = a.x - center.x, ay = a.y - center.y;
    const aa = dx * dx + dy * dy, bb = 2 * (ax * dx + ay * dy), cc = ax * ax + ay * ay - r * r;
    const cuts = [0, 1], discriminant = bb * bb - 4 * aa * cc;
    if (aa > 0 && discriminant > 0) for (const t of [(-bb - Math.sqrt(discriminant)) / (2 * aa), (-bb + Math.sqrt(discriminant)) / (2 * aa)]) if (t > 0 && t < 1) cuts.push(t);
    cuts.sort((a, b) => a - b);
    const interpolate = (t: number): LocalPoint => t === 0 ? points[i - 1] : t === 1 ? points[i]
      : { x: points[i - 1].x + (points[i].x - points[i - 1].x) * t, y: points[i - 1].y + (points[i].y - points[i - 1].y) * t };
    for (let j = 1; j < cuts.length; j++) {
      const mid = (cuts[j - 1] + cuts[j]) / 2;
      if (Math.hypot(ax + dx * mid, ay + dy * mid) > r) {
        if (!current.length) current.push(interpolate(cuts[j - 1]));
        current.push(interpolate(cuts[j]));
      } else flush();
    }
  }
  flush(); return pieces;
}

/** One gesture's geometry cache. Each new eraser circle is applied once, regardless of preview frequency. */
export class CanonicalEraseCursor {
  private readonly page: Page;
  private readonly options: CanonicalEraseOptions;
  private readonly groups: Group[];
  private readonly originalIds: Set<string>;
  private readonly seed: bigint;
  private readonly path: Point[] = [];
  private readonly seen = new Set<string>();
  private cached?: PageAnnotation[];

  constructor(page: Page, options: CanonicalEraseOptions) {
    validatePage(page); assertPage(page); validateId(options.fragmentIdSeed);
    if (!Number.isFinite(options.radius) || options.radius < 0) throw new Error('invalid-ink-radius');
    // Capture the gesture base so caller-owned objects cannot change a running gesture.
    this.page = structuredClone(page); this.options = { ...options };
    this.seed = BigInt(`0x${options.fragmentIdSeed.replace(/-/g, '')}`);
    this.originalIds = new Set(page.annotations.map(annotation => annotation.id));
    this.groups = this.page.annotations.map(original => ({ original, gone: false,
      ...(original.kind === 'ink' && (!options.highlightOnly || original.style.highlighter)
        ? { projection: projectInkObject(original, this.page) } : {}) }));
  }

  /** Accept the complete append-only path; reject an invalid suffix/prefix before touching any geometry. */
  append(path: Point[]): void {
    if (path.length < this.path.length) throw new Error('eraser-path-prefix');
    for (let i = 0; i < path.length; i++) {
      const point = path[i];
      if (point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) throw new Error('non-finite-ink-operation');
      if (i < this.path.length && (point[0] !== this.path[i][0] || point[1] !== this.path[i][1])) throw new Error('eraser-path-prefix');
    }
    const { radius, partial } = this.options, ratio = this.page.heightPt / this.page.widthPt;
    for (let i = this.path.length; i < path.length; i++) {
      const at = path[i], key = `${at[0]},${at[1]}`;
      this.path.push([at[0], at[1]]);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      for (const group of this.groups) {
        const original = group.original;
        if (group.gone || !group.projection || original.kind !== 'ink') continue;
        if (!partial || original.geometry.kind !== 'path') {
          if (hitInk(group.projection, at, radius, ratio)) { group.gone = true; this.cached = undefined; }
          continue;
        }
        if (!group.pieces && !hitInk(group.projection, at, radius, ratio)) continue;
        const pieces = group.pieces ?? [{ points: original.geometry.points, projection: group.projection }];
        let changed = false;
        const next = pieces.flatMap(piece => {
          if (!hitInk(piece.projection, at, radius, ratio)) return [piece];
          const cut = cutPath(original, piece.points, at, radius, this.page);
          if (cut.length === 1 && cut[0].length === piece.points.length && cut[0].every((point, j) => point.x === piece.points[j].x && point.y === piece.points[j].y)) return [piece];
          changed = true;
          return cut.map(points => ({ points, projection: projectInkObject({ ...original, geometry: { kind: 'path', points } }, this.page) }));
        });
        if (changed) { group.pieces = next; group.gone = !next.length; this.cached = undefined; }
      }
    }
  }

  /** Assign IDs from final fragment order, never from how the gesture was partitioned into previews. */
  getAnnotations(): PageAnnotation[] {
    if (this.cached) return this.cached;
    let index = 0;
    const nextId = () => {
      const hex = ((this.seed + BigInt(index++)) & ((1n << 128n) - 1n)).toString(16).padStart(32, '0');
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      if (this.originalIds.has(id)) throw new Error('existing-ink-operation-id');
      return id;
    };
    const annotations = this.groups.flatMap<PageAnnotation>(group => {
      if (group.gone) return [];
      const original = group.original;
      if (!group.pieces || original.kind !== 'ink') return [original];
      return group.pieces.map((piece, i) => ({ ...original, id: i === 0 ? original.id : nextId(), geometry: { kind: 'path' as const, points: piece.points } }));
    });
    this.cached = annotations; return annotations;
  }
}

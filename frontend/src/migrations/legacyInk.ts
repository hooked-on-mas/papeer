import type { Geometry, InkObject, Page, Point, Transform } from '../runtime/edits/contracts.ts';
import { geometryPoints, transformInkPoint } from '../runtime/edits/annotationGeometry.ts';
import { assertSnapshot, EditRejected } from '../runtime/edits/editModel.ts';
import { editContentHash } from '../runtime/edits/editContentHash.ts';
import { migrationStableId } from './stableId.ts';
import { assertLegacyPageTarget, legacyPageKey, type LegacyPageContext as LegacyInkContext, type LegacyPageMigration as LegacyInkMigration,
  type MigrationIdMapping, type PageMigrationIssue as InkMigrationIssue } from './legacyPage.ts';
export type { LegacyInkContext, LegacyInkMigration, MigrationIdMapping, InkMigrationIssue };

/** Frozen source format for the one-time converter. Production editors never fall back to it. */
export type LegacyInk = { id: string; color: string; width: number; points: [number, number][];
  kind?: 'pen' | 'highlighter' | 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'text'; text?: string | null; arrowHeadLength?: number | null };
const EPS = 1e-6;
const identity = (): Transform => ({ x: 0, y: 0, rotationRad: 0, scaleX: 1, scaleY: 1 });
const reject = (reason: string): never => { throw new EditRejected(reason); };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const same = (a: Point, b: Point) => distance(a, b) <= EPS;

function assertLegacyInk(value: unknown): asserts value is LegacyInk {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('invalid-legacy-stroke');
  const s = value as LegacyInk;
  if (Object.keys(s).some(key => !['id', 'color', 'width', 'points', 'kind', 'text', 'arrowHeadLength'].includes(key)
    || (s as unknown as Record<string, unknown>)[key] === undefined)
    || typeof s.id !== 'string' || !s.id || Array.from(s.id).length > 80
    || typeof s.color !== 'string' || s.color.length !== 7 || !/^#[0-9a-fA-F]{6}$/.test(s.color) || typeof s.width !== 'number' || !Number.isFinite(s.width) || !(s.width > 0 && s.width <= .08)
    || (s.kind !== undefined && !['pen', 'highlighter', 'line', 'arrow', 'rectangle', 'ellipse', 'text'].includes(s.kind))
    || !Array.isArray(s.points) || !s.points.length || s.points.length > 20000
    || s.points.some(point => !Array.isArray(point) || point.length !== 2 || point.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1))) reject('invalid-legacy-stroke');
  if (s.kind === 'text' ? typeof s.text !== 'string' || !s.text.trim() || Array.from(s.text).length > 2000 : s.text != null) reject('invalid-legacy-text');
  if (s.arrowHeadLength != null && (s.kind !== 'arrow'
    || typeof s.arrowHeadLength !== 'number' || !Number.isFinite(s.arrowHeadLength) || s.arrowHeadLength < 0)) reject('invalid-legacy-arrow-head');
}
function box(points: Point[], closed: boolean) {
  if (points.length !== (closed ? 5 : 4) || (closed && !same(points[0], points[4]))) reject('unsupported-box');
  const [a, b, c, d] = points, ux = b.x - a.x, uy = b.y - a.y, vx = d.x - a.x, vy = d.y - a.y;
  const width = Math.hypot(ux, uy), height = Math.hypot(vx, vy);
  if (!(width > 0 && height > 0) || ux * vy - uy * vx <= 0 || Math.abs(ux * vx + uy * vy) / (width * height) > 1e-8
    || !same(c, { x: b.x + vx, y: b.y + vy })) reject('unsupported-box');
  return { width, height, transform: { ...identity(), x: a.x, y: a.y, rotationRad: Math.atan2(uy, ux) } };
}
function convertedInk(stroke: LegacyInk, page: Page, id: string): InkObject {
  const points = stroke.points.map(([x, y]) => ({ x: x * page.widthPt, y: y * page.heightPt }));
  const kind = stroke.kind ?? 'pen'; let geometry: Geometry, transform = identity();
  if (kind === 'pen' || kind === 'highlighter') geometry = { kind: 'path', points };
  else if (kind === 'line') {
    if (points.length !== 2 || distance(points[0], points[1]) === 0) reject('unsupported-line');
    geometry = { kind: 'line', start: points[0], end: points[1] };
  } else if (kind === 'arrow') {
    if (points.length !== 5 || !same(points[1], points[3]) || distance(points[0], points[1]) === 0) reject('unsupported-arrow');
    const actual = distance(points[1], points[2]), preferred = (stroke.arrowHeadLength ?? Math.max(.025, actual / page.widthPt)) * page.widthPt;
    if (preferred + EPS < actual) reject('inconsistent-arrow-head');
    geometry = { kind: 'arrow', start: points[0], end: points[1], head: 'end', headLengthPt: actual, preferredHeadLengthPt: Math.max(preferred, actual) };
  } else if (kind === 'rectangle' || kind === 'text') {
    const frame = box(points, kind === 'rectangle'); transform = frame.transform;
    if (kind === 'rectangle') geometry = { kind: 'rect', widthPt: frame.width, heightPt: frame.height };
    else {
      const text = stroke.text!, lines = text.split('\n'), size = frame.height / (lines.length * 1.3);
      const units = Math.max(1, ...lines.map(line => [...line].reduce((sum, char) => sum + (/^[\x00-\xff]$/.test(char) ? .6 : 1), 0)));
      geometry = { kind: 'text', widthPt: units * size, heightPt: frame.height, text, fontSizePt: size, fontFamily: 'sans-serif' };
      transform.scaleX = frame.width / geometry.widthPt;
    }
  } else {
    if (points.length !== 65 || !same(points[0], points[64])) reject('unsupported-ellipse');
    const center = { x: (points[0].x + points[32].x) / 2, y: (points[0].y + points[32].y) / 2 };
    const u = { x: points[0].x - center.x, y: points[0].y - center.y }, v = { x: points[16].x - center.x, y: points[16].y - center.y };
    const rx = Math.hypot(u.x, u.y), ry = Math.hypot(v.x, v.y);
    if (!(rx > 0 && ry > 0) || u.x * v.y - u.y * v.x <= 0 || Math.abs(u.x * v.x + u.y * v.y) / (rx * ry) > 1e-8) reject('unsupported-ellipse');
    geometry = { kind: 'ellipse', widthPt: rx * 2, heightPt: ry * 2 };
    transform = { ...identity(), x: center.x - u.x - v.x, y: center.y - u.y - v.y, rotationRad: Math.atan2(u.y, u.x) };
  }
  const result: InkObject = { kind: 'ink', id, geometry, transform, style: { color: stroke.color, widthPt: stroke.width * page.widthPt,
    opacity: kind === 'highlighter' ? .3 : 1, highlighter: kind === 'highlighter' } };
  // No lossy path fallback: rotated frames and every saved arrow wing/ellipse sample must agree.
  const restored = geometryPoints(geometry).map(point => transformInkPoint(result, point));
  const expected = kind === 'rectangle' ? points.slice(0, 4) : points;
  if (restored.length !== expected.length || restored.some((point, index) => !same(point, expected[index]))) reject('geometry-not-representable');
  return result;
}

/** All-or-nothing page conversion. Invalid input remains in the source/backup and is reported by key. */
export async function convertLegacyInkPage(page: Page, strokes: unknown, context: LegacyInkContext): Promise<LegacyInkMigration> {
  let stable: { page: Page; strokes: unknown; context: LegacyInkContext };
  try { stable = structuredClone({ page, strokes, context }); }
  catch (error) { return { status: 'blocked', mappings: [], issues: [{ source: [], code: 'non-data-source', detail: String(error) }] }; }
  if (!stable.context || typeof stable.context !== 'object') return { status: 'blocked', mappings: [], issues: [{ source: [], code: 'invalid-source-page', detail: 'migration-page-context' }] };
  const mappings: MigrationIdMapping[] = [], issues: InkMigrationIssue[] = [];
  const source = legacyPageKey(stable.context);
  const fail = (code: string, detail: string, key = source) => { issues.push({ source: key, code, detail }); };
  try {
    assertLegacyPageTarget(stable.page, stable.context);
    if (!Array.isArray(stable.strokes)) reject('invalid-legacy-page');
  } catch (error) { fail('invalid-source-page', String(error)); return { status: 'blocked', mappings, issues }; }
  const annotations: InkObject[] = [], ids = new Set<string>();
  for (const [index, value] of (stable.strokes as unknown[]).entries()) {
    // Keep an address even for an invalid or duplicate ID; the raw source is never discarded.
    let key = [...source, `row:${index}`];
    try {
      if (value && typeof value === 'object' && typeof (value as LegacyInk).id === 'string') key = [...source, (value as LegacyInk).id];
      assertLegacyInk(value);
      if (ids.has(value.id)) reject('duplicate-source-id'); ids.add(value.id);
      const id = await migrationStableId(stable.context.libraryId, 'ink', key), sourceFingerprint = await editContentHash(value);
      mappings.push({ kind: 'ink', source: key, targetId: id, sourceFingerprint });
      annotations.push(convertedInk(value, stable.page, id));
    } catch (error) { fail('invalid-source-ink', String(error), key); }
  }
  const converted = { ...stable.page, annotations };
  if (!issues.length) try {
    assertSnapshot({ kind: 'document', id: stable.context.documentId, version: stable.page.annotationVersion, pages: [converted], deletedPages: [] });
  } catch (error) { fail('invalid-target-page', String(error)); }
  return issues.length ? { status: 'blocked', mappings, issues } : { status: 'converted', mappings, page: converted };
}

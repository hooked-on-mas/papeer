import type { DocumentSnapshot, StickyNote, TextHighlight } from '../../../runtime/edits/contracts.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import { validAnnotationTimestamp } from '../../../runtime/edits/annotationTime.ts';
import { markdownQuote, type CitationTarget } from '../../../runtime/markdown/markdownCitations.ts';

export type AnnotationBrowserSource = { libraryId: string; title: string; document: DocumentSnapshot };
export type AnnotationBrowserRow = {
  key: string; libraryId: string; documentId: string; title: string;
  /** All selected source heads containing this exact variant; never an inferred winning head. */
  sourceVersions: readonly string[];
  surface: 'original' | 'translated'; pageId: string; backgroundRevision: string;
  pageIndex: number; annotationIndex: number; annotationId: string;
  annotation: StickyNote | TextHighlight; target: CitationTarget;
};
export type AnnotationBrowserFilter = {
  documentId?: string; surface?: 'original' | 'translated'; kind?: 'sticky' | 'highlight';
  label?: string; query?: string; sort?: 'document' | 'created-ascending' | 'created-descending';
};
function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(immutable); Object.freeze(value);
  }
  return value;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const normalize = (value: string) => value.normalize('NFKC').toLowerCase();

/** Read only live collections, including unmapped/ambiguous translated pool pages. */
export function projectCanonicalAnnotations(sources: readonly AnnotationBrowserSource[]): readonly AnnotationBrowserRow[] {
  const rows = new Map<string, AnnotationBrowserRow>();
  for (const { libraryId, title, document } of sources) {
    for (const surface of ['original', 'translated'] as const) {
      const pages = surface === 'original' ? document.pages : document.translation?.pages ?? [];
      pages.forEach((page, pageIndex) => page.annotations.forEach((annotation, annotationIndex) => {
        if (annotation.kind === 'ink') return;
        // Ordinal and title are display metadata. A reorder/rename must not change row identity.
        const key = canonicalJson([libraryId, document.id, surface, page.id, page.backgroundRevision, annotation]);
        const previous = rows.get(key);
        if (previous) {
          if (!previous.sourceVersions.includes(document.version)) previous.sourceVersions = [...previous.sourceVersions, document.version].sort(compare);
          // Deterministic display metadata even when source snapshots arrive in another order.
          previous.title = [previous.title, title].sort(compare)[0];
          previous.pageIndex = Math.min(previous.pageIndex, pageIndex);
          previous.annotationIndex = Math.min(previous.annotationIndex, annotationIndex);
          return;
        }
        rows.set(key, { key, libraryId, documentId: document.id, title, sourceVersions: [document.version],
          surface, pageId: page.id, backgroundRevision: page.backgroundRevision, pageIndex, annotationIndex,
          annotationId: annotation.id, annotation: structuredClone(annotation),
          target: { libraryId, documentId: document.id, pageId: page.id, backgroundRevision: page.backgroundRevision,
            surface, anchor: { xPt: annotation.anchor.x, yPt: annotation.anchor.y } } });
      }));
    }
  }
  return immutable([...rows.values()].sort(documentOrder));
}
function documentOrder(a: AnnotationBrowserRow, b: AnnotationBrowserRow): number {
  return compare(normalize(a.title), normalize(b.title)) || compare(a.libraryId, b.libraryId)
    || compare(a.documentId, b.documentId) || (a.surface === b.surface ? 0 : a.surface === 'original' ? -1 : 1)
    || a.pageIndex - b.pageIndex || a.annotationIndex - b.annotationIndex || compare(a.key, b.key);
}
function timeKey(value: string | null): string | null {
  if (value === null || !validAnnotationTimestamp(value)) return null;
  // Date.parse truncates fractions beyond milliseconds. UTC Gregorian fixed-width text does not.
  const [seconds, fraction = ''] = value.slice(0, -1).split('.');
  return `${seconds}.${fraction.padEnd(6, '0')}`;
}
export function filterCanonicalAnnotations(rows: readonly AnnotationBrowserRow[], filter: AnnotationBrowserFilter = {}): readonly AnnotationBrowserRow[] {
  const words = normalize(filter.query ?? '').split(/\s+/u).filter(Boolean);
  const result = rows.filter(row => {
    if (filter.documentId !== undefined && row.documentId !== filter.documentId
      || filter.surface !== undefined && row.surface !== filter.surface
      || filter.kind !== undefined && row.annotation.kind !== filter.kind
      || filter.label !== undefined && row.annotation.metadata.label !== filter.label) return false;
    const text = normalize([row.title, row.annotation.text, row.annotation.quote ?? '', row.annotation.metadata.label].join('\n'));
    return words.every(word => text.includes(word));
  });
  result.sort((a, b) => {
    if (filter.sort === 'created-ascending' || filter.sort === 'created-descending') {
      const at = timeKey(a.annotation.metadata.createdAt), bt = timeKey(b.annotation.metadata.createdAt);
      if (at === null || bt === null) { if (at !== bt) return at === null ? 1 : -1; }
      else { const order = compare(at, bt); if (order) return filter.sort === 'created-ascending' ? order : -order; }
    }
    return documentOrder(a, b);
  });
  return Object.freeze(result);
}
export type AnnotationBrowserExport = { rows: readonly AnnotationBrowserRow[]; markdown: string };
/** Capture the entire chosen result once; callers hand this single payload to the existing append writer. */
export function freezeAnnotationExport(rows: readonly AnnotationBrowserRow[]): AnnotationBrowserExport {
  const captured = structuredClone(rows);
  const markdown = captured.map(row => {
    const annotation = row.annotation;
    const text = [annotation.quote ?? '', annotation.text].filter(value => value.length > 0).join('\n\n');
    const label = `${row.title} · ${row.surface === 'original' ? '原文' : '訳文'} p.${row.pageIndex + 1}`;
    return markdownQuote(text, row.target, label);
  }).join('\n\n---\n\n');
  return immutable({ rows: captured, markdown: markdown ? `${markdown}\n` : '' });
}

import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import type { Page, Point } from '../../../runtime/edits/contracts';
import type { CanonicalAnnotationFacade, EditableCanonicalAnnotation } from './CanonicalAnnotationEditor';
import { CanonicalPageAnnotations } from './CanonicalPageAnnotations';
import { getPdfPointerOwner, hasOtherPdfPointerContact, hasPdfPointerContact, isPdfPointerDraining } from '../input/usePdfPointerInput';

const caption = (value: EditableCanonicalAnnotation) => `${value.kind === 'highlight' ? '本文ハイライト' : '付箋'}: ${(value.text || value.quote || '本文なし').replace(/\s+/g, ' ').slice(0, 60)}`;
function contains(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
    if (Math.abs(cross) < 1e-8 && point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x)
      && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y)) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Annotation gestures take the existing page input admission before pointer capture or preview. */
export function CanonicalAnnotationLayer({ page, annotation, ready }: { page: Page; annotation: CanonicalAnnotationFacade; ready: boolean }) {
  const root = useRef<HTMLDivElement>(null), pointers = useRef(new Set<number>());
  const highlightHits = useRef<SVGSVGElement>(null);
  const gesture = useRef<{ pointerId: number; id: string; facade: CanonicalAnnotationFacade } | null>(null);
  const selectionPress = useRef<{ pointerId: number; clientX: number; clientY: number; stickyId?: string } | null>(null);
  const [candidates, setCandidates] = useState<EditableCanonicalAnnotation[]>([]);
  const blocked = useRef(false), [preview, setPreview] = useState<Point | null>(null);
  const current = useRef(annotation); current.current = annotation;
  const cancel = () => {
    const pending = gesture.current; gesture.current = null;
    if (pending) pending.facade.endGesture(pending.id, null);
    setPreview(null);
  };
  useLayoutEffect(() => {
    const clear = () => { cancel(); selectionPress.current = null; pointers.current.clear(); blocked.current = false; setCandidates([]); };
    // Cancel only this layer's preview; the pointer hook owns contacts and gesture phases.
    const secondContact = (event: globalThis.PointerEvent) => {
      const first = gesture.current?.pointerId ?? selectionPress.current?.pointerId;
      const scope = root.current?.closest('[data-reader-root]');
      if (first !== undefined && first !== event.pointerId && event.target instanceof Node && scope?.contains(event.target)) {
        blocked.current = true; selectionPress.current = null; setPreview(null);
      }
    };
    const canceledContactsEnded = () => {
      // The pointer hook removes raw contacts at its one terminal boundary.
      // Retain the existing annotation admission until that inventory is empty.
      queueMicrotask(() => {
        if (blocked.current && !hasPdfPointerContact(root.current)) {
          cancel(); pointers.current.clear(); blocked.current = false;
        }
      });
    };
    window.addEventListener('pointerdown', secondContact, true);
    window.addEventListener('pointerup', canceledContactsEnded, true); window.addEventListener('pointercancel', canceledContactsEnded, true);
    window.addEventListener('blur', clear); window.addEventListener('pagehide', clear);
    return () => { clear(); window.removeEventListener('pointerdown', secondContact, true);
      window.removeEventListener('pointerup', canceledContactsEnded, true); window.removeEventListener('pointercancel', canceledContactsEnded, true);
      window.removeEventListener('blur', clear); window.removeEventListener('pagehide', clear); };
  }, [page.id, page.backgroundRevision]);
  useLayoutEffect(() => {
    if (!annotation.available) { cancel(); selectionPress.current = null; pointers.current.clear(); blocked.current = false; setCandidates([]); }
  }, [annotation.available]);
  useLayoutEffect(() => { setCandidates([]); selectionPress.current = null; }, [page.annotationVersion, annotation.mode]);
  const point = (event: PointerEvent): Point | null => {
    const bounds = root.current?.getBoundingClientRect();
    if (!bounds || !(bounds.width > 0 && bounds.height > 0)) return null;
    return { x: Math.max(0, Math.min(page.widthPt, (event.clientX - bounds.left) / bounds.width * page.widthPt)),
      y: Math.max(0, Math.min(page.heightPt, (event.clientY - bounds.top) / bounds.height * page.heightPt)) };
  };
  const placing = annotation.mode === 'sticky-place' || annotation.mode === 'annotation-move';
  const interactive = ready && annotation.available && !annotation.busy;
  const stop = (event: PointerEvent) => { event.preventDefault(); event.stopPropagation(); };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (!placing || !interactive || event.button !== 0 && event.pointerType !== 'touch') return;
    stop(event); pointers.current.add(event.pointerId);
    if (pointers.current.size > 1) { blocked.current = true; setPreview(null); return; }
    const pane = root.current?.closest<HTMLDivElement>('[data-pdf-scroller],.web-pdf-pane,.document-paper-pane') ?? null;
    if (getPdfPointerOwner(pane) || isPdfPointerDraining(pane) || hasOtherPdfPointerContact(pane, event.pointerId)) { blocked.current = true; return; }
    const id = annotation.beginGesture(); if (!id) { blocked.current = true; return; }
    gesture.current = { pointerId: event.pointerId, id, facade: annotation }; setPreview(point(event));
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const up = (event: PointerEvent<HTMLDivElement>, canceled: boolean) => {
    if (!pointers.current.has(event.pointerId)) return;
    stop(event); pointers.current.delete(event.pointerId);
    const pending = gesture.current;
    if (blocked.current) {
      if (!pointers.current.size && !hasPdfPointerContact(root.current)) cancel();
    } else if (pending?.pointerId === event.pointerId) {
      gesture.current = null; pending.facade.endGesture(pending.id, canceled || blocked.current ? null : point(event)); setPreview(null);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!pointers.current.size && !hasPdfPointerContact(root.current)) blocked.current = false;
  };
  const canChoose = () => interactive && current.current.mode === 'annotation-select' && !current.current.draft
    && !getPdfPointerOwner(root.current) && !hasPdfPointerContact(root.current) && !isPdfPointerDraining(root.current);
  const choose = ({ clientX, clientY, stickyId }: { clientX: number; clientY: number; stickyId?: string }) => {
    if (!canChoose()) return;
    const bounds = root.current?.getBoundingClientRect(), svg = highlightHits.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    const quadPoint = svg?.width && svg.height ? { x: (clientX - svg.left) / svg.width * page.widthPt, y: (clientY - svg.top) / svg.height * page.heightPt } : null;
    const hits = page.annotations.filter((value): value is EditableCanonicalAnnotation => value.kind !== 'ink').filter(value => value.kind === 'highlight'
      ? !!quadPoint && value.quads.some(quad => contains(quadPoint, quad))
      : value.id === stickyId);
    const found = [...new Map(hits.map(value => [value.id, value])).values()];
    if (found.length === 1) { setCandidates([]); current.current.edit(found[0]); } else setCandidates(found);
  };
  const selectionDown = (event: PointerEvent) => {
    stop(event); selectionPress.current = null;
    if (!interactive || event.button !== 0 && event.pointerType !== 'touch'
      || getPdfPointerOwner(root.current) || isPdfPointerDraining(root.current) || hasOtherPdfPointerContact(root.current, event.pointerId)) return;
    // The button's own hit is authoritative, including its square corners.
    // Never expand another sticky's hit with a distance/bounds approximation.
    const stickyId = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget.dataset.annotationId : undefined;
    if (point(event)) selectionPress.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, stickyId };
  };
  const selectionClick = (event: { stopPropagation(): void }) => {
    event.stopPropagation(); const press = selectionPress.current; selectionPress.current = null;
    if (press) choose(press);
  };
  const draft = annotation.draft;
  const draftValue = draft && !draft.deleted ? draft.annotation : null;
  const at = preview ?? draftValue?.anchor;
  const draftPage = draftValue ? { ...page, annotations: [{ ...draftValue, anchor: preview ?? draftValue.anchor }] } : null;
  return <div ref={root} aria-label="注釈の配置と選択" data-annotation-layer="" className="absolute inset-0 z-20"
    style={{ pointerEvents: interactive && placing ? 'auto' : 'none', touchAction: placing ? 'none' : undefined }}
    onPointerDown={down} onPointerMove={event => { if (gesture.current?.pointerId === event.pointerId) { stop(event); if (!blocked.current) setPreview(point(event)); } }}
    onPointerUp={event => up(event, false)} onPointerCancel={event => up(event, true)}
    onLostPointerCapture={event => { if (gesture.current?.pointerId === event.pointerId) up(event, true); }}>
    {draftPage && <CanonicalPageAnnotations page={draftPage} includeInk={false} />}
    {at && (!draftValue || draftValue.kind === 'highlight') && <span data-annotation-preview="" className="pointer-events-none absolute block size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/40"
      style={{ left: `${at.x / page.widthPt * 100}%`, top: `${at.y / page.heightPt * 100}%`, background: draftValue?.color ?? '#f59e0b' }} />}
    {annotation.mode === 'annotation-select' && !draft && <svg ref={highlightHits} className="pointer-events-none absolute inset-px h-full w-full" viewBox={`0 0 ${page.widthPt} ${page.heightPt}`} aria-label="本文ハイライトを選択">
      {page.annotations.filter(value => value.kind === 'highlight').map(value => value.kind === 'highlight' && <g key={value.id}
        role="button" tabIndex={interactive ? 0 : -1} aria-label={caption(value)} aria-disabled={!interactive} data-annotation-id={value.id}
        onPointerDown={selectionDown} onPointerCancel={() => { selectionPress.current = null; }}
        onClick={event => { if (event.detail === 0) { event.stopPropagation(); if (canChoose()) current.current.edit(value); } else selectionClick(event); }}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); if (canChoose()) current.current.edit(value); } }}>
        {value.quads.map((quad, index) => <polygon key={index} points={quad.map(p => `${p.x},${p.y}`).join(' ')} fill="transparent"
          style={{ pointerEvents: interactive ? 'all' : 'none' }} />)}
      </g>)}
    </svg>}
    {annotation.mode === 'annotation-select' && !draft && page.annotations.filter(value => value.kind === 'sticky').map(value => value.kind === 'sticky' &&
      <button key={value.id} type="button" data-annotation-id={value.id} aria-label={caption(value)}
        className="absolute size-8 -translate-x-1/2 -translate-y-1/2 rounded-full border border-transparent focus:border-primary focus:outline-none"
        style={{ left: `${value.anchor.x / page.widthPt * 100}%`, top: `${value.anchor.y / page.heightPt * 100}%`, pointerEvents: interactive ? 'auto' : 'none' }}
        disabled={!interactive} onPointerDown={selectionDown} onPointerCancel={() => { selectionPress.current = null; }}
        onClick={event => { if (event.detail === 0) { event.stopPropagation(); if (canChoose()) current.current.edit(value); } else selectionClick(event); }} />)}
    {annotation.mode === 'annotation-select' && !draft && candidates.length > 1 && <div role="group" aria-label="重なっている注釈を選択"
      className="absolute left-2 top-2 max-h-48 max-w-xs overflow-auto rounded border bg-background p-2 shadow"
      style={{ pointerEvents: interactive ? 'auto' : 'none' }} onPointerDown={event => event.stopPropagation()}>
      <p>注釈が重なっています。編集する注釈を選んでください。</p>
      {candidates.map((value, index) => <button key={value.id} type="button" className="block min-h-10 w-full text-left" disabled={!interactive}
        onClick={() => { if (canChoose() && current.current.edit(value)) setCandidates([]); }}>{index + 1}. {caption(value)}</button>)}
      <button type="button" onClick={() => setCandidates([])}>閉じる</button>
    </div>}
  </div>;
}

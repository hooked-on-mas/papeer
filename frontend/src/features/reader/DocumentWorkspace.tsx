import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { DocumentLibraryView } from './DocumentLibraryConnection';
import { ReaderWorkspace } from './ReaderWorkspace';
import { SurfaceGestureGate } from './input/surfaceGestureGate';
import { hasOtherPdfPointerContact, hasPdfPointerContact, isPdfPointerDraining } from './input/usePdfPointerInput';
import { DocumentReferenceSurface } from './reference/DocumentReferenceSurface';

/** One editor is placed in either column. A reference borrows only its read model. */
export function DocumentWorkspace({ view, renderSurface }: { view: DocumentLibraryView; renderSurface(view: DocumentLibraryView): ReactNode }) {
  const current = useRef(view); current.current = view;
  const gate = useRef(new SurfaceGestureGate()), suppressClick = useRef(false);
  useEffect(() => {
    const stop = (event: PointerEvent) => { event.preventDefault(); event.stopPropagation(); };
    const down = (event: PointerEvent) => {
      const root = current.current.rootRef.current;
      const target = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
      if (!root || !target || target.closest('[data-reader-root]') !== root || !root.contains(target)) return;
      if (gate.current.down(event.pointerId)) stop(event);
      else suppressClick.current = false;
    };
    const move = (event: PointerEvent) => { if (gate.current.owns(event.pointerId)) stop(event); };
    const end = (event: PointerEvent) => {
      if (!gate.current.end(event.pointerId)) return;
      stop(event);
      const root = current.current.rootRef.current;
      queueMicrotask(() => {
        // Complete only the already-accepted activation handoff once its whole
        // consumed column and the shared raw inventory have physically ended.
        if (root?.isConnected && current.current.rootRef.current === root && !gate.current.active
          && !hasPdfPointerContact(root) && !isPdfPointerDraining(root)) current.current.editor.activate();
      });
    };
    const clear = () => { gate.current.clear(); suppressClick.current = false; };
    window.addEventListener('pointerdown', down, { capture: true, passive: false });
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', end, { capture: true, passive: false });
    window.addEventListener('pointercancel', end, { capture: true, passive: false });
    window.addEventListener('pagehide', clear);
    window.addEventListener('blur', clear);
    return () => {
      clear(); window.removeEventListener('pointerdown', down, true); window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true); window.removeEventListener('pointercancel', end, true);
      window.removeEventListener('pagehide', clear);
      window.removeEventListener('blur', clear);
    };
  }, []);
  const displayed = view.display === 'split' ? ['original', 'translated'] as const : [view.display];
  const editor = <div className="grid h-full min-h-0 min-w-0" data-document-display={view.display}
    style={{ gridTemplateColumns: view.display === 'split' ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)' }}
    onClickCapture={event => { if (event.detail !== 0 && suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}
    onKeyDownCapture={() => { suppressClick.current = false; }}>
    {displayed.map(surface => <DocumentSurface key={surface} view={view} surface={surface} renderSurface={renderSurface}
      gate={gate} suppressClick={suppressClick} />)}
  </div>;
  return <ReaderWorkspace placement={view.placement} editor={editor} reference={<section data-reader-reference tabIndex={0}
    aria-label="参照ページ" className="h-full min-h-0 min-w-0">{view.reference.status === 'ready'
      ? <DocumentReferenceSurface view={view.reference.view} /> : <div role="status">{view.reference.reason}</div>}</section>} />;
}

function DocumentSurface({ view, surface, renderSurface, gate, suppressClick }: {
  view: DocumentLibraryView; surface: 'original' | 'translated'; renderSurface(view: DocumentLibraryView): ReactNode;
  gate: RefObject<SurfaceGestureGate>; suppressClick: RefObject<boolean>;
}) {
  const readonlyScope = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const pane = view.surfaces[surface], label = surface === 'original' ? '原文' : '訳文';
  const activation = useRef({ active: pane.active, activate: view.activateSurface });
  activation.current = { active: pane.active, activate: view.activateSurface };
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const wheel = (event: WheelEvent) => {
      if (activation.current.active) return;
      // A non-passive native capture listener runs before the reader's zoom/page wheel handler.
      event.preventDefault(); event.stopImmediatePropagation();
      activation.current.activate(surface);
    };
    section.addEventListener('wheel', wheel, { capture: true, passive: false });
    return () => { section.removeEventListener('wheel', wheel, true); };
  }, [surface]);
  useLayoutEffect(() => {
    if (pane.active && document.activeElement === sectionRef.current)
      pane.editor.scopeRef.current?.querySelector<HTMLElement>('textarea,[contenteditable="true"],[tabindex="0"]')?.focus({ preventScroll: true });
  }, [pane.active, pane.editor.scopeRef]);
  const resolved: DocumentLibraryView = { ...view, ...pane, activeSurface: surface, editable: pane.active && pane.editable,
    annotation: pane.active ? pane.annotation : { ...pane.annotation, available: false, cancelAllowed: false, draft: null }, editor: pane.active ? pane.editor : {
    ...pane.editor, tool: 'select', scopeRef: readonlyScope, activate: pane.editor.deactivate,
  } };
  return <section ref={sectionRef} tabIndex={pane.active ? -1 : 0} className="relative min-h-0 min-w-0 overflow-hidden" aria-label={`${label}の表示`}
    data-reader-surface={surface} data-active-surface={pane.active ? 'true' : 'false'}
    onPointerDownCapture={event => {
      if (pane.active) return;
      if (isPdfPointerDraining(view.rootRef.current) || hasOtherPdfPointerContact(view.rootRef.current, event.pointerId)) {
        event.preventDefault(); event.stopPropagation(); return;
      }
      gate.current.begin(event.pointerId); suppressClick.current = true;
      event.preventDefault(); event.stopPropagation();
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Window listeners cover detached/canceled pointers. */ }
      view.activateSurface(surface, { kind: 'pointer', pointerId: event.pointerId, target: event.target });
    }} onFocusCapture={event => {
      if (!pane.active) {
        event.stopPropagation();
        if (!view.activateSurface(surface, { kind: 'keyboard' })) {
          const target = event.target as EventTarget;
          if (target instanceof HTMLElement || target instanceof SVGElement) target.blur();
          view.editor.scopeRef.current?.querySelector<HTMLElement>('textarea,[contenteditable="true"],[tabindex="0"]')?.focus({ preventScroll: true });
        }
      }
    }}>
    {view.display === 'split' && <span className="pointer-events-none absolute right-2 top-1 z-20 rounded bg-background/90 px-2 text-xs">
      {label}{pane.active ? '（編集中）' : '（選択して編集）'}
    </span>}
    {pane.status === 'ready' ? renderSurface(resolved) : <UnavailableSurface surface={surface} status={pane.status} />}
  </section>;
}

function UnavailableSurface({ surface, status }: { surface: 'original' | 'translated'; status: 'missing' | 'ambiguous' }) {
  return <div role="status" className="flex h-full items-center justify-center p-4 text-center">
    {status === 'ambiguous' ? '対応する訳文が複数あるため、このページは表示できません。'
      : surface === 'translated' ? 'このページの訳文はまだありません。' : '表示するページがありません。'}
  </div>;
}

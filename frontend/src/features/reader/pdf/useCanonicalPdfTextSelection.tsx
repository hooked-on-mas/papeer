import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { CanonicalPdfTextBinding } from './canonicalPdfHighlight';
import { mapPdfCaretText, isCurrentPdfCaretMap, movePdfCaret, pdfCaretAtOffset, pdfCaretFromPoint, pdfCaretRange,
  pdfWordAt, restorePdfSelectionBodyFocus, type PdfCaretMap } from './canonicalPdfCaret';
import { pdfHandleMotion, type PdfTextEndpoint, type PdfTextPointerPort } from './pdfTextGesture';
import { pdfSelectionKeyIntent, pdfSelectionHandleVisible, type ReaderSelectionKeyPort, type ReaderSelectionKeyResult } from '../input/readerSelectionKeys';

type Selection = { binding: CanonicalPdfTextBinding; map: PdfCaretMap; anchor: number; focus: number; range: Range };
type Box = Readonly<{ left: number; top: number; width: number; height: number }>;
type Display = { rects: readonly Box[]; anchor: Box | null; focus: Box | null; announcement: string;
  focusedEndpoint: PdfTextEndpoint | null };
export type CanonicalPdfSelectionRead = Readonly<{ binding: CanonicalPdfTextBinding; range: Range }>;
export type CanonicalPdfTextSelectionOptions = {
  binding: CanonicalPdfTextBinding | null;
  /** Changes on scope, owner/lease, page and active surface replacement. Not a new owner. */
  lifetimeKey: unknown;
  readerRootRef: RefObject<HTMLElement | null>;
  pageLabel: string;
  /** Re-evaluate current active reading surface, owner and scope on every operation. */
  available(): boolean;
  /** Query usePdfPointerInput's raw inventory. Never maintain a second contact Set here. */
  hasContact(): boolean;
  /** Only this Reader's copy/quote/highlight toolbar. Never include inputs/editors. */
  isToolbarTarget(target: Element): boolean;
};

const emptyDisplay = (): Display => ({ rects: [], anchor: null, focus: null, announcement: '', focusedEndpoint: null });
const editable = (target: Element | null) => !!target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
const box = (rect: DOMRect): Box => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
const hidden: CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' };

/** Ephemeral DOM selection only. No journal/history/session, pointer inventory,
 * window.Selection mutation, native handles, or keyboard event listener. */
export function useCanonicalPdfTextSelection(options: CanonicalPdfTextSelectionOptions) {
  const current = useRef(options); current.current = options;
  const selection = useRef<Selection | null>(null);
  const keyEvidence = useRef<{ key: string; trusted: boolean; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean; intent: string; result: string; anchor: number | null; focus: number | null; collapsed: boolean | null; quote: string | null; keyCurrent: boolean | null }[]>([]);
  const [display, setDisplay] = useState<Display>(emptyDisplay);
  const identity = useId(), instructionsId = `${identity}-instructions`;
  const alive = useRef(true);
  const actions = useMemo(() => {
    const ownsHandle = (target: Element | null) => target?.closest<HTMLElement>('[data-pdf-text-selection]')?.dataset.pdfTextSelection === identity;
    const handleRole = (target: Element | null): PdfTextEndpoint | null => {
      if (!ownsHandle(target)) return null;
      const role = target?.closest<HTMLElement>('[data-pdf-text-endpoint]')?.dataset.pdfTextEndpoint;
      return role === 'anchor' || role === 'focus' ? role : null;
    };
    const focusPlace = (target: Element | null): 'body' | 'handle' | 'other' => {
      if (ownsHandle(target)) return 'handle';
      const layer = current.current.binding?.textLayer ?? selection.current?.binding.textLayer;
      return !!target && !!layer?.contains(target) && !editable(target) ? 'body' : 'other';
    };
    const commandFocus = (target: Element | null) => !!target && !editable(target)
      && (focusPlace(target) !== 'other' || current.current.isToolbarTarget(target));
    const bindingNow = () => {
      const { binding, available } = current.current;
      return binding && available() && binding.isCurrent() && binding.textLayer.isConnected ? binding : null;
    };
    const valid = () => {
      const state = selection.current;
      return state && bindingNow() === state.binding && isCurrentPdfCaretMap(state.map)
        && state.range.startContainer.isConnected && state.range.endContainer.isConnected
        && state.binding.textLayer.contains(state.range.startContainer) && state.binding.textLayer.contains(state.range.endContainer)
        ? state : null;
    };
    const clear = (announce = true, restoreHandleFocus = false) => {
      const state = selection.current;
      // Transfer focus before unmounting the handle, while its binding is still
      // current. Lifecycle invalidation never calls this focus-restoring branch.
      if (restoreHandleFocus && state) restorePdfSelectionBodyFocus({ layer: state.binding.textLayer,
        current: valid() === state, ownsHandle });
      const existed = selection.current !== null; selection.current = null;
      if (alive.current) setDisplay({ ...emptyDisplay(), announcement: announce && existed ? '本文の選択を解除しました。' : '' });
    };
    const measureEndpoint = (state: Selection, offset: number): Box | null => {
      const point = pdfCaretAtOffset(state.map, offset);
      if (!point) return null;
      const caret = state.binding.textLayer.ownerDocument.createRange();
      caret.setStart(point.node, point.offset); caret.collapse(true);
      // Actual collapsed Range rects only. No glyph-size or character-ratio estimate.
      const rect = Array.from(caret.getClientRects()).find(item => Number.isFinite(item.left) && Number.isFinite(item.top) && item.height > 0);
      return rect ? box(rect) : null;
    };
    const paint = (state: Selection, announcement?: string) => {
      if (!alive.current) return;
      const rects = Array.from(state.range.getClientRects()).filter(rect => [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
        && rect.height > 0 && (state.range.collapsed || rect.width > 0)).map(box);
      const focusedEndpoint = handleRole(state.binding.textLayer.ownerDocument.activeElement);
      const anchor = measureEndpoint(state, state.anchor), focus = measureEndpoint(state, state.focus);
      setDisplay(previous => ({ rects,
        // A missing collapsed caret rect must not unmount the focused button.
        // Keep its last actual handle position; no glyph position is estimated.
        anchor: anchor ?? (focusedEndpoint === 'anchor' ? previous.anchor : null),
        focus: focus ?? (focusedEndpoint === 'focus' ? previous.focus : null),
        announcement: announcement ?? previous.announcement, focusedEndpoint }));
    };
    const apply = (binding: CanonicalPdfTextBinding, map: PdfCaretMap, anchor: number, focus: number) => {
      const range = pdfCaretRange(map, anchor, focus);
      if (!range || bindingNow() !== binding) return false;
      const state = { binding, map, anchor, focus, range }; selection.current = state; paint(state); return true;
    };
    const finish = () => {
      const state = valid();
      if (!state) { clear(); return; }
      const text = state.range.toString();
      const count = state.map.boundaries.filter(boundary => boundary >= Math.min(state.anchor, state.focus) && boundary < Math.max(state.anchor, state.focus)).length;
      paint(state, text ? `${count}文字を選択しました。${text.slice(0, 60)}` : '本文の選択操作を開始しました。左右キーで移動、Shiftと左右キーで選択します。');
    };
    const readSelection = (): CanonicalPdfSelectionRead | null => {
      const state = valid();
      const document = current.current.binding?.textLayer.ownerDocument;
      if (!state || state.range.collapsed || current.current.hasContact() || !commandFocus(document?.activeElement ?? null)) return null;
      // The caller must consume synchronously and revalidate before draft admission.
      return { binding: state.binding, range: state.range.cloneRange() };
    };
    const pointerPort: PdfTextPointerPort = {
      available: () => !!bindingNow(),
      hit(target) {
        const element = target instanceof Element ? target : null;
        if (!element || editable(element)) return null;
        if (ownsHandle(element)) {
          const role = element.closest<HTMLElement>('[data-pdf-text-endpoint]')?.dataset.pdfTextEndpoint;
          return role === 'anchor' || role === 'focus' ? role : null;
        }
        return bindingNow()?.textLayer.contains(element) ? 'text' : null;
      },
      start(point, kind) {
        const binding = bindingNow(); if (!binding) { clear(); return false; }
        if (kind === 'anchor' || kind === 'focus') return !!valid(); // Logical role stays fixed in the contact.
        const map = mapPdfCaretText(binding.textLayer);
        const offset = map && pdfCaretFromPoint(map, point.x, point.y);
        if (!map || offset === null) { clear(); return false; }
        const word = kind === 'longpress' ? pdfWordAt(map, offset) : [offset, offset] as const;
        if (!word || !apply(binding, map, word[0], word[1])) { clear(); return false; }
        binding.textLayer.focus({ preventScroll: true });
        if (kind === 'longpress') finish();
        return true;
      },
      startHandle(point, endpoint) {
        const state = valid(); if (!state) return null;
        const caret = pdfCaretAtOffset(state.map, state[endpoint]); if (!caret) return null;
        const range = state.binding.textLayer.ownerDocument.createRange();
        range.setStart(caret.node, caret.offset); range.collapse(true);
        const originRects = Array.from(range.getClientRects(), rect => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }));
        const motion = pdfHandleMotion(originRects, point);
        if (!motion || valid() !== state) return null;
        const lifetimeKey = current.current.lifetimeKey;
        return { ...motion, restoreOrigin: (candidateEndpoint: PdfTextEndpoint) => {
          const currentState = valid();
          if (candidateEndpoint !== endpoint || current.current.lifetimeKey !== lifetimeKey
            || !currentState || currentState.binding !== state.binding || currentState.map !== state.map) return false;
          // The raw origin is meaningful only while its original logical caret
          // still occupies the same actual viewport geometry (no scroll/reflow inference).
          const original = pdfCaretAtOffset(state.map, state[endpoint]); if (!original) return false;
          try {
            const currentOrigin = state.binding.textLayer.ownerDocument.createRange();
            currentOrigin.setStart(original.node, original.offset); currentOrigin.collapse(true);
            const rects = Array.from(currentOrigin.getClientRects());
            if (rects.length !== originRects.length || rects.some((rect, index) => {
              const prior = originRects[index];
              return rect.left !== prior.left || rect.top !== prior.top || rect.width !== prior.width || rect.height !== prior.height;
            })) return false;
          } catch { return false; }
          return apply(state.binding, state.map,
            endpoint === 'anchor' ? state.anchor : currentState.anchor,
            endpoint === 'focus' ? state.focus : currentState.focus);
        } };
      },
      move(point, endpoint) {
        const state = valid(); if (!state) { clear(); return false; }
        const offset = pdfCaretFromPoint(state.map, point.x, point.y);
        // An outside/unsupported caret supplies no position. Keep the last real Range.
        return offset !== null && apply(state.binding, state.map, endpoint === 'anchor' ? offset : state.anchor, endpoint === 'focus' ? offset : state.focus);
      },
      finish, clear: () => clear(),
    };
    const keyPort: ReaderSelectionKeyPort = {
      handleKey(event) {
        let intentEvidence = 'editable', bindingEvidence: boolean | null = null;
        const handle = (): ReaderSelectionKeyResult => {
        const element = event.target instanceof Element ? event.target : null;
        if (editable(element)) return 'pass';
        const state = valid();
        bindingEvidence = !!bindingNow() && (!selection.current || !!state);
        const intent = pdfSelectionKeyIntent({ key: event.key, started: selection.current !== null,
          target: focusPlace(element), contact: current.current.hasContact(), current: bindingEvidence,
          ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey });
        intentEvidence = intent;
        if (intent === 'pass' || intent === 'blocked' || intent === 'handled') return intent;
        if (intent === 'clear') { clear(true, true); return 'handled'; }
        if (intent === 'start') {
          const binding = bindingNow(), map = binding && mapPdfCaretText(binding.textLayer);
          if (!binding || !map || !apply(binding, map, 0, 0)) return 'blocked';
          finish(); return 'handled';
        }
        if (!state) return 'blocked';
        const handle = element?.closest<HTMLElement>('[data-pdf-text-endpoint]')?.dataset.pdfTextEndpoint;
        const endpoint: PdfTextEndpoint = handle === 'anchor' ? 'anchor' : 'focus';
        let next = movePdfCaret(state.map, state[endpoint], event.key);
        if (next === null) return 'blocked';
        if (handle !== 'anchor' && handle !== 'focus' && !event.shiftKey && !state.range.collapsed && (event.key === 'ArrowLeft' || event.key === 'ArrowRight'))
          next = event.key === 'ArrowLeft' ? Math.min(state.anchor, state.focus) : Math.max(state.anchor, state.focus);
        const extending = event.shiftKey || handle === 'anchor' || handle === 'focus';
        const anchor = extending ? endpoint === 'anchor' ? next : state.anchor : next;
        const focus = extending ? endpoint === 'focus' ? next : state.focus : next;
        if (!apply(state.binding, state.map, anchor, focus)) return 'blocked';
        finish(); return 'handled';
        };
        const result = handle(), stored = selection.current;
        let quote: string | null = null;
        try { quote = stored ? stored.range.toString().slice(0, 300) : null; } catch { /* diagnostic only */ }
        keyEvidence.current.push({ key: event.key, trusted: event.isTrusted, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey,
          intent: intentEvidence, result, anchor: stored?.anchor ?? null, focus: stored?.focus ?? null,
          collapsed: stored?.range.collapsed ?? null, quote, keyCurrent: bindingEvidence });
        if (keyEvidence.current.length > 32) keyEvidence.current.shift();
        return result;
      },
    };
    const refresh = () => { const state = valid(); if (state) paint(state); else if (selection.current) clear(); };
    return { pointerPort, keyPort, clear, clearSelection: () => clear(true, true), readSelection, refresh, commandFocus, valid,
      copy(event: ClipboardEvent) {
        const target = event.target instanceof Element ? event.target : null;
        if (event.defaultPrevented || editable(target) || !commandFocus(target)) return;
        const read = readSelection();
        if (!read || !event.clipboardData) return;
        event.clipboardData.setData('text/plain', read.range.toString()); event.preventDefault();
      },
      async copySelection() {
        const read = readSelection(); if (!read) return false;
        const clipboard = read.binding.textLayer.ownerDocument.defaultView?.navigator.clipboard;
        if (!clipboard) return false;
        try { await clipboard.writeText(read.range.toString()); return true; } catch { return false; }
      },
    };
  }, [identity]);

  useLayoutEffect(() => {
    alive.current = true;
    actions.clear(false);
    const binding = options.binding, layer = binding?.textLayer;
    const root = options.readerRootRef.current;
    const document = layer?.ownerDocument ?? root?.ownerDocument;
    const view = document?.defaultView;
    if (!layer || !root || !document || !view || layer.ownerDocument !== root.ownerDocument)
      return () => { alive.current = false; selection.current = null; };
    const attributes = { tabindex: '0', role: 'group', 'aria-label': options.pageLabel,
      'aria-describedby': instructionsId };
    const previous = Object.fromEntries(Object.keys(attributes).map(name => [name, layer.getAttribute(name)]));
    for (const [name, value] of Object.entries(attributes)) layer.setAttribute(name, value);
    const clear = () => actions.clear();
    const focus = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!actions.commandFocus(target)) actions.clear(); else actions.refresh();
    };
    const mutation = new MutationObserver(actions.refresh); mutation.observe(layer, { subtree: true, childList: true, characterData: true });
    const fonts = document.fonts;
    const onCopy = (event: Event) => actions.copy(event as ClipboardEvent);
    // Filter copy at the document boundary by this Reader's exact target predicate.
    document.addEventListener('copy', onCopy);
    document.addEventListener('focusin', focus);
    view.addEventListener('blur', clear); view.addEventListener('pagehide', clear);
    view.addEventListener('scroll', actions.refresh, true); view.addEventListener('resize', actions.refresh);
    fonts?.addEventListener('loading', clear);
    return () => {
      mutation.disconnect(); document.removeEventListener('copy', onCopy); document.removeEventListener('focusin', focus);
      view.removeEventListener('blur', clear); view.removeEventListener('pagehide', clear);
      view.removeEventListener('scroll', actions.refresh, true); view.removeEventListener('resize', actions.refresh);
      fonts?.removeEventListener('loading', clear);
      for (const [name, value] of Object.entries(attributes)) if (layer.getAttribute(name) === value) {
        const old = previous[name]; if (old === null) layer.removeAttribute(name); else layer.setAttribute(name, old);
      }
      selection.current = null; alive.current = false;
    };
  }, [options.binding, options.lifetimeKey, options.readerRootRef, options.pageLabel, instructionsId, actions]);

  const handle = (endpoint: PdfTextEndpoint, rect: Box | null) => rect && <button type="button" key={endpoint}
    data-pdf-text-selection={identity} data-pdf-text-endpoint={endpoint}
    aria-label={endpoint === 'anchor' ? '本文選択の開始端。左右キーで移動' : '本文選択の終了端。左右キーで移動'}
    style={{ position: 'fixed', left: rect.left - 22, top: rect.top + rect.height - 8, width: 44, height: 44, padding: 0,
      border: 0, borderRadius: 22, background: 'transparent', pointerEvents: 'auto', touchAction: 'none', cursor: 'grab' }}>
    <span aria-hidden="true" style={{ display: 'block', width: 14, height: 14, margin: '8px auto 0', borderRadius: '50%', background: '#2563eb' }} />
  </button>;
  const state = actions.valid();
  const portalRoot = options.readerRootRef.current;
  const overlay = portalRoot?.isConnected && (!options.binding || options.binding.textLayer.ownerDocument === portalRoot.ownerDocument) ? createPortal(<div data-managed-pdf-selection-overlay
    style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 50 }}>
    {display.rects.map((rect, index) => <span key={index} aria-hidden="true" style={{ ...rect, position: 'fixed',
      minWidth: 1, background: 'rgba(37,99,235,.25)', pointerEvents: 'none' }} />)}
    {state && <>
      {pdfSelectionHandleVisible('anchor', state.range.collapsed, display.focusedEndpoint) && handle('anchor', display.anchor)}
      {pdfSelectionHandleVisible('focus', state.range.collapsed, display.focusedEndpoint) && handle('focus', display.focus)}
    </>}
    <span id={instructionsId} style={hidden}>Enterで本文選択を開始。左右キーで文字移動、Shiftと左右キーで選択、HomeとEndで本文の端へ移動。Escapeで解除。</span>
    <span aria-live="polite" aria-atomic="true" style={hidden}>{display.announcement}</span>
  </div>, portalRoot) : null;
  const readKeyEvidence = useCallback(() => keyEvidence.current.map(item => ({ ...item })), []);
  return { pointerPort: actions.pointerPort, selectionKeyPort: actions.keyPort, readSelection: actions.readSelection,
    copySelection: actions.copySelection, clearSelection: actions.clearSelection, readKeyEvidence, overlay };
}

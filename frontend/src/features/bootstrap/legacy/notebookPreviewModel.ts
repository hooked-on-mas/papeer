import type { NativeNotebookPreview, NativePreparationFacade, NativePreviewBlockedReason } from '../bootstrapPorts.ts';
import type { DocumentSnapshot } from '../../../runtime/edits/contracts.ts';
import { projectLegacyNotebookEntry } from '../../../migrations/legacyNotebookProjection.ts';

/** Same limit the server enforces; checked again here because the wire value is untrusted. */
export const MAX_PREVIEW_PAGES = 256;

/** Strict base64: the server's own encoder never emits whitespace or a missing pad. */
function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('preview-bytes-invalid');
  let raw: string;
  try { raw = atob(value); } catch { throw new Error('preview-bytes-invalid'); }
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}

/**
 * Display-only projection of one verified Notebook entry. Nothing is stored or written back:
 * the result is dropped with the panel, and no edit session or repository is involved.
 */
export async function projectNotebookPreview(value: NativeNotebookPreview, signal: AbortSignal): Promise<DocumentSnapshot> {
  signal.throwIfAborted();
  const bytes = decodeBase64(value.bytesBase64);
  if (bytes.byteLength !== value.entry.byteLength) throw new Error('preview-bytes-mismatch');
  signal.throwIfAborted();
  const projection = await projectLegacyNotebookEntry({
    libraryId: value.libraryId, sourceDocumentId: value.sourceDocumentId, entry: { sha256: value.entry.sha256, byteLength: value.entry.byteLength },
    bytes, annotations: value.annotations.map(item => ({ pageId: item.pageId, ink: item.ink, bookmarks: item.bookmarks })),
  });
  signal.throwIfAborted();
  if (projection.document.pages.length > MAX_PREVIEW_PAGES) throw new Error('preview-page-capacity-exceeded');
  return projection.document;
}

export type PreviewNoteView =
  | Readonly<{ kind: 'idle' }> | Readonly<{ kind: 'loading' }> | Readonly<{ kind: 'error' }>
  | Readonly<{ kind: 'blocked'; reason: NativePreviewBlockedReason }>
  | Readonly<{ kind: 'ok'; document: DocumentSnapshot; inkRows: number; bookmarkRows: number }>;
export type PreviewListView =
  | Readonly<{ kind: 'idle' }> | Readonly<{ kind: 'loading' }> | Readonly<{ kind: 'error' }>
  | Readonly<{ kind: 'blocked'; reason: NativePreviewBlockedReason }> | Readonly<{ kind: 'ok'; selectors: readonly string[] }>;
export type PreviewState = Readonly<{ list: PreviewListView; notes: Readonly<Record<string, PreviewNoteView>>; busy: boolean }>;

/**
 * Per-panel state for the read-only preview. One request at a time; a user cancel aborts the
 * request and is shown as "cancelled"; a dispose (unmount) aborts silently. Nothing is persisted.
 */
export function createPreviewController(facade: NativePreparationFacade, runId: string) {
  let state: PreviewState = { list: { kind: 'idle' }, notes: {}, busy: false };
  let current: { controller: AbortController; userCancelled: boolean } | null = null, disposed = false;
  const listeners = new Set<() => void>();
  const set = (next: PreviewState) => { state = next; listeners.forEach(listener => listener()); };
  const setNote = (selector: string, view: PreviewNoteView, busy: boolean) => set({ ...state, notes: { ...state.notes, [selector]: view }, busy });
  const available = () => !!facade.notebookSelectors && !!facade.notebookPreview;
  const begin = () => {
    if (disposed || current || !available()) return null;
    const request = { controller: new AbortController(), userCancelled: false }; current = request; return request;
  };
  const settle = (request: NonNullable<typeof current>) => { if (current === request) current = null; };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async loadList() {
      const request = begin(); if (!request) return;
      set({ list: { kind: 'loading' }, notes: {}, busy: true });
      let list: PreviewListView;
      try {
        const result = await facade.notebookSelectors!(runId, request.controller.signal);
        list = result.status === 'ok' ? { kind: 'ok', selectors: result.selectors } : { kind: 'blocked', reason: result.reason };
      } catch { list = request.userCancelled ? { kind: 'blocked', reason: 'preview-cancelled' } : { kind: 'error' }; }
      settle(request); if (!disposed) set({ list, notes: {}, busy: false });
    },
    async loadNote(selector: string) {
      if (state.list.kind !== 'ok' || !state.list.selectors.includes(selector)) return;
      const request = begin(); if (!request) return;
      // Only one projected document is kept: showing another note drops the previous one.
      const notes: Record<string, PreviewNoteView> = {};
      for (const [key, view] of Object.entries(state.notes)) notes[key] = view.kind === 'ok' || view.kind === 'loading' ? { kind: 'idle' } : view;
      notes[selector] = { kind: 'loading' }; set({ ...state, notes, busy: true });
      let view: PreviewNoteView;
      try {
        const result = await facade.notebookPreview!(runId, selector, request.controller.signal);
        if (result.status !== 'ok') view = { kind: 'blocked', reason: result.reason };
        else {
          const document = await projectNotebookPreview(result.value, request.controller.signal);
          view = { kind: 'ok', document, inkRows: result.value.coverage.inkRows, bookmarkRows: result.value.coverage.bookmarkRows };
        }
      } catch { view = request.userCancelled ? { kind: 'blocked', reason: 'preview-cancelled' } : { kind: 'error' }; }
      settle(request); if (!disposed) setNote(selector, view, false);
    },
    cancel() { if (current) { current.userCancelled = true; current.controller.abort(); } },
    dispose() { disposed = true; current?.controller.abort(); current = null; listeners.clear(); },
  };
}

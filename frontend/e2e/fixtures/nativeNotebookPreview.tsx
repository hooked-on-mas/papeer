// Real NativePreparationPanel (React StrictMode) on a scripted facade: the screen operations of the read-only
// Notebook preview. No server, no Library, no edit session; the facade is the only thing replaced.
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NativePreparationPanel } from '../../src/features/bootstrap/legacy/NativePreparationPanel.tsx';
import type { NativeNotebookPreview, NativePreparationFacade, NativePreparationStatus, NativePreviewBlockedReason, NativePreviewResult } from '../../src/features/bootstrap/bootstrapPorts.ts';
import { resourceHash } from '../../src/runtime/edits/contentPublication.ts';
import { legacyBookmarkFixture } from '../../tests/support/legacyBookmarkFixture.ts';

const RUN = '11111111-1111-4111-8111-111111111111', NOTE = 'fedcba9876543210fedcba9876543210';
const PAGES = ['0123456789abcdef0123456789abcdef', '1123456789abcdef0123456789abcdef'];

async function wire(): Promise<NativeNotebookPreview> {
  const notebook = { version: 1, revision: 1, pages: PAGES.map(id => ({ id, size: 'A4', orientation: 'portrait', width_mm: 210, height_mm: 297, template: 'ruled7', color: 'white' })) };
  const bytes = new TextEncoder().encode(JSON.stringify(notebook));
  const strokes = [{ id: 's0', color: '#000000', width: .01, points: [[.1, .2], [.3, .4]] }];
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return { libraryId: '00000000-0000-0000-0000-000000000001', sourceDocumentId: NOTE, entry: { sha256: await resourceHash(bytes), byteLength: bytes.byteLength },
    bytesBase64: btoa(binary), annotations: [{ pageId: PAGES[0], ink: [], bookmarks: legacyBookmarkFixture(NOTE, 1) }, { pageId: PAGES[1], ink: strokes, bookmarks: [] }],
    incomplete: ['page-text-not-converted', 'original-pdf-fidelity-unverified'], coverage: { pageRows: 2, inkRows: 1, bookmarkRows: 7 } };
}

type Mode = 'ok' | 'hold' | 'throw' | { blocked: NativePreviewBlockedReason };
type Setup = { status: NativePreparationStatus; preview: boolean };
const state = { root: null as Root | null, listMode: 'ok' as Mode, noteMode: 'ok' as Mode, calls: [] as string[], aborted: 0, settledHeld: 0, statusPolls: 0, lifecycle: { start: 0, resume: 0, abandon: 0 } };

function gate(mode: Mode, signal: AbortSignal, key: string): Promise<'ok' | NativePreviewResult<object>> {
  state.calls.push(key);
  if (mode === 'ok') return Promise.resolve('ok');
  if (mode === 'throw') return Promise.reject(new Error('fixture-failure'));
  if (typeof mode === 'object') return Promise.resolve({ status: 'blocked', reason: mode.blocked });
  return new Promise((_resolve, reject) => {
    const abort = () => { state.aborted++; reject(new DOMException('aborted', 'AbortError')); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

async function mount({ status, preview }: Setup) {
  state.root?.unmount(); Object.assign(state, { listMode: 'ok', noteMode: 'ok', calls: [], aborted: 0, statusPolls: 0, lifecycle: { start: 0, resume: 0, abandon: 0 } });
  const value = await wire();
  const facade: NativePreparationFacade = {
    status: async () => { state.statusPolls++; return status; },
    start: async () => { state.lifecycle.start++; return status; },
    resume: async () => { state.lifecycle.resume++; return status; },
    abandon: async () => { state.lifecycle.abandon++; return status; },
    ...(preview ? {
      notebookSelectors: async (_run: string, signal: AbortSignal) => {
        const outcome = await gate(state.listMode, signal, 'list');
        return outcome === 'ok' ? { status: 'ok' as const, selectors: [NOTE] } : outcome as NativePreviewResult<{ selectors: readonly string[] }>;
      },
      notebookPreview: async (_run: string, selector: string, signal: AbortSignal) => {
        const outcome = await gate(state.noteMode, signal, 'note:' + selector);
        return outcome === 'ok' ? { status: 'ok' as const, value } : outcome as NativePreviewResult<{ value: NativeNotebookPreview }>;
      },
    } : {}),
  };
  state.root = createRoot(document.getElementById('root')!);
  state.root.render(<StrictMode><NativePreparationPanel facade={facade} allowStart /></StrictMode>);
}
Object.assign(window, {
  nativePreviewFixture: {
    mount, runId: RUN, noteId: NOTE,
    setModes(list: Mode, note: Mode) { state.listMode = list; state.noteMode = note; },
    unmount() { state.root?.unmount(); state.root = null; },
    snapshot: () => ({ calls: [...state.calls], aborted: state.aborted, lifecycle: { ...state.lifecycle } }),
  },
});

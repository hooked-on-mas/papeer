import { useEffect, useState, useSyncExternalStore } from 'react';
import type { NativePreparationFacade, NativePreviewBlockedReason } from '../bootstrapPorts.ts';
import type { DocumentSnapshot } from '../../../runtime/edits/contracts.ts';
import { CanonicalPaperBackground } from '../../notebooks/CanonicalPaperBackground.tsx';
import { CanonicalPageAnnotations } from '../../reader/annotations/CanonicalPageAnnotations.tsx';
import { createPreviewController, type PreviewNoteView, type PreviewState } from './notebookPreviewModel.ts';

const idleState: PreviewState = { list: { kind: 'idle' }, notes: {}, busy: false };
const noop = () => () => undefined;
const reasonText: Record<NativePreviewBlockedReason, string> = {
  'preview-busy': 'ほかのノートを確認しています。',
  'preview-shutdown-pending': 'アプリを終了しています。',
  'preview-cancelled': '確認を取り消しました。',
  'preview-capacity-exceeded': '保存データが確認できる上限を超えています。',
  'preview-unavailable': 'このノートを確認できません。保存データは保持しています。',
};
const unavailable = reasonText['preview-unavailable'];

/** Pure display of a projected Notebook: no Reader, edit session, repository or PDF loader. */
export function NotebookPreviewPages({ document }: { document: DocumentSnapshot }) {
  return <div>
    {document.pages.map((page, index) => <div key={page.id} aria-label={`ページ ${index + 1}`} className="relative mx-auto my-2 max-w-full"
      style={{ width: 480, aspectRatio: `${page.widthPt} / ${page.heightPt}` }}>
      <CanonicalPaperBackground page={page} /><CanonicalPageAnnotations page={page} includeInk />
    </div>)}
  </div>;
}

function NoteStatus({ view }: { view: PreviewNoteView }) {
  if (view.kind === 'loading') return <span role="status">保存データを確認しています…</span>;
  if (view.kind === 'blocked') return <span role="alert">{reasonText[view.reason]}</span>;
  if (view.kind === 'error') return <span role="alert">{unavailable}</span>;
  if (view.kind === 'ok') return <span>{view.document.pages.length}ページ・手書き{view.inkRows}件・付箋{view.bookmarkRows}件</span>;
  return null;
}

/** Read-only preview of saved Notebooks, one at a time. Nothing is stored and nothing is edited. */
export function NativeNotebookPreview({ facade, runId, onBusyChange, disabled = false }: {
  facade: NativePreparationFacade; runId: string; onBusyChange?: (busy: boolean) => void; disabled?: boolean;
}) {
  // Created in an effect so that a StrictMode remount gets a live controller instead of a disposed one.
  const [controller, setController] = useState<ReturnType<typeof createPreviewController> | null>(null);
  useEffect(() => {
    const created = createPreviewController(facade, runId);
    setController(created);
    return () => { created.dispose(); setController(null); onBusyChange?.(false); };
  }, [facade, runId, onBusyChange]);
  const state = useSyncExternalStore(controller?.subscribe ?? noop, controller?.getSnapshot ?? (() => idleState), () => idleState);
  useEffect(() => { onBusyChange?.(state.busy); }, [state.busy, onBusyChange]);
  const { list, notes, busy } = state;
  return <section aria-label="保存したノートの確認">
    <h3>保存したノートの確認</h3>
    <p>保存した端末データから1冊ずつ読み取って表示します。編集や移行は行いません。ページ本文、元PDFの再現、ほかの端末やWeb・Driveのデータ、移行の完了はまだ確認していません。保存データ全体が256MiBを超える場合は確認できません。</p>
    <button type="button" disabled={disabled || busy || !controller} onClick={() => void controller?.loadList()}>保存したノートを確認</button>
    {busy && <button type="button" onClick={() => controller?.cancel()}>確認を取り消す</button>}
    {list.kind === 'loading' && <p role="status">保存データを確認しています…</p>}
    {list.kind === 'blocked' && <p role="alert">{reasonText[list.reason]}</p>}
    {list.kind === 'error' && <p role="alert">{unavailable}</p>}
    {list.kind === 'ok' && list.selectors.length === 0 && <p>確認できるノートはありません。</p>}
    {list.kind === 'ok' && list.selectors.length > 0 && <ul>
      {list.selectors.map((selector, index) => {
        const view = notes[selector] ?? { kind: 'idle' as const };
        return <li key={selector} aria-label={`ノート ${index + 1}`}>
          <span>ノート {index + 1}</span>{' '}
          <button type="button" disabled={disabled || busy} onClick={() => void controller?.loadNote(selector)}>{view.kind === 'idle' ? '表示する' : 'もう一度確認する'}</button>{' '}
          <NoteStatus view={view} />
          {view.kind === 'ok' && <NotebookPreviewPages document={view.document} />}
        </li>;
      })}
    </ul>}
  </section>;
}

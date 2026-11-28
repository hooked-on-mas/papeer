import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ContentRepository } from '../../../runtime/edits/ports';
import { CanonicalMarkdownPreview } from '../../notes/markdown/CanonicalMarkdownPreview';
import { CanonicalDocumentPagePreview } from '../../reader/CanonicalDocumentPagePreview';
import { ContentNavigationContext } from '../../reader/navigation/ContentNavigationContext';
import { DeletedContentComparisonSession, comparisonPages, type DeletedContentComparisonSide, type ComparisonPageKey } from './DeletedContentComparisonSession';

type Resources = Pick<ContentRepository, 'scope' | 'readResource'>;
function ComparisonSide({ side, session, resources, available }: {
  side: DeletedContentComparisonSide; session: DeletedContentComparisonSession; resources: Resources; available: boolean;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const snapshot = state[side], selectedPage = state.page[side];
  const heads = side === 'observed' ? state.observedHeads : state.currentHeads;
  const title = side === 'observed' ? '削除時点の版' : '現在の版';
  const scroll = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const pendingRestore = useRef<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const element = scroll.current, inner = content.current, saved = session.getSnapshot().scroll[side];
    if (!element || !inner || !available) { pendingRestore.current = null; return; }
    const target = { ...saved }; pendingRestore.current = target;
    const restore = () => {
      if (pendingRestore.current !== target) return;
      element.scrollTop = target.top; element.scrollLeft = target.left;
      if (Math.abs(element.scrollTop - target.top) < 1 && Math.abs(element.scrollLeft - target.left) < 1) pendingRestore.current = null;
    };
    // Images can establish their dimensions well after a page preview's first layout or animation frame.
    const observer = new ResizeObserver(restore); observer.observe(inner); restore();
    const frame = requestAnimationFrame(restore);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); if (pendingRestore.current === target) pendingRestore.current = null; };
  }, [session, side, snapshot?.version, selectedPage.key?.collection, selectedPage.key?.pageId, available]);
  const cancelRestore = () => {
    pendingRestore.current = null;
    const element = scroll.current;
    if (available && element) session.rememberScroll(side, { top: element.scrollTop, left: element.scrollLeft });
  };
  return <section aria-label={title} className="flex min-h-0 min-w-0 flex-col rounded border">
    <h4 className="p-2 font-medium">{title}</h4>
    <label className="px-2 pb-2">{title}を選択 <select aria-label={`${title}を選択`} value={snapshot?.version ?? ''}
      disabled={state.loading || state.stale || !!state.error}
      onChange={event => session.select(side, event.target.value)}>
      <option value="" disabled>版を選択してください</option>
      {snapshot && !heads.includes(snapshot.version) && <option value={snapshot.version}>表示中の旧版（{snapshot.version}）</option>}
      {heads.map((head, index) => <option key={head} value={head} disabled={state.missingVersions.includes(head)}>
        版 {index + 1}（{head}）{state.missingVersions.includes(head) ? '・未取得' : ''}
      </option>)}
    </select></label>
    {heads.length > 1 && !snapshot && <p role="status" className="px-2">複数の版があります。比較する版を選んでください。</p>}
    {snapshot && <p className="break-all px-2 text-xs">表示中: {snapshot.version}</p>}
    {snapshot?.kind === 'document' && <>
      <label className="px-2 pb-2">{title}のページ <select aria-label={`${title}のページを選択`}
        value={selectedPage.key ? JSON.stringify(selectedPage.key) : ''} disabled={state.loading || state.stale || !!state.error}
        onChange={event => session.selectPage(side, JSON.parse(event.target.value) as ComparisonPageKey)}>
        <option value="" disabled>ページを選択してください</option>
        {selectedPage.missing && selectedPage.key && <option value={JSON.stringify(selectedPage.key)}>選択していたページ（この版にはありません）</option>}
        {comparisonPages(snapshot).map(({ key, page }, index) => <option key={`${key.collection}:${key.pageId}`} value={JSON.stringify(key)}>
          {key.collection === 'original' ? '原文' : key.collection === 'translated' ? '訳文' : '削除済ページ'} / {page.id}
          {page.background.kind === 'pdf' ? `（PDF ${page.background.pdfPage}ページ）` : `（${page.background.spec.template}）`} / 候補 {index + 1}
        </option>)}
      </select></label>
      {selectedPage.missing && <p role="status" className="px-2">選択していたページはこの版にはありません。別のページを選んで確認できます。</p>}
      {selectedPage.key?.collection === 'deleted' && <p role="status" className="px-2">削除済ページを表示しています。元の原文・訳文への対応は推測しません。</p>}
    </>}
    <div ref={scroll} aria-label={`${title}の本文`} tabIndex={0} className="shrink-0 overflow-auto"
      style={{ height: 'min(55vh, 38rem)', minHeight: '12rem' }}
      onWheelCapture={cancelRestore} onPointerDownCapture={cancelRestore} onTouchStartCapture={cancelRestore} onKeyDownCapture={cancelRestore}
      onScroll={event => {
        if (available && !pendingRestore.current) session.rememberScroll(side, { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft });
      }}>
      <div ref={content}>
      {!available ? <p role="status" className="p-2">比較の取得を停止しています。表示する版とページは保持しています。</p> : snapshot?.kind === 'markdown' ? <>
        <CanonicalMarkdownPreview content={snapshot.content} imageResources={snapshot.imageResources} resources={resources} />
        <details className="border-t p-2"><summary>Markdown全文と画像参照</summary>
          <pre className="whitespace-pre-wrap break-words">{snapshot.content}</pre>
          <h5>この版の画像参照（{snapshot.imageResources.length}件）</h5>
          {snapshot.imageResources.length ? <ul>{snapshot.imageResources.map(image => <li key={`${image.resourceId}:${image.sha256}`} className="break-all">
            {image.resourceId} / SHA-256: {image.sha256}
          </li>)}</ul> : <p>画像参照はありません。</p>}
        </details>
      </> : snapshot?.kind === 'document' ? selectedPage.page
        ? <CanonicalDocumentPagePreview page={selectedPage.page} resources={resources} snapshotVersion={snapshot.version} />
        : <p role="status" className="p-2">表示できるページを選んでください。</p>
        : <p role="status" className="p-2">{state.loading ? '本文を取得しています…' : '表示できる版を選んでください。未取得の版は再取得できます。'}</p>}
      </div>
    </div>
  </section>;
}

/** Read-only snapshots; restoring delegates exclusively to the existing catalog authority. */
export function DeletedContentComparisonPanel({ session, resources, canRestore, available, restore, close }: {
  session: DeletedContentComparisonSession; resources: Resources; canRestore: boolean; available: boolean;
  restore(): Promise<boolean>; close(): void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [restoring, setRestoring] = useState(false), [restoreError, setRestoreError] = useState(false);
  const lifetime = useRef({ generation: 0 });
  useLayoutEffect(() => {
    const current = lifetime.current; current.generation++;
    return () => { current.generation++; };
  }, [state.selection?.deletionId, state.selection?.itemId]);
  if (!state.selection) return null;
  const restoreNow = async () => {
    if (!canRestore || restoring || state.stale) return;
    const generation = lifetime.current.generation;
    setRestoring(true); setRestoreError(false);
    try {
      const saved = await restore();
      if (generation !== lifetime.current.generation) return;
      if (saved) close(); else setRestoreError(true);
    } catch { if (generation === lifetime.current.generation) setRestoreError(true); }
    finally { if (generation === lifetime.current.generation) setRestoring(false); }
  };
  return <section aria-label="削除した資料の比較" className="my-3 space-y-2 rounded border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3>削除時点と現在の資料を比較</h3>
      <button type="button" onClick={close}>比較を閉じる</button></div>
    <p>左右の版を閲覧できます。比較を閉じても両方の版と削除状態は保持されます。復元すると、次の資料の削除状態だけをまとめて解除し、本文と編集履歴はそのまま保持します。削除時に切り離した子ノートや解除した関連は戻しません。</p>
    <ul aria-label="一緒に復元する資料">{state.targets.map(target => <li key={target.id}>{target.title}</li>)}</ul>
    {state.stale && <p role="alert">削除の状態が変わりました。この比較は閲覧のみです。一覧から開き直してください。</p>}
    {state.error && !state.stale && <p role="alert">比較する本文を取得できませんでした。表示中の内容は保持しています。</p>}
    {state.waiting.length > 0 && <p role="status">編集履歴の到着を待っています（{state.waiting.length}件）。取得できた版を表示しています。</p>}
    {state.missingVersions.length > 0 && <p role="status">未取得の版があります（{state.missingVersions.length}件）。表示中の版は保持しています。</p>}
    {state.newHeads.length > 0 && <p role="status">新しい版が届きました。現在の比較は保持しています。右側の選択欄から確認できます。</p>}
    {(state.observedStale || state.currentStale) && <p role="status">表示中の版は以前に取得した内容です。現在の版が変わっても、この比較の選択は保持します。</p>}
    <button type="button" disabled={state.loading || state.stale || restoring} onClick={() => { void session.refresh(); }}>
      {state.loading ? '比較を取得中…' : '比較を再取得'}</button>
    <ContentNavigationContext.Provider value={null}>
      <div className="grid min-h-0 gap-3 md:grid-cols-2">
        <ComparisonSide side="observed" session={session} resources={resources} available={available} />
        <ComparisonSide side="current" session={session} resources={resources} available={available} />
      </div>
    </ContentNavigationContext.Provider>
    {restoreError && <p role="alert">復元できませんでした。比較内容は保持しています。資料一覧の保存状態を確認して再試行してください。</p>}
    <button type="button" disabled={!canRestore || state.stale || restoring} onClick={() => { void restoreNow(); }}>
      {restoring ? '復元しています…' : '比較した資料を復元'}</button>
  </section>;
}

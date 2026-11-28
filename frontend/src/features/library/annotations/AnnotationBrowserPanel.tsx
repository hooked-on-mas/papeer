import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronRight, StickyNote } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { NativeSelect } from '../../../components/ui/native-select';
import type { AnnotationBrowserSession, AnnotationLocationValidation } from './AnnotationBrowserSession';
import type { AnnotationBrowserExport, AnnotationBrowserRow } from './canonicalAnnotationBrowser';
import { useWorkspaceCommands, useWorkspaceFocusGuard } from '../../workspace/WorkspaceCommandContext';

export type AnnotationBrowserPanelProps = {
  session: AnnotationBrowserSession;
  openLocation(location: Extract<AnnotationLocationValidation, { status: 'valid' }>): Promise<{ status: 'applied' | 'unchanged' | 'blocked'; reason?: string }>;
  appendResults(result: AnnotationBrowserExport): Promise<boolean>;
  appendUnavailableReason?: string;
  unavailableReason?: string;
  refreshSources?(): Promise<void>;
};
const inputClass = 'h-7 text-xs';
const sessionKeys = new WeakMap<AnnotationBrowserSession, number>();
let nextSessionKey = 0;

/** Presentation only. Reads and append/navigation admission remain in the supplied authorities. */
export function AnnotationBrowserPanel(props: AnnotationBrowserPanelProps) {
  let key = sessionKeys.get(props.session);
  if (key === undefined) { key = ++nextSessionKey; sessionKeys.set(props.session, key); }
  return <AnnotationBrowserPanelInner key={key} {...props} />;
}

/** Transient requests belong to this exact read authority, including replacements within one scope. */
function AnnotationBrowserPanelInner({ session, openLocation, appendResults, appendUnavailableReason, unavailableReason, refreshSources }: AnnotationBrowserPanelProps) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [pendingExport, setPendingExport] = useState<AnnotationBrowserExport | null>(null);
  const focusBusy = useRef(false), pendingRef = useRef<AnnotationBrowserExport | null>(null);
  const commands = useWorkspaceCommands();
  const focused = useSyncExternalStore(commands?.subscribeFocus ?? (() => () => {}), commands?.getFocusSnapshot ?? (() => false), commands?.getFocusSnapshot ?? (() => false));
  const focusScroll = useRef<{ rowKey: string; offset: number } | null>(null);
  pendingRef.current = pendingExport;
  const setGuardedBusy = (value: boolean) => { focusBusy.current = value; setBusy(value); };
  const paneRef = useRef<HTMLDivElement>(null), rowRefs = useRef(new Map<string, HTMLElement>());
  useWorkspaceFocusGuard('annotation-panel', () => !focusBusy.current && !pendingRef.current, () => {
    focusScroll.current = null;
    restoreFocus.current = false;
    const pane = paneRef.current; if (!expanded || !pane || !pane.getClientRects().length) return;
    const top = pane.getBoundingClientRect().top + pane.clientTop;
    const row = state.rows.find(value => { const element = rowRefs.current.get(value.key); return !!element && element.getBoundingClientRect().bottom > top; });
    const element = row && rowRefs.current.get(row.key);
    if (row && element) focusScroll.current = { rowKey: row.key, offset: element.getBoundingClientRect().top - top };
  });
  const lifetime = useRef(0), mounted = useRef(false), restoring = useRef(false), restoreFocus = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    const generation = ++lifetime.current;
    return () => { mounted.current = false; lifetime.current = generation + 1; };
  }, [session]);
  const rememberScroll = () => {
    const pane = paneRef.current; if (!pane || focused || !pane.getClientRects().length || restoring.current) return;
    const top = pane.getBoundingClientRect().top + pane.clientTop;
    for (const row of state.rows) {
      const element = rowRefs.current.get(row.key); if (!element) continue;
      const box = element.getBoundingClientRect();
      if (box.bottom > top) { session.rememberScroll(row.key, box.top - top); break; }
    }
  };
  useLayoutEffect(() => {
    const pane = paneRef.current; if (!expanded || focused || !pane || !pane.getClientRects().length) return;
    const scroll = focusScroll.current ?? session.getSnapshot().scroll, element = scroll && rowRefs.current.get(scroll.rowKey);
    restoring.current = true;
    if (scroll && element) pane.scrollTop += element.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientTop - scroll.offset;
    focusScroll.current = null;
    if (restoreFocus.current) {
      const selected = session.getSnapshot().selectedKey;
      if (selected) rowRefs.current.get(selected)?.focus({ preventScroll: true });
      restoreFocus.current = false;
    }
    restoring.current = false;
  }, [expanded, focused, session, state.rows]);
  const toggle = () => {
    if (expanded) rememberScroll(); else restoreFocus.current = true;
    setExpanded(value => !value);
  };
  const open = async (row: AnnotationBrowserRow) => {
    if (busy) return;
    const conflicted = state.conflictedIds.includes(row.documentId);
    const version = versions[row.key];
    if (conflicted && (!version || !row.sourceVersions.includes(version))) {
      setError('この資料には複数の版があります。移動する版を選んでください。'); return;
    }
    session.select(row.key); rememberScroll(); setGuardedBusy(true); setError('');
    const generation = lifetime.current;
    try {
      const result = await session.validateLocation(row.key, conflicted ? version : undefined);
      if (!mounted.current || generation !== lifetime.current) return;
      if (result.status !== 'valid') { setError('出典の版・場所・注釈が変わったか、取得できません。一覧を更新して確認してください。'); return; }
      const opened = await openLocation(result);
      if (!mounted.current || generation !== lifetime.current) return;
      if (opened.status === 'blocked') setError('出典を開けませんでした。現在の入力・保存状態と原訳の対応を確認してください。');
      else { rememberScroll(); restoreFocus.current = true; setExpanded(false); }
    } catch { if (mounted.current && generation === lifetime.current) setError('出典を開けませんでした。一覧と選択内容は保持しています。'); }
    finally { if (mounted.current && generation === lifetime.current) setGuardedBusy(false); }
  };
  const append = async () => {
    if (busy) return;
    const result = pendingExport ?? session.captureExport();
    if (!result) {
      setError(session.getSnapshot().exportError === 'annotation-export-location-invalid'
        ? '出典として書き出せない位置の注釈があります。内容は一覧に保持しています。'
        : '一覧が取得中か、以前の結果を表示しています。更新してから書き出してください。'); return;
    }
    if (!result.rows.length) { setError('書き出す注釈がありません。'); return; }
    pendingRef.current = result; setPendingExport(result); setGuardedBusy(true); setError('');
    const generation = lifetime.current;
    try {
      const accepted = await appendResults(result);
      if (!mounted.current || generation !== lifetime.current) return;
      if (accepted) setPendingExport(null);
      else setError('追記を開始できませんでした。開始時の一覧を保持しています。同じ内容で再試行できます。');
    } catch { if (mounted.current && generation === lifetime.current) setError('追記できませんでした。開始時の一覧を保持しています。'); }
    finally { if (mounted.current && generation === lifetime.current) setGuardedBusy(false); }
  };
  const update = async () => {
    if (busy) return;
    const generation = lifetime.current;
    setGuardedBusy(true); setError('');
    try { await (refreshSources ? refreshSources() : session.retry()); }
    catch {
      if (mounted.current && generation === lifetime.current)
        setError('一覧を更新できませんでした。表示中の結果と選択内容は保持しています。');
    } finally { if (mounted.current && generation === lifetime.current) setGuardedBusy(false); }
  };
  return <section aria-label="付箋・ハイライト一覧" className="flex max-h-[55%] min-h-0 shrink-0 flex-col border-t bg-sidebar">
    <button type="button" aria-expanded={expanded} onClick={toggle}
      className="flex w-full shrink-0 items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground">
      {expanded ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
      <StickyNote className="size-3.5 shrink-0" />
      <span className="flex-1 truncate">付箋・ハイライト一覧（{state.rows.length}件）</span>
    </button>
    {expanded && <div className="min-h-0 space-y-2 overflow-auto border-t bg-background p-2.5 text-xs">
      <div className="grid grid-cols-2 gap-1.5">
        <label className="space-y-1">
          <span className="text-muted-foreground">対象</span>
          <NativeSelect aria-label="対象" className={inputClass} value={state.query.scope} onChange={event => session.setQuery({ scope: event.target.value as 'current' | 'all' })}>
            <option value="current">現在の資料</option><option value="all">すべての資料</option>
          </NativeSelect>
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground">種類</span>
          <NativeSelect aria-label="種類" className={inputClass} value={state.query.kind ?? ''}
            onChange={event => session.setQuery({ kind: (event.target.value || undefined) as 'sticky' | 'highlight' | undefined })}>
            <option value="">すべて</option><option value="sticky">付箋</option><option value="highlight">ハイライト</option>
          </NativeSelect>
        </label>
        <label className="col-span-2 space-y-1">
          <span className="text-muted-foreground">検索</span>
          <Input className={inputClass} type="search" value={state.query.query ?? ''} placeholder="複数の語を空白で区切る"
            onChange={event => session.setQuery({ query: event.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground">原訳</span>
          <NativeSelect aria-label="原訳" className={inputClass} value={state.query.surface ?? ''}
            onChange={event => session.setQuery({ surface: (event.target.value || undefined) as 'original' | 'translated' | undefined })}>
            <option value="">両方</option><option value="original">原文</option><option value="translated">訳文</option>
          </NativeSelect>
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground">順序</span>
          <NativeSelect aria-label="順序" className={inputClass} value={state.query.sort ?? 'document'}
            onChange={event => session.setQuery({ sort: event.target.value as 'document' | 'created-ascending' | 'created-descending' })}>
            <option value="document">資料・ページ順</option><option value="created-ascending">作成日時が古い順</option><option value="created-descending">作成日時が新しい順</option>
          </NativeSelect>
        </label>
        <label className="col-span-2 space-y-1">
          <span className="text-muted-foreground">分類</span>
          <Input className={inputClass} value={state.query.label ?? ''} placeholder="分類名と完全一致"
            onChange={event => session.setQuery({ label: event.target.value || undefined })} />
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" variant="outline" size="xs" onClick={() => session.clear()}>条件を解除</Button>
        <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => { void update(); }}>一覧を更新</Button>
      </div>
      <p role="status" className="text-muted-foreground">{state.loading ? '注釈を取得中… ' : `${state.rows.length}件 `}
        {state.missingIds.length > 0 && `未取得 ${state.missingIds.length}資料 `}
        {state.partialIds.length > 0 && `一部未取得 ${state.partialIds.length}資料 `}
        {state.conflictedIds.length > 0 && `複数の版 ${state.conflictedIds.length}資料 `}
        {state.staleIds.length > 0 && `以前の結果 ${state.staleIds.length}資料`}
      </p>
      {unavailableReason && <p role="status" className="text-muted-foreground">{unavailableReason}</p>}
      {(error || state.error || state.exportError) && <p role="alert" className="text-destructive">
        {error || (state.exportError === 'annotation-export-location-invalid' ? '出典として書き出せない位置の注釈があります。内容は保持しています。'
          : state.exportError ? '以前の結果は書き出せません。取得状態を確認して一覧を更新してください。' : '取得できない資料があります。表示中の結果と状態を確認して再試行してください。')}
      </p>}
      <div ref={paneRef} onScroll={rememberScroll} className="max-h-64 overflow-auto" aria-label="注釈の検索結果">
        {state.rows.length === 0 && !state.loading && <p className="p-2 text-muted-foreground">条件に一致する注釈はありません。</p>}
        <ol className="space-y-1.5">
          {state.rows.map(row => {
            const stale = state.staleIds.includes(row.documentId), conflicted = state.conflictedIds.includes(row.documentId);
            const chosen = row.sourceVersions.includes(versions[row.key]) ? versions[row.key] : '';
            return <li key={row.key} ref={element => { if (element) rowRefs.current.set(row.key, element); else rowRefs.current.delete(row.key); }}
              tabIndex={0} onFocus={() => session.select(row.key)} className={`rounded-md border p-2 ${state.selectedKey === row.key ? 'border-primary bg-accent/30' : ''}`}>
              <p className="font-medium">{row.title} · {row.surface === 'original' ? '原文' : '訳文'} p.{row.pageIndex + 1} · {row.annotation.kind === 'sticky' ? '付箋' : 'ハイライト'}</p>
              {row.annotation.metadata.label && <p>分類: {row.annotation.metadata.label}</p>}
              <p className="text-muted-foreground">作成日時: {row.annotation.metadata.createdAt ?? '不明'}{stale ? ' · 以前の結果（再取得が必要）' : ''}</p>
              {row.annotation.quote && <blockquote className="mt-1 whitespace-pre-wrap break-words border-l-2 pl-2 text-muted-foreground">{row.annotation.quote}</blockquote>}
              {row.annotation.text && <p className="mt-1 whitespace-pre-wrap break-words">{row.annotation.text}</p>}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {conflicted && <label className="flex items-center gap-1">出典の版 <NativeSelect aria-label="出典の版" className={inputClass} value={chosen}
                  onChange={event => setVersions(value => ({ ...value, [row.key]: event.target.value }))}>
                  <option value="">版を選択</option>{row.sourceVersions.map(version => <option key={version} value={version}>{version}</option>)}
                </NativeSelect></label>}
                <Button type="button" variant="outline" size="xs" disabled={!!unavailableReason || busy || stale || conflicted && !chosen} onClick={() => { void open(row); }}>場所へ移動</Button>
              </div>
            </li>;
          })}
        </ol>
      </div>
      {pendingExport && <p>開始時の{pendingExport.rows.length}件を保持しています。条件を変更しても再試行する内容は変わりません。</p>}
      <Button type="button" variant="outline" size="xs" className="w-full" disabled={!!unavailableReason || !!appendUnavailableReason || busy || !pendingExport && (state.loading || !state.rows.length || state.rows.some(row => state.staleIds.includes(row.documentId)))}
        onClick={() => { void append(); }}>{pendingExport ? '同じ一覧の追記を再試行' : '絞込結果をノートへ追記'}</Button>
      <p className="text-muted-foreground">保存済みの注釈が対象です。未保存の編集や未取得の資料は含みません。</p>
      {appendUnavailableReason && <p role="status" className="text-muted-foreground">{appendUnavailableReason}</p>}
    </div>}
  </section>;
}

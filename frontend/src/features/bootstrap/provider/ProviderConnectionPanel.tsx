import { useEffect, useId, useState, type FormEvent } from 'react';
import { Cloud } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { pyStrip } from '../../../lib/pyWhitespace.ts';
import type { ProviderConnectionController, ProviderConnectionState } from './providerConnectionPorts.ts';

/** Display only. The host owns credentials, requests, admissions and the connection lifetime. */
export function ProviderConnectionPanel({ controller, state, disabled = false, initiallyExpanded = false }: {
  controller: ProviderConnectionController;
  state: ProviderConnectionState;
  disabled?: boolean;
  initiallyExpanded?: boolean;
}) {
  const [title, setTitle] = useState('');
  const [actionError, setActionError] = useState(false);
  const [leaveRefused, setLeaveRefused] = useState(false);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const titleId = useId();
  const visible = expanded || state.connected || state.request !== null;

  useEffect(() => {
    if (!visible) return;
    let present = true;
    void controller.prepare().catch(() => { if (present) setActionError(true); });
    // Unmounting the chooser does not disconnect an editor or drop a pending request.
    return () => { present = false; };
  }, [controller, visible]);

  const perform = (start: () => Promise<unknown>) => {
    setActionError(false); setLeaveRefused(false);
    // In particular, connect starts synchronously in the click event before any awaited work.
    try { void start().catch(() => setActionError(true)); }
    catch { setActionError(true); }
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    if (!disabled && state.canCreate && pyStrip(title)) perform(() => controller.create(title));
  };
  const request = state.request;
  const busyMessage = state.phase === 'preloading' ? 'Googleへの接続を準備しています…'
    : state.phase === 'connecting' ? 'Googleの画面で接続を確認してください。'
    : state.phase === 'opening' ? 'ライブラリを開いています…'
    : state.phase === 'disconnecting' ? '接続を終了しています…'
    : 'ライブラリの保存状況を確認しています…';

  return <section aria-label="Google Driveのライブラリ" className="space-y-2 rounded-lg border bg-muted/30 p-3 text-sm">
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 font-medium">
        <Cloud className="size-4 text-muted-foreground" />
        <h2>Google Drive</h2>
      </div>
      {!visible && <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setExpanded(true)}>Google Driveを使う</Button>}
    </div>
    <p className="text-xs text-muted-foreground">別の端末とライブラリを共有できます。</p>
    {visible && <>
    {state.busy && <p role="status" className="text-xs text-muted-foreground">{busyMessage}</p>}
    {(state.error || actionError) && <p role="alert" className="text-xs text-destructive">{state.error || '操作を完了できませんでした。もう一度確認してください。'}</p>}
    {leaveRefused && <p role="alert" className="text-xs text-destructive">入力を確定または取り消し、保存状況を確認してから接続を終了してください。</p>}

    {!state.connected && <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" disabled={disabled || !state.canConnect} onClick={() => perform(() => controller.connect())}>Googleに接続</Button>
      {state.phase === 'unavailable' && <Button type="button" variant="outline" size="sm" disabled={disabled || state.busy}
        onClick={() => perform(() => controller.prepare())}>接続の準備を再確認</Button>}
      {state.phase === 'connecting' && <Button type="button" variant="outline" size="sm" disabled={disabled}
        onClick={() => perform(() => controller.cancelConnect())}>接続を取り消す</Button>}
    </div>}

    {request && <div role="status" className="space-y-2 rounded border bg-background p-2 text-xs">
      <p>{request.title}: {request.status === 'accepted' ? (state.pendingGuard ? '保存しました。残っている処理の状況を確認してください。' : 'ライブラリを開く準備ができました。')
        : request.status === 'rejected' ? '操作を完了できませんでした。'
        : request.status === 'unknown' ? '保存結果を確認できていません。同じ処理の状況を確認してください。'
        : request.action === 'create' ? (state.busy ? 'ライブラリを作成しています…' : '未完了の作成処理が残っています。「保存状況を再確認」で再開できます。')
        : (state.busy ? 'ライブラリを読み込んでいます…' : '未完了の読み込み処理が残っています。「保存状況を再確認」で再開できます。')}</p>
      {state.canRetry && <Button type="button" variant="outline" size="xs" disabled={disabled || state.busy}
        onClick={() => perform(() => controller.retry())}>保存状況を再確認</Button>}
      {state.canOpenInstalled && <Button type="button" size="xs" disabled={disabled || state.busy}
        onClick={() => perform(() => controller.openInstalled())}>ライブラリを開く</Button>}
    </div>}

    {state.connected && <>
      <ul className="space-y-1.5">{state.choices.map((choice, index) => <li key={index}>
        {choice.status === 'available' ? <Button type="button" variant="outline" size="sm" className="w-full justify-start" disabled={disabled || !state.canJoin}
          onClick={() => perform(() => controller.join(choice.handle))}>{choice.title}</Button>
          : <span className="text-xs text-muted-foreground">{choice.title}（{choice.status === 'owner-write-required' ? '所有者の書込み権限が必要です' : '現在は開けません'}）</span>}
      </li>)}</ul>
      {state.canCreate && state.choices.length === 0 && !state.error && <p className="text-xs text-muted-foreground">開けるライブラリはありません。新しく作成できます。</p>}
      <form onSubmit={create} className="space-y-2 pt-1">
        <label htmlFor={titleId} className="block text-xs text-muted-foreground">新しいクラウドライブラリの名前</label>
        <div className="flex gap-2">
          <Input id={titleId} value={title} onChange={event => setTitle(event.target.value)} disabled={disabled || !state.canCreate} required />
          <Button type="submit" size="sm" disabled={disabled || !state.canCreate || !pyStrip(title)}>クラウドライブラリを作成</Button>
        </div>
      </form>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="button" variant="outline" size="xs" disabled={disabled || !state.canRefresh} onClick={() => perform(() => controller.refresh())}>Driveの一覧を更新</Button>
        <Button type="button" variant="ghost" size="xs" disabled={disabled || !state.canDisconnect} onClick={() => perform(async () => {
          const result = await controller.disconnect(); setLeaveRefused(result.status !== 'allowed');
        })}>Googleとの接続を終了</Button>
      </div>
    </>}
    </>}
  </section>;
}

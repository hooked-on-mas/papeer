import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { WifiOff } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import type { ProviderOfflineController, ProviderOfflineState } from './providerOfflinePorts.ts';

/** Product display only; authentication, request identity and scope authority belong to the host. */
export function ProviderOfflinePanel({
  controller,
  state,
  disabled = false,
  collapsible = false,
  initiallyExpanded = true,
}: {
  controller: ProviderOfflineController;
  state: ProviderOfflineState;
  disabled?: boolean;
  collapsible?: boolean;
  initiallyExpanded?: boolean;
}) {
  const secret = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState(false);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const secretId = useId();
  const visible = !collapsible || expanded || initiallyExpanded || state.offlineActive || state.phase === 'unlocked'
    || state.choices.length > 0 || state.outcome !== 'none' || state.revocation !== 'none' || state.error || localError;

  const attachSecret = useCallback((element: HTMLInputElement | null) => {
    if (secret.current && secret.current !== element) secret.current.value = '';
    secret.current = element;
  }, []);
  useEffect(() => {
    const clear = () => { if (secret.current) secret.current.value = ''; };
    window.addEventListener('pagehide', clear);
    return () => { window.removeEventListener('pagehide', clear); clear(); };
  }, []);
  useEffect(() => {
    if (disabled || state.busy || (!state.canEnroll && !state.canUnlock && !state.canRevokeEnrollment)) {
      if (secret.current) secret.current.value = '';
    }
  }, [disabled, state.busy, state.canEnroll, state.canUnlock, state.canRevokeEnrollment]);
  const perform = (action: () => Promise<void>) => {
    setLocalError(false);
    try { void action().catch(() => setLocalError(true)); } catch { setLocalError(true); }
  };
  const submit = (action: 'enroll' | 'unlock' | 'revokeEnrollment') => {
    const input = secret.current, value = input?.value ?? '';
    if (input) input.value = '';
    if (disabled || state.busy || !value) return;
    if (action === 'enroll' && state.canEnroll) perform(() => controller.enroll(value));
    else if (action === 'unlock' && state.canUnlock) perform(() => controller.unlock(value));
    else if (action === 'revokeEnrollment' && state.canRevokeEnrollment) perform(() => controller.revokeEnrollment(value));
  };
  const needsSecret = state.canEnroll || state.canUnlock || state.canRevokeEnrollment;
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (state.canEnroll) submit('enroll');
    else if (state.canUnlock) submit('unlock');
  };

  return <section aria-label="端末でのオフライン利用" className="space-y-2 rounded-lg border bg-muted/30 p-3 text-sm">
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 font-medium">
        <WifiOff className="size-4 shrink-0 text-muted-foreground" />
        <h2>端末でのオフライン利用</h2>
      </div>
      {!visible && <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setExpanded(true)}>
        {state.canUnlock ? '端末で開く' : '設定を開く'}
      </Button>}
    </div>
    <p className="text-xs text-muted-foreground">事前に許可したライブラリを、この端末のパスフレーズで開きます。同期にはGoogleへの再接続が必要です。</p>
    {visible && <>
      <p className="text-xs text-muted-foreground">この設定はアプリで開くときの確認に使います。資料自体は暗号化されません。</p>
      {state.offlineActive && <p role="status" className="text-xs text-muted-foreground">端末の保存データを使用中です。同期は停止しています。</p>}
      {state.busy && <p role="status" className="text-xs text-muted-foreground">確認しています…</p>}
      {(state.error || localError) && <p role="alert" className="text-xs text-destructive">操作を完了できませんでした。入力と保存状態を確認してください。</p>}
      {state.outcome === 'unknown' && <p role="status" className="text-xs text-muted-foreground">許可の保存結果を確認できません。同じ操作を再確認してください。</p>}
      {state.outcome === 'accepted' && <p role="status" className="text-xs text-foreground">この端末での利用を許可しました。</p>}
      {state.outcome === 'rejected' && <p role="alert" className="text-xs text-destructive">この端末での利用を許可できませんでした。</p>}
      {state.revocation === 'unknown' && <p role="status" className="text-xs text-muted-foreground">許可の取り消し結果を確認できません。同じライブラリで、パスフレーズを入力して取り消しを再確認してください。</p>}
      {state.revocation === 'revoked' && <p role="status" className="text-xs text-foreground">このライブラリの端末利用の許可を取り消しました。資料と未送信の変更は保持しています。</p>}
      {needsSecret && <form onSubmit={onSubmit} className="space-y-2 pt-1">
        <div className="space-y-1.5">
          <label htmlFor={secretId} className="block text-xs text-muted-foreground">端末のパスフレーズ</label>
          <Input id={secretId} ref={attachSecret} type="password" autoComplete="off" disabled={disabled || state.busy} required />
        </div>
        <div className="flex flex-wrap gap-2">
          {state.canEnroll && <Button type="submit" size="sm" disabled={disabled || state.busy}>この端末での利用を許可</Button>}
          {state.canUnlock && <Button type="submit" size="sm" disabled={disabled || state.busy}>端末で開く</Button>}
          {state.canRevokeEnrollment && <Button type="button" variant="outline" size="sm" disabled={disabled || state.busy} onClick={() => submit('revokeEnrollment')}>
            {state.revocation === 'unknown' ? '端末利用の許可の取り消しを再確認' : 'このライブラリの端末利用の許可を取り消す'}
          </Button>}
        </div>
      </form>}
      {state.phase === 'unlocked' && <div className="space-y-2 pt-1">
        <ul className="space-y-1.5">{state.choices.map((choice, index) => <li key={index} className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" className="min-w-0 flex-1 justify-start truncate"
            disabled={disabled || state.busy || !state.canOpen} onClick={() => perform(() => controller.open(choice.handle))}>
            {choice.title}
          </Button>
          {state.canRevoke && <Button type="button" variant="ghost" size="xs" disabled={disabled || state.busy}
            onClick={() => perform(() => controller.revoke(choice.handle))}>この端末での許可を取り消す</Button>}
        </li>)}</ul>
        {state.canLock && <Button type="button" variant="ghost" size="xs" disabled={disabled || state.busy}
          onClick={() => perform(() => controller.lock())}>端末での利用をロック</Button>}
      </div>}
    </>}
  </section>;
}

import { useEffect, useState } from 'react';
import type { NativePreparationFacade, NativePreparationStatus } from '../bootstrapPorts.ts';
import { NativeNotebookPreview } from './NativeNotebookPreview.tsx';

/** Preparation is not migration, publication or a live lock certificate. */
export function NativePreparationPanel({ facade, allowStart }: { facade: NativePreparationFacade; allowStart: boolean }) {
  const [status, setStatus] = useState<NativePreparationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  // While a preview is reading the saved data, starting, resuming or abandoning the preparation is not offered.
  const [previewBusy, setPreviewBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void facade.status(controller.signal).then(setStatus, () => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [facade]);
  useEffect(() => {
    if (status?.state !== 'running') return;
    const controller = new AbortController();
    const timer = setInterval(() => { void facade.status(controller.signal).then(setStatus, () => { if (!controller.signal.aborted) setError(true); }); }, 1500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [facade, status?.state]);
  const perform = (action: 'start' | 'resume' | 'abandon') => {
    if (busy || previewBusy || !status || (action !== 'start' && !status.runId)) return;
    setBusy(true); setError(false);
    const controller = new AbortController();
    const pending = action === 'start' ? facade.start(controller.signal)
      : action === 'resume' ? facade.resume(status.runId!, controller.signal) : facade.abandon(status.runId!, controller.signal);
    void pending.then(setStatus, () => setError(true)).finally(() => setBusy(false));
  };
  const resume = status?.state === 'recovery-required' && ['not-collected', 'hold-only', 'partial', 'artifacts-verified'].includes(status.phase ?? '');
  const abandon = !!status?.runId && (status.state === 'captured' || (status.state === 'recovery-required'
    && ['not-collected', 'hold-only', 'partial', 'artifacts-verified', 'cancel-interrupted'].includes(status.phase ?? '')));
  return <section aria-label="以前のデータの準備">
    <h2>以前のデータの準備</h2>
    <p>この端末のライブラリと関連する端末設定を保全する準備です。ほかの端末やWeb・Driveのデータは対象外です。移行や切り替えはまだ行いません。</p>
    {!status && <p role="status">準備状況を確認しています…</p>}
    {status?.state === 'running' && <p role="status">データを保全しています。完了までお待ちください。</p>}
    {status?.state === 'captured' && <p role="status">準備したデータを確認しました。移行はまだ完了していません。</p>}
    {status?.state === 'recovery-required' && <p role="status">前回の準備が中断されました。保存された状態を確認してください。</p>}
    {status?.state === 'failed' && <p role="alert">準備を完了できませんでした。状態を保持しています。アプリを終了してから開き直し、準備状況を確認してください。</p>}
    {status?.state === 'cancelled' && <p role="status">準備を中止しました。アプリを終了してから開き直してください。</p>}
    {error && <p role="alert">準備状況を確認できません。保存データを保持しています。</p>}
    {allowStart && (status?.state === 'idle' || status?.state === 'cancelled' && status.phase === 'restart-complete') && <button type="button" disabled={busy || previewBusy} onClick={() => perform('start')}>準備を始める</button>}
    {resume && <button type="button" disabled={busy || previewBusy} onClick={() => perform('resume')}>準備を続ける</button>}
    {abandon && <button type="button" disabled={busy || previewBusy} onClick={() => perform('abandon')}>準備を中止する</button>}
    {status?.runId && (status.state === 'captured' || status.state === 'recovery-required' && status.phase === 'artifacts-verified') && facade.notebookSelectors && facade.notebookPreview
      && <NativeNotebookPreview key={status.runId} facade={facade} runId={status.runId} onBusyChange={setPreviewBusy} disabled={busy} />}
  </section>;
}

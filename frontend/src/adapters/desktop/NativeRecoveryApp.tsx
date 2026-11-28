import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { NativePreparationPanel } from '../../features/bootstrap/legacy/NativePreparationPanel.tsx';
import { createDesktopBootstrapHost, type DesktopBootstrapHost } from './bootstrapEntry.ts';
import { installTauriCloseRequests } from './desktopWindowClose.ts';
import { createRecoveryClose, recoveryCloseHost } from './NativeRecoveryClose.ts';
import type { NativePreparationFacade } from '../../features/bootstrap/bootstrapPorts.ts';

/** This entry never mounts a Library, provider chooser, or editing surface. */
function Recovery({ host }: { host: DesktopBootstrapHost & { preparation: NativePreparationFacade | null } }) {
  const close = useSyncExternalStore(host.close.subscribe, host.close.getSnapshot, host.close.getSnapshot);
  const facade = host.preparation;
  if (!facade) return <p role="alert">準備状況を確認できません。</p>;
  return <main><NativePreparationPanel facade={facade} allowStart />
    {close === 'failed' && <p role="alert">終了を完了できませんでした。もう一度お試しください。</p>}
    {close === 'refused' && <p role="alert">処理が完了してから終了してください。</p>}
  </main>;
}

export async function mountNativeRecoveryApp(container: HTMLElement) {
  const base = createDesktopBootstrapHost(), raw = base.session.getNativePreparation();
  const recovery = raw ? createRecoveryClose(base.session, raw, recoveryCloseHost()) : null;
  const host = { ...base, preparation: recovery?.facade ?? null, close: recovery?.close ?? base.close };
  const root = createRoot(container);
  root.render(<StrictMode><Recovery host={host} /></StrictMode>);
  void installTauriCloseRequests(host.close).catch(() => undefined);
  return root;
}

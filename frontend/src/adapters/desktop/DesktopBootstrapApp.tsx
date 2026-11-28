import { lazy, StrictMode, Suspense, useEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { BootstrapConnection } from '../../features/bootstrap/BootstrapConnection';
import { createDesktopBootstrapHost, type DesktopBootstrapHost } from './bootstrapEntry';
import { installTauriCloseRequests } from './desktopWindowClose';

const DesktopDocumentLibrary = lazy(() => import('./DocumentLibraryView').then(module => ({ default: module.DesktopDocumentLibrary })));
const DesktopMarkdownLibrary = lazy(() => import('./MarkdownLibraryView').then(module => ({ default: module.DesktopMarkdownLibrary })));

/**
 * The webview's own zoom stays enabled only so touchpad pinch reaches the reader as Ctrl+wheel;
 * everywhere else it must not scale the whole app (same rule as the previous shell).
 */
function useBlockWebviewZoom(): void {
  useEffect(() => {
    const onWheel = (event: WheelEvent) => { if (event.ctrlKey || event.metaKey) event.preventDefault(); };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && ['+', '-', '=', '0', ';'].includes(event.key)) event.preventDefault();
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('wheel', onWheel); window.removeEventListener('keydown', onKeyDown); };
  }, []);
}

export function DesktopBootstrapApp({ host }: { host: DesktopBootstrapHost }) {
  useBlockWebviewZoom();
  const closeState = useSyncExternalStore(host.close.subscribe, host.close.getSnapshot, host.close.getSnapshot);
  return <div className="h-dvh w-full">
    <Suspense fallback={<p role="status">編集画面を起動しています…</p>}>
      <BootstrapConnection session={host.session}
        renderDocument={binding => <DesktopDocumentLibrary binding={binding} />}
        renderMarkdown={binding => <DesktopMarkdownLibrary binding={binding} />} />
    </Suspense>
    {closeState === 'refused' && <p role="alert" className="fixed bottom-2 left-2 z-50 rounded border bg-background p-2">
      入力を確定または取り消し、保存を確認してから終了してください。</p>}
    {closeState === 'failed' && <p role="alert" className="fixed bottom-2 left-2 z-50 rounded border bg-background p-2">
      終了を完了できませんでした。もう一度お試しください。</p>}
  </div>;
}

/** Normal PC entry: no arguments, no window binding. The host and its close handlers live as long as the window. */
export async function mountDesktopBootstrapApp(container: HTMLElement = document.getElementById('root')!) {
  const host = createDesktopBootstrapHost();
  const root = createRoot(container);
  root.render(<StrictMode><DesktopBootstrapApp host={host} /></StrictMode>);
  // Failing to listen must not stop the editor; the page lifecycle guards still apply.
  void installTauriCloseRequests(host.close).catch(() => undefined);
  return root;
}

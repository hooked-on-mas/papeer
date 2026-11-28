import { authToken, backendUrl } from '../../api/connection.ts';
import type { NativePreparationFacade, NativePreviewResult } from '../../features/bootstrap/bootstrapPorts.ts';
import type { ScopeLeaveResult } from '../../features/reader/DocumentEditSessions.ts';
import { tauriCloseHost, type DesktopCloseHost, type DesktopCloseState } from './desktopWindowClose.ts';

/** Recovery has no mounted editing scope: drain first, keeping the status facade live on pending. */
export function createRecoveryClose(session: { close(): Promise<ScopeLeaveResult> }, raw: NativePreparationFacade, host: DesktopCloseHost) {
  let state: DesktopCloseState = 'idle', flight: Promise<void> | null = null, action = false, closing = false, drained = false;
  const listeners = new Set<() => void>();
  const set = (next: DesktopCloseState) => { if (state !== next) { state = next; listeners.forEach(listener => listener()); } };
  // Previews only read, so a close request does not wait for them: it aborts them and goes on to /shutdown.
  const previews = new Set<AbortController>();
  const mutate = async (work: () => ReturnType<NativePreparationFacade['start']>) => {
    if (action || closing || drained) throw new Error('maintenance-operation-pending');
    if (previews.size > 0) throw new Error('maintenance-preview-pending');
    action = true; try { return await work(); } finally { action = false; }
  };
  /** A refusal is a value (as on the wire): the panel shows its reason and keeps the note in the list. */
  const preview = async <T extends object>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<NativePreviewResult<T>>): Promise<NativePreviewResult<T>> => {
    if (closing || drained) return { status: 'blocked', reason: 'preview-shutdown-pending' };
    if (action) return { status: 'blocked', reason: 'preview-busy' };
    const internal = new AbortController(), forward = () => internal.abort();
    signal.addEventListener('abort', forward, { once: true }); if (signal.aborted) forward();
    previews.add(internal);
    try { return await work(internal.signal); } finally { previews.delete(internal); signal.removeEventListener('abort', forward); }
  };
  const facade: NativePreparationFacade = {
    status: signal => raw.status(signal),
    start: signal => mutate(() => raw.start(signal)),
    resume: (runId, signal) => mutate(() => raw.resume(runId, signal)),
    abandon: (runId, signal) => mutate(() => raw.abandon(runId, signal)),
    ...(raw.notebookSelectors ? { notebookSelectors: (runId: string, signal: AbortSignal) => preview(signal, inner => raw.notebookSelectors!(runId, inner)) } : {}),
    ...(raw.notebookPreview ? { notebookPreview: (runId: string, selector: string, signal: AbortSignal) => preview(signal, inner => raw.notebookPreview!(runId, selector, inner)) } : {}),
  };
  const close = {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    request(): Promise<void> {
      if (flight) return flight;
      if (closing) return Promise.resolve();
      if (action) { set('refused'); return Promise.resolve(); }
      closing = true;
      for (const controller of previews) controller.abort();
      set('closing');
      const current = (async () => {
        if (!drained) {
          try { await host.shutdown(); drained = true; } catch { set('failed'); return; }
        }
        let result: ScopeLeaveResult;
        try { result = await session.close(); } catch { set('failed'); return; }
        if (result.status !== 'allowed') { set('refused'); return; }
        try { await host.exit(); } catch { set('failed'); }
      })().finally(() => { if (flight === current) { flight = null; closing = false; } });
      flight = current; return current;
    },
  };
  return { facade, close };
}

export function recoveryCloseHost(fetcher: typeof fetch = globalThis.fetch): DesktopCloseHost {
  const base = tauriCloseHost(fetcher);
  return { ...base, async shutdown() {
    const token = authToken();
    const response = await fetcher(backendUrl('/shutdown'), { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok) throw new Error('shutdown-refused');
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || (value as { stopped?: unknown }).stopped !== true) throw new Error('shutdown-incomplete');
  } };
}

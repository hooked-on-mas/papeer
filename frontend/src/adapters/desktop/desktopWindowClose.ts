import { authToken, backendUrl } from '../../api/connection.ts';
import type { ScopeLeaveResult } from '../../features/reader/DocumentEditSessions.ts';

/** What the window may do only after the bootstrap session allowed its final close. */
export type DesktopCloseHost = {
  /** Ask the sidecar to stop; best effort, it may already be gone. */
  shutdown(): Promise<void>;
  /** Hide the window and end the application. */
  exit(): Promise<void>;
};
export type DesktopCloseState = 'idle' | 'closing' | 'refused' | 'failed';
type Closable = { close(): Promise<ScopeLeaveResult> };

/**
 * The window / tray close request path. It never forces a close: when the session refuses
 * (unsaved input, unknown creation, a guard still held) the window stays open and the refusal is
 * shown. React effect cleanup never reaches this; only the real window lifetime does.
 */
export function createDesktopCloseController(session: Closable, host: DesktopCloseHost) {
  let state: DesktopCloseState = 'idle', flight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: DesktopCloseState) => { if (state === next) return; state = next; listeners.forEach(listener => listener()); };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    request(): Promise<void> {
      if (flight) return flight;
      const current = (async () => {
        set('closing');
        let result: ScopeLeaveResult;
        try { result = await session.close(); } catch { set('failed'); return; }
        if (result.status !== 'allowed') { set('refused'); return; }
        // Closed durably first; only then may the sidecar stop. A failed shutdown must not keep the window.
        try { await host.shutdown(); } catch { /* the sidecar may already be gone */ }
        try { await host.exit(); } catch { set('failed'); }
      })().finally(() => { if (flight === current) flight = null; });
      flight = current; return current;
    },
  };
}
export type DesktopCloseController = ReturnType<typeof createDesktopCloseController>;

/** Tauri host: bearer-authenticated /shutdown, then hide and exit like the previous shell did. */
export function tauriCloseHost(fetcher: typeof fetch = globalThis.fetch): DesktopCloseHost {
  return {
    async shutdown() {
      const token = authToken();
      const response = await fetcher(backendUrl('/shutdown'), { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!response.ok) throw new Error('shutdown-refused');
    },
    async exit() {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().hide().catch(() => undefined);
      const { exit } = await import('@tauri-apps/plugin-process');
      await exit(0);
    },
  };
}

/** Subscribe the controller to the Tauri window close request and the tray quit event. Plain browsers do nothing. */
export async function installTauriCloseRequests(controller: Pick<DesktopCloseController, 'request'>): Promise<() => void> {
  if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return () => {};
  const unlisteners: (() => void)[] = [];
  const [{ getCurrentWindow }, { listen }] = await Promise.all([import('@tauri-apps/api/window'), import('@tauri-apps/api/event')]);
  unlisteners.push(await getCurrentWindow().onCloseRequested(async event => { event.preventDefault(); await controller.request(); }));
  unlisteners.push(await listen('tray-quit-requested', () => { void controller.request(); }));
  return () => unlisteners.forEach(unlisten => unlisten());
}

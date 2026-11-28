import { invoke } from '@tauri-apps/api/core';
import { backendUrl } from './api/connection';
import { fetchStartupWithRetry } from './adapters/desktop/startup/fetchStartupWithRetry';
import { startGuardedApplication } from './app/startup';
import './index.css';

void startGuardedApplication(document.getElementById('root')!, {
  async readHold(signal) {
    if ((window as any).__TAURI_INTERNALS__) {
      const [port, token] = await invoke<[number, string]>('get_backend_config');
      signal.throwIfAborted();
      (window as any).__PAPEER_PORT = port; (window as any).__PAPEER_TOKEN = token;
      // Wait for the asynchronously spawned sidecar to finish binding localhost before mounting bootstrap.
      const response = await fetchStartupWithRetry(backendUrl('/health'), { method: 'GET', cache: 'no-store', signal });
      if (!response.ok) throw new Error('startup-unavailable');
    }
    return null;
  },
  async load() { await (await import('./DesktopApp')).mountDesktopApp(); },
});

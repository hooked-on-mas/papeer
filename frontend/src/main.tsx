import { invoke } from '@tauri-apps/api/core';
import { backendUrl, authToken } from './api/connection';
import { startGuardedApplication } from './app/startup';
import { fetchStartupWithRetry } from './adapters/desktop/startup/fetchStartupWithRetry';
import { bootstrapRoutes } from './adapters/desktop/canonicalBootstrapWire';
import { readLegacyWebPresenceReadonly } from './adapters/browser/legacyPresenceReadonly';
import { readLegacyHoldRecordReadonly } from './adapters/browser/legacyHoldReadonly';
import { validateLegacyMigrationHold } from './runtime/edits/contracts.ts';
import './index.css';

async function readStartup(path: typeof bootstrapRoutes.hold | typeof bootstrapRoutes.legacyPresence, signal: AbortSignal): Promise<unknown> {
  const token = authToken();
  const request = (window as any).__TAURI_INTERNALS__ ? fetchStartupWithRetry : fetch;
  const response = await request(backendUrl(path), { method: 'POST', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: '{}' });
  if (!response.ok) throw new Error('startup-unavailable');
  return response.json();
}

async function nativeRecoveryRequired(signal: AbortSignal): Promise<boolean> {
  const token = authToken();
  const response = await fetchStartupWithRetry(backendUrl('/api/edits/legacy-maintenance/status'), { method: 'POST', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: '{}' });
  if (!response.ok) throw new Error('startup-unavailable');
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('startup-unavailable');
  const row = value as Record<string, unknown>;
  if (row.scope !== 'native-preparation-only' || !['idle', 'running', 'captured', 'failed', 'recovery-required', 'cancelled'].includes(String(row.state))) throw new Error('startup-unavailable');
  return row.state !== 'idle' && !(row.state === 'cancelled' && row.phase === 'restart-complete');
}

void startGuardedApplication(document.getElementById('root')!, {
  async readHold(signal) {
    if ((window as any).__TAURI_INTERNALS__) {
      const [port, token] = await invoke<[number, string]>('get_backend_config');
      signal.throwIfAborted();
      (window as any).__PAPEER_PORT = port; (window as any).__PAPEER_TOKEN = token;
    }
    const nativeHold = await readStartup(bootstrapRoutes.hold, signal);
    if (nativeHold !== null) validateLegacyMigrationHold(nativeHold);
    return nativeHold === null ? readLegacyHoldRecordReadonly(signal) : nativeHold;
  },
  async readLegacyPresence(signal) {
    const presence = await readStartup(bootstrapRoutes.legacyPresence, signal);
    if (presence !== 'clear' && presence !== 'legacy-present') throw new Error('startup-presence-unverifiable');
    // A moved/empty native data root can still have old unsaved input in this WebView profile.
    return presence === 'legacy-present' ? presence : readLegacyWebPresenceReadonly(signal);
  },
  async readRecoveryRequired(signal) {
    return (window as any).__TAURI_INTERNALS__ ? nativeRecoveryRequired(signal) : false;
  },
  async loadRecovery(signal) {
    if (!(window as any).__TAURI_INTERNALS__) return false;
    // Native preparation never claims old WebView drafts or another browser's data.
    const webHold = await readLegacyHoldRecordReadonly(signal);
    const webPresence = await readLegacyWebPresenceReadonly(signal);
    if (webHold !== null && webHold !== undefined || webPresence !== 'clear') return false;
    const recovery = await nativeRecoveryRequired(signal);
    const nativeHold = await readStartup(bootstrapRoutes.hold, signal);
    if (nativeHold !== null) validateLegacyMigrationHold(nativeHold);
    const nativePresence = await readStartup(bootstrapRoutes.legacyPresence, signal);
    if (nativePresence !== 'clear' && nativePresence !== 'legacy-present') throw new Error('startup-presence-unverifiable');
    if (!recovery && nativeHold === null && nativePresence !== 'legacy-present') return false;
    signal.throwIfAborted();
    const { mountNativeRecoveryApp } = await import('./adapters/desktop/NativeRecoveryApp');
    signal.throwIfAborted();
    await mountNativeRecoveryApp(document.getElementById('root')!);
    return true;
  },
  async load() { await (await import('./DesktopApp')).mountDesktopApp(); },
});

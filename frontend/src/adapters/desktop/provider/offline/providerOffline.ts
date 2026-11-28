import type { ActiveLibraryProof, OfflineLibraryHandle, OfflineUnlockSession, ProviderInstalledLibrary, ProviderOfflineFacade } from '../../../../features/bootstrap/bootstrapPorts.ts';

/** Only the host transport uses this for a definitive pre-effect response. */
export class NativeOfflineRejected extends Error {}

type Bridge<B> = {
 local(signal: AbortSignal): Promise<B>;
 active(proof: ActiveLibraryProof): B;
 call(operation: string, body: unknown, signal: AbortSignal, binding: B): Promise<unknown>;
 installed(value: unknown, binding: B): ProviderInstalledLibrary;
 retire(binding: B): void;
};
type Session<B> = { token: string; binding: B; active: boolean };
const object = (v: unknown): Record<string, unknown> => {
 if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('offline-response-invalid');
 return v as Record<string, unknown>;
};
const text = (v: unknown): string => { if (typeof v !== 'string' || !v || v.length > 4096) throw new Error('offline-response-invalid'); return v; };
const check = (s: AbortSignal) => { if (s.aborted) throw new DOMException('Cancelled', 'AbortError'); };

/** Wire IDs live only in this host adapter; arbitrary objects never become capabilities. */
export function createDesktopProviderOffline<B>(bridge: Bridge<B>): ProviderOfflineFacade & { close(): Promise<void> } {
 const sessions = new WeakMap<OfflineUnlockSession, Session<B>>(), handles = new WeakMap<OfflineLibraryHandle, { session: Session<B>; id: string }>();
 const live = new Set<Session<B>>();
 let generation = 0, closed = false;
 const current = (value: OfflineUnlockSession) => {
  const saved = sessions.get(value); if (closed || !saved?.active) throw new Error('offline-session-invalid'); return saved;
 };
 const selected = (session: OfflineUnlockSession, handle: OfflineLibraryHandle) => {
  const saved = current(session), item = handles.get(handle);
  if (!item || item.session !== saved) throw new Error('offline-handle-invalid');
  return { saved, body: { unlockSession: saved.token, handle: item.id } };
 };
 async function stop(saved: Session<B>) {
  saved.active = false; bridge.retire(saved.binding);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  try { const response = object(await bridge.call('lock', {}, controller.signal, saved.binding)); if (response.status !== 'locked') throw new Error('offline-response-invalid'); live.delete(saved); }
  finally { clearTimeout(timer); }
 }
 return {
  async enroll(proof, secret, requestId, signal) {
   check(signal); if (closed) throw new Error('host-unavailable');
   const binding = bridge.active(proof);
   try {
    const response = object(await bridge.call('enroll', { secret, requestId }, signal, binding)); check(signal);
    if (response.requestId !== requestId || (typeof response.status !== 'string' || !['accepted', 'unknown', 'rejected'].includes(response.status))) throw new Error('offline-response-invalid');
    return { requestId, status: response.status as 'accepted' | 'unknown' | 'rejected' };
   } catch (error) {
    if (signal.aborted) {
     const pending: Session<B> = { token:'', binding, active:false }; live.add(pending);
     try { await stop(pending); } catch { /* retained for close() */ }
     throw error;
    }
    // A transport failure may follow a durable grant. The same fixed ID must be retried.
    return { requestId, status: 'unknown' };
   }
  },
  async revokeEnrollment(proof, secret, signal) {
   check(signal); if (closed) throw new Error('host-unavailable');
   const binding = bridge.active(proof);
   try {
    const value = object(await bridge.call('revoke-enrollment', { secret }, signal, binding)); check(signal);
    if (value.status !== 'revoked' && value.status !== 'unknown') throw new Error('offline-response-invalid');
    return { status:value.status };
   } catch (error) {
    if (error instanceof NativeOfflineRejected) throw error;
    return { status:'unknown' };
   }
  },
  async recoverEnrollment(proof, secret, signal) {
   check(signal); if (closed) throw new Error('host-unavailable');
   const binding = bridge.active(proof);
   const value = await bridge.call('recover-enrollment', { secret }, signal, binding); check(signal);
   if (value === null) return null;
   const result = object(value), requestId = text(result.requestId);
   if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)
       || typeof result.status !== 'string' || !['accepted', 'pending', 'unknown'].includes(result.status)) throw new Error('offline-response-invalid');
   return { requestId, status:result.status as 'accepted' | 'pending' | 'unknown' };
  },
  async unlock(secret, signal) {
   check(signal); if (closed) throw new Error('host-unavailable');
   const ticket = generation, binding = await bridge.local(signal);
   const pending: Session<B> = { token:'', binding, active:false }; live.add(pending);
   try {
    check(signal); if (closed || ticket !== generation) throw new Error('offline-operation-retired');
    const result = object(await bridge.call('unlock', { secret }, signal, binding)); check(signal);
    if (closed || ticket !== generation) throw new Error('offline-operation-retired');
    if (!Array.isArray(result.choices) || result.choices.length < 1 || result.choices.length > 128) throw new Error('offline-response-invalid');
    const saved: Session<B> = { token: text(result.unlockSession), binding, active: true };
    const seen = new Set<string>();
    const choices = result.choices.map(value => {
     const item = object(value), id = text(item.handle), title = text(item.title);
     if (seen.has(id)) throw new Error('offline-response-invalid'); seen.add(id);
     const handle = Object.freeze({}) as OfflineLibraryHandle; handles.set(handle, { session: saved, id });
     return { handle, title };
    });
    const session = Object.freeze({}) as OfflineUnlockSession; sessions.set(session, saved); live.delete(pending); live.add(saved);
    return { session, choices };
   } catch (error) {
    // A response may have issued a host session even when its shape is invalid.
    // Keep failed retirement in live so close() can retry it. Do not replace the
    // original decode/abort error with a cleanup transport failure.
    try { await stop(pending); } catch { /* retained for close() */ }
    throw error;
   }
  },
  async open(session, handle, signal) {
   check(signal); const { saved, body } = selected(session, handle);
   const result = await bridge.call('open', body, signal, saved.binding); check(signal); current(session);
   return bridge.installed(result, saved.binding);
  },
  async revoke(session, handle, signal) {
   check(signal); const { saved, body } = selected(session, handle);
   const result = object(await bridge.call('revoke', body, signal, saved.binding)); check(signal); current(session);
   if (result.status !== 'revoked') throw new Error('offline-response-invalid');
   await stop(saved);
  },
  async lock(session) { const saved = current(session); generation++; await stop(saved); },
  async close() {
   if (closed && live.size === 0) return; generation++; closed = true;
   const results = await Promise.allSettled([...live].map(stop));
   if (results.some(result => result.status === 'rejected')) throw new Error('offline-close-incomplete');
  },
 };
}

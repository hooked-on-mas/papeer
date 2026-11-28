import type { ActiveLibraryProof, ProviderGrant, ProviderInstalledLibrary, ProviderOperationOutcome, ProviderOwnerFacade, ProviderReplication, RemoteLibraryHandle } from '../../../features/bootstrap/bootstrapPorts.ts';

type Grant = { leaseId: string; operationId: string; active: boolean };
type PendingResume = { grant: Grant; attemptId: string; fresh?: Grant; publicGrant?: ProviderGrant; signal?: AbortSignal; abort?: () => void; ticket?: number };
type Selection = { id: string };
type Bridge = {
  call(path: string, body: unknown, signal: AbortSignal, grant?: Grant, admission?: string): Promise<unknown>;
  installed(value: unknown): ProviderInstalledLibrary;
  admission(proof: ActiveLibraryProof, grant: Grant): string;
  revoke(grant: Grant): void;
  resumeRetained(grant: Grant, requestId: string, attemptId: string, signal: AbortSignal): Promise<unknown>;
  settleResume(grant: Grant, attemptId: string, action: 'cancel' | 'acknowledge', signal: AbortSignal): Promise<void>;
  discardResumed(grant: Grant): Promise<void>;
  cancelAttempt(attemptId: string, signal: AbortSignal): Promise<void>;
  disconnect(grant: Grant, signal: AbortSignal): Promise<void>;
  release(grant: Grant, signal: AbortSignal): Promise<void>;
};
const prefix = '/api/edits/provider-owner/';
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provider-response-invalid');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => { if (typeof value !== 'string' || !value) throw new Error('provider-response-invalid'); return value; };
const pause = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 200);
  const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
  signal.addEventListener('abort', abort, { once:true });
});

/** Capabilities are opaque WeakMap keys; the bridge remains host-owned. */
export function createDesktopProviderOwner(bridge: Bridge): ProviderOwnerFacade & { openCurrentReplication(proof: ActiveLibraryProof, signal: AbortSignal): Promise<ProviderReplication>; cancelPending(): Promise<void>; invalidateOperation(id?: string): void; parkForPageHide(): void; discardRetained(): void } {
  const grants = new WeakMap<ProviderGrant, Grant>(), selections = new WeakMap<RemoteLibraryHandle, Selection>();
  let currentGrant: ProviderGrant | undefined;
  const settledResumes = new WeakMap<ProviderGrant, Grant>();
  let pendingAttempt: string | undefined, pendingResume: PendingResume | undefined;
  let lastRequest: string | undefined, parked: { grant: Grant; requestId: string } | undefined, lifecycle = 0;
  const invalidationListeners = new Set<() => void>();
  const replicationStops = new Set<() => void>();
  let healthTimer: ReturnType<typeof setInterval> | undefined, healthFlight = false;
  const stopHealth = () => { if (healthTimer) clearInterval(healthTimer); healthTimer = undefined; };
  const invalidateOperation = (id?: string) => {
    if (!currentGrant) return;
    const saved = grants.get(currentGrant);
    if (!saved?.active || (id && saved.operationId !== id)) return;
    lifecycle++; parked = undefined;
    saved.active = false; currentGrant = undefined; stopHealth();
    replicationStops.forEach(stop => stop()); bridge.revoke(saved);
    invalidationListeners.forEach(listener => listener());
  };
  const startHealth = () => {
    if (healthTimer || !currentGrant || !invalidationListeners.size) return;
    healthTimer = setInterval(() => {
      if (healthFlight || !currentGrant) return;
      const grant = currentGrant, saved = grants.get(grant); if (!saved?.active) return;
      healthFlight = true;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
      void bridge.call(prefix + 'health', {}, controller.signal, saved).then(value => {
        if (currentGrant === grant && obj(value).active !== true) invalidateOperation(saved.operationId);
      }).catch(() => { if (currentGrant === grant) invalidateOperation(saved.operationId); }).finally(() => { clearTimeout(timer); healthFlight = false; });
    }, 2000);
  };
  const cancelPending = async () => {
    const attemptId = pendingAttempt;
    if (!attemptId) return;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
    try { await bridge.cancelAttempt(attemptId, controller.signal); } catch { /* finished, superseded or host unavailable */ }
    finally { clearTimeout(timer); }
  };
  const cancelResume = async (pending = pendingResume) => {
    if (!pending) return;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
    try { await bridge.settleResume(pending.grant, pending.attemptId, 'cancel', controller.signal); }
    catch { /* Retired, unavailable, or expiry cleanup owns this attempt. */ }
    finally { clearTimeout(timer); }
  };
  const grantOf = (grant: ProviderGrant) => { const value = grants.get(grant); if (!value?.active) throw new Error('provider-unavailable'); return value; };
  const outcome = (value: unknown): ProviderOperationOutcome => {
    const row = obj(value), status = text(row.status);
    if (!['pending', 'accepted', 'rejected', 'unknown', 'not-found'].includes(status)) throw new Error('provider-response-invalid');
    return { requestId:text(row.requestId), status:status as ProviderOperationOutcome['status'] };
  };
  const request = async (grant: ProviderGrant, path: string, body: unknown, signal: AbortSignal) => {
    const saved = grantOf(grant), value = await bridge.call(prefix + path, body, signal, saved);
    if (grantOf(grant) !== saved || currentGrant !== grant) throw new Error('provider-unavailable');
    return value;
  };
  const retireGrant = async (grant: ProviderGrant, signal: AbortSignal, finish: (saved: Grant, signal: AbortSignal) => Promise<void>) => {
    lifecycle++; parked = undefined;
    const saved = grantOf(grant), pending = finish(saved, signal);
    invalidateOperation(saved.operationId);
    await pending;
  };
  const facade: ProviderOwnerFacade = {
    subscribeInvalidation(listener) { invalidationListeners.add(listener); startHealth(); return () => { invalidationListeners.delete(listener); if (!invalidationListeners.size) stopHealth(); }; },
    async preload(signal) { const row = obj(await bridge.call(prefix + 'preload', {}, signal)); if (typeof row.configured !== 'boolean') throw new Error('provider-response-invalid'); return { configured:row.configured }; },
    async reconnectSaved(signal) {
      if (currentGrant || pendingAttempt || signal.aborted) return null;
      try {
        const raw = await bridge.call(prefix + 'reconnect-saved', {}, signal);
        if (raw === null) return null;
        const row = obj(raw);
        const grantData: Grant = { leaseId: text(row.leaseId), operationId: text(row.operationId), active: true };
        if (signal.aborted || currentGrant || pendingAttempt) {
          void bridge.release(grantData, new AbortController().signal).catch(() => undefined);
          return null;
        }
        const grant = Object.freeze({}) as ProviderGrant; grants.set(grant, grantData);
        currentGrant = grant; startHealth(); return grant;
      } catch (error) {
        if (signal.aborted) throw error;
        return null;
      }
    },
    async connect(signal) {
      lifecycle++; parked = undefined; void cancelResume();
      if (pendingAttempt) throw new Error('provider-attempt-active');
      const attemptId = crypto.randomUUID();
      pendingAttempt = attemptId;
      if (currentGrant) invalidateOperation();
      try {
        await bridge.call(prefix + 'connect', { attemptId }, signal);
        for (;;) {
          const state = obj(await bridge.call(prefix + 'status', { attemptId }, signal));
          if (state.auth_error) throw new Error('provider-connect-failed');
          if (state.connecting === false) break;
          if (state.connecting !== true) throw new Error('provider-response-invalid');
          await pause(signal);
        }
        const row = obj(await bridge.call(prefix + 'finish-connect', { attemptId }, signal));
        const grant = Object.freeze({}) as ProviderGrant; grants.set(grant, { leaseId:text(row.leaseId), operationId:text(row.operationId), active:true }); currentGrant = grant; startHealth(); return grant;
      } catch (error) {
        // The server checks the attempt ID and bearer, so a late cancellation
        // cannot cancel a newer login. It may already be finished or closed.
        if (pendingAttempt === attemptId) await cancelPending();
        throw error;
      } finally { if (pendingAttempt === attemptId) pendingAttempt = undefined; }
    },
    async list(grant, signal) {
      grantOf(grant); const rows = await request(grant, 'list', {}, signal);
      if (!Array.isArray(rows)) throw new Error('provider-response-invalid');
      return rows.map(value => { const row = obj(value), status = text(row.status);
        if (!['available', 'owner-write-required', 'unavailable'].includes(status)) throw new Error('provider-response-invalid');
        const handle = Object.freeze({}) as RemoteLibraryHandle; selections.set(handle, { id:text(row.handleId) });
        return { handle, title:text(row.title), status:status as 'available'|'owner-write-required'|'unavailable' }; });
    },
    async prepareCreate(grant, title, requestId, signal) { return outcome(await request(grant, 'create/prepare', { title, requestId }, signal)); },
    async prepareJoin(grant, handle, requestId, signal) { const row = selections.get(handle); grantOf(grant); if (!row) throw new Error('provider-selection-invalid'); return outcome(await request(grant, 'join/prepare', { handleId:row.id, requestId }, signal)); },
    async query(grant, requestId, signal) { return outcome(await request(grant, 'query', { requestId }, signal)); },
    async execute(grant, requestId, signal) { return outcome(await request(grant, 'execute', { requestId }, signal)); },
    async recoveries(grant, signal) { const rows = await request(grant, 'recoveries', {}, signal); if (!Array.isArray(rows)) throw new Error('provider-response-invalid'); return rows.map(value => { const row = obj(value), action = text(row.action), status = text(row.status); if (!['create','join'].includes(action) || !['pending','accepted','rejected','unknown'].includes(status)) throw new Error('provider-response-invalid'); return { requestId:text(row.requestId), title:text(row.title), action:action as 'create'|'join', status:status as 'pending'|'accepted'|'rejected'|'unknown' }; }); },
    async acknowledge(grant, requestId, signal) { await request(grant, 'acknowledge', { requestId }, signal); },
    async openInstalled(grant, requestId, signal) { const result = bridge.installed(await request(grant, 'open-installed', { requestId }, signal)); lastRequest = result.requestId; return result; },
    async openSelected(grant, handle, signal) { const row = selections.get(handle); grantOf(grant); if (!row) throw new Error('provider-selection-invalid'); const result = await request(grant, 'open-selected', { handleId:row.id }, signal); if (result === null) return null; const installed = bridge.installed(result); lastRequest = installed.requestId; return installed; },
    async resumeRetained(requestId, signal) {
      const saved = parked, ticket = lifecycle;
      if (!saved || saved.requestId !== requestId || currentGrant || pendingResume || signal.aborted) return null;
      parked = undefined;
      const pending: PendingResume = { grant: saved.grant, attemptId: crypto.randomUUID(), signal, ticket };
      pendingResume = pending;
      const abort = () => { void cancelResume(pending); if (pending.fresh) invalidateOperation(pending.fresh.operationId); };
      pending.abort = abort; signal.addEventListener('abort', abort, { once:true });
      try {
        const row = obj(await bridge.resumeRetained(saved.grant, requestId, pending.attemptId, signal));
        const fresh = { leaseId:text(row.leaseId), operationId:text(row.operationId), active:true }; pending.fresh = fresh;
        if (signal.aborted || ticket !== lifecycle || currentGrant) throw new Error('provider-unavailable');
        const installed = obj(row.installed);
        if (text(installed.leaseId) !== fresh.leaseId || text(installed.requestId) !== requestId) throw new Error('provider-response-invalid');
        const target = bridge.installed(installed), grant = Object.freeze({}) as ProviderGrant;
        grants.set(grant, fresh); pending.publicGrant = grant; currentGrant = grant; lastRequest = target.requestId; startHealth();
        // ACK is deferred until the shared session has prepared and revalidated
        // the retained editor, immediately before making it available.
        return { grant, target };
      } catch (error) {
        signal.removeEventListener('abort', abort);
        await cancelResume(pending);
        if (pending.fresh) await bridge.discardResumed(pending.fresh).catch(() => {});
        if (pendingResume === pending) pendingResume = undefined;
        if (signal.aborted) throw error;
        return null;
      }
    },
    async settleRetainedResume(grant, accepted) {
      const pending = pendingResume;
      if (!pending || pending.publicGrant !== grant || !pending.fresh || pending.ticket !== lifecycle) {
        if (accepted) throw new Error('provider-unavailable');
        const settled = settledResumes.get(grant);
        if (settled) {
          settledResumes.delete(grant);
          await bridge.discardResumed(settled).catch(() => {});
          invalidateOperation(settled.operationId);
        }
        return;
      }
      const fresh = pending.fresh;
      try {
        if (!accepted) throw new Error('provider-resume-refused');
        if (pending.signal?.aborted || currentGrant !== grant) throw new Error('provider-unavailable');
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
        try { await bridge.settleResume(pending.grant, pending.attemptId, 'acknowledge', controller.signal); }
        finally { clearTimeout(timer); }
        if (pending.signal?.aborted || pending.ticket !== lifecycle || currentGrant !== grant) throw new Error('provider-unavailable');
        settledResumes.set(grant, fresh);
      } catch (error) {
        await cancelResume(pending);
        await bridge.discardResumed(fresh).catch(() => {});
        invalidateOperation(fresh.operationId);
        if (accepted) throw error;
      } finally {
        if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort);
        if (pendingResume === pending) pendingResume = undefined;
      }
    },
    async openReplication(grant, proof, signal) {
      const saved = grantOf(grant), admission = bridge.admission(proof, saved), open = obj(await bridge.call(prefix + 'replication/open', {}, signal, saved, admission)), id = text(open.replicationId);
      if (grantOf(grant) !== saved || currentGrant !== grant) throw new Error('provider-unavailable');
      let serverState = { running:false, suspended:false, error:'' }, state = serverState, epoch = 0; const flights = new Set<Promise<void>>(), listeners = new Set<() => void>();
      const invoke = async (path: string, ticket: number) => { if (grantOf(grant) !== saved) throw new Error('provider-unavailable'); const value = obj(await bridge.call(prefix + 'replication/' + path, { replicationId:id }, new AbortController().signal, saved)); if (grantOf(grant) !== saved || typeof value.running !== 'boolean' || typeof value.suspended !== 'boolean' || typeof value.error !== 'string') throw new Error('provider-response-invalid'); if (ticket !== epoch) return; serverState = { running:value.running, suspended:value.suspended, error:value.error }; if (path === 'resume' && !value.suspended) autoResumeNeeded = false; publish(); };
      const track = (next: Promise<void>) => { flights.add(next); void next.finally(() => { flights.delete(next); scheduleAuto(); }).catch(() => {}); return next; };
      const sync = (path: string, ticket = epoch) => track(invoke(path, ticket));
      type Pass = { ticket: number; promise: Promise<void> };
      type Queued = { ticket: number; after: Pass; promise: Promise<void>; resolve(): void; reject(error: unknown): void };
      let activePass: Pass | undefined, queued: Queued | undefined;
      let autoEnabled = false, autoResumeNeeded = false, timer: ReturnType<typeof setTimeout> | undefined;
      const assertGrant = () => { if (grantOf(grant) !== saved || currentGrant !== grant) throw new Error('provider-unavailable'); };
      const clearAutoTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
      const stopAuto = () => { autoEnabled = false; autoResumeNeeded = false; clearAutoTimer(); replicationStops.delete(stopAuto); };
      const scheduleAuto = () => {
        if (!autoEnabled || timer !== undefined || flights.size || activePass || queued || (state.suspended && !autoResumeNeeded)) return;
        try { assertGrant(); } catch { stopAuto(); return; }
        const ticket = epoch, next = setTimeout(() => {
          if (timer !== next) return;
          timer = undefined;
          if (!autoEnabled || ticket !== epoch) return;
          try { assertGrant(); } catch { stopAuto(); return; }
          if (!flights.size && !activePass && !queued && (!state.suspended || autoResumeNeeded))
            void (autoResumeNeeded ? startPass('resume', ticket) : flush()).catch(() => {});
        }, 5000);
        timer = next;
      };
      const publish = (localStop = false): void => {
        if (!localStop) { try { assertGrant(); } catch { return; } }
        const running = serverState.running || activePass?.ticket === epoch || queued?.ticket === epoch;
        if (state.running === running && state.suspended === serverState.suspended && state.error === serverState.error) return;
        state = { ...serverState, running }; listeners.forEach(listener => listener());
      };
      const publishFailure = (ticket: number) => {
        if (ticket !== epoch || (state.suspended && !autoResumeNeeded)) return;
        try { assertGrant(); } catch { return; }
        serverState = { ...serverState, running:false, error:'provider-replication-failed' };
      };
      const cancelQueued = () => { const value = queued; queued = undefined; value?.reject(new DOMException('Cancelled', 'AbortError')); };
      const startPass = (path: 'flush' | 'resume', ticket: number): Promise<void> => {
        clearAutoTimer();
        const slot: Pass = { ticket, promise: sync(path, ticket) }; activePass = slot; publish();
        const settled = () => {
          if (activePass === slot) activePass = undefined;
          const value = queued;
          if (!value || value.after !== slot) { publish(); scheduleAuto(); return; }
          queued = undefined;
          try {
            assertGrant();
            if (value.ticket !== epoch || state.suspended) throw new DOMException('Cancelled', 'AbortError');
            // A request arriving during a pass needs a later pass: its durable
            // commit may be newer than that pass's pending-records snapshot.
            void startPass('flush', value.ticket).then(value.resolve, value.reject);
          } catch (error) { value.reject(error); publish(); scheduleAuto(); }
        };
        void slot.promise.then(settled, () => { publishFailure(ticket); settled(); });
        return slot.promise;
      };
      const flush = (): Promise<void> => {
        try { assertGrant(); } catch (error) { return Promise.reject(error); }
        if (activePass?.ticket === epoch) {
          if (queued?.ticket === epoch) return activePass.promise;
          let resolve!: () => void, reject!: (error: unknown) => void;
          const promise = track(new Promise<void>((ok, fail) => { resolve = ok; reject = fail; }));
          const ticket = epoch;
          // Callers join the current pass, but the tracked tail still covers a
          // commit newer than its pending-records snapshot.
          queued = { ticket, after: activePass, promise, resolve, reject }; return activePass.promise;
        }
        if (state.suspended) return Promise.resolve();
        return startPass('flush', epoch);
      };
      const suspend = () => {
        stopAuto();
        const ticket = ++epoch; cancelQueued(); serverState = { ...serverState, suspended:true }; publish(true);
        // Pagehide permanently retires this private grant. Local cancellation/drain
        // must not require remote authority that the old replica no longer has.
        if (saved.active === false) return Promise.resolve();
        return sync('suspend', ticket);
      };
      const replication: ProviderReplication = { scope:proof.scope, getSnapshot:() => state, subscribe:listener => { listeners.add(listener); return () => listeners.delete(listener); },
        suspend:() => { void suspend().catch(() => {}); }, suspendAndWait:async () => { const pending = [...flights], stop = suspend(), results = await Promise.allSettled([...pending, stop]); const last = results[results.length - 1]; if (last.status === 'rejected') throw last.reason; }, resume:() => { try { assertGrant(); } catch (error) { return Promise.reject(error); } autoEnabled = true; autoResumeNeeded = true; replicationStops.add(stopAuto); clearAutoTimer(); const ticket = ++epoch; cancelQueued(); return startPass('resume', ticket); }, flush };
      return replication;
    },
    disconnect: (grant, signal) => retireGrant(grant, signal, bridge.disconnect),
    releaseOnClose: (grant, signal) => retireGrant(grant, signal, bridge.release),
  };
  const parkForPageHide = () => {
    const saved = !pendingResume && currentGrant && grants.get(currentGrant), requestId = lastRequest;
    lifecycle++; parked = undefined; void cancelResume();
    invalidateOperation();
    if (saved && requestId) parked = { grant: saved, requestId };
  };
  const discardRetained = () => { lifecycle++; parked = undefined; lastRequest = undefined; void cancelResume(); };
  return Object.assign(facade, { cancelPending, invalidateOperation, parkForPageHide, discardRetained, openCurrentReplication(proof: ActiveLibraryProof, signal: AbortSignal) {
    if (!currentGrant) throw new Error('provider-unavailable');
    return facade.openReplication(currentGrant, proof, signal);
  } });
}

import { ProviderConnectionSession } from './provider/ProviderConnectionSession.ts';
import type { ProviderConnectionController } from './provider/providerConnectionPorts.ts';
import { ProviderOfflineSession } from './provider/ProviderOfflineSession.ts';
import type { ProviderOfflineController } from './provider/providerOfflinePorts.ts';
import type { ProviderOwnerFacade, ProviderInstalledLibrary, ProviderReplication } from './bootstrapPorts.ts';
import type { EditScope } from '../../runtime/edits/ports.ts';
import type { CanonicalInitializeRequest } from '../../runtime/edits/contracts.ts';
import type { InitializationOutcome } from '../../runtime/edits/canonicalInitializationStorage.ts';
import { canonicalJson } from '../../runtime/edits/editModel.ts';
import { EditReplication, type EditTransferPort } from '../../runtime/edits/replication.ts';
import { DocumentEditSessions, type ScopeLeaveResult } from '../reader/DocumentEditSessions.ts';
import { DocumentInkSettings } from '../reader/ink/DocumentInkSettings.ts';
import { ContentNavigationSession } from '../reader/navigation/ContentNavigationSession.ts';
import { assertLibraryScopeBinding } from '../reader/DocumentLibraryBinding.ts';
import { initialRequest } from './initialRequest.ts';
import type { BootstrapDiscovery, BootstrapHostDriver, HostLease, LibraryHandle, LibraryRuntime } from './bootstrapPorts.ts';

type Creation = { requestId: string; title: string; stage: 'preparing' | 'unknown' | 'pending' | 'accepted' | 'rejected'; reason?: string };
export type BootstrapState = Readonly<{ phase: 'idle' | 'checking' | 'setup-required' | 'choosing' | 'creating' | 'opening' | 'ready' | 'recovery-required' | 'closed'; discovery: BootstrapDiscovery | null; creation: Creation | null; locked: boolean; error: string }>;
const unavailable = async (): Promise<never> => { throw new Error('remote-unconfigured'); };
const localTransfer: EditTransferPort = { pull: unavailable, upload: unavailable, uploadResource: unavailable, downloadResource: unavailable, imported: unavailable };
const offlineReplication = (scope: EditScope): ProviderReplication => {
 const state = Object.freeze({ running: false, suspended: true, error: '' });
 const blocked = async (): Promise<never> => { throw new Error('provider-offline'); };
 return { scope, getSnapshot: () => state, subscribe: () => () => {}, suspend: () => {}, suspendAndWait: async () => {}, flush: blocked, resume: blocked };
};
const refused = (reason: string): ScopeLeaveResult => ({ status: 'refused', reason, targets: [] });
/** One host-lifetime owner; all asynchronous publication is fenced by generation and AbortSignal. */
export class BootstrapSession {
 private state: BootstrapState = Object.freeze({ phase: 'idle', discovery: null, creation: null, locked: false, error: '' });
 private readonly listeners = new Set<() => void>(); private readonly driver: BootstrapHostDriver;
 private readonly providerConnection: ProviderConnectionSession | null;
 private readonly offlineConnection: ProviderOfflineSession | null;
 private providerFacade: ProviderOwnerFacade | null = null;
 private providerRequestId: string | null = null;
 private lease: HostLease | null = null; private runtime: LibraryRuntime | null = null;
 private generation = 0; private controller = new AbortController(); private pageAvailable = true; private flight: Promise<void> | null = null;
 private fixed: CanonicalInitializeRequest | null = null; private closing = false;
 private leaveFlight: Promise<ScopeLeaveResult> | null = null; private closeFlight: Promise<ScopeLeaveResult> | null = null;
 private driverCloseFlight: Promise<void> | null = null; private readonly unsubscribe: () => void;
 constructor(driver: BootstrapHostDriver) {
  this.driver = driver;
  const global = driver.subscribeInvalidation(() => this.hostLost());
  const scoped = driver.subscribeScopedInvalidation?.(affected => {
   const runtime = this.runtime;
   if (runtime ? affected.affectsProof(runtime.proof) : !!this.lease && affected.affectsLease(this.lease)) this.hostLost();
  });
  this.unsubscribe = () => { global(); scoped?.(); };
  this.providerConnection = driver.getProvider || driver.provider ? new ProviderConnectionSession({
   getFacade: async () => {
    if (this.providerFacade) return this.providerFacade;
    const facade = driver.getProvider?.() ?? (this.lease ? driver.provider?.(this.lease) : null);
    if (!facade) return null;
    // Local and provider actions share this owner. Receiver-preserving delegates keep GIS synchronous.
    const guard = (reauth = false) => { const offline = this.offlineConnection?.getSnapshot();
     const retained = !!this.runtime && this.state.locked && this.getRuntimeStorageKind() === 'google-drive' && !!this.providerRequestId;
     if (this.closing || this.flight || this.leaveFlight || offline?.busy || offline?.pendingGuard && !(reauth && retained) || this.state.creation && ['preparing','unknown','pending'].includes(this.state.creation.stage)) throw new Error('local-operation-pending'); };
    this.providerFacade = { ...facade,
     connect: signal => { guard(true);
      if (this.runtime && this.getRuntimeProviderOffline() && !this.state.locked) {
       if (this.runtime.binding.sessions.needsExitConfirmation()) throw new Error('offline-pending');
       this.hostLost();
      }
      return facade.connect(signal);
     },
     ...(facade.reconnectSaved ? {
      reconnectSaved: async (signal: AbortSignal) => {
       guard(true);
       if (this.runtime && this.getRuntimeProviderOffline() && !this.state.locked
        && this.runtime.binding.sessions.needsExitConfirmation()) {
        throw new Error('offline-pending');
       }
       return facade.reconnectSaved!(signal);
      },
     } : {}),
     ...(facade.resumeRetained ? { resumeRetained: (requestId: string, signal: AbortSignal) => { guard(true); return facade.resumeRetained!(requestId, signal); } } : {}),
     ...(facade.settleRetainedResume ? { settleRetainedResume: (grant: import('./bootstrapPorts.ts').ProviderGrant, accepted: boolean) => facade.settleRetainedResume!(grant, accepted) } : {}),
     prepareCreate: (...args) => { guard(); if (this.runtime) throw new Error('library-active'); return facade.prepareCreate(...args); },
     prepareJoin: (...args) => { guard(); if (this.runtime) throw new Error('library-active'); return facade.prepareJoin(...args); },
    };
    return this.providerFacade;
   },
   retained: () => this.runtime ? { kind: this.getRuntimeStorageKind(), requestId: this.providerRequestId, locked: this.state.locked } : null,
   subscribe: listener => this.subscribe(listener),
   openInstalled: (target, signal, beforeActivate) => this.openProviderTarget(target, signal, beforeActivate),
   prepareDisconnect: () => { const offline = this.offlineConnection?.getSnapshot();
    return offline?.busy || offline?.pendingGuard ? Promise.resolve(refused('offline-operation-pending')) : this.leaveRuntime(); },
  }) : null;
  this.offlineConnection = driver.getOffline ? new ProviderOfflineSession({
   getFacade: () => driver.getOffline?.() ?? null,
   retained: () => this.runtime ? { proof: this.runtime.proof, provider: this.getRuntimeStorageKind() === 'google-drive',
    offline: this.getRuntimeProviderOffline(), locked: this.state.locked } : null,
   subscribe: listener => { const session = this.subscribe(listener), provider = this.providerConnection?.subscribe(listener);
    return () => { session(); provider?.(); }; },
   available: () => { const provider = this.providerConnection?.getSnapshot();
    return !this.closing && this.pageAvailable && this.state.phase !== 'idle' && this.state.phase !== 'checking' && !this.flight && !this.leaveFlight && !provider?.busy && !provider?.pendingGuard
     && !(this.state.creation && ['preparing', 'unknown', 'pending'].includes(this.state.creation.stage)); },
   openInstalled: (target, signal) => this.openProviderTarget(target, signal),
   prepareLeave: () => this.leaveRuntime(),
  }) : null;
 }
 getProviderConnection(): ProviderConnectionController | null { return this.providerConnection; }
 getOfflineConnection(): ProviderOfflineController | null { return this.offlineConnection; }
 getRuntimeStorageKind(): 'local' | 'google-drive' { return this.runtime ? this.driver.storageKind?.(this.runtime.proof) ?? 'local' : 'local'; }
 getRuntimeProviderOffline(): boolean { return !!this.runtime && !!this.driver.providerOffline?.(this.runtime.proof); }
 private providerBlocksLocal(): boolean { const state = this.providerConnection?.getSnapshot(), offline = this.offlineConnection?.getSnapshot();
  return !!(state?.busy || state?.pendingGuard || offline?.busy || offline?.pendingGuard); }

 getSnapshot = () => this.state;
 subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
 private update(fields: Partial<BootstrapState>) { if (fields.creation) fields = { ...fields, creation: Object.freeze({ ...fields.creation }) }; this.state = Object.freeze({ ...this.state, ...fields }); this.listeners.forEach(listener => listener()); }
 private fence() { const generation = this.generation, signal = this.controller.signal; return { signal, alive: () => this.generation === generation && !signal.aborted && this.pageAvailable && this.state.phase !== 'closed' }; }
 private invalidate() { this.generation++; this.controller.abort(); this.controller = new AbortController(); }
 private run(action: () => Promise<void>): Promise<void> {
  if (this.closing || this.leaveFlight || this.providerBlocksLocal()) return Promise.resolve();
  if (this.flight) return this.flight;
  const flight = action().finally(() => { if (this.flight === flight) { this.flight = null; this.update({}); } }); this.flight = flight; this.update({}); return flight;
 }
 private hostLost() {
  if (this.state.phase === 'closed') return; this.invalidate(); this.lease = null;
  this.offlineConnection?.hostLost();
  if (this.runtime) { this.runtime.navigation.setAvailable(false); this.runtime.binding.sessions.deactivateForHostLoss(); this.runtime.binding.replication.suspend(); }
  this.update({ locked: !!this.runtime, phase: this.runtime ? 'recovery-required' : 'idle', error: 'host-unavailable' });
 }
 setPageAvailable(available: boolean) { if (this.pageAvailable === available) return; this.pageAvailable = available; if (!available) this.hostLost(); else this.update({}); }
 /** Wait out an invalidated operation before obtaining a fresh lease for this page generation. */
 async resumePage(): Promise<void> {
  this.setPageAvailable(true);
  const generation = this.generation, previous = this.flight;
  if (previous) await previous.catch(() => undefined);
  if (!this.pageAvailable || this.generation !== generation || this.closing || this.getSnapshot().phase === 'closed') return;
  if (this.runtime && this.state.locked && this.getRuntimeProviderOffline()) return;
  if (this.runtime && this.state.locked && this.getRuntimeStorageKind() === 'google-drive' && !this.getRuntimeProviderOffline()) {
   await this.providerConnection?.resumeRetained(); return;
  }
  await this.start();
  if (!this.pageAvailable || this.generation !== generation || this.closing || this.state.phase === 'closed') return;
  if (this.runtime && this.lease && this.state.phase === 'recovery-required') await this.restoreRetained();
 }
 cancelPendingView() { if (this.closing || this.state.phase === 'closed') return; this.invalidate(); this.offlineConnection?.hostLost(); if (this.runtime) { this.runtime.navigation.setAvailable(false); this.runtime.binding.sessions.deactivateForHostLoss(); this.runtime.binding.replication.suspend(); }
  this.update({ phase: this.runtime ? 'recovery-required' : 'idle', locked: !!this.runtime, error: 'cancelled' }); }
 getNativePreparation() { return this.driver.getNativePreparation?.() ?? null; }
 getActiveRuntime(): LibraryRuntime | null { return this.state.phase === 'ready' && !this.state.locked ? this.runtime : null; }
 /** Host connection must retain the previous subtree while locked; this is not authority to edit it. */
 getRetainedRuntime(): LibraryRuntime | null { return this.runtime; }
 start(): Promise<void> { return this.run(async () => { const f = this.fence(); this.update({ phase: 'checking', error: '' });
  try { if (await this.driver.readHold(f.signal) !== 'clear') throw new Error('hold-active'); if (!f.alive()) return;
   const context = await this.driver.readLocalContext(f.signal); if (!f.alive()) return;
   if (context.status === 'setup-required') { this.update({ phase: 'setup-required', error: context.reason }); return; }
   if (context.status === 'recovery-required') { this.update({ phase: 'recovery-required', error: context.reason }); return; }
   this.lease = context.lease; await this.discover(f);
  } catch (error) { if (f.alive()) this.update({ phase: 'recovery-required', error: String(error) }); }
 }); }
 provisionLocal(): Promise<void> { return this.run(async () => { const f = this.fence(); this.update({ phase: 'checking', error: '' });
  try { if (await this.driver.readHold(f.signal) !== 'clear') throw new Error('hold-active'); if (!f.alive()) return;
   const lease = await this.driver.provisionLocalContext(f.signal); if (!f.alive()) return; this.lease = lease; await this.discover(f);
  } catch (error) { if (f.alive()) this.update({ phase: 'recovery-required', error: String(error) }); }
 }); }
 private async discover(f: ReturnType<BootstrapSession['fence']>) { if (!this.lease) throw new Error('host-unavailable');
  const discovery = await this.driver.discover(this.lease, f.signal); if (!f.alive()) return;
  this.update({ discovery: Object.freeze(discovery), phase: this.runtime ? 'recovery-required' : 'choosing', locked: !!this.runtime, error: '' }); }
 refresh(): Promise<void> { return this.run(async () => { const f = this.fence(); try { if (!this.lease) throw new Error('host-unavailable'); await this.discover(f); }
  catch (error) { if (f.alive()) this.update({ phase: 'recovery-required', error: String(error) }); } }); }
 createLibrary(title: string): Promise<void> { return this.run(async () => { const f = this.fence(), lease = this.lease;
  if (!lease || !this.state.discovery?.canCreateLibrary || this.runtime || this.fixed) { if (f.alive()) this.update({ error: 'creation-unavailable' }); return; }
  try { const api = this.driver.initialization(lease), peer = await api.getOrCreatePeer(f.signal); if (!f.alive()) return;
   const request = await initialRequest(title, peer); if (!f.alive()) return; this.fixed = request;
   this.update({ phase: 'creating', creation: { requestId: request.control.id, title: request.profile.title, stage: 'preparing' }, error: '' });
   const prepared = await api.prepare(request, f.signal); if (!f.alive()) return;
   await this.deliverOutcome(prepared, request.control.id, f, true);
  } catch (error) { if (f.alive()) this.update({ phase: 'choosing', creation: this.fixed ? { requestId: this.fixed.control.id, title: this.fixed.profile.title, stage: 'unknown' } : null, error: String(error) }); }
 }); }
 private async deliverOutcome(outcome: InitializationOutcome, id: string, f: ReturnType<BootstrapSession['fence']>, executePending: boolean) {
  if (!f.alive() || !this.lease) return;
  if (outcome.status === 'pending' && executePending) { this.update({ creation: { requestId: id, title: this.state.creation?.title ?? '', stage: 'pending' } });
   outcome = await this.driver.initialization(this.lease).execute(id, f.signal); if (!f.alive()) return; }
  const stage = outcome.status === 'not-found' ? 'unknown' : outcome.status;
  this.update({ phase: 'choosing', creation: { requestId: id, title: this.state.creation?.title ?? '', stage, ...(outcome.status === 'rejected' ? { reason: outcome.reason } : {}) }, error: '' });
 }
 recoverCreation(requestId: string): Promise<void> { return this.run(async () => { const f = this.fence(), lease = this.lease; if (!lease) return;
  if (this.fixed && this.fixed.control.id !== requestId) { this.update({ error: 'creation-request-in-flight' }); return; }
  try { const api = this.driver.initialization(lease); let outcome = await api.query(requestId, f.signal); if (!f.alive()) return;
   if (outcome.status === 'not-found' && this.fixed?.control.id === requestId) { outcome = await api.prepare(this.fixed, f.signal); if (!f.alive()) return; }
   await this.deliverOutcome(outcome, requestId, f, true);
  } catch (error) { if (f.alive()) this.update({ phase: 'choosing', creation: { requestId, title: this.state.creation?.title ?? '', stage: 'unknown' }, error: String(error) }); }
 }); }
 acknowledgeCreation(requestId: string): Promise<void> { return this.run(async () => { const f = this.fence(), lease = this.lease;
  if (!lease || this.state.creation?.requestId !== requestId || !['accepted', 'rejected'].includes(this.state.creation.stage)) return;
  try { await this.driver.initialization(lease).acknowledge(requestId, f.signal); if (!f.alive()) return; if (this.fixed?.control.id === requestId) this.fixed = null; this.update({ creation: null }); }
  catch (error) { if (f.alive()) this.update({ error: String(error) }); }
 }); }
 openLibrary(handle: LibraryHandle): Promise<void> { return this.run(async () => {
  const f = this.fence(); if (!this.lease || this.runtime) return;
  await this.openTarget(this.lease, handle, f.signal, f.alive);
 }); }
 private async openTarget(lease: HostLease, handle: LibraryHandle, signal: AbortSignal, alive: () => boolean): Promise<boolean> {
  this.update({ phase: 'opening', error: '' }); let resource: LibraryRuntime['resources'] | null = null;
  let replication: LibraryRuntime['binding']['replication'] | null = null;
  try { const proof = await this.driver.inspect(lease, handle, signal); if (!alive()) return false;
   resource = await this.driver.openScope(proof, signal); if (!alive()) return false;
   if (canonicalJson(resource.repository.scope) !== canonicalJson(proof.scope)) throw new Error('admission-scope');
   const sessions = new DocumentEditSessions(resource.repository, resource.markdownDrafts, resource.markdownImages, resource.appendDrafts, resource.queryPreferences);
   if (this.driver.storageKind?.(proof) === 'google-drive' && !this.driver.providerOffline?.(proof)) {
    if (!this.driver.openReplication) throw new Error('provider-replication-unavailable');
    replication = await this.driver.openReplication(proof, signal);
   } else if (this.driver.providerOffline?.(proof)) replication = offlineReplication(proof.scope);
   else { replication = new EditReplication(resource.repository, localTransfer, resource.peerId); replication.suspend(); }
   const binding = { repository: resource.repository, sessions, replication, readerState: resource.readerState, inkSettings: new DocumentInkSettings(resource.repository.scope, resource.inkPreferences), outputFile: resource.outputFile, workspacePreferences: resource.workspacePreferences, selectionPreferences: resource.selectionPreferences };
   assertLibraryScopeBinding(binding);
   const navigation = new ContentNavigationSession({ repository: resource.repository, documentId: null, isActive: () => { const s = sessions.getSnapshot(); return s.ready && s.active; } });
   await sessions.initialize(); if (!alive()) return false; if (!sessions.getSnapshot().ready) throw new Error('recovery-not-ready');
   if (!await sessions.getLibrary().refresh()) throw new Error('catalog-unavailable'); if (!alive()) return false;
   await this.driver.revalidate(proof, signal); if (!alive()) return false;
   this.runtime = { binding, navigation, proof, handle, resources: resource }; resource = null; navigation.setAvailable(true);
   this.update({ phase: 'ready', locked: false, error: '' });
   if (this.driver.storageKind?.(proof) === 'google-drive' && !this.driver.providerOffline?.(proof)) void replication.resume().catch(() => undefined);
   replication = null; return true;
  } catch (error) { if (alive()) this.update({ phase: 'recovery-required', error: String(error) }); return false; }
  finally { if (replication) await replication.suspendAndWait(); if (resource) await resource.close(); }
 }
 private async openProviderTarget(target: ProviderInstalledLibrary, signal: AbortSignal, beforeActivate?: () => Promise<void>): Promise<boolean> {
  if (this.closing || this.flight || this.leaveFlight || signal.aborted || !this.pageAvailable) return false;
  const f = this.fence(), alive = () => f.alive() && !signal.aborted, runtime = this.runtime;
  if (!runtime) {
   if (beforeActivate) return false; // Retained readmission cannot replace a vanished runtime.
   const opened = await this.openTarget(target.lease, target.handle, signal, alive);
   if (opened) { this.providerRequestId = target.requestId; this.update({}); } return opened;
  }
  if (this.getRuntimeStorageKind() !== 'google-drive' || this.providerRequestId !== target.requestId) return false;
  let nextReplication: LibraryRuntime['binding']['replication'] | null = null;
  try {
   const proof = await this.driver.inspect(target.lease, target.handle, signal); if (!alive()) return false;
   if (!this.driver.sameAdmission(runtime.proof, proof) || canonicalJson(proof.scope) !== canonicalJson(runtime.proof.scope)) throw new Error('admission-changed');
   if (this.driver.providerOffline?.(proof)) {
    if (!this.getRuntimeProviderOffline() || !this.state.locked || beforeActivate) throw new Error('offline-readmission-denied');
    await this.driver.revalidate(proof, signal); if (!alive()) return false;
    await runtime.resources.reauthorize(proof, signal); if (!alive()) return false;
    await runtime.binding.sessions.resumeForHost(alive); if (!alive()) return false;
    if (!runtime.binding.sessions.getSnapshot().ready || !runtime.binding.sessions.getSnapshot().active) throw new Error('recovery-not-ready');
    await this.driver.revalidate(proof, signal); if (!alive()) return false;
    runtime.proof = proof; runtime.handle = target.handle; runtime.navigation.setAvailable(true);
    this.update({ phase: 'ready', locked: false, error: '' }); return true;
   }
   const wasOffline = this.getRuntimeProviderOffline();
   if (wasOffline && !this.state.locked && runtime.binding.sessions.needsExitConfirmation()) return false;
   await runtime.binding.replication.suspendAndWait(); if (!alive()) return false;
   await this.driver.revalidate(proof, signal); if (!alive()) return false;
   if (!this.driver.openReplication) throw new Error('provider-replication-unavailable');
   nextReplication = await this.driver.openReplication(proof, signal); if (!alive()) return false;
   await runtime.resources.reauthorize(proof, signal); if (!alive()) return false;
   await runtime.binding.sessions.resumeForHost(alive); if (!alive()) return false;
   if (!runtime.binding.sessions.getSnapshot().ready || !runtime.binding.sessions.getSnapshot().active) throw new Error('recovery-not-ready');
   await this.driver.revalidate(proof, signal); if (!alive()) return false;
   if (beforeActivate) { await beforeActivate(); if (!alive()) return false; }
   if (wasOffline) this.offlineConnection?.hostLost();
   runtime.proof = proof; runtime.handle = target.handle; runtime.binding.replication = nextReplication; nextReplication = null;
   runtime.navigation.setAvailable(true); this.update({ phase: 'ready', locked: false, error: '' });
   void runtime.binding.replication.resume().catch(() => undefined); return true;
  } catch (error) { if (alive()) { runtime.binding.sessions.deactivateForHostLoss(); runtime.navigation.setAvailable(false); runtime.binding.replication.suspend(); this.update({ phase: 'recovery-required', locked: true, error: String(error) }); } return false; }
  finally { if (nextReplication) await nextReplication.suspendAndWait(); }
 }
 /** Re-admit only the retained scope and exact host proof; preserve the same runtime and form owners. */
 restoreRetained(): Promise<void> { return this.run(async () => { const f = this.fence(), runtime = this.runtime;
  if (!runtime || !this.lease || this.getRuntimeStorageKind() === 'google-drive') return;
  try { const proof = await this.driver.inspect(this.lease, runtime.handle, f.signal); if (!f.alive()) return;
   if (!this.driver.sameAdmission(runtime.proof, proof) || canonicalJson(proof.scope) !== canonicalJson(runtime.proof.scope)) throw new Error('admission-changed');
   await this.driver.revalidate(proof, f.signal); if (!f.alive()) return;
   await runtime.resources.reauthorize(proof, f.signal); if (!f.alive()) return;
   await runtime.binding.sessions.resumeForHost(f.alive); if (!f.alive()) return;
   if (!runtime.binding.sessions.getSnapshot().ready || !runtime.binding.sessions.getSnapshot().active) throw new Error('recovery-not-ready');
   await this.driver.revalidate(proof, f.signal); if (!f.alive()) return;
   runtime.proof = proof; runtime.navigation.setAvailable(true); this.update({ phase: 'ready', locked: false, error: '' });
  } catch (error) { if (f.alive()) { runtime.binding.sessions.deactivateForHostLoss(); runtime.navigation.setAvailable(false); runtime.binding.replication.suspend(); this.update({ phase: 'recovery-required', locked: true, error: String(error) }); } }
 }); }
 async prepareClose(): Promise<ScopeLeaveResult> {
  if (this.state.creation && ['preparing', 'unknown', 'pending'].includes(this.state.creation.stage)) return refused('creation-unknown');
  const runtime = this.runtime; if (!runtime) return { status: 'allowed' };
  if (this.state.locked || !await runtime.navigation.prepareScopeLeave()) return refused('current-blocked');
  return runtime.binding.sessions.prepareLeave();
 }
 private async leaveRuntime(): Promise<ScopeLeaveResult> {
  const f = this.fence(), runtime = this.runtime; if (!runtime) return { status: 'allowed' };
  const fromProvider = this.getRuntimeStorageKind() === 'google-drive';
  const allowed = await this.prepareClose(); if (allowed.status !== 'allowed' || !f.alive()) return allowed.status === 'allowed' ? refused('stale') : allowed;
  const suspended = await runtime.binding.sessions.suspend(); if (suspended.status !== 'allowed' || !f.alive()) return suspended.status === 'allowed' ? refused('stale') : suspended;
  await runtime.binding.replication.suspendAndWait(); if (!f.alive()) return refused('stale');
  runtime.navigation.setAvailable(false);
  // Transfer ownership before awaiting close; no competing leave can close it a second time.
  if (this.runtime === runtime) { this.runtime = null; this.providerRequestId = null; }
  await runtime.resources.close(); if (!f.alive()) return refused('stale');
  if (fromProvider && !this.closing) {
   this.lease = null;
   const context = await this.driver.readLocalContext(f.signal); if (!f.alive()) return refused('stale');
   if (context.status === 'ready') { this.lease = context.lease; await this.discover(f); }
   else this.update({ phase: context.status === 'setup-required' ? 'setup-required' : 'recovery-required',
    discovery: null, locked: false, error: context.reason });
  } else this.update({ phase: 'choosing', locked: false });
  return { status: 'allowed' };
 }
 returnToChooser(): Promise<ScopeLeaveResult> {
  if (this.providerBlocksLocal()) return Promise.resolve(refused('provider-operation-pending'));
  if (this.closeFlight) return this.closeFlight;
  if (this.leaveFlight) return this.leaveFlight;
  const flight = this.leaveRuntime().finally(() => { if (this.leaveFlight === flight) { this.leaveFlight = null; this.update({}); } });
  this.leaveFlight = flight; this.update({}); return flight;
 }
 close(): Promise<ScopeLeaveResult> {
  if (this.closeFlight) return this.closeFlight;
  // Do not invalidate the fence of an initialization that already owns a fixed
  // request: its in-flight result must still reach the recoverable creation UI.
  if (this.state.creation && ['preparing', 'unknown', 'pending'].includes(this.state.creation.stage)) return Promise.resolve(refused('creation-unknown'));
  if (this.providerConnection?.getSnapshot().pendingGuard) return Promise.resolve(refused('provider-operation-pending'));
  if (this.offlineConnection?.getSnapshot().pendingGuard || this.offlineConnection?.getSnapshot().busy) return Promise.resolve(refused('offline-operation-pending'));
  this.closing = true; // Block new work before any await; an existing voluntary leave keeps its fence.
  const active = this.flight, leaving = this.leaveFlight;
  // An unadmitted candidate is safe to cancel; an admitted runtime must keep its live I/O
  // until its dirty/current-view guards have allowed leave.
  if (!this.runtime && !leaving) this.invalidate();
  const flight = (async (): Promise<ScopeLeaveResult> => {
   if (active) await active.catch(() => undefined);
   if (leaving) {
    const prior = await leaving;
    if (prior.status !== 'allowed') { this.closing = false; return prior; }
   }
   if (this.state.creation && ['preparing', 'unknown', 'pending'].includes(this.state.creation.stage)) { this.closing = false; return refused('creation-unknown'); }
   const providerResult = await this.providerConnection?.close();
   if (providerResult && providerResult.status !== 'allowed') { this.closing = false; return providerResult; }
   const result = await this.leaveRuntime(); if (result.status !== 'allowed') { this.closing = false; return result; }
   this.invalidate(); this.unsubscribe();
   this.driverCloseFlight ??= this.driver.close();
   const driverClosing = this.driverCloseFlight;
   try { await driverClosing; }
   catch (error) { if (this.driverCloseFlight === driverClosing) this.driverCloseFlight = null; throw error; }
   this.offlineConnection?.dispose(); this.update({ phase: 'closed' }); return { status: 'allowed' };
  })().finally(() => { if (this.closeFlight === flight) { this.closeFlight = null; if (!this.closing) this.update({}); } });
  this.closeFlight = flight; this.update({}); return flight;
 }
}

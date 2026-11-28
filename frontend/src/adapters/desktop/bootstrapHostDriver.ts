import { authToken, backendUrl } from '../../api/connection.ts';
import { createDesktopProviderOffline, NativeOfflineRejected } from './provider/offline/providerOffline.ts';
import { createDesktopProviderOwner } from './provider/providerOwner.ts';
import { createDesktopEditRepository } from './editRepository.ts';
import { BrowserMarkdownDraftPort } from '../browser/canonicalMarkdownDrafts.ts';
import { BrowserAnnotationAppendDraftPort } from '../browser/annotationAppendDrafts.ts';
import { BrowserReaderStatePort } from '../browser/readerState.ts';
import { BrowserWorkspaceSelection } from '../browser/workspaceSelection.ts';
import { BrowserWorkspacePreferences } from '../browser/workspacePreferences.ts';
import { BrowserLibraryQueryPreferences } from '../browser/libraryQueryPreferences.ts';
import { saveOutputFile } from './outputFile.ts';
import { browserOutputFile } from '../browser/outputFile.ts';
import { createBrowserInkPreferences } from '../browser/inkPreferences.ts';
import { readLegacyHoldRecordReadonly } from '../browser/legacyHoldReadonly.ts';
import { readLegacyWebPresenceReadonly } from '../browser/legacyPresenceReadonly.ts';
import { validateCanonicalDevicePeer, validateCanonicalInitializeRequest, editSchema } from '../../runtime/edits/contracts.ts';
import { validateStructure } from '../../runtime/edits/schemaValidator.ts';
import type { EditScope } from '../../runtime/edits/ports.ts';
import type { InitializationOutcome } from '../../runtime/edits/canonicalInitializationStorage.ts';
import type { ActiveLibraryProof, BootstrapDiscovery, BootstrapHostDriver, HostLease, LibraryHandle, NativePreparationStatus, NativePreviewBlocked, NativePreviewBlockedReason, OwnerInitializationFacade, ScopeResources } from '../../features/bootstrap/bootstrapPorts.ts';
import { RuntimeIoGate, type RuntimeIoGateHooks } from '../../runtime/lifecycle/RuntimeIoGate.ts';
import { admissionHeader, authorizationHeader, bootstrapRoutes as routes, hostLeaseHeader, type BootstrapBody, type BootstrapPath, type ContextWire, type DiscoveryWire, type InspectWire, type RevalidateWire } from './canonicalBootstrapWire.ts';

type Lease = { id: string; active: boolean };
type Handle = { id: string; provider?: boolean; offline?: boolean };
type Proof = { lease: Lease; admission: string; fingerprint: string; scope: EditScope; peerId: string; provider?: boolean; offline?: boolean };
type DesktopBinding = { lease: Lease };
type DesktopOperation = { lease: Lease; admission: string; signal: AbortSignal };

const canceled = () => new DOMException('Cancelled', 'AbortError');
const check = (signal: AbortSignal) => { if (signal.aborted) throw canceled(); };
const sameScope = (a: EditScope, b: EditScope) => a.accountId === b.accountId && a.libraryId === b.libraryId && a.epoch === b.epoch;
const validScope = (scope: EditScope) => scope && typeof scope.accountId === 'string' && !!scope.accountId && typeof scope.libraryId === 'string' && !!scope.libraryId && typeof scope.epoch === 'string' && !!scope.epoch;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function object(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}
function context(value: unknown): ContextWire {
  const v = object(value, 'invalid-context-response');
  if (typeof v.status !== 'string' || (v.reason !== undefined && typeof v.reason !== 'string') || (v.leaseId !== undefined && typeof v.leaseId !== 'string')) throw new Error('invalid-context-response');
  return { status:v.status, ...(v.reason !== undefined ? { reason:v.reason } : {}), ...(v.leaseId !== undefined ? { leaseId:v.leaseId } : {}) };
}
function admission(value: unknown, requireId: true): InspectWire;
function admission(value: unknown, requireId: false): RevalidateWire;
function admission(value: unknown, requireId: boolean): InspectWire | RevalidateWire {
  const v = object(value, 'invalid-admission-response');
  validateStructure(editSchema, 'DatasetScope', v.scope);
  if (!validId(v.peerId) || typeof v.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(v.fingerprint) || (requireId && (typeof v.admissionId !== 'string' || !v.admissionId))) throw new Error('invalid-admission-response');
  if (v.authorizationMode !== undefined && (typeof v.authorizationMode !== 'string' || !['local', 'provider-online', 'provider-offline'].includes(v.authorizationMode))) throw new Error('invalid-admission-response');
  const proof = { scope:v.scope as EditScope, peerId:v.peerId, fingerprint:v.fingerprint, ...(v.authorizationMode !== undefined ? { authorizationMode:v.authorizationMode as 'local' | 'provider-online' | 'provider-offline' } : {}) };
  return requireId ? { ...proof, admissionId:v.admissionId as string } : proof;
}
function discovery(value: unknown): DiscoveryWire {
  const v = object(value, 'invalid-discovery-response');
  if (!Array.isArray(v.libraries) || !Array.isArray(v.creations) || v.canCreateLibrary !== true) throw new Error('invalid-discovery-response');
  const libraries = v.libraries.map((entry: unknown): DiscoveryWire['libraries'][number] => {
    const item = object(entry, 'invalid-discovery-response');
    if (typeof item.handleId !== 'string' || !item.handleId || typeof item.title !== 'string' || (item.status !== 'available' && item.status !== 'recovery-required' && item.status !== 'frozen') || (item.reason !== undefined && typeof item.reason !== 'string')) throw new Error('invalid-discovery-response');
    return { handleId:item.handleId, title:item.title, status:item.status, ...(item.reason !== undefined ? { reason:item.reason } : {}) };
  });
  const creations = v.creations.map((entry: unknown) => {
    const item = object(entry, 'invalid-discovery-response');
    if (!validId(item.requestId) || typeof item.title !== 'string') throw new Error('invalid-discovery-response');
    return { requestId:item.requestId, title:item.title, outcome:outcome(item.outcome) };
  });
  return { libraries, creations, canCreateLibrary:true };
}
function outcome(value: unknown): InitializationOutcome {
  if (!value || typeof value !== 'object') throw new Error('invalid-initialization-response');
  const v = value as Record<string, unknown>;
  if ((v.status === 'pending' || v.status === 'not-found') && Object.keys(v).length === 1) return v as InitializationOutcome;
  if (v.status === 'rejected' && typeof v.reason === 'string' && v.reason.length > 0 && v.reason.length <= 200 && Object.keys(v).length === 2) return v as InitializationOutcome;
  if (v.status === 'accepted' && Object.keys(v).length === 2) { validateStructure(editSchema, 'CanonicalInitializationReceipt', v.receipt); return v as InitializationOutcome; }
  throw new Error('invalid-initialization-response');
}

/** Only test transport is replaceable; grant, lease and proof are never factory inputs. */
export function createDesktopBootstrapHostDriver(fetcher: typeof fetch = globalThis.fetch): BootstrapHostDriver {
  const leases = new WeakMap<HostLease, Lease>(), handles = new WeakMap<LibraryHandle, Handle>(), proofs = new WeakMap<ActiveLibraryProof, Proof>();
  const liveLeases = new Set<Lease>(), gates = new Set<RuntimeIoGate<DesktopBinding, Proof, DesktopOperation>>(), listeners = new Set<() => void>(), controllers = new Set<AbortController>();
  const scopedListeners = new Set<(leaseId: string) => void>();
  let closed = false;
  let closeFlight: Promise<void> | undefined;
  let closeLeaseIds: string[] | undefined;
  function invalidate(notify = true) {
    for (const lease of liveLeases) lease.active = false;
    for (const gate of gates) gate.revoke();
    for (const controller of controllers) controller.abort();
    if (notify) for (const listener of listeners) listener();
  }
  const pageHide = () => { provider.parkForPageHide(); invalidate(); void provider.cancelPending(); }; globalThis.addEventListener('pagehide', pageHide);
  function leaseOf(value: HostLease): Lease {
    const lease = leases.get(value); if (closed || !lease?.active) throw new Error('host-unavailable'); return lease;
  }
  function proofOf(value: ActiveLibraryProof, current = true): Proof {
    const proof = proofs.get(value); if (!proof || closed || (current && !proof.lease.active) || !sameScope(value.scope, proof.scope)) throw new Error('invalid-admission'); return proof;
  }
  /** Classification of our retained proof is metadata, including after its authority expires. */
  function knownProof(value: ActiveLibraryProof): Proof {
    const proof = proofs.get(value); if (!proof || !sameScope(value.scope, proof.scope)) throw new Error('invalid-admission'); return proof;
  }
  async function wire<T>(path: string, body: unknown, signal: AbortSignal, lease?: Lease, admission?: string, providerOperation?: string, acceptStatuses?: readonly number[]): Promise<T> {
    const offlineRequest = path.startsWith('/api/edits/provider-owner/offline/');
    if (offlineRequest && (signal.aborted || closed || (lease && !lease.active))) throw new NativeOfflineRejected('offline-request-rejected');
    check(signal); if (closed || (lease && !lease.active)) throw new Error('host-unavailable');
    const controller = new AbortController(), abort = () => controller.abort(); controllers.add(controller);
    signal.addEventListener('abort', abort, { once:true }); if (signal.aborted) abort();
    try {
      const token = authToken(); if (!token) { if (offlineRequest) throw new NativeOfflineRejected('offline-request-rejected'); throw new Error('host-unavailable'); }
      const response = await fetcher(backendUrl(path), { method:'POST', headers:{ 'Content-Type':'application/json', [authorizationHeader]:`Bearer ${token}`,
        ...(lease ? { [hostLeaseHeader]:lease.id } : {}), ...(admission ? { [admissionHeader]:admission } : {}),
        ...(providerOperation ? { 'X-Papeer-Provider-Operation':providerOperation } : {}) }, body:JSON.stringify(body), signal:controller.signal });
      const bodyValue: unknown = await response.json(); check(signal);
      if (closed || (lease && !lease.active)) throw new Error('host-unavailable'); check(controller.signal);
      // A status the caller named is a value (a refusal), not a failure: no invalidation, 401 is never accepted.
      if (!response.ok && response.status !== 401 && acceptStatuses?.includes(response.status)) return bodyValue as T;
      if (!response.ok) {
        const detail = bodyValue && typeof bodyValue === 'object' ? (bodyValue as { detail?: unknown }).detail : undefined;
        if (offlineRequest) {
          if ([400, 401, 403, 422].includes(response.status)) throw new NativeOfflineRejected('offline-request-rejected');
          throw new Error('offline-request-failed');
        }
        if (providerOperation && (response.status === 401 || detail === 'canonical-authority-denied')) provider.invalidateOperation(providerOperation);
        else if (response.status === 401 || (detail === 'canonical-authority-denied' && !(path === routes.release && response.status === 403))) invalidate();
        throw new Error('native-request-failed');
      }
      if (closed || (lease && !lease.active)) throw new Error('host-unavailable');
      return bodyValue as T;
    } finally { signal.removeEventListener('abort', abort); controllers.delete(controller); }
  }
  function bootstrap<P extends BootstrapPath>(path: P, body: BootstrapBody<P>, signal: AbortSignal, lease?: Lease, admissionId?: string): Promise<unknown> {
    return wire<unknown>(path, body, signal, lease, admissionId);
  }
  function newLease(id: unknown): HostLease {
    if (typeof id !== 'string' || !id) throw new Error('invalid-lease-response');
    const object = Object.freeze({}) as HostLease, lease = { id, active:true }; leases.set(object,lease); liveLeases.add(lease); return object;
  }
  function makeProof(lease: Lease, value: InspectWire, provider = false): ActiveLibraryProof {
    if (!value || typeof value.admissionId !== 'string' || !value.admissionId || !validScope(value.scope) || !validId(value.peerId) || typeof value.fingerprint !== 'string' || value.fingerprint.length !== 64 || !/^[0-9a-f]{64}$/.test(value.fingerprint)) throw new Error('invalid-admission-response');
    validateStructure(editSchema, 'DatasetScope', value.scope);
    const scope = Object.freeze({ ...value.scope }); const object = Object.freeze({ scope }) as ActiveLibraryProof;
    const offlineMode = value.authorizationMode === 'provider-offline';
    if ((offlineMode && !provider) || (provider && value.authorizationMode === 'local') || (!provider && value.authorizationMode === 'provider-online')) throw new Error('invalid-admission-response');
    proofs.set(object,{ lease, admission:value.admissionId, fingerprint:value.fingerprint, scope, peerId:value.peerId, provider, offline:offlineMode }); return object;
  }
  async function verify(proof: Proof, signal: AbortSignal) {
    const response = admission(await bootstrap(routes.revalidate,{},signal,proof.lease,proof.admission),false);
    if (!!proof.offline !== (response.authorizationMode === 'provider-offline')) throw new Error('admission-changed');
    if (!sameScope(response.scope,proof.scope) || response.peerId !== proof.peerId || response.fingerprint !== proof.fingerprint) throw new Error('admission-changed');
  }

  const wrapLeaseCall = <P extends BootstrapPath>(value: HostLease, signal: AbortSignal, path: P, body: BootstrapBody<P>) => bootstrap(path,body,signal,leaseOf(value));
  const retireProviderGrant = async (path: string, grant: { leaseId: string; operationId: string }, signal: AbortSignal) => {
    const token = authToken(); if (!token) throw new Error('host-unavailable');
    const response = await fetcher(backendUrl(path), {
      method:'POST', headers:{ 'Content-Type':'application/json', [authorizationHeader]:`Bearer ${token}`,
        [hostLeaseHeader]:grant.leaseId, 'X-Papeer-Provider-Operation':grant.operationId }, body:'{}', signal,
    });
    if (!response.ok) throw new Error('native-request-failed');
  };
  const providerLeases = new Map<string, Lease>();
  const provider = createDesktopProviderOwner({
    async call(path, body, signal, grant, admissionId) {
      let lease: Lease | undefined;
      if (grant) {
        lease = providerLeases.get(grant.leaseId);
        if (!lease) { lease = { id:grant.leaseId, active:true }; providerLeases.set(grant.leaseId, lease); liveLeases.add(lease); }
      }
      return wire(path, body, signal, lease, admissionId, grant?.operationId);
    },
    installed(value) {
      const result = object(value, 'invalid-provider-installed');
      const lease = newLease(result.leaseId), handle = Object.freeze({}) as LibraryHandle;
      handles.set(handle, { id:textProviderId(result.handleId), provider:true });
      return { lease, handle, requestId:textProviderId(result.requestId) };
    },
    admission(value, grant) { const proof = proofOf(value); if (proof.lease.id !== grant.leaseId || !proof.provider) throw new Error('provider-admission-invalid'); return proof.admission; },
    revoke(grant) {
      for (const lease of liveLeases) if (lease.id === grant.leaseId) lease.active = false;
      for (const listener of scopedListeners) listener(grant.leaseId);
    },
    async resumeRetained(grant, requestId, attemptId, signal) {
      const token = authToken(); if (!token || closed) throw new Error('host-unavailable');
      const response = await fetcher(backendUrl('/api/edits/provider-owner/resume-retained'), {
        method:'POST', headers:{ 'Content-Type':'application/json', [authorizationHeader]:`Bearer ${token}`,
          [hostLeaseHeader]:grant.leaseId, 'X-Papeer-Provider-Operation':grant.operationId }, body:JSON.stringify({ requestId, attemptId }), signal,
      });
      if (!response.ok || closed || signal.aborted) throw new Error('native-request-failed');
      return response.json();
    },
    async settleResume(grant, attemptId, action, signal) {
      const token = authToken(); if (!token) throw new Error('host-unavailable');
      const path = action === 'cancel' ? 'cancel-resume' : 'acknowledge-resume';
      const response = await fetcher(backendUrl('/api/edits/provider-owner/' + path), { method:'POST',
        headers:{ 'Content-Type':'application/json', [authorizationHeader]:`Bearer ${token}`,
          [hostLeaseHeader]:grant.leaseId, 'X-Papeer-Provider-Operation':grant.operationId }, body:JSON.stringify({ attemptId }), signal });
      if (!response.ok) throw new Error('native-request-failed');
    },
    async discardResumed(grant) {
      const token = authToken(); if (!token) return;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
      try { await fetcher(backendUrl('/api/edits/provider-owner/discard-resumed'), { method:'POST',
        headers:{ 'Content-Type':'application/json', [authorizationHeader]:`Bearer ${token}`,
          [hostLeaseHeader]:grant.leaseId, 'X-Papeer-Provider-Operation':grant.operationId }, body:'{}', signal:controller.signal }); }
      finally { clearTimeout(timer); }
    },
    async cancelAttempt(attemptId, signal) {
      const token = authToken(); if (!token) throw new Error('host-unavailable');
      const response = await fetcher(backendUrl('/api/edits/provider-owner/cancel-connect'), {
        method:'POST', headers:{ 'Content-Type':'application/json', [authorizationHeader]:`Bearer ${token}` },
        body:JSON.stringify({ attemptId }), signal,
      });
      if (!response.ok) throw new Error('native-request-failed');
    },
    disconnect: (grant, signal) => retireProviderGrant('/api/edits/provider-owner/disconnect', grant, signal),
    release: (grant, signal) => retireProviderGrant('/api/edits/provider-owner/release', grant, signal),
  });
  type OfflineBinding = { lease: Lease; admission?: string };
  const offlineLeases = new Set<Lease>();
  const installedOfflineLeases = new WeakSet<Lease>();
  const offline = createDesktopProviderOffline<OfflineBinding>({
    async local(signal) {
      const result = context(await bootstrap(routes.readContext, {}, signal));
      if (result.status !== 'ready') throw new Error('offline-context-unavailable');
      const publicLease = newLease(result.leaseId), lease = leaseOf(publicLease); offlineLeases.add(lease);
      return { lease };
    },
    active(value) {
      const proof = proofOf(value);
      if (!proof.provider || proof.offline) throw new Error('online-provider-admission-required');
      return { lease:proof.lease, admission:proof.admission };
    },
    async call(operation, body, signal, binding) {
      const path = '/api/edits/provider-owner/offline/' + operation;
      if (operation !== 'lock') return wire(path, body, signal, binding.lease, binding.admission);
      // Retirement is permitted after the local gate is fenced; it cannot issue authority.
      const token = authToken(); if (!token) throw new Error('host-unavailable');
      const response = await fetcher(backendUrl(path), { method:'POST', headers:{ 'Content-Type':'application/json',
        [authorizationHeader]:`Bearer ${token}`, [hostLeaseHeader]:binding.lease.id }, body:'{}', signal });
      if (!response.ok) throw new Error('offline-lock-incomplete');
      return response.json();
    },
    installed(value, binding) {
      const result = object(value, 'invalid-offline-installed');
      if (result.authorizationMode !== 'provider-offline' || result.leaseId !== binding.lease.id || !validId(result.requestId)) throw new Error('invalid-offline-installed');
      const lease = newLease(result.leaseId), saved = leaseOf(lease), handle = Object.freeze({}) as LibraryHandle;
      offlineLeases.add(saved); installedOfflineLeases.add(saved); handles.set(handle, { id:textProviderId(result.handleId), provider:true, offline:true });
      return { lease, handle, requestId:result.requestId };
    },
    retire(binding) {
      // Native offline/lock retires the matching lease only. A failed unlock's
      // uninstalled lease must not invalidate an unrelated active runtime.
      let installedRetired = false;
      for (const lease of offlineLeases) {
        if (lease.id === binding.lease.id && lease.active) {
          if (installedOfflineLeases.has(lease)) installedRetired = true;
          lease.active = false;
        }
      }
      if (installedRetired) for (const listener of scopedListeners) listener(binding.lease.id);
    },
  });
  function textProviderId(value: unknown): string { if (typeof value !== 'string' || !value) throw new Error('invalid-provider-response'); return value; }
  const preparationCall = async (action: 'status' | 'start' | 'resume' | 'abandon', signal: AbortSignal, runId?: string): Promise<NativePreparationStatus> => {
    if (runId !== undefined && !validId(runId)) throw new Error('maintenance-invalid-request');
    const value = object(await wire('/api/edits/legacy-maintenance/' + action, runId === undefined ? {} : { runId }, signal), 'maintenance-invalid-response');
    if (!['idle', 'running', 'captured', 'failed', 'recovery-required', 'cancelled', 'blocked'].includes(String(value.state)) || value.scope !== 'native-preparation-only'
        || (value.runId !== undefined && !validId(value.runId)) || (value.phase !== undefined && typeof value.phase !== 'string')
        || (value.failure !== undefined && value.failure !== null && typeof value.failure !== 'string')) throw new Error('maintenance-invalid-response');
    return value as unknown as NativePreparationStatus;
  };
  const previewReasons: readonly string[] = ['preview-busy', 'preview-shutdown-pending', 'preview-cancelled', 'preview-capacity-exceeded', 'preview-unavailable'];
  const isSelector = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
  /** Refusals (409) and results (200) share one envelope check: anything else is an invalid response. */
  const previewCall = async (runId: string, selector: string | undefined, signal: AbortSignal): Promise<Record<string, unknown>> => {
    if (!validId(runId) || selector !== undefined && !isSelector(selector)) throw new Error('preview-invalid-request');
    const value = object(await wire('/api/edits/legacy-maintenance/' + (selector === undefined ? 'notebooks' : 'notebook-preview'),
      selector === undefined ? { runId } : { runId, selector }, signal, undefined, undefined, undefined, [409]), 'preview-invalid-response');
    if (value.scope !== 'native-notebook-preview-only') throw new Error('preview-invalid-response');
    return value;
  };
  const previewBlocked = (value: Record<string, unknown>): NativePreviewBlocked | null => {
    if (!('state' in value)) return null;
    if (value.state !== 'blocked' || typeof value.reason !== 'string' || !previewReasons.includes(value.reason) || Object.keys(value).length !== 3) throw new Error('preview-invalid-response');
    return { status: 'blocked', reason: value.reason as NativePreviewBlockedReason };
  };
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  return {
    getNativePreparation() {
      return { status: signal => preparationCall('status', signal), start: signal => preparationCall('start', signal),
        resume: (runId, signal) => preparationCall('resume', signal, runId), abandon: (runId, signal) => preparationCall('abandon', signal, runId),
        async notebookSelectors(runId, signal) {
          const value = await previewCall(runId, undefined, signal), blocked = previewBlocked(value); if (blocked) return blocked;
          if (!Array.isArray(value.selectors) || value.selectors.length > 256 || !value.selectors.every(isSelector) || new Set(value.selectors).size !== value.selectors.length) throw new Error('preview-invalid-response');
          return { status: 'ok', selectors: value.selectors as string[] };
        },
        async notebookPreview(runId, selector, signal) {
          const value = await previewCall(runId, selector, signal), blocked = previewBlocked(value); if (blocked) return blocked;
          const entry = object(value.entry, 'preview-invalid-response'), coverage = object(value.coverage, 'preview-invalid-response');
          if (value.sourceDocumentId !== selector || typeof value.libraryId !== 'string' || !value.libraryId || typeof value.bytesBase64 !== 'string' || value.bytesBase64.length > 8 * 1024 * 1024
              || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256) || !count(entry.byteLength)
              || !Array.isArray(value.annotations) || !Array.isArray(value.incomplete) || value.incomplete.some(item => typeof item !== 'string')
              || !count(coverage.pageRows) || !count(coverage.inkRows) || !count(coverage.bookmarkRows)) throw new Error('preview-invalid-response');
          return { status: 'ok', value: { libraryId: value.libraryId, sourceDocumentId: selector, entry: { sha256: entry.sha256, byteLength: entry.byteLength as number },
            bytesBase64: value.bytesBase64, annotations: value.annotations as never, incomplete: value.incomplete as string[],
            coverage: { pageRows: coverage.pageRows as number, inkRows: coverage.inkRows as number, bookmarkRows: coverage.bookmarkRows as number } } };
        } };
    },
    getProvider() { return provider; },
    getOffline() { return offline; },
    providerOffline(value) { return !!knownProof(value).offline; },
    storageKind(value) { return knownProof(value).provider ? 'google-drive' : 'local'; },
    openReplication(value, signal) { if (knownProof(value).offline) throw new Error('provider-offline-transfer-denied'); return provider.openCurrentReplication(value, signal); },
    async readHold(signal) {
      const maintenance = await preparationCall('status', signal);
      if (maintenance.state !== 'idle' && !(maintenance.state === 'cancelled' && maintenance.phase === 'restart-complete')) return 'held';
      const result = await bootstrap(routes.hold,{},signal);
      if (result !== null) { validateStructure(editSchema,'LegacyMigrationHold',result); return 'held'; }
      const presence = await bootstrap(routes.legacyPresence,{},signal);
      if (presence !== 'clear' && presence !== 'legacy-present') throw new Error('invalid-legacy-presence-response');
      if (presence !== 'clear' || await readLegacyHoldRecordReadonly(signal) !== null) return 'held';
      return await readLegacyWebPresenceReadonly(signal) === 'clear' ? 'clear' : 'held';
    },
    async readLocalContext(signal) {
      const result = context(await bootstrap(routes.readContext,{},signal));
      if (result.status === 'ready') return { status:'ready', lease:newLease(result.leaseId) };
      if (result.status === 'setup-required' && (result.reason === 'absent' || result.reason === 'schema-upgrade')) return { status:'setup-required', reason:result.reason };
      if (result.status === 'recovery-required' || result.status === 'blocked') return { status:'recovery-required', reason:result.reason ?? 'storage-error' };
      throw new Error('invalid-context-response');
    },
    async provisionLocalContext(signal) { const result = context(await bootstrap(routes.provisionContext,{},signal)); if (result.status !== 'ready') throw new Error('invalid-context-response'); return newLease(result.leaseId); },
    async discover(value,signal) {
      const result = discovery(await wrapLeaseCall(value,signal,routes.discover,{}));
      if (!Array.isArray(result.libraries) || !Array.isArray(result.creations) || result.canCreateLibrary !== true) throw new Error('invalid-discovery-response');
      const libraries: BootstrapDiscovery['libraries'] = result.libraries.map(item => {
        if (typeof item.handleId !== 'string' || !item.handleId || typeof item.title !== 'string' || !['available','recovery-required','frozen'].includes(item.status)) throw new Error('invalid-discovery-response');
        const object = Object.freeze({}) as LibraryHandle; handles.set(object,{ id:item.handleId });
        return { handle:object, title:item.title, status:item.status, ...(item.reason ? { reason:item.reason } : {}) };
      });
      const creations = result.creations.map(item => { if (!validId(item.requestId) || typeof item.title !== 'string') throw new Error('invalid-discovery-response'); return { requestId:item.requestId, title:item.title, outcome:outcome(item.outcome) }; });
      return { libraries, creations, canCreateLibrary:true };
    },
    initialization(value): OwnerInitializationFacade {
      leaseOf(value);
      return {
        async getOrCreatePeer(signal) { const peer = await wrapLeaseCall(value,signal,routes.peer,{}); validateCanonicalDevicePeer(peer); return peer; },
        async prepare(request,signal) { const captured = structuredClone(request); validateCanonicalInitializeRequest(captured); return outcome(await wrapLeaseCall(value,signal,routes.prepare,{ request:captured })); },
        async query(requestId,signal) { if (!validId(requestId)) throw new Error('invalid-id'); return outcome(await wrapLeaseCall(value,signal,routes.query,{ requestId })); },
        async execute(requestId,signal) { if (!validId(requestId)) throw new Error('invalid-id'); return outcome(await wrapLeaseCall(value,signal,routes.execute,{ requestId })); },
        async acknowledge(requestId,signal) { if (!validId(requestId)) throw new Error('invalid-id'); await wrapLeaseCall(value,signal,routes.acknowledge,{ requestId }); },
      };
    },
    async inspect(value,handle,signal) {
      const lease = leaseOf(value), saved = handles.get(handle); if (!saved) throw new Error('invalid-handle');
      const result = admission(await bootstrap(routes.inspect,{ handleId:saved.id },signal,lease),true);
      if (saved.offline && result.authorizationMode !== 'provider-offline') throw new Error('invalid-offline-admission');
      return makeProof(lease,result,!!saved.provider);
    },
    async revalidate(value,signal) { await verify(proofOf(value),signal); },
    sameAdmission(previous,next) { const a = proofOf(previous,false), b = proofOf(next); return a.fingerprint === b.fingerprint && sameScope(a.scope,b.scope); },
    async openScope(value,signal) {
      const proof = proofOf(value); await verify(proof,signal); check(signal);
      const binding: DesktopBinding = { lease: proof.lease };
      let activeLease = proof.lease;
      const candidateLeases = new Set<{ lease: Lease }>();
      const hooks: RuntimeIoGateHooks<DesktopBinding, Proof, DesktopOperation> = {
        capture(b, p, opSignal) {
          if (closed || !b.lease.active || !p.lease.active) throw new Error('host-unavailable');
          return { lease: p.lease, admission: p.admission, signal: opSignal };
        },
        assertCurrent(op) {
          if (closed || !op.lease.active) throw new Error('host-unavailable');
        },
        sameAdmission(prev, next) {
          return prev.fingerprint === next.fingerprint && sameScope(prev.scope, next.scope);
        },
        async validateCandidate(b, p, candSignal) {
          check(candSignal);
          if (closed || !b.lease.active || !p.lease.active) throw new Error('host-unavailable');
          await verify(p, candSignal);
        },
        subscribeInvalidation(listener) {
          listeners.add(listener);
          const scoped = (leaseId: string) => {
            if (activeLease.id === leaseId || [...candidateLeases].some(candidate => candidate.lease.id === leaseId)) listener();
          };
          scopedListeners.add(scoped);
          return () => { listeners.delete(listener); scopedListeners.delete(scoped); };
        },
      };
      const gate = new RuntimeIoGate(binding, proof, hooks);
      gates.add(gate);
      const repository = createDesktopEditRepository(proof.scope, (path, body) =>
        gate.run(undefined, op => wire(path, body, op.signal, op.lease, op.admission))
      );
      const rawDrafts = new BrowserMarkdownDraftPort(proof.scope), rawAppend = new BrowserAnnotationAppendDraftPort(proof.scope), rawReader = new BrowserReaderStatePort(proof.scope), rawInk = createBrowserInkPreferences(proof.scope);
      const drafts: ScopeResources['markdownDrafts'] = {
        scope: repository.scope,
        targets: () => gate.runSync(() => rawDrafts.targets()),
        read: id => gate.runSync(() => rawDrafts.read(id)),
        write: (id, val) => gate.runSync(() => rawDrafts.write(id, val)),
        remove: id => gate.runSync(() => rawDrafts.remove(id)),
      };
      const append: ScopeResources['appendDrafts'] = {
        scope: repository.scope,
        read: () => gate.runSync(() => rawAppend.read()),
        write: val => gate.runSync(() => rawAppend.write(val)),
        remove: () => gate.runSync(() => rawAppend.remove()),
      };
      const reader: ScopeResources['readerState'] = {
        scope: repository.scope,
        read: id => gate.runSync(() => rawReader.read(id)),
        write: (id, state) => gate.runSync(() => rawReader.write(id, state)),
      };
      const rawWorkspace = new BrowserWorkspacePreferences(proof.scope);
      const rawSelection = new BrowserWorkspaceSelection(proof.scope);
      const rawQuery = new BrowserLibraryQueryPreferences(proof.scope);
      const resources: ScopeResources = {
        repository,
        markdownDrafts: drafts,
        markdownImages: repository,
        appendDrafts: append,
        readerState: reader,
        workspacePreferences: { scope: repository.scope, read: () => gate.runSync(() => rawWorkspace.read()), write: value => gate.runSync(() => rawWorkspace.write(value)) },
        selectionPreferences: { scope: repository.scope, read: () => gate.runSync(() => rawSelection.read()), write: value => gate.runSync(() => rawSelection.write(value)) },
        queryPreferences: { scope: repository.scope, read: () => gate.runSync(() => rawQuery.read()), write: value => gate.runSync(() => rawQuery.write(value)) },
        outputFile: { ...browserOutputFile, save: saveOutputFile },
        inkPreferences: { getItem: key => gate.runSync(() => rawInk.getItem(key)), setItem: (key, value) => gate.runSync(() => rawInk.setItem(key, value)) },
        peerId: proof.peerId,
        async reauthorize(next, reauthSignal) {
          const nextProof = proofOf(next);
          check(reauthSignal);
          if (!hooks.sameAdmission(proof, nextProof)) throw new Error('admission-changed');
          const candidate = { lease: nextProof.lease }; candidateLeases.add(candidate);
          try {
            binding.lease = nextProof.lease;
            await gate.reauthorize(binding, nextProof, reauthSignal);
            activeLease = nextProof.lease;
          } finally { candidateLeases.delete(candidate); }
        },
        async close() {
          gates.delete(gate);
          await gate.close();
          if (proof.lease.active && !closed) {
            const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
            try { await bootstrap(routes.release, { admissionId: proof.admission }, controller.signal, proof.lease); }
            catch { /* already invalid or unreachable */ } finally { clearTimeout(timer); }
          }
        },
      };
      if (signal.aborted || !proof.lease.active || closed) {
        gates.delete(gate);
        await gate.close();
        throw canceled();
      }
      return resources;
    },
    subscribeInvalidation(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeScopedInvalidation(listener) {
      const notify = (leaseId: string) => listener({
        affectsLease: lease => leases.get(lease)?.id === leaseId,
        affectsProof: proof => proofs.get(proof)?.lease.id === leaseId,
      });
      scopedListeners.add(notify); return () => scopedListeners.delete(notify);
    },
    close() {
      if (closeFlight) return closeFlight;
      const flight = (async () => {
      if (!closed) {
        closeLeaseIds = [...liveLeases].map(lease => lease.id);
        provider.discardRetained(); invalidate(false); closed = true;
      }
      // Closed fences ordinary work. It does not mean failed retirement finished.
      // Keep the original leases until offline lock succeeds; only cleanup retries.
      const retirement = await Promise.allSettled([provider.cancelPending(), offline.close()]);
      for (const result of retirement) if (result.status === 'rejected') throw result.reason;
      globalThis.removeEventListener('pagehide',pageHide); await Promise.all([...gates].map(gate => gate.close())); listeners.clear(); scopedListeners.clear();
      const token = authToken(); if (!token) return;
      await Promise.allSettled((closeLeaseIds ?? []).map(async id => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(),3000);
        const body = {} satisfies BootstrapBody<typeof routes.release>;
        try { await fetcher(backendUrl(routes.release),{ method:'POST', headers:{ 'Content-Type':'application/json', [authorizationHeader]:`Bearer ${token}`, [hostLeaseHeader]:id }, body:JSON.stringify(body), signal:controller.signal }); }
        finally { clearTimeout(timer); }
      }));
      })().catch(error => { if (closeFlight === flight) closeFlight = undefined; throw error; });
      closeFlight = flight; return flight;
    },
  };
}

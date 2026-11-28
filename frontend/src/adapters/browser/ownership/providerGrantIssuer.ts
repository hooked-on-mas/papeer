import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import { assertLocalOwnerGrant } from '../../../runtime/edits/canonicalLocalGrant.ts';
import { readProviderDescriptorBytes } from '../../../runtime/edits/provider/providerDescriptorBytes.ts';
import type { CanonicalProviderDescriptor } from '../../../runtime/edits/contracts.ts';
import type { HostLease, ProviderGrant, RemoteLibraryHandle } from '../../../features/bootstrap/bootstrapPorts.ts';
import type { EditScope } from '../../../runtime/edits/ports.ts';
import type { HostOperation, LocalHostAuthority } from '../localHostAuthority.ts';

// Host-only collaborators must authenticate the live principal and validate descriptor bytes.
// Neither collaborator nor this issuer is exposed to renderer code.
export type VerifiedPrincipal = Readonly<{ digest: string; generation: number }>;
export type VerifiedDescriptor = Readonly<{ id: string; version: string; sha256: string; scope: EditScope; owner: true; writable: true; folderId?: string; title?: string }>;
export type ProviderVerifier = {
  /** Synchronous host-monotonic identity fence; never renderer evidence. Required for transactional use. */
  subscribeInvalidation?(listener: () => void): () => void;
  assertCurrent?(principal: VerifiedPrincipal): void;
  descriptorBytes?(principal: VerifiedPrincipal, id: string, signal: AbortSignal): Promise<Uint8Array>;
  captureDescriptor?(principal: VerifiedPrincipal, selection: string, signal: AbortSignal): Promise<{ descriptor: VerifiedDescriptor; bytes: Uint8Array }>;
  current(signal: AbortSignal): Promise<VerifiedPrincipal>;
  descriptor(principal: VerifiedPrincipal, selection: string, signal: AbortSignal): Promise<VerifiedDescriptor>;
};
type GrantRecord = { lease: HostLease; principal: VerifiedPrincipal; revoked: boolean; controllers: Set<AbortController> };
type HandleRecord = { grant: ProviderGrant; descriptor: VerifiedDescriptor; revoked: boolean; controllers: Set<AbortController> };

declare const providerOperationBrand: unique symbol;
/** Only this issuer's WeakMap can recognize an operation. Persisted data cannot recreate it. */
export type ProviderHostOperation = { readonly [providerOperationBrand]: true };
type CapturedProvider = { host: HostOperation; grant: ProviderGrant; descriptor: VerifiedDescriptor; canonical: CanonicalProviderDescriptor; selection: HandleRecord; principal: VerifiedPrincipal; bytes: Uint8Array; retire(): void };
type CapturedOwner = { host: HostOperation; grant: ProviderGrant; principal: VerifiedPrincipal; retire(): void };
export class ProviderGrantIssuer {
  private readonly operations = new WeakMap<object, CapturedProvider>();
  private readonly ownerOperations = new WeakMap<object, CapturedOwner>();
  private readonly grants = new WeakMap<object, GrantRecord>();
  private readonly handles = new WeakMap<object, HandleRecord>();
  private readonly parked = new WeakMap<object, { owner: string; principal: VerifiedPrincipal; cancelled: boolean; controller?: AbortController }>();
  private readonly authority: Pick<LocalHostAuthority, 'captureNamespaceOwner' | 'captureRecord'>;
  private readonly verifier: ProviderVerifier;
  constructor(authority: Pick<LocalHostAuthority, 'captureNamespaceOwner' | 'captureRecord'>, verifier: ProviderVerifier) {
    this.authority = authority; this.verifier = verifier;
  }
  private capture(lease: HostLease, signal: AbortSignal): HostOperation {
    const op = this.authority.captureNamespaceOwner(lease, signal); this.authority.captureRecord(op); return op;
  }
  private async check(grant: ProviderGrant, signal: AbortSignal): Promise<GrantRecord> {
    const record = this.grants.get(grant); if (!record || record.revoked) throw new Error('provider-grant-invalid');
    try {
      const op = this.capture(record.lease, signal); const current = await this.verifier.current(signal);
      this.authority.captureRecord(op);
      if (record.revoked || current.generation !== record.principal.generation || current.digest !== record.principal.digest) throw new Error('provider-grant-stale');
    } catch (error) { if (!signal.aborted) { record.revoked = true; for (const controller of record.controllers) controller.abort(); } throw error; }
    return record;
  }
  async connect(lease: HostLease, signal: AbortSignal): Promise<ProviderGrant> {
    const op = this.capture(lease, signal); const principal = await this.verifier.current(signal);
    this.authority.captureRecord(op);
    if (!/^[0-9a-f]{64}$/.test(principal.digest) || !Number.isSafeInteger(principal.generation) || principal.generation < 0) throw new Error('provider-principal-invalid');
    const grant = Object.freeze({}) as ProviderGrant;
    this.grants.set(grant, { lease, principal: Object.freeze({ ...principal }), revoked: false, controllers: new Set() }); return grant;
  }
  /** Host-private pagehide retirement. No old grant becomes live again. */
  parkForPageHide(grant: ProviderGrant): void {
    this.assertCurrentGrant(grant); const record = this.grants.get(grant)!;
    const host = this.authority.captureRecord(this.capture(record.lease, new AbortController().signal));
    assertLocalOwnerGrant(host.grant);
    this.parked.set(grant, { owner: canonicalJson(host.grant), principal: { ...record.principal }, cancelled: false });
    record.revoked = true; for (const controller of record.controllers) controller.abort();
  }
  async resumeParked(grant: ProviderGrant, lease: HostLease, signal: AbortSignal): Promise<ProviderGrant> {
    const parked = this.parked.get(grant);
    if (!parked || parked.cancelled || parked.controller) throw new Error('provider-resume-invalid');
    const controller = new AbortController(), cancel = () => controller.abort(); parked.controller = controller;
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
    try {
      controller.signal.throwIfAborted();
      const host = this.capture(lease, controller.signal), captured = this.authority.captureRecord(host);
      assertLocalOwnerGrant(captured.grant);
      if (canonicalJson(captured.grant) !== parked.owner) throw new Error('provider-resume-owner-changed');
      if (!this.verifier.assertCurrent) throw new Error('provider-live-fence-required');
      this.verifier.assertCurrent(parked.principal);
      const principal = await this.verifier.current(controller.signal);
      controller.signal.throwIfAborted(); this.authority.captureRecord(host); this.verifier.assertCurrent(parked.principal);
      if (parked.cancelled || principal.digest !== parked.principal.digest || principal.generation !== parked.principal.generation)
        throw new Error('provider-resume-principal-changed');
      const fresh = Object.freeze({}) as ProviderGrant;
      this.grants.set(fresh, { lease, principal: Object.freeze({ ...principal }), revoked: false, controllers: new Set() }); return fresh;
    } finally { parked.cancelled = true; this.parked.delete(grant); signal.removeEventListener('abort', cancel); }
  }
  disconnect(grant: ProviderGrant): void {
    const parked = this.parked.get(grant); if (parked) { parked.cancelled = true; parked.controller?.abort(); this.parked.delete(grant); }
    const record = this.grants.get(grant); if (record) { record.revoked = true; for (const controller of record.controllers) controller.abort(); }
  }
  async select(grant: ProviderGrant, selection: string, signal: AbortSignal): Promise<RemoteLibraryHandle> {
    const record = await this.check(grant, signal); const op = this.capture(record.lease, signal);
    try {
      const descriptor = await this.verifier.descriptor(record.principal, selection, signal);
      this.authority.captureRecord(op);
      if (record.revoked) throw new Error('provider-grant-invalid');
      if (this.verifier.assertCurrent) this.verifier.assertCurrent(record.principal);
      else await this.check(grant, signal);
      this.authority.captureRecord(op);
      this.validateDescriptor(descriptor);
      const handle = Object.freeze({}) as RemoteLibraryHandle;
      this.handles.set(handle, { grant, revoked: false, controllers: new Set(), descriptor: Object.freeze({ ...descriptor, scope: Object.freeze({ ...descriptor.scope }) }) }); return handle;
    } catch (error) { this.failSelection(record); throw error; }
  }
  private failSelection(owner: GrantRecord, selection?: HandleRecord): void {
    if (selection) { selection.revoked = true; for (const controller of selection.controllers) controller.abort(); }
    try { if (!this.verifier.assertCurrent) throw new Error('provider-live-fence-required'); this.verifier.assertCurrent(owner.principal); }
    catch { owner.revoked = true; for (const controller of owner.controllers) controller.abort(); }
  }
  assertCurrentSelection(grant: ProviderGrant, handle: RemoteLibraryHandle): void {
    this.assertCurrentGrant(grant); const selected = this.handles.get(handle);
    if (!selected || selected.grant !== grant || selected.revoked) throw new Error('provider-selection-invalid');
  }
  inspectSelection(grant: ProviderGrant, handle: RemoteLibraryHandle): VerifiedDescriptor {
    this.assertCurrentSelection(grant, handle);
    return structuredClone(this.handles.get(handle)!.descriptor);
  }
  private validateDescriptor(descriptor: VerifiedDescriptor): void {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!descriptor.id || !descriptor.version || !/^[0-9a-f]{64}$/.test(descriptor.sha256) || descriptor.owner !== true || descriptor.writable !== true
      || !uuid.test(descriptor.scope.accountId) || !uuid.test(descriptor.scope.libraryId) || !descriptor.scope.epoch || descriptor.scope.epoch.length > 200) throw new Error('provider-descriptor-invalid');
  }
  async resolve(grant: ProviderGrant, handle: RemoteLibraryHandle, expected: EditScope, signal: AbortSignal): Promise<VerifiedDescriptor> {
    const owner = await this.check(grant, signal); const op = this.capture(owner.lease, signal); const record = this.handles.get(handle);
    if (!record || record.revoked || record.grant !== grant || record.descriptor.scope.accountId !== expected.accountId
      || record.descriptor.scope.libraryId !== expected.libraryId || record.descriptor.scope.epoch !== expected.epoch) throw new Error('provider-handle-invalid');
    try {
      const fresh = await this.verifier.descriptor(owner.principal, record.descriptor.id, signal);
      this.authority.captureRecord(op); await this.check(grant, signal); this.authority.captureRecord(op);
      this.validateDescriptor(fresh);
      if (fresh.id !== record.descriptor.id || fresh.version !== record.descriptor.version || fresh.sha256 !== record.descriptor.sha256
        || fresh.scope.accountId !== expected.accountId || fresh.scope.libraryId !== expected.libraryId || fresh.scope.epoch !== expected.epoch) throw new Error('provider-descriptor-stale');
      return structuredClone(fresh);
    } catch (error) { if (!signal.aborted) this.failSelection(owner, record); throw error; }
  }
  /** Host-only preparation seam. Validates actual canonical bytes and holds the original local operation across awaits. */
  async captureProviderOperation(grant: ProviderGrant, handle: RemoteLibraryHandle, signal: AbortSignal): Promise<ProviderHostOperation> {
    const owner = await this.check(grant, signal), selected = this.handles.get(handle);
    if (!selected || selected.revoked || selected.grant !== grant || (!this.verifier.captureDescriptor && !this.verifier.descriptorBytes) || !this.verifier.assertCurrent || !this.verifier.subscribeInvalidation) throw new Error('provider-byte-verifier-required');
    const controller = new AbortController(), cancel = () => controller.abort(); owner.controllers.add(controller); selected.controllers.add(controller);
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
    let unsubscribe = () => {};
    const retire = () => { unsubscribe(); signal.removeEventListener('abort', cancel); owner.controllers.delete(controller); selected.controllers.delete(controller); controller.abort(); };
    try {
      unsubscribe = this.verifier.subscribeInvalidation(() => { owner.revoked = true; for (const active of owner.controllers) active.abort(); });
      const host = this.capture(owner.lease, controller.signal);
      let fresh: VerifiedDescriptor, bytes: Uint8Array;
      if (this.verifier.captureDescriptor) {
        const result = await this.verifier.captureDescriptor(owner.principal, selected.descriptor.id, controller.signal);
        this.authority.captureRecord(host);
        if (owner.revoked || selected.revoked) throw new Error('provider-grant-invalid');
        this.verifier.assertCurrent(owner.principal);
        fresh = result.descriptor;
        this.validateDescriptor(fresh);
        if (fresh.id !== selected.descriptor.id || fresh.version !== selected.descriptor.version || fresh.sha256 !== selected.descriptor.sha256
          || canonicalJson(fresh.scope) !== canonicalJson(selected.descriptor.scope)) throw new Error('provider-descriptor-stale');
        bytes = Uint8Array.from(result.bytes);
      } else {
        fresh = await this.resolve(grant, handle, selected.descriptor.scope, controller.signal);
        bytes = Uint8Array.from(await this.verifier.descriptorBytes!(owner.principal, fresh.id, controller.signal));
        this.authority.captureRecord(host);
      }
      const validated = await readProviderDescriptorBytes(bytes, fresh.sha256, fresh.scope);
      if (this.verifier.captureDescriptor) {
        this.authority.captureRecord(host);
        this.verifier.assertCurrent(owner.principal);
      } else {
        await this.resolve(grant, handle, fresh.scope, controller.signal); this.authority.captureRecord(host);
      }
      if (owner.revoked || selected.revoked) throw new Error('provider-grant-invalid');
      const operation = Object.freeze({}) as ProviderHostOperation;
      this.operations.set(operation, { host, grant, descriptor: structuredClone(fresh), canonical: validated.descriptor, selection: selected,
        principal: { ...owner.principal }, bytes, retire }); return operation;
    } catch (error) { if (!signal.aborted) this.failSelection(owner, selected); retire(); throw error; }
  }
  /** Principal + local namespace owner capture for CREATE before a remote descriptor exists. */
  async captureProviderOwnerOperation(grant: ProviderGrant, signal: AbortSignal): Promise<ProviderHostOperation> {
    const owner = await this.check(grant, signal);
    if (!this.verifier.assertCurrent || !this.verifier.subscribeInvalidation) throw new Error('provider-live-fence-required');
    const controller = new AbortController(), cancel = () => controller.abort(); owner.controllers.add(controller);
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
    let unsubscribe = () => {};
    const retire = () => { unsubscribe(); signal.removeEventListener('abort', cancel); owner.controllers.delete(controller); controller.abort(); };
    try {
      unsubscribe = this.verifier.subscribeInvalidation(() => { owner.revoked = true; for (const active of owner.controllers) active.abort(); });
      const host = this.capture(owner.lease, controller.signal);
      this.verifier.assertCurrent(owner.principal); this.authority.captureRecord(host);
      const operation = Object.freeze({}) as ProviderHostOperation;
      this.ownerOperations.set(operation, { host, grant, principal: { ...owner.principal }, retire });
      return operation;
    } catch (error) { owner.revoked = true; retire(); throw error; }
  }
  /** Synchronous authentic owner observation for fencing a UI request BEFORE its first await. */
  currentOwner(grant: ProviderGrant, signal: AbortSignal): { ownerNamespace: string; principalDigest: string } {
    this.assertCurrentGrant(grant); const record = this.grants.get(grant)!;
    const host = this.authority.captureRecord(this.capture(record.lease, signal));
    return { ownerNamespace: host.grant.namespaceId, principalDigest: record.principal.digest };
  }
  assertCurrentGrant(grant: ProviderGrant): void {
    const owner = this.grants.get(grant);
    if (!owner || owner.revoked || !this.verifier.assertCurrent) throw new Error('provider-grant-invalid');
    try { this.verifier.assertCurrent(owner.principal); }
    catch (error) { owner.revoked = true; for (const controller of owner.controllers) controller.abort(); throw error; }
  }
  inspectProviderOwnerOperation(operation: ProviderHostOperation): CapturedOwner {
    const captured = this.ownerOperations.get(operation) ?? this.operations.get(operation), owner = captured && this.grants.get(captured.grant);
    if (!captured || !owner || owner.revoked || owner.principal.digest !== captured.principal.digest
      || owner.principal.generation !== captured.principal.generation) throw new Error('provider-operation-invalid');
    this.assertCurrentGrant(captured.grant); this.authority.captureRecord(captured.host);
    return { host: captured.host, grant: captured.grant, principal: { ...captured.principal }, retire: captured.retire };
  }
  releaseProviderOperation(operation: ProviderHostOperation): void {
    const record = this.operations.get(operation) ?? this.ownerOperations.get(operation);
    this.operations.delete(operation); this.ownerOperations.delete(operation); record?.retire();
  }

  /** Synchronous in-transaction checks. Remote evidence was fetched before IDB, never inside an auto-closing transaction. */
  inspectProviderOperation(operation: ProviderHostOperation): CapturedProvider {
    const captured = this.operations.get(operation), owner = captured && this.grants.get(captured.grant);
    if (!captured || !owner || owner.revoked || captured.selection.revoked || owner.principal.digest !== captured.principal.digest
      || owner.principal.generation !== captured.principal.generation) throw new Error('provider-operation-invalid');
    if (!this.verifier.assertCurrent) throw new Error('provider-live-fence-required');
    try { this.verifier.assertCurrent(captured.principal); }
    catch (error) { owner.revoked = true; for (const controller of owner.controllers) controller.abort(); throw error; }
    // An individual operation can be cancelled without retiring its provider grant.
    // A stale or cancelled host operation still fails its own authority fence.
    this.authority.captureRecord(captured.host);
    return { ...captured, descriptor: structuredClone(captured.descriptor), canonical: structuredClone(captured.canonical),
      principal: { ...captured.principal }, bytes: Uint8Array.from(captured.bytes) };
  }

}

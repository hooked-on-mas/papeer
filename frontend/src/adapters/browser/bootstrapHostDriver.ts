import { createProviderCompositeDriver } from './provider/providerCompositeDriver.ts';
import type { ProviderGrant, RemoteLibraryHandle, ProviderInstalledLibrary } from '../../features/bootstrap/bootstrapPorts.ts';
import { ProviderGrantIssuer, type ProviderVerifier } from './ownership/providerGrantIssuer.ts';
import { ProviderJoinPreparation } from './ownership/providerJoinPreparation.ts';
import type { ActiveLibraryProof, BootstrapDiscovery, BootstrapHostDriver, HostLease, LibraryHandle, OwnerInitializationFacade, ScopeResources } from '../../features/bootstrap/bootstrapPorts.ts';
import type { MarkdownDraftPort } from '../../features/notes/markdown/MarkdownDraftPort.ts';
import type { NoteAppendDraftPort } from '../../features/notes/append/NoteAppendDraftPort.ts';
import type { ReaderStatePort, SavedReaderPreference } from '../../features/reader/ReaderSession.ts';
import type { EditScope, ResourceInspectionPort } from '../../runtime/edits/ports.ts';
import { BrowserAnnotationAppendDraftPort } from './annotationAppendDrafts.ts';
import { createOwnerInitialization } from './ownership/browserOwnerInitialization.ts';
import { createBrowserScopePorts } from './browserScopePorts.ts';
import { canonicalHostTransaction } from './canonicalHostTransaction.ts';
import { BrowserMarkdownDraftPort } from './canonicalMarkdownDrafts.ts';
import { CANONICAL_DATABASE_NAME } from './canonicalIndexedDbSchema.ts';
import { LEGACY_BACKUP_DATABASE_NAME, readLegacyHoldReadonly } from './legacyHoldReadonly.ts';
import { readLegacyWebPresenceReadonly } from './legacyPresenceReadonly.ts';
import { LocalHostAuthority } from './localHostAuthority.ts';
import { listOwnerLibraries } from './ownership/namespaceOwnerLibraries.ts';
import { BrowserReaderStatePort } from './readerState.ts';
import { browserOutputFile } from './outputFile.ts';
import { createBrowserInkPreferences } from './inkPreferences.ts';

export type BrowserScopeDraftPorts = { drafts: MarkdownDraftPort; appends: NoteAppendDraftPort; reader: ReaderStatePort<SavedReaderPreference> };
/** Only storage locations and test seams are configurable. Grants, leases and proofs are never inputs. */
export type BrowserBootstrapHostDriverOptions = {
  factory?: IDBFactory; databaseName?: string; legacyBackupDatabaseName?: string;
  /** Per-scope device-local draft and preference ports. They are always wrapped by the scope's I/O gate. */
  draftPorts?: (scope: EditScope) => BrowserScopeDraftPorts;
  inspection?: ResourceInspectionPort;
};
export type BrowserBootstrapHostDriverParts = {
  providerVerifier?: ProviderVerifier;
  readHold(signal: AbortSignal): Promise<'clear' | 'held'>;
  draftPorts(scope: EditScope): BrowserScopeDraftPorts;
  inspection?: ResourceInspectionPort;
};

const defaultDraftPorts = (scope: EditScope): BrowserScopeDraftPorts =>
  ({ drafts: new BrowserMarkdownDraftPort(scope), appends: new BrowserAnnotationAppendDraftPort(scope), reader: new BrowserReaderStatePort(scope) });

/** Production factory: same-origin canonical IndexedDB, real local grant, readonly hold check. */
export type BrowserBootstrapHostDriver = BootstrapHostDriver & {
 /** Host-only composition seam, absent verifier means unconfigured. No renderer admission is accepted. */
 admitProvider(issuer: ProviderGrantIssuer, grant: ProviderGrant, handle: RemoteLibraryHandle, requestId: string | undefined, signal: AbortSignal): Promise<ProviderInstalledLibrary | null>;
 prepareProviderOwner(lease: HostLease, signal: AbortSignal): Promise<{ issuer: ProviderGrantIssuer; preparation: ProviderJoinPreparation; lease: HostLease }>;
 /** Host-only offline passphrase path. No secret is retained in the handle. */
 admitOffline(lease: HostLease, vaultToken: object, grantId: string, signal: AbortSignal): Promise<ProviderInstalledLibrary>;
 drainOfflineScopes(): Promise<void>;
 reserveOfflineRetirement(): () => void;
};
export function createBrowserBootstrapHostDriver(options: BrowserBootstrapHostDriverOptions = {}): BootstrapHostDriver {
  const factory = options.factory ?? globalThis.indexedDB, backup = options.legacyBackupDatabaseName ?? LEGACY_BACKUP_DATABASE_NAME;
  const authority = new LocalHostAuthority(factory, options.databaseName ?? CANONICAL_DATABASE_NAME);
  const local = assembleBrowserBootstrapHostDriver(authority, {
    readHold: async signal => {
      if (await readLegacyHoldReadonly(signal, factory, backup) === 'held') return 'held';
      if (await readLegacyWebPresenceReadonly(signal, factory) !== 'clear') throw new Error('legacy-data-present');
      return 'clear';
    },
    draftPorts: options.draftPorts ?? defaultDraftPorts,
    ...(options.inspection ? { inspection: options.inspection } : {}),
  });
  return createProviderCompositeDriver(local, options.inspection);
}

/**
 * Composition seam for unit tests that substitute the authority object. It still never accepts a grant, lease or proof:
 * all of those are issued by the authority passed here, and the driver trusts only objects it was handed back.
 */
export function assembleBrowserBootstrapHostDriver(authority: LocalHostAuthority, parts: BrowserBootstrapHostDriverParts): BrowserBootstrapHostDriver {
  const proofLeases = new WeakMap<ActiveLibraryProof, HostLease>(), handles = new WeakMap<LibraryHandle, { libraryId: string; inspect?: (signal: AbortSignal) => Promise<{lease: HostLease; proof: ActiveLibraryProof} | null> }>();
  const open = new Set<{ close(): Promise<void> }>();
  const offlineOpen = new Map<{ close(): Promise<void> }, ActiveLibraryProof>();
  let offlineRetiring = false, offlineOpening = 0, offlineAdmitting = 0;
  let closed = false, closeFlight: Promise<void> | null = null;
  const assertOpen = () => { if (closed) throw new Error('host-closed'); };
  // Invalidate synchronously: the authority aborts transactions and revokes every gate before the page is hidden.
  const pageHide = () => authority.invalidate();
  globalThis.addEventListener?.('pagehide', pageHide);
  const leaseOfProof = (proof: ActiveLibraryProof): HostLease => {
    const lease = proofLeases.get(proof); if (!lease) throw new Error('invalid-admission'); return lease;
  };
  const verify = async (proof: ActiveLibraryProof, signal: AbortSignal): Promise<void> => {
    assertOpen(); const lease = leaseOfProof(proof);
    if (await parts.readHold(signal) !== 'clear') throw new Error('hold-active');
    const operation = authority.capture(lease, proof, signal);
    await canonicalHostTransaction<void>(authority, operation, [], 'readonly', (_tx, _tuple, finish) => finish());
  };

  return {
    reserveOfflineRetirement() {
      assertOpen(); if (offlineRetiring || offlineOpen.size || offlineOpening || offlineAdmitting) throw new Error('offline-runtime-active');
      offlineRetiring = true; let released = false;
      return () => { if (!released) { released = true; offlineRetiring = false; } };
    },
    async drainOfflineScopes() {
      const results = await Promise.allSettled([...offlineOpen.keys()].map(resource => resource.close()));
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    },
    async admitOffline(lease, vaultToken, grantId, signal) {
      if (offlineRetiring) throw new Error('offline-runtime-active'); offlineAdmitting++;
      try {
      assertOpen(); if (open.size && (open.size !== 1 || offlineOpen.size !== 1)) throw new Error('provider-scope-active');
      if (await parts.readHold(signal) !== 'clear') throw new Error('hold-active');
      const proof = await authority.unlockOffline(lease, vaultToken, grantId, signal);
      assertOpen(); if (open.size && (open.size !== 1 || offlineOpen.size !== 1
        || !authority.sameAdmission([...offlineOpen.values()][0], proof))) throw new Error('provider-scope-active');
      const requestId = authority.providerRequestId(proof); if (!requestId) throw new Error('offline-unlock-failed');
      proofLeases.set(proof, lease);
      const handle = Object.freeze({}) as LibraryHandle;
      handles.set(handle, { libraryId: proof.scope.libraryId, inspect: async nextSignal => {
        await verify(proof, nextSignal); return { lease, proof };
      } });
      return { lease, handle, requestId };
      } finally { offlineAdmitting--; }
    },
    async prepareProviderOwner(lease, signal) {
      assertOpen(); if (!parts.providerVerifier) throw new Error('provider-unconfigured');
      if (open.size) throw new Error('provider-scope-active');
      const ownerOperation = authority.captureNamespaceOwner(lease, signal);
      await canonicalHostTransaction<void>(authority, ownerOperation, ['canonicalInitialIntents'], 'readonly', (tx, _tuple, finish) => {
        const pending = tx.objectStore('canonicalInitialIntents').getAll();
        pending.onsuccess = () => {
          if (pending.result.some(row => row.value?.result === null)) { tx.abort(); return; }
          finish();
        };
      });
      assertOpen(); if (open.size) throw new Error('provider-scope-active');
      const upgraded = await authority.upgradeProviderStorage(lease, signal); assertOpen();
      const issuer = new ProviderGrantIssuer(authority, parts.providerVerifier);
      return { issuer, preparation: new ProviderJoinPreparation(authority, issuer), lease: upgraded };
    },
    async admitProvider(issuer, grant, selected, requestId, signal) {
      assertOpen();
      const admitted = await authority.inspectProvider(issuer, grant, selected, requestId, signal);
      if (!admitted) return null;
      const handle = Object.freeze({}) as LibraryHandle;
      handles.set(handle, { libraryId: admitted.proof.scope.libraryId,
        inspect: nextSignal => authority.inspectProvider(issuer, grant, selected, admitted.requestId, nextSignal) });
      proofLeases.set(admitted.proof, admitted.lease);
      return { lease: admitted.lease, handle, requestId: admitted.requestId };
    },
    storageKind: proof => authority.storageKind(proof),
    providerOffline: proof => authority.isOffline(proof),
    readHold: signal => parts.readHold(signal),
    async readLocalContext(signal) {
      assertOpen(); const result = await authority.discover(signal);
      if (result.status === 'ready') return { status: 'ready', lease: result.lease };
      if (result.status === 'setup-required') return result;
      return { status: 'recovery-required', reason: result.reason };
    },
    async provisionLocalContext(signal) { assertOpen(); return authority.provision(signal); },
    async discover(lease, signal) {
      assertOpen(); const listing = await listOwnerLibraries(authority, authority.captureNamespaceOwner(lease, signal));
      const libraries: BootstrapDiscovery['libraries'][number][] = listing.libraries.map(item => {
        const handle = Object.freeze({}) as LibraryHandle; handles.set(handle, { libraryId: item.libraryId });
        return { handle, title: item.title, status: item.status, ...(item.reason ? { reason: item.reason } : {}) };
      });
      return { libraries, creations: listing.creations, canCreateLibrary: true };
    },
    initialization(lease): OwnerInitializationFacade {
      assertOpen(); authority.captureNamespaceOwner(lease, new AbortController().signal); // forged/stale leases fail here, not at first use
      const owner = createOwnerInitialization(authority, lease);
      return Object.freeze({ getOrCreatePeer: owner.getOrCreatePeer, prepare: owner.prepare, query: owner.query, execute: owner.execute, acknowledge: owner.acknowledge });
    },
    async inspect(lease, handle, signal) {
      assertOpen(); const saved = handles.get(handle); if (!saved) throw new Error('invalid-handle');
      if (saved.inspect) {
        const admitted = await saved.inspect(signal); if (!admitted || admitted.lease !== lease) throw new Error('provider-admission-changed');
        proofLeases.set(admitted.proof, admitted.lease); return admitted.proof;
      }
      const proof = await authority.inspect(lease, saved.libraryId, signal); proofLeases.set(proof, lease); return proof;
    },
    async openScope(proof, signal) {
      assertOpen(); const lease = leaseOfProof(proof), openingOffline = authority.isOffline(proof);
      if (openingOffline && offlineRetiring) throw new Error('offline-runtime-active');
      if (openingOffline) offlineOpening++;
      try {
      await verify(proof, signal);
      const scope = Object.freeze({ ...proof.scope }), ports = parts.draftPorts(scope);
      const built = createBrowserScopePorts(authority, lease, proof, ports.drafts, ports.appends, ports.reader, parts.inspection, createBrowserInkPreferences(proof.scope));
      // The acquisition signal ends here; the gate's lifetime is the host generation and the explicit close.
      let flight: Promise<void> | null = null;
      const resources: ScopeResources = {
        repository: built.repository, markdownDrafts: built.markdown, markdownImages: built.images, appendDrafts: built.annotation, readerState: built.preferences, outputFile: browserOutputFile,
        inkPreferences: built.inkPreferences, workspacePreferences: built.workspacePreferences, selectionPreferences: built.selectionPreferences, queryPreferences: built.queryPreferences,
        peerId: authority.admittedPeerId(proof),
        async reauthorize(next, reauthorizeSignal) {
          if (closed || flight) throw new Error('host-closed'); const nextLease = leaseOfProof(next);
          const nextOffline = authority.isOffline(next); if (nextOffline && offlineRetiring) throw new Error('offline-runtime-active');
          if (nextOffline) offlineOpening++;
          try { await built.gate.reauthorize(nextLease, next, reauthorizeSignal);
            if (nextOffline) offlineOpen.set(resources, next); else offlineOpen.delete(resources);
          } finally { if (nextOffline) offlineOpening--; }
        },
        close: () => flight ??= (async () => { open.delete(resources); offlineOpen.delete(resources); await built.gate.close(); })(),
      };
      open.add(resources);
      if (authority.isOffline(proof)) offlineOpen.set(resources, proof);
      if (signal.aborted || closed) { await resources.close(); throw new DOMException('Cancelled', 'AbortError'); }
      return resources;
      } finally { if (openingOffline) offlineOpening--; }
    },
    revalidate: verify,
    sameAdmission: (previous, next) => proofLeases.has(previous) && proofLeases.has(next) && authority.sameAdmission(previous, next),
    subscribeInvalidation: listener => authority.subscribe(listener),
    close() {
      if (closeFlight) return closeFlight; closed = true; globalThis.removeEventListener?.('pagehide', pageHide);
      return closeFlight = (async () => { authority.close(); await Promise.allSettled([...open].map(resource => resource.close())); })();
    },
  };
}

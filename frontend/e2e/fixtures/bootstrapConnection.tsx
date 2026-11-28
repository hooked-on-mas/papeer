// Test-only fake host boundary. This is neither a production driver nor an authorization test.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BootstrapConnection } from '../../src/features/bootstrap/BootstrapConnection';
import { BootstrapSession } from '../../src/features/bootstrap/BootstrapSession';
import type { ActiveLibraryProof, BootstrapHostDriver, HostLease, LibraryHandle, ScopeResources } from '../../src/features/bootstrap/bootstrapPorts';
import type { CanonicalInitializeRequest } from '../../src/runtime/edits/contracts';
import { DurableEditRepository } from '../../src/runtime/edits/repository';
import { EditMemoryDatabase } from '../../tests/support/editMemoryDatabase';

const lease = {} as HostLease, handle = {} as LibraryHandle;
const peer = { version: 1 as const, accountId: 'fixture', peerId: '00000000-0000-4000-8000-000000000001' };
let request: CanonicalInitializeRequest | null = null, provisioned = false, acknowledged = false, invalidation = () => {};
let repository: DurableEditRepository | null = null;
let blockDiscovery: Promise<void> | null = null, releaseDiscovery = () => {}, discoveryEntered = false, contextReads = 0, inspections = 0;
const api = {
  getOrCreatePeer: async () => peer,
  prepare: async (value: CanonicalInitializeRequest) => { request = structuredClone(value); return { status: 'pending' as const }; },
  query: async () => request ? outcome() : { status: 'not-found' as const },
  execute: async () => {
    if (!request) throw new Error('missing');
    const scope = request.control.transition.publication.manifest.scope;
    repository ??= new DurableEditRepository(scope, new EditMemoryDatabase());
    await repository.initialize(request.control.transition.publication.checkpoint.roots[0]);
    return outcome();
  },
  acknowledge: async () => { acknowledged = true; },
};
function outcome() {
  if (!request) throw new Error('missing');
  if (!repository) return { status: 'pending' as const };
  return { status: 'accepted' as const, receipt: { requestId: request.control.id, identity: request.profile.identity,
    initialScope: request.control.transition.publication.manifest.scope, manifestId: request.control.transition.publication.manifest.id, peerId: peer.peerId } };
}
const driver: BootstrapHostDriver = {
  readHold: async () => 'clear', readLocalContext: async () => { contextReads++; return provisioned ? { status: 'ready', lease } : { status: 'setup-required', reason: 'absent' }; },
  provisionLocalContext: async () => { provisioned = true; return lease; },
  discover: async () => { if (blockDiscovery) { discoveryEntered = true; await blockDiscovery; }
    return { libraries: repository && request ? [{ handle, title: request.profile.title, status: 'available' }] : [],
      creations: request && !acknowledged ? [{ requestId: request.control.id, title: request.profile.title, outcome: outcome() }] : [], canCreateLibrary: true }; },
  initialization: () => api,
  inspect: async () => { inspections++; if (!repository) throw new Error('missing'); return { scope: repository.scope } as ActiveLibraryProof; },
  openScope: async proof => {
    if (!repository) throw new Error('missing');
    const scope = proof.scope;
    return { repository, peerId: peer.peerId, readerState: { scope, read: () => undefined, write: () => {} },
      markdownDrafts: { scope, targets: () => [], read: () => undefined, write: () => {}, remove: () => {} },
      markdownImages: { scope }, appendDrafts: { scope, read: () => undefined }, reauthorize: async () => {}, close: async () => {} } as unknown as ScopeResources;
  },
  revalidate: async () => {}, sameAdmission: (a, b) => JSON.stringify(a.scope) === JSON.stringify(b.scope),
  subscribeInvalidation: listener => { invalidation = listener; return () => { invalidation = () => {}; }; }, close: async () => {},
};
const session = new BootstrapSession(driver);
Object.assign(window, { bootstrapFixtureLose: () => invalidation(), bootstrapFixtureSession: session,
  bootstrapFixtureBlock: () => { discoveryEntered = false; blockDiscovery = new Promise<void>(resolve => { releaseDiscovery = resolve; }); void session.refresh(); },
  bootstrapFixtureRelease: () => { const release = releaseDiscovery; blockDiscovery = null; release(); },
  bootstrapFixtureEvidence: () => ({ discoveryEntered, contextReads, inspections }) });
createRoot(document.getElementById('root')!).render(<StrictMode><BootstrapConnection session={session}
  renderDocument={() => <p>テスト資料</p>} renderMarkdown={() => <p>テスト Markdown</p>} /></StrictMode>);

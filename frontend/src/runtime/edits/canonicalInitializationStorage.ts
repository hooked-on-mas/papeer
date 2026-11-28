import type { CanonicalDevicePeer, CanonicalLibraryProfile, CanonicalInitializeRequest, CanonicalInitializationReceipt, CanonicalLibraryInitializationIntent } from './contracts.ts';

/** Host-created principal proof. Implementations must reject account/generation changes and bind commit to guard. */
export interface CanonicalPrincipalLease { readonly accountId: string; readonly generation: string; assertCurrent(): void; withCommitGuard<T>(commit: () => Promise<T>): Promise<T> }
export type InitializationOutcome = { status: 'pending' } | { status: 'accepted'; receipt: CanonicalInitializationReceipt } | { status: 'rejected'; reason: string } | { status: 'not-found' };
export interface CanonicalInitializationStorage {
  list(lease: CanonicalPrincipalLease, signal: AbortSignal): Promise<{ profiles: CanonicalLibraryProfile[]; intents: CanonicalLibraryInitializationIntent[] }>;
  getOrCreatePeer(lease: CanonicalPrincipalLease, candidatePeerId: string, signal: AbortSignal): Promise<CanonicalDevicePeer>;
  prepare(lease: CanonicalPrincipalLease, request: CanonicalInitializeRequest, signal: AbortSignal): Promise<InitializationOutcome>;
  query(lease: CanonicalPrincipalLease, requestId: string, signal: AbortSignal): Promise<InitializationOutcome>;
  execute(lease: CanonicalPrincipalLease, requestId: string, signal: AbortSignal): Promise<InitializationOutcome>;
  acknowledge(lease: CanonicalPrincipalLease, requestId: string, signal: AbortSignal): Promise<void>;
}

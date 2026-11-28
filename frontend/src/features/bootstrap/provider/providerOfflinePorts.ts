import type { OfflineLibraryHandle } from '../bootstrapPorts.ts';

/** Display state only: choices are empty until the host has unlocked the vault. */
export type ProviderOfflineState = Readonly<{
  phase: 'locked' | 'unlocked' | 'unavailable';
  busy: boolean; pendingGuard: boolean; offlineActive: boolean;
  canEnroll: boolean; canUnlock: boolean; canOpen: boolean; canLock: boolean; canRevoke: boolean;
  canRevokeEnrollment: boolean;
  revocation: 'none' | 'revoked' | 'unknown';
  choices: readonly Readonly<{ handle: OfflineLibraryHandle; title: string }>[];
  outcome: 'none' | 'accepted' | 'unknown' | 'rejected';
  error: boolean;
}>;
/** The controller owns request IDs, host-issued handles, cancellation and dirty-scope guards. */
export interface ProviderOfflineController {
  getSnapshot(): ProviderOfflineState;
  subscribe(listener: () => void): () => void;
  enroll(secret: string): Promise<void>;
  revokeEnrollment(secret: string): Promise<void>;
  unlock(secret: string): Promise<void>;
  open(handle: OfflineLibraryHandle): Promise<void>;
  revoke(handle: OfflineLibraryHandle): Promise<void>;
  lock(): Promise<void>;
}

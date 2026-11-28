import type { ActiveLibraryProof, OfflineLibraryHandle, OfflineUnlockSession, ProviderInstalledLibrary, ProviderOfflineFacade } from '../bootstrapPorts.ts';
import type { ScopeLeaveResult } from '../../reader/DocumentEditSessions.ts';
import type { ProviderOfflineController, ProviderOfflineState } from './providerOfflinePorts.ts';

/** Coordination only. All identity, vault verification and scope admissions belong to the host. */
export interface ProviderOfflineBridge {
  getFacade(): ProviderOfflineFacade | null;
  retained(): Readonly<{ proof: ActiveLibraryProof; provider: boolean; offline: boolean; locked: boolean }> | null;
  subscribe(listener: () => void): () => void;
  available(): boolean;
  openInstalled(target: ProviderInstalledLibrary, signal: AbortSignal): Promise<boolean>;
  /** Run current-view, dirty and unknown guards, then leave the runtime before voluntary lock/revoke. */
  prepareLeave(): Promise<ScopeLeaveResult>;
}

type Frame = { signal: AbortSignal; alive(): boolean };
type Outcome = ProviderOfflineState['outcome'];
const scopeKey = (proof: ActiveLibraryProof) => JSON.stringify([proof.scope.accountId, proof.scope.libraryId, proof.scope.epoch]);

export class ProviderOfflineSession implements ProviderOfflineController {
  private readonly bridge: ProviderOfflineBridge;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private controller = new AbortController();
  private generation = 0;
  private flight: Promise<void> | null = null;
  private reserved = false;
  private closed = false;
  private session: OfflineUnlockSession | null = null;
  private choices: ProviderOfflineState['choices'] = Object.freeze([]);
  private fixed: { requestId: string; scope: string } | null = null;
  private acceptedScope: string | null = null;
  private outcomeScope: string | null = null;
  private pendingRevokeScope: string | null = null;
  private revokeFlightScope: string | null = null;
  private revocation: 'none' | 'revoked' | 'unknown' = 'none';
  private revocationScope: string | null = null;
  private outcome: Outcome = 'none';
  private error = false;
  private state!: ProviderOfflineState;

  constructor(bridge: ProviderOfflineBridge) {
    this.bridge = bridge;
    this.publish();
    this.unsubscribe = bridge.subscribe(() => this.publish());
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private publish(): void {
    const runtime = this.bridge.retained(), facade = this.bridge.getFacade();
    if (!this.fixed && this.outcomeScope && (!runtime || scopeKey(runtime.proof) !== this.outcomeScope)) {
      this.outcome = 'none'; this.outcomeScope = null; this.acceptedScope = null;
    }
    if (!this.pendingRevokeScope && !this.revokeFlightScope && this.revocationScope && (!runtime || scopeKey(runtime.proof) !== this.revocationScope)) {
      this.revocation = 'none'; this.revocationScope = null;
    }
    const busy = this.reserved || this.flight !== null;
    const enrollmentPending = !!this.fixed && this.outcome === 'unknown';
    const pendingGuard = enrollmentPending || this.pendingRevokeScope !== null;
    const available = !this.closed && !busy && this.bridge.available() && !!facade;
    const canEnroll = available && !!runtime?.provider && !runtime.offline && !runtime.locked
      && this.pendingRevokeScope === null
      && (!this.fixed || this.fixed.scope === scopeKey(runtime.proof))
      && this.acceptedScope !== scopeKey(runtime.proof);
    const next: ProviderOfflineState = Object.freeze({
      phase: !facade || this.closed ? 'unavailable' : this.session ? 'unlocked' : 'locked', busy, pendingGuard,
      offlineActive: !!runtime?.offline,
      canEnroll,
      canRevokeEnrollment: available && !!runtime?.provider && !runtime.offline && !runtime.locked && !enrollmentPending
        && (this.pendingRevokeScope === null || this.pendingRevokeScope === scopeKey(runtime.proof)),
      revocation: this.revocation,
      canUnlock: available && !pendingGuard && !this.session && (!runtime || runtime.offline && runtime.locked),
      canOpen: available && !pendingGuard && !!this.session && (!runtime || runtime.offline && runtime.locked),
      canLock: available && !pendingGuard && !!this.session,
      canRevoke: available && !pendingGuard && !!this.session,
      choices: this.choices, outcome: this.outcome, error: this.error,
    });
    if (this.state && (Object.keys(next) as (keyof ProviderOfflineState)[]).every(key => next[key] === this.state[key])) return;
    this.state = next;
    this.listeners.forEach(listener => listener());
  }
  private operate(action: (facade: ProviderOfflineFacade, frame: Frame) => Promise<void>): Promise<void> {
    if (this.closed || this.flight || this.reserved || !this.bridge.available()) return Promise.resolve();
    const facade = this.bridge.getFacade(); if (!facade) return Promise.resolve();
    const generation = this.generation, signal = this.controller.signal;
    const frame = { signal, alive: () => !this.closed && generation === this.generation && !signal.aborted };
    this.reserved = true; this.error = false; this.publish();
    let started: Promise<void>;
    try { started = action(facade, frame); } catch (error) { started = Promise.reject(error); }
    const flight = started.catch(() => { if (frame.alive()) this.error = true; })
      .finally(() => { if (this.flight === flight) { this.flight = null; this.reserved = false; this.publish(); } });
    this.flight = flight; this.publish(); return flight;
  }

  enroll = (secret: string): Promise<void> => {
    if (!this.getSnapshot().canEnroll) return Promise.resolve();
    const runtime = this.bridge.retained(); if (!runtime?.provider || runtime.offline || runtime.locked) return Promise.resolve();
    const scope = scopeKey(runtime.proof);
    return this.operate(async (facade, frame) => {
      this.revocation = 'none'; this.revocationScope = null; this.outcomeScope = scope;
      if (!this.fixed) {
        // The host verifies the fresh online admission and passphrase before returning any durable request ID.
        const recovered = await facade.recoverEnrollment(runtime.proof, secret, frame.signal);
        if (!frame.alive()) return;
        if (recovered?.status === 'accepted') {
          this.acceptedScope = scope; this.outcome = 'accepted'; return;
        }
        this.fixed = { requestId: recovered?.requestId ?? crypto.randomUUID(), scope };
      }
      if (this.fixed.scope !== scope) return;
      const fixed = this.fixed;
      // Until the host confirms a terminal result, cancellation or loss must retain this exact request ID.
      this.outcome = 'unknown'; this.publish();
      const result = await facade.enroll(runtime.proof, secret, fixed.requestId, frame.signal);
      if (!frame.alive()) return;
      if (result.requestId !== fixed.requestId) throw new Error('offline-request-mismatch');
      const status = result.status === 'accepted' || result.status === 'rejected' ? result.status : 'unknown';
      this.outcome = status;
      if (status !== 'unknown') {
        this.fixed = null;
        this.acceptedScope = status === 'accepted' ? scope : null;
      }
    });
  };
  /** Revoke this live Library's local permission, including a stale prior epoch, without closing its online editor. */
  revokeEnrollment = (secret: string): Promise<void> => {
    if (!this.getSnapshot().canRevokeEnrollment) return Promise.resolve();
    const runtime = this.bridge.retained(); if (!runtime?.provider || runtime.offline || runtime.locked) return Promise.resolve();
    const scope = scopeKey(runtime.proof);
    return this.operate(async (facade, frame) => {
      this.revokeFlightScope = scope; this.revocationScope = scope;
      try {
        // The facade returns unknown for ambiguous post-dispatch outcomes; throws are definite pre-effect failures.
        const result = await facade.revokeEnrollment(runtime.proof, secret, frame.signal);
        if (!frame.alive()) return;
        const status = result?.status === 'revoked' ? 'revoked' : 'unknown';
        this.pendingRevokeScope = status === 'unknown' ? scope : null;
        this.revocation = status;
        this.acceptedScope = null; this.outcome = 'none'; this.outcomeScope = null;
      } finally { this.revokeFlightScope = null; }
    });
  };
  unlock = (secret: string): Promise<void> => {
    if (!this.getSnapshot().canUnlock) return Promise.resolve();
    return this.operate(async (facade, frame) => {
      const result = await facade.unlock(secret, frame.signal);
      if (!frame.alive()) {
        // No target has been opened by this controller; release a late candidate without publishing its names.
        await facade.lock(result.session); return;
      }
      this.session = result.session;
      this.choices = Object.freeze(result.choices.map(choice => Object.freeze({ handle: choice.handle, title: choice.title })));
      this.outcome = 'none'; this.outcomeScope = null;
    });
  };
  open = (handle: OfflineLibraryHandle): Promise<void> => {
    if (!this.getSnapshot().canOpen || !this.session || !this.choices.some(choice => choice.handle === handle)) return Promise.resolve();
    const session = this.session;
    return this.operate(async (facade, frame) => {
      const target = await facade.open(session, handle, frame.signal); if (!frame.alive()) return;
      if (!await this.bridge.openInstalled(target, frame.signal) && frame.alive()) throw new Error('offline-open-refused');
    });
  };
  lock = (): Promise<void> => {
    if (!this.getSnapshot().canLock || !this.session) return Promise.resolve();
    const session = this.session;
    return this.operate(async (facade, frame) => {
      const leave = await this.bridge.prepareLeave(); if (!frame.alive()) return;
      if (leave.status !== 'allowed') throw new Error('offline-leave-refused');
      try { await facade.lock(session); }
      finally { if (frame.alive()) { this.session = null; this.choices = Object.freeze([]); this.acceptedScope = null; this.outcome = 'none'; } }
    });
  };
  revoke = (handle: OfflineLibraryHandle): Promise<void> => {
    if (!this.getSnapshot().canRevoke || !this.session || !this.choices.some(choice => choice.handle === handle)) return Promise.resolve();
    const session = this.session;
    return this.operate(async (facade, frame) => {
      const leave = await this.bridge.prepareLeave(); if (!frame.alive()) return;
      if (leave.status !== 'allowed') throw new Error('offline-leave-refused');
      try { await facade.revoke(session, handle, frame.signal); }
      finally { if (frame.alive()) { this.session = null; this.choices = Object.freeze([]); this.acceptedScope = null; this.outcome = 'none'; } }
    });
  };
  /** Host has already revoked its real authority. Preserve unresolved enrollment, never retain an unlock session. */
  hostLost = (): void => {
    this.generation++; this.controller.abort(); this.controller = new AbortController();
    if (this.revokeFlightScope) { this.pendingRevokeScope = this.revokeFlightScope; this.revocation = 'unknown'; }
    this.session = null; this.choices = Object.freeze([]); this.acceptedScope = null;
    if (!this.fixed) { this.outcome = 'none'; this.outcomeScope = null; }
    this.publish();
  };
  /** Only after the enclosing bootstrap's pending/dirty guards and host close have completed. */
  dispose = (): void => {
    if (this.closed) return;
    this.closed = true; this.hostLost(); this.unsubscribe(); this.listeners.clear();
  };
}

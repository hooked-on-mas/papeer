import type { ProviderInstalledLibrary, ProviderOwnerFacade, RemoteLibraryHandle } from '../bootstrapPorts.ts';
import type { ScopeLeaveResult } from '../../reader/DocumentEditSessions.ts';

export type ProviderConnectionPhase = 'idle' | 'preloading' | 'connect-ready' | 'connecting' | 'choosing'
  | 'preparing' | 'executing' | 'opening' | 'ready' | 'disconnecting' | 'unavailable' | 'closed';

export type ProviderLibraryChoice = Readonly<{
  handle: RemoteLibraryHandle;
  title: string;
  status: 'available' | 'owner-write-required' | 'unavailable';
}>;

export type ProviderRequestView = Readonly<{
  requestId: string;
  action: 'create' | 'join';
  title: string;
  status: 'preparing' | 'pending' | 'unknown' | 'accepted' | 'rejected';
}>;

export type ProviderConnectionState = Readonly<{
  phase: ProviderConnectionPhase;
  connected: boolean;
  choices: readonly ProviderLibraryChoice[];
  request: ProviderRequestView | null;
  /** User-facing message; credentials, raw provider replies and authorization URLs never enter this state. */
  error: string;
  busy: boolean;
  canConnect: boolean;
  canCreate: boolean;
  canJoin: boolean;
  canRefresh: boolean;
  canRetry: boolean;
  canOpenInstalled: boolean;
  canDisconnect: boolean;
  /** beforeunload/scope close must retain this owner's pending operation instead of dropping it. */
  pendingGuard: boolean;
}>;

/** Session glue supplied by the one normal BootstrapSession. This carries no provider credentials. */
export interface ProviderConnectionBridge {
  /** May prepare a real owner/cache and return a stable facade before the user's connect click. */
  getFacade(): Promise<ProviderOwnerFacade | null>;
  retained(): Readonly<{ kind: 'local' | 'google-drive'; requestId: string | null; locked: boolean }> | null;
  subscribe(listener: () => void): () => void;
  /** Restore the retained same-scope runtime when present; otherwise use normal session openLibrary. */
  openInstalled(target: ProviderInstalledLibrary, signal: AbortSignal, beforeActivate?: () => Promise<void>): Promise<boolean>;
  prepareDisconnect(): Promise<ScopeLeaveResult>;
}

/** Product view/controller contract, not provider authority. All handles are issued by the host. */
export interface ProviderConnectionController {
  getSnapshot(): ProviderConnectionState;
  subscribe(listener: () => void): () => void;
  /** Run when the Google section opens. Cache the facade and preload SDK before enabling connect. */
  prepare(): Promise<void>;
  /** Call directly inside the actual click handler, without an await before it.
   * The implementation starts facade.connect synchronously before cache/lock/network awaits.
   */
  connect(): Promise<void>;
  cancelConnect(): Promise<void>;
  refresh(): Promise<void>;
  /** Preparation automatically advances execute/activation/open; pending/unknown retains the same request ID. */
  create(title: string): Promise<void>;
  join(handle: RemoteLibraryHandle): Promise<void>;
  retry(): Promise<void>;
  openInstalled(): Promise<void>;
  /** Dirty/navigation/journal guards run before the host suspends and drains provider I/O. */
  disconnect(): Promise<ScopeLeaveResult>;
  canLeave(): boolean;
  close(): Promise<ScopeLeaveResult>;
}

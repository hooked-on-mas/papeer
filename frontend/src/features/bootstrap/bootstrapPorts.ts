import type { CanonicalDevicePeer, CanonicalInitializeRequest } from '../../runtime/edits/contracts.ts';
import type { InitializationOutcome } from '../../runtime/edits/canonicalInitializationStorage.ts';
import type { ContentRepository, EditScope } from '../../runtime/edits/ports.ts';
import type { MarkdownDraftPort } from '../notes/markdown/MarkdownDraftPort.ts';
import type { MarkdownImagePort } from '../notes/markdown/MarkdownEditSession.ts';
import type { NoteAppendDraftPort } from '../notes/append/NoteAppendDraftPort.ts';
import type { ReaderStatePort, SavedReaderPreference } from '../reader/ReaderSession.ts';
import type { LibraryScopeBinding } from '../reader/DocumentLibraryBinding.ts';
import type { ContentNavigationSession } from '../reader/navigation/ContentNavigationSession.ts';
import type { OutputFilePort } from '../reader/output/ports.ts';
import type { InkPreferenceStorage } from '../reader/ink/inkPreferencePersistence.ts';
import type { WorkspaceSelectionPort } from '../workspace/WorkspaceSelectionSession.ts';
import type { WorkspacePreferencePort } from '../workspace/WorkspaceSession.ts';
import type { LibraryQueryPreferencePort } from '../library/query/LibraryQuerySession.ts';
import type { ReplicationState } from '../../runtime/edits/replication.ts';

declare const hostLeaseBrand: unique symbol, libraryHandleBrand: unique symbol, activeProofBrand: unique symbol;
declare const providerGrantBrand: unique symbol, remoteLibraryHandleBrand: unique symbol;
declare const offlineSessionBrand: unique symbol, offlineHandleBrand: unique symbol;
export type HostLease = { readonly [hostLeaseBrand]: true };
export type LibraryHandle = { readonly [libraryHandleBrand]: true };
/** Scope is an observation, never a capability. Only the host validates opaque proof. */
export type ActiveLibraryProof = { readonly [activeProofBrand]: true; readonly scope: Readonly<EditScope> };
/** Opaque host-issued handles; a descriptor, digest or persisted binding is never a live grant. */
export type ProviderGrant = { readonly [providerGrantBrand]: true };
export type RemoteLibraryHandle = { readonly [remoteLibraryHandleBrand]: true };
export type OfflineUnlockSession = { readonly [offlineSessionBrand]: true };
export type OfflineLibraryHandle = { readonly [offlineHandleBrand]: true };
/** Host-owned local authorization; no remote credentials or raw scope selectors. */
export interface ProviderOfflineFacade {
 enroll(proof: ActiveLibraryProof, secret: string, requestId: string, signal: AbortSignal): Promise<{ requestId: string; status: 'accepted' | 'unknown' | 'rejected' }>;
 recoverEnrollment(proof: ActiveLibraryProof, secret: string, signal: AbortSignal): Promise<{ requestId: string; status: 'accepted' | 'pending' | 'unknown' } | null>;
 revokeEnrollment(proof: ActiveLibraryProof, secret: string, signal: AbortSignal): Promise<{ status: 'revoked' | 'unknown' }>;
 unlock(secret: string, signal: AbortSignal): Promise<{ session: OfflineUnlockSession; choices: readonly { handle: OfflineLibraryHandle; title: string }[] }>;
 open(session: OfflineUnlockSession, handle: OfflineLibraryHandle, signal: AbortSignal): Promise<ProviderInstalledLibrary>;
 revoke(session: OfflineUnlockSession, handle: OfflineLibraryHandle, signal: AbortSignal): Promise<void>;
 lock(session: OfflineUnlockSession): Promise<void>;
}
export type ProviderOperationStatus = 'pending' | 'accepted' | 'rejected' | 'unknown' | 'not-found';
export type ProviderOperationOutcome = Readonly<{ requestId: string; status: ProviderOperationStatus; reason?: string }>;
/** One host-owned sync authority; this surface exposes no owner repository or provider credentials. */
export interface ProviderReplication {
 readonly scope: EditScope; suspend(): void; flush(): Promise<void>;
 getSnapshot(): ReplicationState; subscribe(listener: () => void): () => void;
 resume(): Promise<void>; suspendAndWait(): Promise<void>;
}
export type ProviderInstalledLibrary = Readonly<{ lease: HostLease; handle: LibraryHandle; requestId: string }>;
export type ProviderRecoveryRequest = Readonly<{ requestId: string; action: 'create' | 'join'; title: string;
 status: 'pending' | 'unknown' | 'accepted' | 'rejected' }>;
export interface ProviderOwnerFacade {
 /** Live credential generation loss, including while no editor is open. */
 subscribeInvalidation?(listener: () => void): () => void;
 /** SDK/configuration preparation only. Must settle before connect is enabled; never opens OAuth itself. */
 preload(signal: AbortSignal): Promise<{ configured: boolean; reason?: string }>;
 /** Initiated directly by a user gesture; a new grant requires live identity and read/write ownership verification. */
 connect(signal: AbortSignal): Promise<ProviderGrant>;
 recoveries(grant: ProviderGrant, signal: AbortSignal): Promise<readonly ProviderRecoveryRequest[]>;
 list(grant: ProviderGrant, signal: AbortSignal): Promise<readonly { handle: RemoteLibraryHandle; title: string;
  status: 'available' | 'owner-write-required' | 'unavailable' }[]>;
 prepareCreate(grant: ProviderGrant, title: string, requestId: string, signal: AbortSignal): Promise<ProviderOperationOutcome>;
 prepareJoin(grant: ProviderGrant, handle: RemoteLibraryHandle, requestId: string, signal: AbortSignal): Promise<ProviderOperationOutcome>;
 query(grant: ProviderGrant, requestId: string, signal: AbortSignal): Promise<ProviderOperationOutcome>;
 execute(grant: ProviderGrant, requestId: string, signal: AbortSignal): Promise<ProviderOperationOutcome>;
 acknowledge(grant: ProviderGrant, requestId: string, signal: AbortSignal): Promise<void>;
 /** Open an already activated selected library, or null when the selected scope is not installed. */
 openSelected(grant: ProviderGrant, handle: RemoteLibraryHandle, signal: AbortSignal): Promise<ProviderInstalledLibrary | null>;
 /** Fresh provider/binding admission for exactly this retained activation request. */
 openInstalled(grant: ProviderGrant, requestId: string, signal: AbortSignal): Promise<ProviderInstalledLibrary>;
 /** OAuth-free startup reconnection from host-persisted credentials, or null when none are available. */
 reconnectSaved?(signal: AbortSignal): Promise<ProviderGrant | null>;
 /** OAuth-free, one-shot fresh admission of the privately parked exact installed request. */
 resumeRetained?(requestId: string, signal: AbortSignal): Promise<{ grant: ProviderGrant; target: ProviderInstalledLibrary } | null>;
 /** Complete ownership handoff only after the existing editor adoption finishes; false retires unused fresh authority. */
 settleRetainedResume?(grant: ProviderGrant, accepted: boolean): Promise<void> | void;
 openReplication(grant: ProviderGrant, proof: ActiveLibraryProof, signal: AbortSignal): Promise<ProviderReplication>;
 disconnect(grant: ProviderGrant, signal: AbortSignal): Promise<void>;
 /** Retire the current host session on app close without erasing persisted credentials. */
 releaseOnClose?(grant: ProviderGrant, signal: AbortSignal): Promise<void>;
}
export type LocalContextResult = { status: 'ready'; lease: HostLease } | { status: 'setup-required'; reason: 'absent' | 'schema-upgrade' } | { status: 'recovery-required'; reason: string };
export type BootstrapDiscovery = { libraries: readonly { handle: LibraryHandle; title: string; status: 'available' | 'recovery-required' | 'frozen'; reason?: string }[];
 creations: readonly { requestId: string; title: string; outcome: InitializationOutcome }[]; canCreateLibrary: boolean };
export type ScopeResources = { repository: ContentRepository; markdownDrafts: MarkdownDraftPort; markdownImages: MarkdownImagePort; appendDrafts: NoteAppendDraftPort;
 readerState: ReaderStatePort<SavedReaderPreference>; peerId: string; outputFile?: OutputFilePort; inkPreferences?: InkPreferenceStorage; workspacePreferences?: WorkspacePreferencePort; selectionPreferences?: WorkspaceSelectionPort; queryPreferences?: LibraryQueryPreferencePort;
 /** Host drains/revokes the old I/O gate, then atomically binds these resources to new proof. Signal cancels the pending handoff only; after resolution host loss and close own gate revocation. */
 reauthorize(proof: ActiveLibraryProof, signal: AbortSignal): Promise<void>; close(): Promise<void> };
export interface OwnerInitializationFacade {
 getOrCreatePeer(signal: AbortSignal): Promise<CanonicalDevicePeer>;
 prepare(request: CanonicalInitializeRequest, signal: AbortSignal): Promise<InitializationOutcome>;
 query(requestId: string, signal: AbortSignal): Promise<InitializationOutcome>;
 execute(requestId: string, signal: AbortSignal): Promise<InitializationOutcome>;
 acknowledge(requestId: string, signal: AbortSignal): Promise<void>;
}
export type NativePreparationStatus = Readonly<{ state: 'idle' | 'running' | 'captured' | 'failed' | 'recovery-required' | 'cancelled' | 'blocked'; phase?: string; runId?: string; failure?: string | null; scope: 'native-preparation-only' }>;
export interface NativePreparationFacade {
 status(signal: AbortSignal): Promise<NativePreparationStatus>;
 start(signal: AbortSignal): Promise<NativePreparationStatus>;
 resume(runId: string, signal: AbortSignal): Promise<NativePreparationStatus>;
 abandon(runId: string, signal: AbortSignal): Promise<NativePreparationStatus>;
 /** Read-only Notebook preview (optional: only the real Native driver offers it). Refusals are values, not exceptions. */
 notebookSelectors?(runId: string, signal: AbortSignal): Promise<NativePreviewResult<{ selectors: readonly string[] }>>;
 notebookPreview?(runId: string, selector: string, signal: AbortSignal): Promise<NativePreviewResult<{ value: NativeNotebookPreview }>>;
}
export type NativePreviewBlockedReason = 'preview-busy' | 'preview-shutdown-pending' | 'preview-cancelled' | 'preview-capacity-exceeded' | 'preview-unavailable';
export type NativePreviewBlocked = Readonly<{ status: 'blocked'; reason: NativePreviewBlockedReason }>;
export type NativePreviewResult<T extends object> = Readonly<{ status: 'ok' } & T> | NativePreviewBlocked;
export type NativeNotebookPreview = Readonly<{
  libraryId: string; sourceDocumentId: string; entry: Readonly<{ sha256: string; byteLength: number }>;
  bytesBase64: string; annotations: readonly { pageId: string; ink: unknown; bookmarks: unknown }[]; incomplete: readonly string[];
  coverage: Readonly<{ pageRows: number; inkRows: number; bookmarkRows: number }>;
}>;
export interface BootstrapHostDriver {
 getNativePreparation?(): NativePreparationFacade;
 /** Stable ordinary provider entry; needs no local Library provisioning and starts no OAuth itself. */
 getProvider?(): ProviderOwnerFacade;
 getOffline?(): ProviderOfflineFacade;
 /** Uses the admitted binding and host-held live grant; views never receive a privileged repository. */
 openReplication?(proof: ActiveLibraryProof, signal: AbortSignal): Promise<ProviderReplication>;
 /** Absent for local-only hosts. Issuance belongs to the host and remains subject to its live lease. */
 provider?(lease: HostLease): ProviderOwnerFacade;
 /** Derived from the host's admitted proof/binding, not renderer state or connection status. */
 storageKind?(proof: ActiveLibraryProof): 'local' | 'google-drive';
 /** Provider-backed local admission, with transfer disabled until fresh online admission. */
 providerOffline?(proof: ActiveLibraryProof): boolean;
 readHold(signal: AbortSignal): Promise<'clear' | 'held'>;
 readLocalContext(signal: AbortSignal): Promise<LocalContextResult>;
 provisionLocalContext(signal: AbortSignal): Promise<HostLease>;
 discover(lease: HostLease, signal: AbortSignal): Promise<BootstrapDiscovery>;
 initialization(lease: HostLease): OwnerInitializationFacade;
 inspect(lease: HostLease, handle: LibraryHandle, signal: AbortSignal): Promise<ActiveLibraryProof>;
 /** Signal cancels pending acquisition only. Once resolved, the admitted gate lives until host loss or resources.close(), not operation-signal cancellation. */
 openScope(proof: ActiveLibraryProof, signal: AbortSignal): Promise<ScopeResources>;
 revalidate(proof: ActiveLibraryProof, signal: AbortSignal): Promise<void>;
 /** Host compares persistent grant/identity/control/profile/manifest and same epoch, never the revoked lease, not caller-provided booleans. */
 sameAdmission(previous: ActiveLibraryProof, next: ActiveLibraryProof): boolean;
 subscribeInvalidation(listener: () => void): () => void;
 /** Host-issued scoped event: asks whether an opaque lease or proof belongs to the retired owner. */
 subscribeScopedInvalidation?(listener: (affected: { affectsLease(lease: HostLease): boolean; affectsProof(proof: ActiveLibraryProof): boolean }) => void): () => void;
 close(): Promise<void>;
}
export type LibraryRuntime = { binding: LibraryScopeBinding; navigation: ContentNavigationSession; proof: ActiveLibraryProof; handle: LibraryHandle; resources: ScopeResources };

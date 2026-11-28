import type { HostLease, ActiveLibraryProof } from '../../features/bootstrap/bootstrapPorts.ts';
import type { EditScope, ResourceInspectionPort, ContentRepository } from '../../runtime/edits/ports.ts';
import { createPlanEvidence, fingerprintPlanInput } from '../../runtime/edits/repositoryExecution.ts';
import { createPlannedRepositoryDraft, type RepositoryOperationHost } from '../../runtime/edits/repositoryFacadeDraft.ts';
import { IndexedDbPlan } from './indexedDbPlan.ts';
import { LocalHostAuthority, createLocalHostGate } from './localHostAuthority.ts';
import type { MarkdownDraftPort } from '../../features/notes/markdown/MarkdownDraftPort.ts';
import type { NoteAppendDraftPort } from '../../features/notes/append/NoteAppendDraftPort.ts';
import type { ReaderStatePort, SavedReaderPreference } from '../../features/reader/ReaderSession.ts';
import type { InkPreferenceStorage } from '../../features/reader/ink/inkPreferencePersistence.ts';
import { BrowserWorkspaceSelection } from './workspaceSelection.ts';
import { BrowserWorkspacePreferences } from './workspacePreferences.ts';
import type { WorkspacePreferencePort } from '../../features/workspace/WorkspaceSession.ts';
import { BrowserLibraryQueryPreferences } from './libraryQueryPreferences.ts';
import type { LibraryQueryPreferencePort } from '../../features/library/query/LibraryQuerySession.ts';

/** One retained gate and facade. Every async method captures its own immutable host operation. */
export function createBrowserScopePorts(authority: LocalHostAuthority, lease: HostLease, proof: ActiveLibraryProof,
 drafts: MarkdownDraftPort, appends: NoteAppendDraftPort, reader: ReaderStatePort<SavedReaderPreference>, inspection?: ResourceInspectionPort, ink?: InkPreferenceStorage) {
 const scope: EditScope = Object.freeze(structuredClone(proof.scope));
 const gate = createLocalHostGate(authority, lease, proof);
 const assertScope = (other: EditScope) => {
  if(other.accountId!==scope.accountId || other.libraryId!==scope.libraryId || other.epoch!==scope.epoch) throw new Error('host-scope-mismatch');
 };
 assertScope(drafts.scope); assertScope(appends.scope); assertScope(reader.scope);
 const host: RepositoryOperationHost = {
  createEvidence: (operation, fixed) => createPlanEvidence(fingerprintPlanInput(operation, fixed)),
  run: (_operation, evidence, action) => gate.run(undefined, operation => authority.withOperationDatabase(operation, () => action(new IndexedDbPlan(authority, operation, scope, evidence.bind(operation))))),
 };
 const repository: ContentRepository = createPlannedRepositoryDraft(scope, host, inspection);
 const sync = <T>(action: () => T): T => gate.runSync(operation => {
  const admitted = authority.captureRecord(operation).tuple; if(!admitted)throw new Error('host-admission-invalid'); assertScope(admitted.scope); return action();
 });
 const markdown: MarkdownDraftPort = { scope, targets: () => sync(() => drafts.targets()), read: id => sync(() => drafts.read(id)),
  write: (id, value) => sync(() => drafts.write(id,value)), remove: id => sync(() => drafts.remove(id)) };
 const annotation: NoteAppendDraftPort = { scope, read: () => sync(() => appends.read()), write: value => sync(() => appends.write(value)), remove: () => sync(() => appends.remove()) };
 const preferences: ReaderStatePort<SavedReaderPreference> = { scope, read: id => sync(() => reader.read(id)), write: (id,value) => sync(() => reader.write(id,value)) };
 const inkPreferences: InkPreferenceStorage | undefined = ink ? { getItem: key => sync(() => ink.getItem(key)), setItem: (key, value) => sync(() => ink.setItem(key, value)) } : undefined;
 const rawWorkspace = new BrowserWorkspacePreferences(scope);
 const workspacePreferences: WorkspacePreferencePort = { scope, read: () => sync(() => rawWorkspace.read()), write: value => sync(() => rawWorkspace.write(value)) };
 const rawSelection = new BrowserWorkspaceSelection(scope);
 const selectionPreferences = { scope, read: () => sync(() => rawSelection.read()), write: (value: Parameters<typeof rawSelection.write>[0]) => sync(() => rawSelection.write(value)) };
 const rawQuery = new BrowserLibraryQueryPreferences(scope);
 const queryPreferences: LibraryQueryPreferencePort = { scope, read: () => sync(() => rawQuery.read()), write: value => sync(() => rawQuery.write(value)) };
 return Object.freeze({ scope, repository, images: repository, markdown, annotation, preferences, inkPreferences, workspacePreferences, selectionPreferences, queryPreferences, gate });
}

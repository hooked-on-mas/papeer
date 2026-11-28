import type { ContentRepository } from '../../runtime/edits/ports';
import type { ProviderReplication } from '../bootstrap/bootstrapPorts.ts';
import { canonicalJson } from '../../runtime/edits/editModel.ts';
import type { DocumentEditSessions } from './DocumentEditSessions';
import type { DocumentInkSettings } from './ink/DocumentInkSettings';
import type { ReaderStatePort, SavedReaderPreference } from './ReaderSession';
import type { OutputFilePort } from './output/ports';
import type { WorkspaceSelectionPort } from '../workspace/WorkspaceSelectionSession';
import type { WorkspacePreferencePort } from '../workspace/WorkspaceSession';

export type LibraryScopeBinding = {
  repository: ContentRepository;
  sessions: DocumentEditSessions;
  replication: ProviderReplication;
  inkSettings: DocumentInkSettings;
  readerState: ReaderStatePort<SavedReaderPreference>;
  outputFile?: OutputFilePort;
  workspacePreferences?: WorkspacePreferencePort;
  selectionPreferences?: WorkspaceSelectionPort;
};

export type DocumentLibraryBinding = LibraryScopeBinding & { documentId: string; catalogVersion?: string };

/** A composition borrows an already selected scope; it never chooses credentials or storage. */
export function assertLibraryScopeBinding(binding: LibraryScopeBinding) {
  const scope = canonicalJson(binding.repository.scope);
  if (canonicalJson(binding.sessions.scope) !== scope || canonicalJson(binding.replication.scope) !== scope
    || canonicalJson(binding.inkSettings.scope) !== scope
    || canonicalJson(binding.readerState.scope) !== scope
    || binding.workspacePreferences && canonicalJson(binding.workspacePreferences.scope) !== scope
    || binding.selectionPreferences && canonicalJson(binding.selectionPreferences.scope) !== scope) throw new Error('document-binding-scope');
}
export function assertDocumentLibraryBinding(binding: DocumentLibraryBinding) {
  assertLibraryScopeBinding(binding);
  if (!binding.documentId) throw new Error('document-binding-target');
}

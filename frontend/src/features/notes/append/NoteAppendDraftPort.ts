import type { EditScope } from '../../../runtime/edits/ports.ts';
import type { AnnotationBrowserExport } from '../../library/annotations/canonicalAnnotationBrowser.ts';
import type { LibraryCreateIdentity, LibraryCreateInput } from '../../library/LibrarySession.ts';

export type AnnotationNoteCreation = { input: LibraryCreateInput & { kind: 'markdown' }; identity: LibraryCreateIdentity };
export type SavedAnnotationAppend = {
  version: 1;
  request: { id: string; input: { kind: 'annotations'; result: AnnotationBrowserExport } };
  destinationId: string | null;
  /** Written durably before the destination may accept the append operation. */
  appendStarted: boolean;
  creation: AnnotationNoteCreation | null;
};
/** One scoped annotations request. Missing is undefined; malformed raw must remain untouched. */
export interface NoteAppendDraftPort {
  readonly scope: EditScope;
  read(): unknown;
  write(value: SavedAnnotationAppend): void;
  remove(): void;
}

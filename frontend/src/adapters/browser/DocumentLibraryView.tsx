import type { DocumentLibraryBinding } from '../../features/reader/DocumentLibraryBinding';
import { CanonicalReaderFrame } from '../../features/workspace/CanonicalReaderFrame';
import { DocumentWritingToolbar } from '../../features/reader/DocumentWritingToolbar';
import { DocumentLibraryConnection, type DocumentLibraryView } from '../../features/reader/DocumentLibraryConnection';
import { DocumentWorkspace } from '../../features/reader/DocumentWorkspace';
import { CanonicalDocumentSurface } from '../../features/reader/CanonicalDocumentSurface';

export function BrowserDocumentLibraryView({ view }: { view: DocumentLibraryView }) {
  return <CanonicalReaderFrame title={view.title} rootRef={view.rootRef} toolbar={<DocumentWritingToolbar view={view} />}>
    <DocumentWorkspace view={view} renderSurface={surface => <CanonicalDocumentSurface view={surface} />} />
  </CanonicalReaderFrame>;
}

export function BrowserDocumentLibrary({ binding }: { binding: DocumentLibraryBinding }) {
  return <DocumentLibraryConnection binding={binding} render={view => <BrowserDocumentLibraryView view={view} />} />;
}

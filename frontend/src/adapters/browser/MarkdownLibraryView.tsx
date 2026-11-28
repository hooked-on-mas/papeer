import type { DocumentLibraryBinding } from '../../features/reader/DocumentLibraryBinding';
import { MarkdownLibraryConnection, type MarkdownLibraryView } from '../../features/notes/markdown/MarkdownLibraryConnection';
import { CanonicalMarkdownToolbar, CanonicalMarkdownView } from '../../features/notes/markdown/CanonicalMarkdownView';
import { CanonicalReaderFrame } from '../../features/workspace/CanonicalReaderFrame';

export function BrowserMarkdownLibraryView({ view }: { view: MarkdownLibraryView }) {
  return <CanonicalReaderFrame title={view.title} rootRef={view.rootRef} toolbar={<CanonicalMarkdownToolbar view={view} />}>
    <CanonicalMarkdownView view={view} />
  </CanonicalReaderFrame>;
}

export function BrowserMarkdownLibrary({ binding }: { binding: DocumentLibraryBinding }) {
  return <MarkdownLibraryConnection binding={binding} render={view => <BrowserMarkdownLibraryView view={view} />} />;
}

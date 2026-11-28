import { lazy } from 'react';
import type { DocumentLibraryBinding, LibraryScopeBinding } from './features/reader/DocumentLibraryBinding';
import type { ContentNavigationSession } from './features/reader/navigation/ContentNavigationSession';
import { LibraryContentConnection } from './features/reader/LibraryContentConnection';

const DesktopDocumentLibrary = lazy(() => import('./adapters/desktop/DocumentLibraryView').then(module => ({ default: module.DesktopDocumentLibrary })));
const DesktopMarkdownLibrary = lazy(() => import('./adapters/desktop/MarkdownLibraryView').then(module => ({ default: module.DesktopMarkdownLibrary })));

/**
 * Explicit-composition branch (tests and the composition fixtures). The normal entry is
 * adapters/desktop/DesktopBootstrapApp; there is no legacy fallback here.
 */
export default function App({ documentLibrary, libraryScope }: { documentLibrary?: DocumentLibraryBinding; libraryScope?: { binding: LibraryScopeBinding; navigation: ContentNavigationSession } }) {
  if (!documentLibrary && !libraryScope) throw new Error('library-composition-required');
  return <LibraryContentConnection binding={libraryScope?.binding ?? documentLibrary!} navigation={libraryScope?.navigation}
    renderDocument={binding => <DesktopDocumentLibrary binding={binding} />}
    renderMarkdown={binding => <DesktopMarkdownLibrary binding={binding} />} />;
}

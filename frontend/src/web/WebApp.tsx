import { lazy, StrictMode, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { LibraryContentConnection } from '../features/reader/LibraryContentConnection';
import { BootstrapConnection } from '../features/bootstrap/BootstrapConnection';
import type { BootstrapSession } from '../features/bootstrap/BootstrapSession';
import type { DocumentLibraryBinding, LibraryScopeBinding } from '../features/reader/DocumentLibraryBinding';
import type { ContentNavigationSession } from '../features/reader/navigation/ContentNavigationSession';
import { createWebBootstrap } from './bootstrapComposition';
import { useWebPwaRuntime, WebPwaBanner, WebPwaInstallHint } from './WebPwaRuntime';
import './style.css';

const BrowserDocumentLibrary = lazy(() => import('../adapters/browser/DocumentLibraryView').then(module => ({ default: module.BrowserDocumentLibrary })));
const BrowserMarkdownLibrary = lazy(() => import('../adapters/browser/MarkdownLibraryView').then(module => ({ default: module.BrowserMarkdownLibrary })));
const renderDocument = (binding: DocumentLibraryBinding) => <BrowserDocumentLibrary binding={binding} />;
const renderMarkdown = (binding: DocumentLibraryBinding) => <BrowserMarkdownLibrary binding={binding} />;

function WebBootstrapRoot({ session }: { session: BootstrapSession }) {
  const canReload = useCallback(() => {
    const snapshot = session.getSnapshot();
    const creation = snapshot.creation;
    const provider = session.getProviderConnection()?.getSnapshot();
    const offline = session.getOfflineConnection()?.getSnapshot();
    return !['checking', 'opening', 'creating'].includes(snapshot.phase)
      && !session.getRetainedRuntime()?.binding.sessions.needsExitConfirmation()
      && !provider?.busy && !provider?.pendingGuard
      && !offline?.pendingGuard && !offline?.busy
      && !(creation && ['preparing', 'unknown', 'pending'].includes(creation.stage));
  }, [session]);
  const pwa = useWebPwaRuntime(canReload);
  return <BootstrapConnection session={session} renderDocument={renderDocument} renderMarkdown={renderMarkdown}
    topNotice={<WebPwaBanner pwa={pwa} />} chooserFooter={<WebPwaInstallHint pwa={pwa} />} />;
}

export async function mountWebApp({ documentLibrary, libraryScope }: { documentLibrary?: DocumentLibraryBinding; libraryScope?: { binding: LibraryScopeBinding; navigation: ContentNavigationSession } } = {}) {
  const root = createRoot(document.getElementById('root')!);
  if (documentLibrary || libraryScope) {
    // Explicit composition for fixtures; it is not host admission evidence.
    root.render(<StrictMode><LibraryContentConnection binding={libraryScope?.binding ?? documentLibrary!} navigation={libraryScope?.navigation}
      renderDocument={renderDocument} renderMarkdown={renderMarkdown} /></StrictMode>);
    return root;
  }
  // Normal entry: the host owns the session for the page lifetime; React effects never close it.
  const { session } = createWebBootstrap();
  root.render(<StrictMode><WebBootstrapRoot session={session} /></StrictMode>);
  return root;
}

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import type { DocumentLibraryBinding, LibraryScopeBinding } from './features/reader/DocumentLibraryBinding';

import type { ContentNavigationSession } from './features/reader/navigation/ContentNavigationSession';

export async function mountDesktopApp({ documentLibrary, libraryScope }: { documentLibrary?: DocumentLibraryBinding; libraryScope?: { binding: LibraryScopeBinding; navigation: ContentNavigationSession } } = {}) {
  if (documentLibrary || libraryScope) {
    const root = ReactDOM.createRoot(document.getElementById('root')!);
    root.render(<React.StrictMode><App documentLibrary={documentLibrary} libraryScope={libraryScope} /></React.StrictMode>);
    return root;
  }
  // Normal entry: hold admission has already passed in main.tsx. No window binding and no legacy fallback.
  const { mountDesktopBootstrapApp } = await import('./adapters/desktop/DesktopBootstrapApp');
  return mountDesktopBootstrapApp(document.getElementById('root')!);
}

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { moduleGraph } from './boundaryVerifier.mjs';

// R29 (abridged): verify via static runtime import graph that PC (src/main.tsx) and Web (src/web/main.tsx)
// load the same A-category feature modules and neither reaches legacy shells or removed feature directories.
const src = path.resolve(import.meta.dirname, '../src');
const rel = file => path.relative(src, file).split(path.sep).join('/');
const reachable = entry => new Set([...moduleGraph(path.join(src, entry), src).files].map(rel));
const featuresOf = files => new Set([...files].filter(file => file.startsWith('features/')));

const REQUIRED_SHARED_A_FEATURES = [
  // Ink & drawing tools (F01-F14)
  'features/ink/inkDraft.ts',
  'features/ink/inkInteraction.ts',
  'features/reader/DocumentWritingToolbar.tsx',
  'features/reader/InkOverlay.tsx',
  'features/reader/ink/useDocumentInkEditor.tsx',
  'features/reader/ink/DocumentInkSettings.ts',
  'features/reader/edit/DocumentEditSession.ts',
  'features/reader/edit/documentHistory.ts',
  'features/reader/edit/DocumentConflictPanel.tsx',
  // PDF reading, search, outline, links & annotations (F15-F20, R07)
  'features/reader/ReaderSession.ts',
  'features/reader/pdf/PdfSurface.tsx',
  'features/reader/pdf/CanonicalPdfSearch.tsx',
  'features/reader/pdf/CanonicalPdfOutline.tsx',
  'features/reader/pdf/PdfLinksLayer.tsx',
  'features/reader/annotations/CanonicalAnnotationEditor.tsx',
  'features/reader/annotations/canonicalAnnotationOperations.ts',
  // Notebooks (F23, R01)
  'features/notebooks/CanonicalNotebookControls.tsx',
  'features/notebooks/CanonicalPaperBackground.tsx',
  'features/notebooks/canonicalNotebookPages.ts',
  // Markdown notes (F24-F25)
  'features/notes/markdown/CanonicalMarkdownView.tsx',
  'features/notes/markdown/CanonicalMarkdownPreview.tsx',
  'features/notes/markdown/MarkdownEditSession.ts',
  'features/notes/markdown/MarkdownLibraryConnection.tsx',
  // Library, catalog, tree, search & attachments (F26-F28, F30-F32, F34, F36, R04)
  'features/library/LibrarySession.ts',
  'features/library/catalog/LibraryCatalogPanel.tsx',
  'features/library/catalog/LibraryConflictPanel.tsx',
  'features/library/tree/LibraryHierarchy.tsx',
  'features/library/query/LibraryQuerySession.ts',
  'features/reader/AttachmentLibraryView.tsx',
  // Workspace & display preferences (F29, F35)
  'features/workspace/WorkspacePreferences.tsx',
  'features/workspace/WorkspaceSession.ts',
  'features/workspace/CanonicalReaderFrame.tsx',
  'features/reader/LibraryContentConnection.tsx',
  // Bootstrap & replication (R08, R09, R12, R29)
  'features/bootstrap/BootstrapConnection.tsx',
  'features/bootstrap/BootstrapSession.ts',
  'features/bootstrap/provider/ProviderConnectionPanel.tsx',
  'features/bootstrap/provider/ProviderOfflinePanel.tsx',
];

const FORBIDDEN_LEGACY_PATHS = [
  'features/summary/',
  'features/chat/',
  'features/references/',
  'features/ocr/',
  'features/settings/',
  'features/documents/',
  'app/LegacyDesktopConnection.tsx',
  'web/LegacyWebConnection.tsx',
  'web/WebLibrary.tsx',
  'web/WebNotes.tsx',
  'store/index.ts',
  'api/client.ts',
];

test('R29: PC and Web normal entries share the same features/** graph except desktop bootstrap legacy preparation', () => {
  const pcFeatures = featuresOf(reachable('main.tsx'));
  const webFeatures = featuresOf(reachable('web/main.tsx'));
  assert.ok(pcFeatures.size >= 100 && webFeatures.size >= 100, `unexpectedly small feature graph: pc=${pcFeatures.size}, web=${webFeatures.size}`);

  const webOnly = [...webFeatures].filter(file => !pcFeatures.has(file)).sort();
  const pcOnlyNonLegacy = [...pcFeatures].filter(file => !webFeatures.has(file) && !file.startsWith('features/bootstrap/legacy/')).sort();
  assert.deepEqual(webOnly, []);
  assert.deepEqual(pcOnlyNonLegacy, []);
});

test('R29: both PC and Web normal entries reach the canonical A-category feature modules', () => {
  const pc = reachable('main.tsx');
  const web = reachable('web/main.tsx');
  for (const modulePath of REQUIRED_SHARED_A_FEATURES) {
    assert.ok(existsSync(path.join(src, modulePath)), `missing required feature module: ${modulePath}`);
    assert.ok(pc.has(modulePath), `PC entry does not reach ${modulePath}`);
    assert.ok(web.has(modulePath), `Web entry does not reach ${modulePath}`);
  }
});

test('R29: desktop and browser host view adapters wrap identical feature subtrees', () => {
  const pairs = [
    ['adapters/desktop/DocumentLibraryView.tsx', 'adapters/browser/DocumentLibraryView.tsx', 'features/reader/DocumentLibraryConnection.tsx'],
    ['adapters/desktop/MarkdownLibraryView.tsx', 'adapters/browser/MarkdownLibraryView.tsx', 'features/notes/markdown/MarkdownLibraryConnection.tsx'],
  ];
  for (const [desktopAdapter, browserAdapter, sharedConnection] of pairs) {
    const desktopFeatures = [...featuresOf(reachable(desktopAdapter))].sort();
    const browserFeatures = [...featuresOf(reachable(browserAdapter))].sort();
    assert.ok(desktopFeatures.includes(sharedConnection), `${desktopAdapter} missing ${sharedConnection}`);
    assert.deepEqual(desktopFeatures, browserFeatures, `${desktopAdapter} and ${browserAdapter} diverge on features/**`);
  }
});

test('R29: neither PC nor Web normal entry reaches legacy shells or removed feature directories', () => {
  const pc = reachable('main.tsx');
  const web = reachable('web/main.tsx');
  for (const [label, files] of [['PC', pc], ['Web', web]]) {
    const hits = [...files].filter(file => FORBIDDEN_LEGACY_PATHS.some(rule => rule.endsWith('/') ? file.startsWith(rule) : file === rule)).sort();
    assert.deepEqual(hits, [], `${label} entry reached forbidden legacy modules: ${hits.join(', ')}`);
  }
});

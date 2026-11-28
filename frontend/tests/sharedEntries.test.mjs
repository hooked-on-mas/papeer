import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { moduleGraph, graphBoundaryViolations, boundaryViolations } from './boundaryVerifier.mjs';

const src = path.resolve(import.meta.dirname, '../src');
const registry = JSON.parse(readFileSync(path.join(src, 'runtime/sharedEntries.json'), 'utf8'));
const graph = root => moduleGraph(root, src);
test('connected common entries are reachable from both production compositions', () => {
  const desktop = graph(path.join(src, 'main.tsx')), web = graph(path.join(src, 'web/main.tsx'));
  for (const entry of registry.entries) {
    const source = path.join(src, entry.source);
    assert.ok(existsSync(source), entry.id);
    if (entry.connection !== 'connected') continue; // Staged is explicitly not an integration acceptance claim.
    assert.ok(desktop.files.has(source), `desktop does not reach ${entry.id}`); assert.ok(web.files.has(source), `web does not reach ${entry.id}`);
  }
  const output = path.resolve(src, '../../output'); mkdirSync(output, { recursive: true });
  const relative = file => path.relative(path.dirname(src), file).replaceAll('\\', '/');
  const sourceHashes = Object.fromEntries([...new Set([...desktop.files, ...web.files])].map(file => [relative(file), createHash('sha256').update(readFileSync(file)).digest('hex')]));
  writeFileSync(path.join(output, 'shared-app-module-graph.json'), JSON.stringify({ recordedAt: new Date().toISOString(), entries: registry.entries, sourceHashes,
    desktop: { entry: 'src/main.tsx', edges: desktop.edges.map(edge => edge.map(relative)) },
    web: { entry: 'src/web/main.tsx', edges: web.edges.map(edge => edge.map(relative)) } }, null, 2) + '\n');
});
test('new shared model/session paths have no transitive host packages, globals or imports', () => {
  const roots = readdirSync(path.join(src, 'runtime/edits')).filter(file => /\.ts$/.test(file)).map(file => path.join(src, 'runtime/edits', file));
  roots.push(...['library/annotations/AnnotationAppendHandoff.ts', 'notes/append/appendAllowsFocusChange.ts', 'workspace/related/relatedContent.ts', 'workspace/FileChooserHold.ts', 'workspace/WorkspaceCommandSession.ts', 'workspace/WorkspaceSelectionSession.ts', 'notes/noteEditSession.ts', 'reader/ConflictSession.ts', 'ink/inkDraft.ts', 'reader/inkEditor.ts', 'reader/edit/DocumentEditSession.ts', 'reader/DocumentEditSessions.ts', 'reader/edit/documentHistory.ts', 'reader/pageMapping.ts', 'library/recovery/deletedContent.ts'].map(file => path.join(src, 'features', file)));
  // This module only builds a Markdown AST; it has no renderer, DOM, storage or network access.
  const allowedPackagesByModule = { 'runtime/markdown/markdownImages.ts': ['unified', 'remark-parse', 'remark-gfm', 'remark-math'] };
  roots.push(...['features/notes/markdown/MarkdownEditSession.ts', 'features/reader/ReaderSession.ts',
    'features/reader/navigation/citationLocation.ts', 'features/reader/navigation/ContentNavigationSession.ts',
    'runtime/markdown/markdownCitations.ts', 'features/notes/append/NoteAppendSession.ts',
    'features/reader/pdf/canonicalPdfCapturePlan.ts', 'features/library/LibrarySession.ts',
    'features/reader/attachmentResource.ts', 'features/reader/libraryContentKind.ts',
    'features/library/tree/canonicalLibraryTree.ts', 'features/library/annotations/AnnotationBrowserSession.ts',
    'features/library/annotations/canonicalAnnotationCorpus.ts', 'features/library/annotations/canonicalAnnotationBrowser.ts',
    'features/library/recovery/DeletedContentComparisonSession.ts', 'features/reader/pdf/canonicalPdfResource.ts',
    'features/reader/annotations/canonicalAnnotationOperations.ts', 'features/workspace/WorkspaceSession.ts'].map(file => path.join(src, file)));
  for (const root of roots) assert.deepEqual(graphBoundaryViolations(root, src, { allowedPackagesByModule }), []);
});

test('shared views may use DOM and approved UI packages but never host storage or transport', () => {
  const roots = ['features/notes/markdown/MarkdownSessionEditor.tsx', 'features/reader/DrawingKindSelect.tsx', 'features/reader/InkOverlay.tsx',
    'features/library/annotations/AnnotationBrowserPanel.tsx', 'features/workspace/WorkspaceCommandContext.tsx',
    'features/workspace/related/RelatedContentPanel.tsx', 'features/workspace/CanonicalReaderFrame.tsx', 'app/startup.ts'];
  for (const root of roots) assert.deepEqual(graphBoundaryViolations(path.join(src, root), src, { layer: 'ui' }), []);
});

test('canonical content connections and preview retain their injected storage and navigation boundaries', () => {
  const allowedPackagesByModule = {
    'components/ui/MarkdownContent.tsx': ['react-markdown', 'remark-gfm', 'remark-math', 'rehype-katex', 'katex/dist/katex.min.css', 'mermaid'],
    'features/notes/markdown/CanonicalMarkdownPreview.tsx': ['react-markdown'],
    // Dynamic-height DOM windowing is a view concern, approved only for this tree component.
    'features/library/tree/LibraryHierarchy.tsx': ['@tanstack/react-virtual'],
    'runtime/markdown/markdownImages.ts': ['unified', 'remark-parse', 'remark-gfm', 'remark-math'],
    'features/reader/pdf/pdfRendering.ts': ['react-pdf', 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'],
    'features/reader/pdf/PdfDocument.tsx': ['react-pdf', 'react-pdf/dist/Page/AnnotationLayer.css', 'react-pdf/dist/Page/TextLayer.css'],
  };
  for (const root of ['features/reader/LibraryContentConnection.tsx', 'features/reader/DocumentLibraryConnection.tsx',
    'features/notes/markdown/MarkdownLibraryConnection.tsx', 'features/notes/markdown/CanonicalMarkdownView.tsx',
    'features/notes/markdown/CanonicalMarkdownPreview.tsx', 'features/library/recovery/DeletedContentComparisonConnection.tsx',
    'features/library/recovery/DeletedContentComparisonPanel.tsx', 'features/reader/CanonicalDocumentPagePreview.tsx',
    'features/reader/pdf/CanonicalPdfPagePreview.tsx', 'features/reader/annotations/CanonicalAnnotationEditor.tsx',
    'features/reader/annotations/CanonicalAnnotationLayer.tsx', 'features/reader/AnnotationForm.tsx', 'features/reader/annotations/useCanonicalAnnotationReadiness.ts',
    'features/reader/pdf/PdfSurface.tsx', 'features/reader/CanonicalDocumentSurface.tsx', 'features/reader/useDocumentPdfAsset.ts',
    'features/reader/pdf/useCanonicalPdfTextBinding.ts', 'features/reader/pdf/canonicalPdfHighlight.ts'])
    assert.deepEqual(graphBoundaryViolations(path.join(src, root), src, { layer: 'ui', allowedPackagesByModule }), []);
});

test('tree windowing approval is view-only and does not grant host storage or package subpaths', () => {
  const source = "import { useVirtualizer } from '@tanstack/react-virtual';";
  const options = { layer: 'ui', allowedPackages: ['@tanstack/react-virtual'] };
  assert.deepEqual(boundaryViolations(source, options), []);
  assert.ok(boundaryViolations(source).some(error => error.includes('@tanstack/react-virtual')));
  assert.ok(boundaryViolations("import x from '@tanstack/react-virtual/host';", options).some(error => error.includes('forbidden runtime package')));
  for (const host of ["fetch('/save');", 'window.localStorage.clear();', 'indexedDB.open("data");']) {
    assert.ok(boundaryViolations(source + host, options).length > 0, host);
  }
});

test('one-time converters depend on the common model and never on legacy editors or host storage', () => {
  const roots = readdirSync(path.join(src, 'migrations')).filter(file => /\.ts$/.test(file)).map(file => path.join(src, 'migrations', file));
  for (const root of roots) assert.deepEqual(graphBoundaryViolations(root, src, { forbiddenPaths: /^(api|store|web|adapters|features)\// }), []);
});


test('portable PDF writer is domain-only and its worker envelope is restricted', () => {
  const base = 'features/reader/pdf/export/';
  const allowedPackagesByModule = { [base+'vectorWriter.ts']: ['pdf-lib','@pdf-lib/fontkit'], [base+'paper.ts']: ['pdf-lib'] };
  assert.deepEqual(graphBoundaryViolations(path.join(src,base+'vectorWriter.ts'),src,{allowedPackagesByModule}),[]);
  assert.deepEqual(boundaryViolations(readFileSync(path.join(src,base+'pdfExport.worker.ts'),'utf8'),{file:path.join(src,base+'pdfExport.worker.ts'),layer:'worker'}),[]);
});

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { graphBoundaryViolations, moduleGraph } from './boundaryVerifier.mjs';

const src = path.resolve(import.meta.dirname, '../src');

test('shared reader controllers and editing sessions do not import a host or transport', () => {
  for (const file of ['navigation/readerCommands.ts', 'input/useReaderInput.ts', 'input/usePdfPointerInput.ts',
    'input/usePdfSurfaceInput.ts', 'navigation/usePairedReaderScroll.ts', 'input/touchSwipe.ts', '../ink/inkDraft.ts', 'DrawingKindSelect.tsx', 'useInkSurfaceEditor.ts']) {
    assert.deepEqual(graphBoundaryViolations(path.join(src, 'features/reader', file), src, { layer: 'ui',
      forbiddenPaths: /^(api|store|web|adapters|migrations)\/|^features\/reader\/navigation\./ }), [], file);
  }
  assert.deepEqual(graphBoundaryViolations(path.join(src, 'features/notes/noteEditSession.ts'), src), []);
});

test('production layout views cannot start legacy queries, storage or host services', () => {
  const forbiddenPaths = /^(api|store|adapters|migrations)\/|^app\/Legacy|^web\/(?!WebLibrary\.tsx$|WebAppView\.tsx$)/;
  for (const file of ['app/AppShell.tsx', 'app/ReaderArea.tsx', 'web/WebLibrary.tsx', 'web/WebAppView.tsx']) {
    assert.deepEqual(graphBoundaryViolations(path.join(src, file), src, { layer: 'ui', forbiddenPaths }), [], file);
  }
});


test('desktop PDF views cannot reach legacy persistence, navigation or host operations', () => {
  const forbiddenPaths = /^(api|store|adapters|migrations|shell)\/|^app\/|^web\/|^features\/reader\/(Legacy|navigation\.|useInkEditor\.|inkStore\.|sticky\/stickyNotesStore\.)/;
  for (const file of ['features/reader/Reader.tsx', 'features/reader/PdfPane.tsx']) {
    assert.deepEqual(graphBoundaryViolations(path.join(src, file), src, { layer: 'ui', forbiddenPaths, allowedUiPackages: ['react-pdf', 'pdfjs-dist', 'react-markdown'] }), [], file);
  }
});

test('web PDF views accept content and commands without legacy storage or connection imports', () => {
  const forbiddenPaths = /^(api|store|adapters|migrations|shell)\/|^app\/Legacy|^web\/(?!DocumentReader\.tsx$|PdfReader\.tsx$|usePdfPinchZoom\.ts$|usePdfReadingPlace\.ts$|readerLayout\.ts$)/;
  for (const file of ['web/DocumentReader.tsx', 'web/PdfReader.tsx']) {
    assert.deepEqual(graphBoundaryViolations(path.join(src, file), src, { layer: 'ui', forbiddenPaths,
      allowedUiPackages: ['react-pdf', 'pdfjs-dist'] }), [], file);
  }
});

test('canonical document UI and settings never reach legacy or concrete host implementations', () => {
  const forbiddenPaths = /^(api|store|web|adapters|migrations|shell)\/|^app\/Legacy|^features\/reader\/(Legacy|navigation\.|useInkEditor\.|inkStore\.|sticky\/stickyNotesStore\.)/;
  const allowedPackagesByModule = { 'features/reader/pdf/pdfRendering.ts': ['react-pdf', 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'] };
  for (const file of ['DocumentLibraryConnection.tsx', 'ink/useDocumentInkEditor.tsx', 'DocumentWritingToolbar.tsx',
    'annotations/CanonicalPageAnnotations.tsx', 'ink/CanonicalInkDrawing.tsx']) {
    assert.deepEqual(graphBoundaryViolations(path.join(src, 'features/reader', file), src, { layer: 'ui', forbiddenPaths, allowedPackagesByModule }), [], file);
  }
  for (const file of ['ink/DocumentInkSettings.ts', 'ink/canonicalInk.ts', 'ink/canonicalInkOperations.ts']) {
    assert.deepEqual(graphBoundaryViolations(path.join(src, 'features/reader', file), src), [], file);
  }
});

test('both canonical host compositions reach the same frame and related panel', () => {
  const frame = path.join(src, 'features/workspace/CanonicalReaderFrame.tsx');
  assert.deepEqual(graphBoundaryViolations(frame, src, { layer: 'ui',
    forbiddenPaths: /^(api|store|web|adapters|migrations|shell|app)\// }), []);
  for (const host of ['browser', 'desktop']) {
    for (const view of ['DocumentLibraryView', 'MarkdownLibraryView']) {
      const root = path.join(src, `adapters/${host}/${view}.tsx`);
      assert.ok(moduleGraph(root, src).edges.some(([from, to]) => from === root && to === frame), `${host}/${view}`);
    }
  }
  const panel = path.join(src, 'features/workspace/related/RelatedContentPanel.tsx');
  for (const entry of ['main.tsx', 'web/main.tsx']) {
    const graph = moduleGraph(path.join(src, entry), src);
    assert.ok(graph.files.has(frame), entry);
    assert.ok(graph.files.has(panel), `${entry} must use the same related panel`);
  }
});

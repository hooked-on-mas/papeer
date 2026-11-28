import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { moduleGraph } from './boundaryVerifier.mjs';
import { typeInclusiveFiles } from './typeInclusiveGraph.mjs';

// Work B13-h. CURRENT STATE (現状値の固定) of how the 62 sharedEntries.json entries are reached from the two ordinary entries
// (src/main.tsx = PC, src/web/main.tsx = Web), by runtime imports (moduleGraph). The tables below are typed by hand, NOT derived from the graph,
// so a changed registry or a changed import graph fails here and must be re-pinned on purpose.
//
// IMPORTANT: this is not an acceptance claim. "staged" stays "staged"; a pinned reach of `both` only says that the module is imported from both entries,
// not that the feature works. In particular the 11 entries pinned as `none` are 未整理 (not sorted out): that they are unreachable is the
// current fact to be investigated (P6.4 decides retirement or replacement), and a green result here must NOT be read as "the entry is fine".
const src = path.resolve(import.meta.dirname, '../src');
const registry = JSON.parse(readFileSync(path.join(src, 'runtime/sharedEntries.json'), 'utf8'));
const rel = file => path.relative(src, file).split(path.sep).join('/');
const pc = new Set([...moduleGraph(path.join(src, 'main.tsx'), src).files].map(rel));
const web = new Set([...moduleGraph(path.join(src, 'web/main.tsx'), src).files].map(rel));
const pcTypes = new Set([...typeInclusiveFiles(path.join(src, 'main.tsx'), src)].map(rel));
const webTypes = new Set([...typeInclusiveFiles(path.join(src, 'web/main.tsx'), src)].map(rel));
const reach = (source, pcSet = pc, webSet = web) => pcSet.has(source) && webSet.has(source) ? 'both' : pcSet.has(source) ? 'pc' : webSet.has(source) ? 'web' : 'none';

/** [id, source] */
const CONNECTED_BOTH = [
  ['reader.ink-draft', 'features/ink/inkDraft.ts'],
  ['reader.output-snapshot', 'features/reader/output/SnapshotSession.ts'],
  ['reader.pdf-export-writer', 'features/reader/pdf/export/vectorWriter.ts'],
  ['migration.startup', 'app/startup.ts'],
];
const STAGED_BOTH = [
  ['edits.model', 'runtime/edits/editModel.ts'],
  ['edits.replication', 'runtime/edits/replication.ts'],
  ['reader.ink-overlay', 'features/reader/InkOverlay.tsx'],
  ['reader.document-session', 'features/reader/edit/DocumentEditSession.ts'],
  ['reader.annotation-operations', 'features/reader/annotations/canonicalAnnotationOperations.ts'],
  ['reader.document-history', 'features/reader/edit/documentHistory.ts'],
  ['reader.document-sessions', 'features/reader/DocumentEditSessions.ts'],
  ['reader.content-navigation', 'features/reader/navigation/ContentNavigationSession.ts'],
  ['notes.canonical-markdown', 'features/notes/markdown/CanonicalMarkdownView.tsx'],
  ['notes.canonical-markdown-preview', 'features/notes/markdown/CanonicalMarkdownPreview.tsx'],
  ['notes.note-append', 'features/notes/append/NoteAppendSession.ts'],
  ['reader.annotation-location', 'features/reader/navigation/annotationLocation.ts'],
  ['reader.canonical-capture', 'features/reader/pdf/canonicalPdfCapture.ts'],
  ['library.catalog-session', 'features/library/LibrarySession.ts'],
  ['library.deleted-content-comparison', 'features/library/recovery/DeletedContentComparisonSession.ts'],
  ['reader.document-page-preview', 'features/reader/CanonicalDocumentPagePreview.tsx'],
  ['reader.canonical-annotation-editor', 'features/reader/annotations/CanonicalAnnotationEditor.tsx'],
  ['reader.canonical-pdf-surface', 'features/reader/pdf/PdfSurface.tsx'],
  ['reader.canonical-document-surface', 'features/reader/CanonicalDocumentSurface.tsx'],
  ['reader.canonical-pdf-asset', 'features/reader/useDocumentPdfAsset.ts'],
  ['reader.canonical-pdf-text-binding', 'features/reader/pdf/useCanonicalPdfTextBinding.ts'],
  ['reader.canonical-pdf-highlight', 'features/reader/pdf/canonicalPdfHighlight.ts'],
  ['reader.attachment-resource', 'features/reader/attachmentResource.ts'],
  ['reader.library-content-kind', 'features/reader/libraryContentKind.ts'],
  ['library.query-session', 'features/library/query/LibraryQuerySession.ts'],
  ['library.annotation-browser', 'features/library/annotations/AnnotationBrowserSession.ts'],
  ['library.canonical-tree', 'features/library/tree/canonicalLibraryTree.ts'],
  ['workspace.command-session', 'features/workspace/WorkspaceCommandSession.ts'],
  ['workspace.command-context', 'features/workspace/WorkspaceCommandContext.tsx'],
  ['workspace.related-projection', 'features/workspace/related/relatedContent.ts'],
  ['workspace.related-panel', 'features/workspace/related/RelatedContentPanel.tsx'],
  ['workspace.reader-frame', 'features/workspace/CanonicalReaderFrame.tsx'],
  ['workspace.preferences-session', 'features/workspace/WorkspaceSession.ts'],
  ['workspace.preferences-view', 'features/workspace/WorkspacePreferences.tsx'],
  ['edits.intent-journal', 'runtime/edits/intentJournal.ts'],
  ['edits.dataset-control', 'runtime/edits/datasetControl.ts'],
  ['bootstrap.session', 'features/bootstrap/BootstrapSession.ts'],
  ['bootstrap.connection', 'features/bootstrap/BootstrapConnection.tsx'],
  ['bootstrap.initial-request', 'features/bootstrap/initialRequest.ts'],
  ['runtime.io-gate', 'runtime/lifecycle/RuntimeIoGate.ts'],
];
/** Reached from one entry only. Whether the difference is a host-design difference is NOT established (the registry has no per-host annotation). */
const STAGED_WEB_ONLY = [
  ['edits.repository', 'runtime/edits/repository.ts'],
  ['edits.dataset-publication', 'runtime/edits/datasetPublication.ts'],
  ['edits.canonical-bootstrap', 'runtime/edits/canonicalBootstrap.ts'],
  ['edits.canonical-initialization-intent', 'runtime/edits/canonicalInitializationIntent.ts'],
  ['edits.canonical-initialization-read-proof', 'runtime/edits/canonicalInitializationReadProof.ts'],
  ['edits.canonical-local-grant', 'runtime/edits/canonicalLocalGrant.ts'],
];
const STAGED_PC_ONLY = [
  ['migration.legacy-annotations', 'migrations/legacyAnnotations.ts'],
];
/** 未整理: reached from neither entry by runtime imports. Third column = reach when type-only imports are also followed (pinned separately because a
 * type-only edge is not an execution edge). Each of these carries a `note` in the registry (checked below). */
const STAGED_NONE_UNSORTED = [
  ['notes.edit-session', 'features/notes/noteEditSession.ts', 'none'],
  ['notes.markdown-editor', 'features/notes/markdown/MarkdownSessionEditor.tsx', 'none'],
  ['notes.handwriting-editor', 'features/notes/HandwrittenNote.tsx', 'none'],
  ['edits.conflict-session', 'features/reader/ConflictSession.ts', 'none'],
  ['edits.checkpoint-publication', 'runtime/edits/checkpointPublication.ts', 'web'],
  ['reader.page-mapping', 'features/reader/pageMapping.ts', 'none'],
  ['edits.canonical-initialization-storage', 'runtime/edits/canonicalInitializationStorage.ts', 'both'],
  ['edits.dataset-transition-session', 'runtime/edits/DatasetTransitionSession.ts', 'none'],
  ['migration.legacy-backup', 'migrations/legacyBackup.ts', 'web'],
  ['migration.stored-backup', 'migrations/storedLegacyBackup.ts', 'web'],
  ['migration.legacy-drive', 'migrations/legacyDrive.ts', 'web'],
];

const rows = [
  ...CONNECTED_BOTH.map(([id, source]) => ({ id, source, connection: 'connected', expected: 'both' })),
  ...STAGED_BOTH.map(([id, source]) => ({ id, source, connection: 'staged', expected: 'both' })),
  ...STAGED_WEB_ONLY.map(([id, source]) => ({ id, source, connection: 'staged', expected: 'web' })),
  ...STAGED_PC_ONLY.map(([id, source]) => ({ id, source, connection: 'staged', expected: 'pc' })),
  ...STAGED_NONE_UNSORTED.map(([id, source]) => ({ id, source, connection: 'staged', expected: 'none' })),
];

test('CURRENT STATE: the registry has 62 entries = 4 connected + 58 staged (40 both + 7 one-sided + 11 unreachable 未整理)', () => {
  assert.equal(registry.entries.length, 62);
  assert.equal(registry.entries.filter(entry => entry.connection === 'connected').length, 4);
  assert.equal(registry.entries.filter(entry => entry.connection === 'staged').length, 58);
  assert.equal(CONNECTED_BOTH.length, 4);
  assert.equal(STAGED_BOTH.length, 40);
  assert.equal(STAGED_WEB_ONLY.length + STAGED_PC_ONLY.length, 7);
  assert.equal(STAGED_NONE_UNSORTED.length, 11);
  assert.equal(rows.length, 62);
  assert.equal(new Set(registry.entries.map(entry => entry.id)).size, 62, 'ids are unique');
  assert.equal(new Set(registry.entries.map(entry => entry.source)).size, 62, 'sources are unique');
});

test('CURRENT STATE: every registry entry is pinned with the same id, source and connection, and its source module exists', () => {
  assert.deepEqual(registry.entries.map(entry => [entry.id, entry.source, entry.connection]).sort(),
    rows.map(row => [row.id, row.source, row.connection]).sort());
  for (const entry of registry.entries) assert.ok(existsSync(path.join(src, entry.source)), `source module does not exist: ${entry.id} -> ${entry.source}`);
});

test('CURRENT STATE: reach from the PC entry and the Web entry matches the pinned table for every entry (both / one side / none)', () => {
  const wrong = rows.filter(row => reach(row.source) !== row.expected).map(row => `${row.id}: pinned ${row.expected}, actual ${reach(row.source)}`);
  assert.deepEqual(wrong, [], 'the import graph or the registry changed: re-pin on purpose (a newly reachable 未整理 entry is progress, not a failure of the product)');
  const groups = Object.fromEntries(['both', 'pc', 'web', 'none'].map(side => [side, registry.entries.filter(entry => reach(entry.source) === side).length]));
  assert.deepEqual(groups, { both: 44, pc: 1, web: 6, none: 11 });
});

test('connected entries are reachable from both entries (pinned independently of sharedEntries.test.mjs)', () => {
  for (const [id, source] of CONNECTED_BOTH) assert.ok(pc.has(source) && web.has(source), id);
});

test('CURRENT STATE: 11 staged entries are reached from neither entry at runtime and are pinned as 未整理 (this is not an acceptance of them)', () => {
  const unsorted = registry.entries.filter(entry => !pc.has(entry.source) && !web.has(entry.source));
  assert.deepEqual(unsorted.map(entry => entry.id).sort(), STAGED_NONE_UNSORTED.map(([id]) => id).sort());
  for (const entry of unsorted) assert.equal(entry.connection, 'staged', `${entry.id} must stay staged`);
  // Each 未整理 entry carries a registry note that says so, and nothing else carries one (a note elsewhere means this table is out of date).
  const noted = registry.entries.filter(entry => entry.note !== undefined);
  assert.deepEqual(noted.map(entry => entry.id).sort(), STAGED_NONE_UNSORTED.map(([id]) => id).sort());
  for (const entry of noted) assert.ok(typeof entry.note === 'string' && entry.note.startsWith('未整理'), `${entry.id}: note must start with 未整理`);
});

test('CURRENT STATE: reach of the 未整理 entries when type-only imports are also followed (type-only edges are not execution edges)', () => {
  const wrong = STAGED_NONE_UNSORTED.filter(([, source, typed]) => reach(source, pcTypes, webTypes) !== typed)
    .map(([id, source, typed]) => `${id}: pinned ${typed}, actual ${reach(source, pcTypes, webTypes)}`);
  assert.deepEqual(wrong, []);
});

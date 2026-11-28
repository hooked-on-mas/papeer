import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { moduleGraph } from './boundaryVerifier.mjs';
import { typeInclusiveFiles } from './typeInclusiveGraph.mjs';

// Work B13-h. These tests PIN THE CURRENT STATE (現状値の固定) of the import graph of the two ordinary entries. They are the Web counterpart of
// desktopEntryGraph.test.mjs. They do not claim that the legacy shell is retired or that any feature works: they only fix which modules the
// entries import (a static, literal-import approximation; see boundaryVerifier.mjs). Removing a legacy file in P6.4 means deleting its line here.
const src = path.resolve(import.meta.dirname, '../src');
const rel = file => path.relative(src, file).split(path.sep).join('/');
const memo = (cache, entry, build) => cache.get(entry) ?? (cache.set(entry, build()), cache.get(entry));
const runtimeCache = new Map(), typeCache = new Map();
const runtime = entry => memo(runtimeCache, entry, () => new Set([...moduleGraph(path.join(src, entry), src).files].map(rel)));
const withTypes = entry => memo(typeCache, entry, () => new Set([...typeInclusiveFiles(path.join(src, entry), src)].map(rel)));

/** Legacy-shell modules (typed literally, not derived from the graph). Every one exists today: a typo or a deletion fails the test below. */
const LEGACY_MODULES = ['app/lazyPanes.tsx', 'shell/index.ts', 'store/index.ts', 'store/persisted.ts', 'api/client.ts',
  'api/connection.ts', 'lib/migrateStorage.ts', 'App.tsx', 'web/WebLibrary.tsx', 'web/WebNotes.tsx',
  'web/LegacyWebLibraryConnection.tsx', 'web/LegacyDocumentReaderConnection.tsx', 'web/LegacyPdfReaderConnection.tsx'];
/** Directories whose files exist only for the legacy shell. */
const LEGACY_DIRECTORIES = ['shell/', 'store/', 'api/', 'features/summary/', 'features/chat/', 'features/references/', 'features/ocr/', 'features/settings/', 'features/documents/'];
/** The host-specific capability tables (webLibraryCapabilities etc. hold permanent `false` entries) and their consumers. */
const CAPABILITY_MODULES = ['runtime/capabilities.ts', 'lib/itemKinds.ts', 'web/libraryRuntime.ts'];

/** Pure check, so that it can be exercised on synthetic file lists below. */
function legacyReached(files, modules = LEGACY_MODULES, directories = LEGACY_DIRECTORIES) {
  return [...files].filter(file => modules.includes(file) || directories.some(directory => file.startsWith(directory))).sort();
}

test('the checker names a legacy module that an entry would import (it is not vacuous)', () => {
  assert.deepEqual(legacyReached(new Set(['web/main.tsx', 'shell/index.ts'])), ['shell/index.ts']);
  assert.deepEqual(legacyReached(new Set(['web/main.tsx', 'api/client.ts', 'store/index.ts', 'features/chat/ChatPane.tsx'])), ['api/client.ts', 'features/chat/ChatPane.tsx', 'store/index.ts']);
  assert.deepEqual(legacyReached(new Set(['web/main.tsx', 'web/WebApp.tsx', 'app/startup.ts'])), []);
  const root = mkdtempSync(path.join(tmpdir(), 'web-entry-graph-'));
  try {
    mkdirSync(path.join(root, 'web')); mkdirSync(path.join(root, 'shell')); mkdirSync(path.join(root, 'types'));
    writeFileSync(path.join(root, 'shell/index.ts'), 'export const shell = 1;\n');
    writeFileSync(path.join(root, 'types/shape.ts'), 'export type Shape = { a: 1 };\n');
    writeFileSync(path.join(root, 'web/main.tsx'), "import '../shell/index.ts';\nimport type { Shape } from '../types/shape.ts';\nexport type { Shape };\n");
    const runtimeFiles = [...moduleGraph(path.join(root, 'web/main.tsx'), root).files].map(file => path.relative(root, file).split(path.sep).join('/'));
    const typeFiles = [...typeInclusiveFiles(path.join(root, 'web/main.tsx'), root)].map(file => path.relative(root, file).split(path.sep).join('/'));
    assert.deepEqual(legacyReached(runtimeFiles), ['shell/index.ts']);
    assert.ok(typeFiles.includes('types/shape.ts') && !runtimeFiles.includes('types/shape.ts'), 'a type-only import is a type-graph edge and not a runtime edge');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Web normal entry reaches the common bootstrap composition (positive control for the graph below)', () => {
  const files = runtime('web/main.tsx');
  for (const required of ['web/WebApp.tsx', 'web/bootstrapComposition.ts', 'app/startup.ts', 'adapters/browser/bootstrapHostDriver.ts',
    'features/bootstrap/BootstrapConnection.tsx', 'features/bootstrap/BootstrapSession.ts', 'runtime/lifecycle/RuntimeIoGate.ts'])
    assert.ok(files.has(required), `missing ${required}`);
});

test('CURRENT STATE: Web normal entry reaches no legacy shell, store, api client or legacy-only feature, by runtime imports and even counting type imports', () => {
  for (const file of [...LEGACY_MODULES, ...CAPABILITY_MODULES]) assert.ok(existsSync(path.join(src, file)), `pinned module no longer exists (update this test): ${file}`);
  for (const directory of LEGACY_DIRECTORIES) assert.ok(existsSync(path.join(src, directory)), `pinned directory no longer exists (update this test): ${directory}`);
  assert.deepEqual(legacyReached(runtime('web/main.tsx')), []);
  assert.deepEqual(legacyReached(withTypes('web/main.tsx')), []);
  // Under app/ the Web entry imports exactly the guarded startup; nothing of the old shell wiring.
  assert.deepEqual([...runtime('web/main.tsx')].filter(file => file.startsWith('app/')), ['app/startup.ts']);
  assert.deepEqual([...runtime('web/main.tsx')].filter(file => /^web\/(Legacy|WebLibrary|WebNotes)/.test(file)), []);
});

test('CURRENT STATE: neither normal entry reaches the host capability table (runtime/capabilities.ts and its consumers); permanent-false rows are not on any ordinary path', () => {
  for (const entry of ['main.tsx', 'web/main.tsx']) {
    assert.deepEqual(CAPABILITY_MODULES.filter(file => runtime(entry).has(file)), [], `${entry} runtime`);
    assert.deepEqual(CAPABILITY_MODULES.filter(file => withTypes(entry).has(file)), [], `${entry} with types`);
  }
});

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { moduleGraph } from './boundaryVerifier.mjs';

const src = path.resolve(import.meta.dirname, '../src');
const rel = file => path.relative(src, file).split(path.sep).join('/');

test('PC normal entry reaches the common bootstrap composition and no legacy editor, store or test-only support', () => {
  const files = [...moduleGraph(path.join(src, 'main.tsx'), src).files].map(rel);
  for (const required of ['DesktopApp.tsx', 'adapters/desktop/DesktopBootstrapApp.tsx', 'adapters/desktop/bootstrapEntry.ts',
    'adapters/desktop/bootstrapHostDriver.ts', 'adapters/desktop/canonicalBootstrapWire.ts', 'adapters/desktop/desktopWindowClose.ts',
    'features/bootstrap/BootstrapConnection.tsx', 'features/bootstrap/BootstrapSession.ts', 'runtime/lifecycle/RuntimeIoGate.ts'])
    assert.ok(files.includes(required), `missing ${required}`);
  for (const forbidden of ['app/LegacyDesktopConnection.tsx', 'store/index.ts', 'api/client.ts', 'lib/migrateStorage.ts'])
    assert.ok(!files.includes(forbidden), `legacy module reachable: ${forbidden}`);
  assert.deepEqual(files.filter(file => /raw-core|(^|\/)e2e\//.test(file)), []);
});

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { boundaryViolations, graphBoundaryViolations, moduleGraph } from './boundaryVerifier.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/boundaries.json', import.meta.url), 'utf8'));
for (const fixture of fixtures) test(`boundary fixture: ${fixture.name}`, () => {
  const errors = boundaryViolations(fixture.source, { layer: fixture.layer });
  assert.equal(errors.length > 0, fixture.reject, errors.join('\n'));
});

test('pure parser package approval is exact and does not permit host globals or package subpaths', () => {
  const allowedPackages = ['unified', 'remark-parse'];
  assert.deepEqual(boundaryViolations("import { unified } from 'unified'; import parse from 'remark-parse';", { allowedPackages }), []);
  assert.ok(boundaryViolations("import { unified } from 'unified'; fetch('/save');", { allowedPackages }).some(error => error.includes('fetch')));
  assert.ok(boundaryViolations("import x from 'unified/host';", { allowedPackages }).some(error => error.includes('unified/host')));
  assert.ok(boundaryViolations("import x from 'unified';").some(error => error.includes('unified')));
});

test('transitive helper violations cannot disappear at the external-package graph boundary', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'papeer-boundary-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('papeer-boundary-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, 'session.ts');
  writeFileSync(root, "export { save } from './helper';\n");
  writeFileSync(path.join(directory, 'helper.ts'), "import { invoke } from '@tauri-apps/api/core'; export const save = () => { window.localStorage.clear(); fetch('/api/save'); };\n");
  const errors = graphBoundaryViolations(root, directory);
  for (const pattern of ['@tauri-apps/api/core', 'window', 'fetch']) assert.ok(errors.some(error => error.includes(pattern)), errors.join('\n'));
});


test('only literal module Worker URLs add graph edges', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'papeer-worker-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir())); rmSync(directory,{recursive:true,force:true}); });
  const root=path.join(directory,'entry.ts');
  writeFileSync(root, `import './ordinary.ts'; new Worker(new URL('./worker.ts', import.meta.url), {type:'module'}); new Worker(new URL(name, import.meta.url)); new URL('./asset.ts', import.meta.url); new Worker(new URL('./image.png', import.meta.url));`);
  for (const file of ['ordinary.ts','worker.ts','asset.ts']) writeFileSync(path.join(directory,file),'export {};');
  const graph=moduleGraph(root,directory);
  assert.deepEqual([...graph.files].map(file=>path.basename(file)).sort(),['entry.ts','ordinary.ts','worker.ts']);
});

test('worker envelope permits only self message dispatch, never host operations', () => {
  assert.deepEqual(boundaryViolations('self.onmessage = e => self.postMessage(e.data)', {layer:'worker'}), []);
  for (const code of ['self.fetch("/")','self.location','self[method]()','fetch("/")','self.postMessage.call(null, 1)'])
    assert.ok(boundaryViolations(code,{layer:'worker'}).length,code);
});

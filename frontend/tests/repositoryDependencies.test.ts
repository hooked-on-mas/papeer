import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { repositoryDependencies, seedRepositoryReads } from '../src/runtime/edits/repositoryDependencies.ts';
import { EditPlanView, selectorKey, type ScopeRead } from '../src/runtime/edits/repositoryPlan.ts';
import { EditPlanMemoryDatabase } from './support/editPlanMemoryDatabase.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const scope = fixture.datasetManifest.scope;

test('dataset proof reads exactly manifest resource IDs and hashes', async () => {
  const db = new EditPlanMemoryDatabase(), reads = seedRepositoryReads(scope, 'installDataset', [fixture.datasetManifest, fixture.checkpoint]);
  const view = new EditPlanView(scope, await db.capture('install-dataset', reads));
  const dependencies = repositoryDependencies(view, 'installDataset', [fixture.datasetManifest, fixture.checkpoint]);
  const bytes = dependencies.filter(value => value.kind === 'resource-bytes');
  assert.deepEqual(bytes.map(value => value.kind === 'resource-bytes' ? value.sha256 : '').sort(), fixture.datasetManifest.resources.map((value: { sha256: string }) => value.sha256).sort());
});

test('readResource closes metadata and matching hash in one recapture', async () => {
  const db = new EditPlanMemoryDatabase(), metadata = fixture.resource.metadata;
  db.mutate({ kind: 'put-resource', scope, resource: { metadata, bytes: Uint8Array.of(1) } });
  const snapshot = await db.capture('read-resource', seedRepositoryReads(scope, 'readResource', [metadata.id]));
  const dependencies = repositoryDependencies(new EditPlanView(scope, snapshot), 'readResource', [metadata.id]);
  assert.ok(dependencies.some(value => value.kind === 'resource-bytes' && value.sha256 === metadata.sha256));
});

test('transition seeds cover complete source and target predicates', () => {
  const control = fixture.datasetControls.initial[0], selected = control.transition.publication.manifest.scope;
  const reads = seedRepositoryReads(scope, 'replaceDatasetControl', [control, null]);
  for (const kind of ['roots', 'edits', 'intents', 'datasets'] as const) {
    const expected: ScopeRead = { kind, scope: selected };
    assert.ok(reads.some(read => selectorKey(read) === selectorKey(expected)), kind);
  }
});

test('ordinary read and resource metadata never request byte bodies', async () => {
  const db = new EditPlanMemoryDatabase();
  for (const [method, args] of [['read', [fixture.document.id]], ['resourceMetadata', [fixture.resource.metadata.id]]] as const) {
    const reads = seedRepositoryReads(scope, method, args), view = new EditPlanView(scope, await db.capture('read', reads));
    assert.ok(![...reads, ...repositoryDependencies(view, method, args)].some(read => read.kind === 'resource-bytes'));
  }
});

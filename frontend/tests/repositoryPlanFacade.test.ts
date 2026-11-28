import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createPlannedRepositoryDraft, type RepositoryOperationHost } from '../src/runtime/edits/repositoryFacadeDraft.ts';
import { createPlanEvidence, fingerprintPlanInput, type NativeAttemptEvidence, type RepositoryExecutionEvidence } from '../src/runtime/edits/repositoryExecution.ts';
import { EditPlanMemoryDatabase } from './support/editPlanMemoryDatabase.ts';
import { createPlanTestRepository } from './support/editPlanTestRepository.ts';
import type { ContentPublication } from '../src/runtime/edits/contracts.ts';
import type { EditMutation } from '../src/runtime/edits/repositoryPlan.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const bytes = Uint8Array.from(readFileSync(new URL(`../../tests/fixtures/${fixture.resource.file}`, import.meta.url)));
const scope = fixture.datasetManifest.scope;
function setup() {
  const db = new EditPlanMemoryDatabase();
  const controls = { failDelivery: false, attempt: undefined as NativeAttemptEvidence | undefined, prior: [] as NativeAttemptEvidence[], calls: [] as RepositoryExecutionEvidence[], captures: 0, applies: 0, outcomes: [] as string[], bundles: [] as EditMutation[][], beforeApply: undefined as (() => Promise<void>) | undefined };
  const host: RepositoryOperationHost = {
    createEvidence: (_op, fixed) => { const evidence = createPlanEvidence(JSON.stringify(fixed), controls.prior); controls.calls.push(evidence.view); return evidence; },
    run: async (operation, evidence, action) => {
      const recorder = evidence.bind({});
      const tracked = { capture: async (...args: Parameters<typeof db.capture>) => { controls.captures++; return db.capture(...args); }, compareAndApply: async (...args: Parameters<typeof db.compareAndApply>) => {
        controls.applies++; controls.bundles.push(structuredClone([...args[1].mutations]));
        const attempt = recorder.startAttempt();
        const before = controls.beforeApply; controls.beforeApply = undefined; if (before) await before();
        if (controls.attempt) {
          if (controls.attempt !== 'not-sent') attempt.sent();
          if (controls.attempt === 'cas-no-write') attempt.casNoWrite();
          if (controls.attempt === 'aborted') attempt.aborted();
          if (controls.attempt === 'unknown') attempt.unknown();
          if (controls.attempt === 'committed') attempt.committed();
          throw new Error('native-failure');
        }
        attempt.sent();
        try {
          const result = await db.compareAndApply(...args); controls.outcomes.push(result.status);
          if (result.status === 'changed') attempt.casNoWrite(); else attempt.committed();
          return result;
        } catch (error) { attempt.aborted(); throw error; }
      } };
      const result = await action(tracked);
      if (controls.failDelivery) throw new Error(`stale-${operation}`);
      return result;
    },
  };
  const repo = createPlannedRepositoryDraft(scope, host, { inspectPdf: async () => fixture.resource.metadata.pdfPages });
  return { db, repo, controls };
}

test('repository facade covers roots, commit, receipts, pending records, and acknowledgements', async () => {
  const { repo } = setup();
  await repo.initialize(fixture.document);
  assert.equal((await repo.read(fixture.document.id)).checkpoint.root.id, fixture.document.id);
  assert.equal((await repo.commit(fixture.batches[0])).status, 'durable');
  assert.equal((await repo.commit(fixture.batches[0])).status, 'durable');
  assert.equal((await repo.receipt(fixture.batches[0].id))?.upload, 'pending');
  assert.equal((await repo.pending()).length, 1); assert.equal((await repo.pendingRecords()).length, 1);
  assert.deepEqual(await repo.pendingPublications(), []);
  await repo.acknowledgeImport(fixture.batches[0].id, 'peer');
  await repo.acknowledgeUpload(fixture.batches[0].id);
  assert.deepEqual((await repo.receipt(fixture.batches[0].id))?.importedBy, ['peer']);
  assert.deepEqual(await repo.pending(), []);
});

test('intent CAS preserves caller expected ID and exposes absence', async () => {
  const { repo } = setup(), id = fixture.document.id, first = fixture.intents[0], second = fixture.intents[1];
  assert.equal(await repo.readIntent(id), undefined);
  assert.equal((await repo.replaceIntent(id, first, null)).status, 'written');
  assert.equal((await repo.replaceIntent(id, second, null)).status, 'conflict');
  assert.equal((await repo.pendingIntents()).length, 1);
  assert.equal((await repo.replaceIntent(id, null, first.id)).status, 'cleared');
});

test('resource and checkpoint methods preserve payloads and marker idempotence', async () => {
  const { repo } = setup();
  await repo.storeResource({ ...fixture.resource.metadata, bytes });
  assert.deepEqual(await repo.resourceMetadata(fixture.resource.metadata.id), fixture.resource.metadata);
  assert.deepEqual((await repo.readResource(fixture.resource.metadata.id))?.bytes, bytes);
  await repo.installCheckpoint(fixture.checkpoint);
  const before = await repo.checkpoint(); await repo.installCheckpoint(fixture.checkpoint);
  assert.deepEqual(await repo.checkpoint(), before);
  await repo.receive([]); await repo.receiveRecords([]); await repo.receivePublications([]);
});

test('publication, dataset and control paths reuse the fixed request', async () => {
  const { repo } = setup();
  for (const key of ['document', 'markdown', 'library']) await repo.initialize(fixture[key]);
  await repo.storeResource({ ...fixture.resource.metadata, bytes });
  assert.equal((await repo.publish(fixture.publications[0].value)).status, 'durable');
  assert.equal((await repo.pendingPublications()).length, 1);
  const { repo: target } = setup(); await target.storeResource({ ...fixture.resource.metadata, bytes });
  assert.equal((await target.replaceDatasetControl(fixture.datasetControls.initial[0], null)).status, 'written');
  await target.installDataset(fixture.datasetManifest, fixture.checkpoint);
  assert.equal((await target.installedDatasets()).length, 1);
  assert.deepEqual(await target.datasetControl(), fixture.datasetControls.initial[0]);
});

test('outer delivery after a durable attempt is unknown, never a disclosed receipt', async () => {
  const { repo, controls } = setup(); await repo.initialize(fixture.document); controls.failDelivery = true;
  const result = await repo.commit(fixture.batches[0]); assert.equal(result.status, 'unknown');
  assert.ok(controls.calls[controls.calls.length - 1]!.attempts.includes('committed'));
});

test('native failure is nonterminal unknown and retains the fixed request fingerprint', async () => {
  const { repo, controls } = setup(); await repo.initialize(fixture.document); controls.attempt = 'aborted';
  const batch = structuredClone(fixture.batches[0]); const result = await repo.commit(batch); batch.id = 'mutated';
  assert.equal(result.status, 'unknown'); assert.ok(controls.calls[controls.calls.length - 1]!.requestFingerprint.includes(fixture.batches[0].id));
});

test('resource hash-key corruption is rejected without replacing the corrupt bytes', async () => {
  const { db, repo } = setup();
  await repo.storeResource({ ...fixture.resource.metadata, bytes });
  const corrupt = Uint8Array.from(bytes); corrupt[0] ^= 255;
  db.mutate({ kind: 'put-resource', scope, resource: { metadata: fixture.resource.metadata, bytes: corrupt } });
  await assert.rejects(repo.storeResource({ ...fixture.resource.metadata, bytes }), /resource-hash/);
  await assert.rejects(repo.readResource(fixture.resource.metadata.id), /resource-hash/);
});

test('stale read delivery suppresses resource metadata and bytes', async () => {
  const { repo, controls } = setup();
  await repo.storeResource({ ...fixture.resource.metadata, bytes }); controls.failDelivery = true;
  await assert.rejects(repo.readResource(fixture.resource.metadata.id), /stale-read-resource/);
});

test('a competing valid edit forces CAS retry with the exact same request and operation', async () => {
  const { db, repo, controls } = setup();
  await repo.initialize(fixture.document); await repo.initialize(fixture.markdown);
  const other = createPlanTestRepository(scope, db), batch = structuredClone(fixture.batches[0]);
  const startCalls = controls.calls.length, startOutcomes = controls.outcomes.length, startBundles = controls.bundles.length;
  controls.beforeApply = async () => { assert.equal((await other.commit(fixture.batches[7])).status, 'durable'); };
  const pending = repo.commit(batch); batch.id = 'caller-mutation';
  const result = await pending;
  assert.equal(result.status, 'durable'); assert.equal(controls.calls.length, startCalls + 1);
  assert.deepEqual(controls.outcomes.slice(startOutcomes), ['changed', 'committed']);
  const plannedBatches = controls.bundles.slice(startBundles).map(bundle => bundle.find(mutation => mutation.kind === 'put-edit'));
  assert.equal(plannedBatches.length, 2);
  for (const mutation of plannedBatches) {
    assert.ok(mutation && mutation.kind === 'put-edit');
    assert.deepEqual(mutation.edit.batch, fixture.batches[0]);
  }
  assert.deepEqual(plannedBatches[0], plannedBatches[1]);
  assert.ok(controls.calls[controls.calls.length - 1]!.requestFingerprint.includes(fixture.batches[0].id));
});


test('a prior unconfirmed attempt prevents terminal rejection of the same request', async () => {
  const { repo, controls } = setup(); controls.prior = ['unknown'];
  const bad = structuredClone(fixture.batches[0]); bad.libraryId = 'invalid';
  assert.equal((await repo.commit(bad)).status, 'unknown');
});

test('a local validation rejection without uncertain prior attempts is terminal', async () => {
  const { repo } = setup(); const bad = structuredClone(fixture.batches[0]); bad.libraryId = 'invalid';
  assert.equal((await repo.commit(bad)).status, 'aborted');
});
for (const attempt of ['not-sent', 'cas-no-write', 'sent', 'aborted', 'unknown', 'committed'] as const) {
  test(`attempt evidence ${attempt} never turns a storage failure into a terminal abort`, async () => {
    const { repo, controls } = setup(); await repo.initialize(fixture.document); controls.attempt = attempt;
    const result = await repo.commit(fixture.batches[0]);
    assert.equal(result.status, 'unknown'); assert.deepEqual(controls.calls[controls.calls.length - 1]!.attempts, [attempt]);
  });
}

test('enumerated facade methods survive repository spreading', async () => {
  const { repo } = setup(), spread = { ...repo };
  assert.equal(typeof spread.commit, 'function'); assert.equal(typeof spread.readIntent, 'function');
  await spread.initialize(fixture.document); assert.equal((await spread.read(fixture.document.id)).checkpoint.root.id, fixture.document.id);
});


for (const [label, publication] of [['null', null], ['undefined', undefined], ['missing batch', {}]] as const) {
  test(`malformed publication ${label} is rejected before native capture or apply`, async () => {
    const { repo, controls } = setup();
    const result = await repo.publish(publication as unknown as ContentPublication);
    assert.equal(result.status, 'aborted');
    assert.equal(controls.captures, 0); assert.equal(controls.applies, 0);
  });
  test(`malformed publication ${label} retains unknown for an earlier uncertain attempt`, async () => {
    const { repo, controls } = setup(); controls.prior = ['unknown'];
    const result = await repo.publish(publication as unknown as ContentPublication);
    assert.equal(result.status, 'unknown');
    assert.equal(controls.captures, 0); assert.equal(controls.applies, 0);
  });
}

test('operation-bound controller exposes immutable snapshots and preserves prior uncertainty', () => {
  const evidence = createPlanEvidence('fixed-request', ['unknown']), operation = {};
  const snapshot = evidence.view.attempts;
  assert.ok(Object.isFrozen(evidence.view)); assert.ok(Object.isFrozen(snapshot));
  assert.equal(Reflect.set(evidence.view, 'requestFingerprint', 'changed'), false);
  assert.equal(Reflect.set(snapshot, '0', 'aborted'), false);
  const bound = evidence.bind(operation), attempt = bound.startAttempt();
  assert.deepEqual(snapshot, ['unknown']);
  attempt.sent(); attempt.aborted();
  assert.deepEqual(evidence.view.attempts, ['unknown', 'aborted']);
  assert.equal(evidence.view.requestFingerprint, 'fixed-request');
  assert.throws(() => evidence.bind(operation), /already-bound/);
  assert.throws(() => createPlanEvidence('other').bind(operation), /already-bound/);
});

test('attempt evidence records CAS zero and durable completion independently', () => {
  const evidence = createPlanEvidence('one-request'), recorder = evidence.bind({});
  const first = recorder.startAttempt(); first.sent(); first.casNoWrite();
  const second = recorder.startAttempt(); second.sent(); second.committed();
  assert.deepEqual(evidence.view.attempts, ['cas-no-write', 'committed']);
  assert.throws(() => first.committed(), /invalid-transition/);
});

test('late native abort can resolve an unknown attempt without erasing an older unknown', () => {
  const evidence = createPlanEvidence('same-request', ['unknown']), recorder = evidence.bind({});
  const attempt = recorder.startAttempt(); attempt.sent(); attempt.unknown(); attempt.aborted();
  assert.deepEqual(evidence.view.attempts, ['unknown', 'aborted']);
});

test('fingerprintPlanInput summarizes binary payloads without expanding Uint8Array elements', () => {
  const digest = 'a'.repeat(64);
  const fingerprint = fingerprintPlanInput('store-resource', [{
    id: 'res-1',
    sha256: digest,
    mediaType: 'application/pdf',
    bytes: new Uint8Array(2 * 1024 * 1024),
  }]);
  assert.ok(fingerprint.includes('res-1'));
  assert.ok(fingerprint.includes(digest));
  assert.ok(fingerprint.includes('2097152'));
  assert.ok(fingerprint.includes('__bytes'));
  assert.ok(fingerprint.length < 500);
});

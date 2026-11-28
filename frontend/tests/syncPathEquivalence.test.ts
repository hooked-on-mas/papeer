// B13-d U5: the one-pass checks of the sync paths (repository.ts installCheckpointIn / receiveRecords + EditGraph.visitMaterialized) change NO
// observable result. Compared with verbatim copies of the pre-U5 files (tests/support/repositoryLegacy.ts + editGraphLegacy.ts, sha256-checked
// against the HEAD blobs): the outcome of every operation (ok, or exception class + complete message), the complete write trace (also the
// writes made before an exception inside a transaction that aborts), the committed database state and argument immutability. Also: the call
// counts that U5 reduces (regression guard, no timing) and the detection power of the differential itself (deliberately broken copies).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EditGraph } from '../src/runtime/edits/editGraph.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import type { EditRecord, LibraryEditBatch, Snapshot } from '../src/runtime/edits/contracts.ts';
import { DurableEditRepository as LegacyRepository } from './support/repositoryLegacy.ts';
import { boundaryScenarios, compareScenario, generateWorld, harmlessChanges, makeRng, newTally, RecordingDatabase, scenarioFrom, stable, uuid,
  type Scenario, type SyncRepositoryClass, type Tally } from './support/syncPathDifferential.ts';
import { instrumentedSyncPath, LEGACY_FILES, PRODUCT_FILES, type SourceMutation } from './support/syncPathInstrument.ts';

/** sha256 of the pre-U5 files as stored in git (HEAD blobs, LF). Working copies may be CRLF or LF, so every text is normalized to LF first. */
const PREIMAGE = {
  graph: 'ac144510e772a6b707cd25b1b8133b5cc83618ee7531693df05c8d8434f1b70d',
  repository: '090fcf03797fd67ea200232ae0601a40b2c89bfb25855190378b63110620353c',
};
const toLf = (text: string) => text.replace(/\r\n/g, '\n');
const sha256 = (text: string) => createHash('sha256').update(toLf(text), 'utf8').digest('hex');
/** The pre-U5 text a legacy copy stands for: header lines dropped, import specifiers mapped back, line endings normalized. */
const originalText = (text: string) => toLf(text).split(/(?<=\n)/).filter(line => !line.startsWith('// LEGACY-COPY ')).join('')
  .replace(/(from ')\.\/editGraphLegacy\.ts(';)/g, '$1./editGraph.ts$2')
  .replace(/(from ')\.\.\/\.\.\/src\/runtime\/edits\//g, '$1./');
const legacy = LegacyRepository as unknown as SyncRepositoryClass, product = DurableEditRepository as unknown as SyncRepositoryClass;
const show = (tally: Tally) => JSON.stringify(tally.differences.slice(0, 4), null, 1);
const summary = (tally: Tally) => `${tally.compared} compared, ${tally.differing} differing, ${tally.outcomes.size} outcome kinds`;

test('the legacy copies are the verbatim pre-U5 product files (only import specifiers rewritten; line endings normalized to LF)', () => {
  for (const name of ['graph', 'repository'] as const) {
    assert.equal(sha256(originalText(readFileSync(LEGACY_FILES[name], 'utf8'))), PREIMAGE[name], name);
    assert.notEqual(sha256(readFileSync(PRODUCT_FILES[name], 'utf8')), PREIMAGE[name], `the product ${name} file was changed by U5`);
  }
});

test('the preimage check gives the same result for CRLF and LF working copies', () => {
  for (const name of ['graph', 'repository'] as const) {
    const lf = toLf(readFileSync(LEGACY_FILES[name], 'utf8')), crlf = lf.replace(/\n/g, '\r\n');
    assert.ok(!lf.includes('\r') && crlf.includes('\r\n') && !/[^\r]\n/.test(crlf), 'the two variants really differ in line endings');
    assert.equal(sha256(originalText(crlf)), PREIMAGE[name]);
    assert.equal(sha256(originalText(lf)), PREIMAGE[name]);
  }
});

// ---------------------------------------------------------------- differential

async function differential(seed: number, worlds: number, candidate: SyncRepositoryClass, perWorld = 2): Promise<Tally> {
  const rng = makeRng(seed), tally = newTally();
  for (let n = 0; n < worlds; n++) {
    const world = generateWorld(rng, n < 8 ? n : rng.chance(.04) ? 40 + rng.int(31) : rng.int(20));
    for (let k = 0; k < perWorld; k++) await compareScenario(tally, scenarioFrom(world, rng, `w${n}/s${k}`), legacy, candidate);
  }
  return tally;
}

test('random sync histories (seed 20261125) give the same outcomes, write traces and states as the pre-U5 code', async () => {
  // Default 3,000 worlds (~7k comparisons, under 2 minutes); B13D_U5_WORLDS raises it (the recorded full run used 16,000 worlds).
  const tally = await differential(20261125, Number(process.env.B13D_U5_WORLDS ?? 3_000), product);
  console.log(`# sync differential: ${summary(tally)}`);
  console.log(`# outcome kinds: ${JSON.stringify([...tally.outcomes].sort((x, y) => y[1] - x[1]))}`);
  console.log(`# faults used: ${JSON.stringify([...tally.faults].sort((x, y) => y[1] - x[1]))}`);
  console.log(`# reads legacy ${JSON.stringify(tally.reads.legacy)} candidate ${JSON.stringify(tally.reads.candidate)}`);
  assert.equal(tally.differing, 0, show(tally));
  assert.ok(tally.compared > 6_500, `compared ${tally.compared}`);
  for (const expected of ['ok', 'parent-cycle', 'batch-id-reused', 'checkpoint-duplicate-batch', 'missing-or-wrong-content', 'missing-resource', 'publication-item-exists',
    'publication-content-exists', 'publication-pdf-required', 'missing-or-stale-resource', 'missing-or-stale-image-resource', 'Invalid edit data', 'batch-scope',
    'storage-read-failed', 'missing-folder', 'missing-target', 'history-action-order'])
    assert.ok([...tally.outcomes.keys()].some(kind => kind.includes(expected)), `outcome ${expected} never reached`);
  for (const fault of ['missing-content-root', 'wrong-kind-root', 'missing-resource', 'rejected-batch', 'parent-cycle', 'missing-parent', 'duplicate-identical',
    'duplicate-changed', 'publication-item-exists', 'schema-invalid', 'batch-scope', 'read-failure', 'history-action-invalid', 'stale-document-page'])
    assert.ok((tally.faults.get(fault) ?? 0) > 30, `fault ${fault} used ${tally.faults.get(fault) ?? 0} times`);
});

test('sync boundaries (empty history, one batch, only waiting / rejected, empty and duplicate-only arrivals, no library root, B = 60)', async () => {
  const tally = newTally();
  for (const scenario of boundaryScenarios(makeRng(20261126))) await compareScenario(tally, scenario, legacy, product);
  console.log(`# sync boundaries: ${summary(tally)} ${JSON.stringify([...tally.outcomes])}`);
  assert.equal(tally.differing, 0, show(tally));
  assert.ok(tally.compared > 300, `compared ${tally.compared}`);
});

test('EditGraph.visitMaterialized visits every materialized version once, parent first, with the snapshot() content, and changes nothing', async () => {
  const rng = makeRng(20261127); let compared = 0;
  for (let n = 0; n < 400; n++) {
    const world = generateWorld(rng, rng.int(40)), lib = world.scope.libraryId;
    const batches = world.records.filter(record => record.batch.targetId === lib).map(record => record.batch);
    if (rng.chance(.3)) batches.push({ kind: 'library', id: uuid(rng), libraryId: lib, targetId: lib, parents: [uuid(rng)], changes: harmlessChanges(rng) });
    if (rng.chance(.3)) batches.push({ kind: 'library', id: uuid(rng), libraryId: lib, targetId: lib, parents: [world.libraryRoot.version], changes: [{ type: 'remove-folder', id: uuid(rng) }] });
    const graph = new EditGraph({ version: 1, libraryId: lib, root: world.libraryRoot, batches: rng.shuffle(batches) });
    const view = stable(graph.getView()), checkpoint = stable(graph.checkpoint()), seen: string[] = [];
    await graph.visitMaterialized(async (version, snapshot: Snapshot) => {
      const parent = batches.find(batch => batch.id === version)?.parents[0];
      assert.ok(version === world.libraryRoot.version ? seen.length === 0 : seen.includes(parent!), 'root first, then a version after its first parent');
      assert.equal(stable(snapshot), stable(graph.snapshot(version)), 'same content as snapshot()'); compared++;
      seen.push(version);
    });
    const materialized = [world.libraryRoot.version, ...batches.map(batch => batch.id).filter(id => graph.snapshot(id))];
    assert.deepEqual([...seen].sort(), [...new Set(materialized)].sort(), 'each materialized version exactly once');
    assert.equal(stable(graph.getView()), view); assert.equal(stable(graph.checkpoint()), checkpoint);
  }
  console.log(`# visitMaterialized: ${compared} visited versions compared`);
  assert.ok(compared > 4_000);
});

// ---------------------------------------------------------------- call counts (regression guard; no timing)

/** A UI-shaped history: 30 publications (markdown items with content roots, history records, random UUID ids) and one incoming update. */
function uiHistory(branch = false) {
  const rng = makeRng(20261128), world = generateWorld(rng, 0), lib = world.scope.libraryId, records: EditRecord[] = [];
  let head = world.libraryRoot.version;
  const roots: Snapshot[] = [world.libraryRoot];
  for (let n = 0; n < 30; n++) {
    const id = uuid(rng), content = { kind: 'markdown' as const, id, version: uuid(rng), content: `body ${n}`, appendIds: [], imageResources: [] };
    const batch: LibraryEditBatch = { kind: 'library', id: uuid(rng), libraryId: lib, targetId: lib, parents: [head],
      changes: [{ type: 'put-item', item: { id, kind: 'markdown', title: `item ${n}`, ownerId: null, folderId: null, position: n, tags: [], read: false, metadata: {} } }] };
    records.push({ batch, history: { operationId: batch.id, beforeVersion: head, afterVersion: batch.id, undoRequested: false }, publication: { libraryBatch: batch, content } });
    roots.push(content); head = batch.id;
  }
  if (branch) {   // a side branch off the 10th version: two heads (a visit must reach both children of that version)
    const parent = records[9].batch.id, batch: LibraryEditBatch = { kind: 'library', id: uuid(rng), libraryId: lib, targetId: lib, parents: [parent], changes: harmlessChanges(rng) };
    records.push({ batch });
  }
  const one: EditRecord = { batch: { kind: 'library', id: uuid(rng), libraryId: lib, targetId: lib, parents: [head], changes: harmlessChanges(rng) } };
  return { world, records, roots, one };
}
async function countRuns(files: typeof PRODUCT_FILES) {
  const { world, records, roots, one } = uiHistory(), copy = await instrumentedSyncPath({ files, count: true, label: 'counts' });
  const Repo = copy.repository.DurableEditRepository as unknown as SyncRepositoryClass, result: Record<string, Record<string, number>> = {};
  try {
    const sorted = [...records].sort((a, b) => a.batch.id < b.batch.id ? -1 : 1);
    const run = async (name: string, setup: (db: RecordingDatabase) => void, action: (repo: InstanceType<SyncRepositoryClass>) => Promise<void>) => {
      const db = new RecordingDatabase({ roots: new Map(), edits: new Map(), resources: new Map(), checkpoints: new Set() }, { order: 'key', cloneReads: false, failReads: [] });
      setup(db); const repo = new Repo(world.scope, db); copy.reset(); await action(repo);
      result[name] = { ...copy.counts(), ...Object.fromEntries(Object.entries(db.reads).map(([key, value]) => [`read.${key}`, value])) };
    };
    await run('install', () => undefined, repo => repo.installCheckpoint({ version: 1, libraryId: world.scope.libraryId, roots, edits: sorted }));
    await run('receiveAll', db => { db.state.roots.set(world.libraryRoot.id, world.libraryRoot); }, repo => repo.receiveRecords(sorted));
    await run('receiveOne', db => {
      for (const root of roots) db.state.roots.set(root.id, root);
      for (const record of records) db.state.edits.set(record.batch.id, { ...record, receipt: { id: record.batch.id, targetId: record.batch.targetId, durable: true, upload: 'accepted', importedBy: [] } });
    }, repo => repo.receiveRecords([one]));
  } finally { copy.dispose(); }
  return result;
}

test('call counts of the sync paths: one replay per batch per pass, one root read per item, one snapshot copy per head (UI-shaped, 30 publications)', async () => {
  const [old, now] = [await countRuns(LEGACY_FILES), await countRuns(PRODUCT_FILES)];
  console.log(`# counts legacy ${JSON.stringify(old)}`);
  console.log(`# counts product ${JSON.stringify(now)}`);
  const pick = (value: Record<string, number>) => ({ replay: value.replay ?? 0, graphSnapshot: value.graphSnapshot ?? 0, assertBindings: value.assertBindings ?? 0, root: value['read.root'] ?? 0 });
  // pre-U5: snapshot() per record replays from the closest of 16 cached versions (key order is random), and every item's root is read per version
  assert.deepEqual(pick(old.install), { replay: 132, graphSnapshot: 60, assertBindings: 61, root: 465 });
  assert.deepEqual(pick(old.receiveAll), { replay: 176, graphSnapshot: 60, assertBindings: 60, root: 526 });
  assert.deepEqual(pick(old.receiveOne), { replay: 183, graphSnapshot: 61, assertBindings: 31, root: 496 });
  // U5: graph construction (B) + one visit (B) per target; snapshot() only for the head; each item root read once per pass (+ the root/publication reads)
  assert.deepEqual(pick(now.install), { replay: 60, graphSnapshot: 1, assertBindings: 61, root: 30 });
  assert.deepEqual(pick(now.receiveAll), { replay: 60, graphSnapshot: 1, assertBindings: 60, root: 91 });
  assert.deepEqual(pick(now.receiveOne), { replay: 62, graphSnapshot: 1, assertBindings: 31, root: 31 });
});

// ---------------------------------------------------------------- detection power

const MUTATIONS: { name: string; equivalent?: true; mutations: SourceMutation[] }[] = [
  { name: 'phase 2 skips the original check of every materialized version', mutations: [
    { file: 'repository', anchor: 'if (passed.bindings.has(edit.batch.id)) {', replacement: 'if (passed.bindings.has(edit.batch.id) || graph.snapshot(edit.batch.id)) {' },
    { file: 'repository', anchor: 'if (passed.bindings.has(version)) {', replacement: 'if (passed.bindings.has(version) || graph.snapshot(version)) {' }] },
  { name: 'a failed bindings check counts as passed', mutations: [{ file: 'repository', anchor: 'catch { /* not passed: the caller re-runs the original check */ }', replacement: 'catch { bindings.add(version); }' }] },
  { name: 'the root memo ignores the id', mutations: [{ file: 'repository', anchor: 'root: id => { let value = roots.get(id); if (!value) roots.set(id, value = tx.root(id)); return value; },',
    replacement: "root: id => { let value = roots.get('one'); if (!value) roots.set('one', value = tx.root(id)); return value; }," }] },
  { name: 'the resource memo ignores the id', mutations: [{ file: 'repository', anchor: 'resource: id => { let value = resources.get(id); if (!value) resources.set(id, value = tx.resource(id)); return value; },',
    replacement: "resource: id => { let value = resources.get('one'); if (!value) resources.set('one', value = tx.resource(id)); return value; }," }] },
  { name: 'a publication conflict counts as passed', mutations: [{ file: 'repository', anchor: 'if (!publicationParentConflict(snapshot, publicationItem(edit.publication!))) publications.add(edit.batch.id);',
    replacement: 'publications.add(edit.batch.id);' }] },
  { name: 'only the first head is projected', mutations: [
    { file: 'repository', anchor: 'heads = graph.getView().heads;\n      for (const edit of targetEdits) {', replacement: 'heads = graph.getView().heads.slice(0, 1);\n      for (const edit of targetEdits) {' },
    { file: 'repository', anchor: 'const heads = graph.getView().heads;\n', replacement: 'const heads = graph.getView().heads.slice(0, 1);\n' }] },
  { name: 'the visitor gets the parent state (version guard removed)', mutations: [
    { file: 'graph', anchor: 'stack.push([next[index], child]);', replacement: 'stack.push([next[index], snapshot]); void child;' },
    { file: 'repository', anchor: 'if (version === rootVersion || snapshot.version !== version) return;', replacement: 'if (version === rootVersion) return;' }] },
  { name: 'receiveRecords uses the bindings set for the publication check', mutations: [{ file: 'repository', anchor: 'for (const edit of published) if (!passed.publications.has(edit.batch.id)) {',
    replacement: 'for (const edit of published) if (!passed.bindings.has(edit.batch.id)) {' }] },
  { name: 'a passed head is projected from its parent', mutations: [{ file: 'repository', anchor: 'if (heads.includes(edit.batch.id)) tx.putProjection(graph.snapshot(edit.batch.id)!); continue; }',
    replacement: 'if (heads.includes(edit.batch.id)) tx.putProjection(graph.snapshot(edit.batch.parents[0]) ?? graph.snapshot(edit.batch.id)!); continue; }' }] },
  { name: 'the publication fallback check of installCheckpoint is dropped', mutations: [{ file: 'repository', anchor: 'if (edit.publication && !passed.publications.has(edit.batch.id)) {',
    replacement: 'if (false && edit.publication && !passed.publications.has(edit.batch.id)) {' }] },
  { name: 'installCheckpoint walks the records in reverse order', mutations: [{ file: 'repository', anchor: 'heads = graph.getView().heads;\n      for (const edit of targetEdits) {',
    replacement: 'heads = graph.getView().heads;\n      for (const edit of [...targetEdits].reverse()) {' }] },
  { name: 'the root memo is shared across calls (module level)', mutations: [
    { file: 'repository', anchor: 'const roots = new Map<string, Promise<Snapshot | undefined>>(), resources', replacement: 'const roots = sharedRoots, resources' },
    { file: 'repository', anchor: '/** The reads of a bindings check', replacement: 'const sharedRoots = new Map<string, Promise<Snapshot | undefined>>();\n/** The reads of a bindings check' }] },
  // Equivalent by design (an unvisited / unknown version falls back to the original statements): the differential must NOT see them; the counts do.
  { name: 'EQUIVALENT: the visit stops at the first child (siblings unvisited)', equivalent: true, mutations: [{ file: 'graph', anchor: 'for (let index = next.length - 1; index >= 0; index--) {',
    replacement: 'for (let index = Math.min(next.length, 1) - 1; index >= 0; index--) {' }] },
  { name: 'EQUIVALENT: the first pass finds nothing', equivalent: true, mutations: [{ file: 'repository', anchor: '    return { bindings, publications };', replacement: '    return { bindings: new Set<string>(), publications: new Set<string>() };' }] },
];

test('detection power: deliberately broken copies of the U5 code are caught by the differential (equivalent ones only by the counts)', async () => {
  const control = await instrumentedSyncPath({ label: 'control' });
  const results: string[] = [];
  const run = async (candidate: SyncRepositoryClass) => {
    const tally = await differential(20261129, 120, candidate);
    for (const scenario of boundaryScenarios(makeRng(20261126))) await compareScenario(tally, scenario, legacy, candidate);
    const rng = makeRng(20261130);   // plus worlds with a forced fault, so that rare check paths are exercised in every run
    for (let n = 0; n < 40; n++) {
      const world = generateWorld(rng, 6 + rng.int(20));
      for (const force of [['publication-item-exists'], ['stale-document-page'], ['read-failure'], ['missing-resource']]) await compareScenario(tally, scenarioFrom(world, rng, `forced${n}`, force), legacy, candidate);
    }
    return tally;
  };
  try {
    const tally = await run(control.repository.DurableEditRepository as unknown as SyncRepositoryClass);
    results.push(`control (unmodified copy): ${tally.differing}/${tally.compared}`);
    assert.equal(tally.differing, 0, show(tally));
  } finally { control.dispose(); }
  const baseline = (await countRunsWith([])).install;
  for (const mutation of MUTATIONS) {
    const copy = await instrumentedSyncPath({ mutations: mutation.mutations, label: 'mutant' });
    let tally: Tally;
    try { tally = await run(copy.repository.DurableEditRepository as unknown as SyncRepositoryClass); } finally { copy.dispose(); }
    results.push(`${mutation.name}: ${tally.differing}/${tally.compared}`);
    if (mutation.equivalent) {
      assert.equal(tally.differing, 0, `${mutation.name} must be equivalent: ${show(tally)}`);
      const counts = (await countRunsWith(mutation.mutations)).install;
      results.push(`  counts install: replay ${counts.replay}, graphSnapshot ${counts.graphSnapshot} (product ${baseline.replay}, ${baseline.graphSnapshot})`);
      assert.ok(counts.graphSnapshot !== baseline.graphSnapshot || counts.replay !== baseline.replay, `${mutation.name}: the counts must see it`);
    } else assert.ok(tally.differing > 0, `${mutation.name} was not detected`);
  }
  console.log(`# detection power:\n# ${results.join('\n# ')}`);
});
async function countRunsWith(mutations: SourceMutation[]) {
  const copy = await instrumentedSyncPath({ mutations, count: true, label: 'mutant-count' });
  try {
    const { world, records, roots } = uiHistory(true), Repo = copy.repository.DurableEditRepository as unknown as SyncRepositoryClass;
    const db = new RecordingDatabase({ roots: new Map(), edits: new Map(), resources: new Map(), checkpoints: new Set() }, { order: 'key', cloneReads: false, failReads: [] });
    copy.reset(); await new Repo(world.scope, db).installCheckpoint({ version: 1, libraryId: world.scope.libraryId, roots, edits: [...records].sort((a, b) => a.batch.id < b.batch.id ? -1 : 1) });
    return { install: copy.counts() };
  } finally { copy.dispose(); }
}
void ({} as Scenario);

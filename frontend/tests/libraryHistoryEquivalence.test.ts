// B13-d U2: the per-call memo of libraryHistory.ts and the shared catalog EditGraph of LibrarySession.ts change NO observable result.
// Compared with verbatim copies of the pre-U2 files (tests/support/*Legacy.ts, sha256-checked against the preimages): every return value
// and every exception (class + complete message) of restoreLibraryHistory / assertLibraryEdit / assertLibraryMetadataEdit / inverseLibraryEdit,
// and the whole LibrarySession state plus its private catalog()/versions() results. Also: the call counts that U2 reduces (regression
// guard, no timing) and the detection power of the differential itself (deliberately broken copies must be caught).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { EditBatch, HistoryRecord, LibraryEditBatch, LibraryItem, LibrarySnapshot } from '../src/runtime/edits/contracts.ts';
import { applyBatch } from '../src/runtime/edits/editModel.ts';
import { renameLibraryItem, setLibraryItemsRead, updateLibraryTags } from '../src/features/library/canonicalLibraryOperations.ts';
import * as product from '../src/features/library/libraryHistory.ts';
import * as productSession from '../src/features/library/LibrarySession.ts';
import * as legacy from './support/libraryHistoryLegacy.ts';
import * as legacySession from './support/librarySessionLegacy.ts';
import { compareStore, generateHistory, makeRng, newTally, tamperings, uuid, versionsOf, type HistoryImpl, type Store, type Tally } from './support/libraryHistoryDifferential.ts';
import { compareSessions, type SessionModule } from './support/librarySessionDifferential.ts';
import { instrumentedModules, LEGACY_FILES, PRODUCT_FILES, type SourceMutation } from './support/libraryHistoryInstrument.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';

/** sha256 of the pre-U2 files as stored in git (HEAD blobs, LF). The working copy may be CRLF or LF (.gitattributes: `* text=auto eol=lf`), so every text is normalized to LF before hashing. */
const PREIMAGE = {
  history: '1f5e6f3ce26080f6e722f0a25afd20959d0325f1c85092194d53d08b47a58587',
  session: 'f719b80d4b116c557f6b12f200b8a258f0663c04b7880c24d40966dad8932f7d',
};
const toLf = (text: string) => text.replace(/\r\n/g, '\n');
const sha256 = (text: string) => createHash('sha256').update(toLf(text), 'utf8').digest('hex');
/** The pre-U2 text a legacy copy stands for: header lines dropped, import specifiers mapped back, line endings normalized. */
const originalText = (text: string) => toLf(text).split(/(?<=\n)/).filter(line => !line.startsWith('// LEGACY-COPY ')).join('')
  .replace(/(from ')\.\/libraryHistoryLegacy\.ts(';)/g, '$1./libraryHistory.ts$2')
  .replace(/(from ')\.\.\/\.\.\/src\/features\/library\//g, '$1./')
  .replace(/(from ')\.\.\/\.\.\/src\//g, '$1../../');
const show = (tally: Tally) => JSON.stringify(tally.differences.slice(0, 5), null, 1);
const summary = (tally: Tally) => `${tally.compared} compared, ${tally.differing} differing, ${tally.outcomes.size} outcome kinds`;

test('the legacy copies are the verbatim pre-U2 product files (only import specifiers rewritten; line endings normalized to LF)', () => {
  assert.equal(sha256(originalText(readFileSync(LEGACY_FILES.history, 'utf8'))), PREIMAGE.history);
  assert.equal(sha256(originalText(readFileSync(LEGACY_FILES.session, 'utf8'))), PREIMAGE.session);
  assert.notEqual(sha256(readFileSync(PRODUCT_FILES.history, 'utf8')), PREIMAGE.history, 'the product file was changed by U2');
});

test('the preimage check gives the same result for CRLF and LF working copies', () => {
  for (const [name, file] of [['history', LEGACY_FILES.history], ['session', LEGACY_FILES.session]] as const) {
    const lf = toLf(readFileSync(file, 'utf8')), crlf = lf.replace(/\n/g, '\r\n');
    assert.ok(!lf.includes('\r') && crlf.includes('\r\n') && !/[^\r]\n/.test(crlf), 'the two variants really differ in line endings');
    assert.equal(sha256(originalText(crlf)), sha256(originalText(lf)), `${name}: CRLF and LF differ after normalization`);
    assert.equal(sha256(originalText(crlf)), PREIMAGE[name]);
    assert.equal(sha256(originalText(lf)), PREIMAGE[name]);
  }
});

// ---------------------------------------------------------------- history functions

/** `histories` random histories (steps 0..maxSteps): each one fully probed, plus every tampered variant probed on a sample. */
function historyDifferential(seed: number, histories: number, maxSteps: number, candidate: HistoryImpl): Tally {
  const rng = makeRng(seed), tally = newTally();
  for (let n = 0; n < histories; n++) {
    const history = generateHistory(rng, { steps: n < 6 ? n : rng.int(maxSteps + 1) });
    compareStore(tally, `h${n}`, history.store, history.records, history.head, legacy, candidate, rng, true);
    for (const tampered of tamperings(rng, history)) compareStore(tally, `h${n}/${tampered.name}`, tampered.store, tampered.records, history.head, legacy, candidate, rng, false);
  }
  return tally;
}

test('history functions: random histories (seed 20261120) give the same results and exceptions as the pre-U2 code', () => {
  const tally = historyDifferential(20261120, 90, 30, product);
  console.log(`# history differential: ${summary(tally)}`);
  console.log(`# outcome kinds: ${JSON.stringify([...tally.outcomes].sort((x, y) => y[1] - x[1]).slice(0, 40))}`);
  assert.equal(tally.differing, 0, show(tally));
  assert.ok(tally.compared > 35_000, `compared ${tally.compared}`);
  // the random histories reach the exceptional paths (each kind at least once)
  for (const expected of ['library-history-unsupported', 'library-history-version-missing', 'library-history-publication-missing', 'library-history-deleted',
    'library-history-diverged', 'library-history-content-version-missing', 'library-history-record-conflict', 'history-mismatch', 'library-history-action-mismatch',
    'library-history-cycle', 'missing-folder', 'Invalid edit data'])
    assert.ok([...tally.outcomes.keys()].some(kind => kind.includes(expected)), `outcome ${expected} never reached`);
});

test('history functions: boundaries (empty history, one batch, all unsupported, an exception in the middle)', () => {
  const libraryId = uuid(1), root: LibrarySnapshot = { kind: 'library', id: libraryId, version: uuid(2), folders: [], links: [], deletions: [],
    items: [{ id: uuid(3), kind: 'markdown', title: 'a', ownerId: null, folderId: null, position: 0, tags: [], read: false, metadata: {} }] };
  const store = (): Store => ({ batches: new Map(), snapshots: new Map([[root.version, structuredClone(root)]]), origins: new Map(), content: new Map(), contentOk: true, cloneSnapshots: false });
  const push = (s: Store, records: HistoryRecord[], id: number, changes: LibraryEditBatch['changes'], recorded = true) => {
    const parent = [...s.snapshots.values()].slice(-1)[0], batch: EditBatch = { kind: 'library', id: uuid(id), libraryId, targetId: libraryId, parents: [parent.version], changes };
    s.batches.set(batch.id, batch); s.snapshots.set(batch.id, applyBatch(parent, batch) as LibrarySnapshot);
    if (recorded) records.push({ operationId: batch.id, beforeVersion: parent.version, afterVersion: batch.id, undoRequested: false });
    return s.snapshots.get(batch.id)!;
  };
  const tally = newTally(), rng = makeRng(7);
  const check = (name: string, s: Store, records: HistoryRecord[], head: string) => {
    for (const clone of [false, true]) compareStore(tally, `${name}/${clone ? 'clone' : 'ref'}`, { ...s, cloneSnapshots: clone }, records, head, legacy, product, rng, true);
  };
  check('empty', store(), [], root.version);
  { const s = store(), r: HistoryRecord[] = []; push(s, r, 10, renameLibraryItem(root, uuid(3), 'b')); check('one-batch', s, r, uuid(10)); check('one-batch-unrecorded', s, [], uuid(10)); }
  { const s = store(), r: HistoryRecord[] = []; let head = root;
    for (let n = 0; n < 6; n++) head = push(s, r, 20 + n, [{ type: 'put-item', item: { ...head.items[0], title: `u${n}`, position: n + 5 } }]);
    check('all-unsupported', s, r, head.version); }
  { const s = store(), r: HistoryRecord[] = []; let head = push(s, r, 30, renameLibraryItem(root, uuid(3), 'c'));
    head = push(s, r, 31, updateLibraryTags(head, [uuid(3)], { mode: 'add', tags: ['t'] }));
    head = push(s, r, 32, setLibraryItemsRead(head, [uuid(3)], true));
    check('mismatch-in-middle', s, r.map(value => value.operationId === uuid(31) ? { ...value, beforeVersion: uuid(99) } : value), head.version);
    const broken = { ...s, batches: new Map(s.batches) }; broken.batches.set(uuid(31), { ...(s.batches.get(uuid(31)) as LibraryEditBatch), changes: [{ type: 'remove-folder', id: uuid(98) }] });
    check('replay-throws-in-middle', broken, r, head.version);
    const invalid = { ...s, batches: new Map(s.batches) };
    invalid.batches.set(uuid(31), { ...(s.batches.get(uuid(31)) as LibraryEditBatch), changes: [{ type: 'put-item', item: { ...(head.items[0] as LibraryItem), title: 7 as unknown as string } }] });
    check('schema-invalid-in-middle', invalid, r, head.version); }
  console.log(`# boundaries: ${summary(tally)}`);
  assert.equal(tally.differing, 0, show(tally));
  const versions = versionsOf(store());
  assert.deepEqual(product.restoreLibraryHistory(versions, root.version, []), { undo: [], redo: [] });
});

// ---------------------------------------------------------------- LibrarySession

async function sessionDifferential(seed: number, runs: number, steps: number, candidate: SessionModule): Promise<Tally> {
  const rng = makeRng(seed), tally = newTally();
  for (let n = 0; n < runs; n++) await compareSessions(tally, `s${n}`, rng, steps, legacySession, candidate, { permute: n % 2 === 1, probeVersions: true });
  return tally;
}
test('LibrarySession: random operation sequences (seed 20261121) give the same state, catalog() and versions() as the pre-U2 code', async () => {
  const tally = await sessionDifferential(20261121, 72, 30, productSession);
  console.log(`# session differential: ${summary(tally)}`);
  console.log(`# session operations (name result: count): ${JSON.stringify([...tally.ops].sort())}`);
  for (const op of ['undo ok true', 'redo ok true', 'resolveConflict ok true', 'external conflict ok "durable"', 'external silent ok "durable"', 'deleteItems delete ok true', 'restoreDeleted ok true', 'reopen ok true'])
    assert.ok(tally.ops.get(`op ${op}`), `operation ${op} never happened`);
  assert.equal(tally.differing, 0, show(tally));
  assert.ok(tally.compared > 20_000, `compared ${tally.compared}`);
});

// ---------------------------------------------------------------- call counts (regression guard; no timing)

/** 20 proven publications, then a rename, a tag, a read change and a position-only change, each recorded. */
async function uiShaped() {
  const scope = { accountId: 'b13d-u2-count', libraryId: uuid(0x501), epoch: 'one' };
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase(), { inspectPdf: async () => [{ widthPt: 600, heightPt: 800 }] });
  let head: LibrarySnapshot = { kind: 'library', id: scope.libraryId, version: uuid(0x502), items: [], folders: [], links: [], deletions: [] };
  await repository.initialize(head);
  let n = 0x600; const id = () => uuid(n++);
  const commit = async (batch: LibraryEditBatch, publication?: boolean) => {
    const history = { operationId: batch.id, beforeVersion: head.version, afterVersion: batch.id, undoRequested: false };
    const item = batch.changes[0].type === 'put-item' ? batch.changes[0].item : undefined;
    const result = publication && item ? await repository.publish({ libraryBatch: batch, content: { kind: 'markdown', id: item.id, version: id(), content: '', appendIds: [], imageResources: [] } }, history)
      : await repository.commit(batch, history);
    assert.equal(result.status, 'durable'); head = applyBatch(head, batch) as LibrarySnapshot;
  };
  const batch = (changes: LibraryEditBatch['changes']): LibraryEditBatch => ({ kind: 'library', id: id(), libraryId: scope.libraryId, targetId: scope.libraryId, parents: [head.version], changes });
  for (let k = 0; k < 20; k++) await commit(batch([{ type: 'put-item', item: { id: id(), kind: 'markdown', title: `i${k}`, ownerId: null, folderId: null, position: k, tags: [], read: false, metadata: {} } }]), true);
  const first = head.items[0].id;
  await commit(batch(renameLibraryItem(head, first, 'renamed')));
  await commit(batch(updateLibraryTags(head, [first], { mode: 'add', tags: ['t'] })));
  await commit(batch(setLibraryItemsRead(head, [first], true)));
  await commit(batch([{ type: 'put-item', item: { ...head.items.find(item => item.id === first)!, position: 100 } }]));
  return repository;
}
test('call counts: one applyBatch per history batch and one session EditGraph per catalog read (pre-U2: 8 per publication, 3 per read)', async () => {
  const repository = await uiShaped();
  const results: Record<string, Record<string, number>> = {};
  for (const [name, files] of [['legacy', LEGACY_FILES], ['product', PRODUCT_FILES]] as const) {
    const copy = await instrumentedModules({ files, count: true, label: `count-${name}` });
    try {
      const session = new copy.session.LibrarySession({ repository, isActive: () => true });
      copy.reset(); assert.equal(await session.refresh(), true);
      const refresh = copy.counts(), state = session.getSnapshot();
      assert.equal(state.items.length, 20); assert.equal(state.canUndo, true);
      const read = await repository.read(repository.scope.libraryId);
      const graph = new (await import('../src/runtime/edits/editGraph.ts')).EditGraph(read.checkpoint);
      const origins = new Map((read.publicationOrigins ?? []).map(origin => [origin.batchId, origin]));
      const versions = { batch: (key: string) => read.checkpoint.batches.find(value => value.id === key), publicationOrigin: (key: string) => origins.get(key),
        snapshot: (key: string) => graph.snapshot(key) as LibrarySnapshot | undefined };
      copy.reset(); const restored = copy.history.restoreLibraryHistory(versions, read.heads[0], read.history);
      assert.equal(restored.undo.length, 24);
      results[name] = { refreshEditGraph: refresh.sessionEditGraph ?? 0, refreshHistoryApplyBatch: refresh.historyApplyBatch ?? 0, restoreApplyBatch: copy.counts().historyApplyBatch ?? 0 };
    } finally { copy.dispose(); }
  }
  console.log(`# counts: ${JSON.stringify(results)}`);
  assert.deepEqual(results.legacy, { refreshEditGraph: 3, refreshHistoryApplyBatch: 20 * 8 + 3 + 4, restoreApplyBatch: 20 * 8 + 3 + 4 });
  assert.deepEqual(results.product, { refreshEditGraph: 1, refreshHistoryApplyBatch: 24, restoreApplyBatch: 24 });
});

// ---------------------------------------------------------------- detection power of the differential

const HISTORY_MUTANTS: { name: string; mutations: SourceMutation[] }[] = [
  { name: 'replay memo key coarsened to a constant', mutations: [
    { file: 'history', anchor: 'const known = this.replays.get(batch.id);', replacement: "const known = this.replays.get('*');" },
    { file: 'history', anchor: 'this.replays.set(batch.id, matches);', replacement: "this.replays.set('*', matches);" }] },
  { name: 'replay memo key coarsened to the number of changes', mutations: [
    { file: 'history', anchor: 'const known = this.replays.get(batch.id);', replacement: 'const known = this.replays.get(String(batch.changes.length));' },
    { file: 'history', anchor: 'this.replays.set(batch.id, matches);', replacement: 'this.replays.set(String(batch.changes.length), matches);' }] },
  { name: 'replay exception swallowed (memoized as a mismatch)', mutations: [
    { file: 'history', anchor: 'const matches = canonicalJson(applyBatch(before, batch)) === canonicalJson(after);',
      replacement: 'let matches: boolean; try { matches = canonicalJson(applyBatch(before, batch)) === canonicalJson(after); } catch { matches = false; }' }] },
  { name: 'replay memo shared across calls (module level)', mutations: [
    { file: 'history', anchor: 'const HISTORY_SNAPSHOT_READS = 4;', replacement: 'const HISTORY_SNAPSHOT_READS = 4; const GLOBAL_REPLAYS = new Map<string, boolean>();' },
    { file: 'history', anchor: 'private readonly replays = new Map<string, boolean>();', replacement: 'private readonly replays = GLOBAL_REPLAYS;' }] },
  { name: 'replay mismatch memoized as a match', mutations: [
    { file: 'history', anchor: 'this.replays.set(batch.id, matches);', replacement: 'this.replays.set(batch.id, true);' }] },
  { name: 'memo hit returns the opposite', mutations: [
    { file: 'history', anchor: 'if (known !== undefined) return known;', replacement: 'if (known !== undefined) return !known;' }] },
  { name: 'snapshot memo ignores the id', mutations: [
    { file: 'history', anchor: 'if (this.snapshots.has(id)) { const value = this.snapshots.get(id);', replacement: 'if (this.snapshots.size) { const value = [...this.snapshots.values()].at(-1);' }] },
  { name: 'batch memo ignores the id', mutations: [
    { file: 'history', anchor: 'if (!this.batches.has(id)) this.batches.set(id, this.source.batch(id));\n    return this.batches.get(id);',
      replacement: 'if (!this.batches.size) this.batches.set(id, this.source.batch(id));\n    return this.batches.values().next().value;' }] },
  { name: 'a parser reorders the shared after snapshot', mutations: [
    { file: 'history', anchor: 'const { batch } = verifiedLibraryBatch(versions, executionId);', replacement: 'const { batch, after: shared } = verifiedLibraryBatch(versions, executionId); shared.items.reverse();' }] },
];
const SESSION_MUTANTS: { name: string; mutations: SourceMutation[] }[] = [
  { name: 'catalog graph shared across reads (module level)', mutations: [
    { file: 'session', anchor: 'function catalogGraph(', replacement: 'const SHARED: { graph?: EditGraph } = {};\nfunction catalogGraph(' },
    { file: 'session', anchor: 'return () => graph ??= new EditGraph(checkpoint);', replacement: 'void graph; return () => SHARED.graph ??= new EditGraph(checkpoint);' }] },
  { name: 'conflict graph kept from the first display', mutations: [
    { file: 'session', anchor: 'this.conflictGraph = read.graph();', replacement: 'this.conflictGraph ??= read.graph();' }] },
  { name: 'versions() reuses the last displayed graph', mutations: [
    { file: 'session', anchor: 'const graph = read.graph(), batches', replacement: 'const graph = this.conflictGraph ?? read.graph(), batches' }] },
];
test('detection power: the differential catches deliberately broken copies (and not the unmodified copy)', async () => {
  const eol = readFileSync(PRODUCT_FILES.history, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  const fixCrLf = (mutations: SourceMutation[]) => mutations.map(value => ({ ...value, anchor: value.anchor.replace(/\n/g, eol), replacement: value.replacement.replace(/\n/g, eol) }));
  const rows: string[] = [];
  const control = await instrumentedModules({ label: 'control' });
  try {
    const h = historyDifferential(31, 12, 18, control.history), s = await sessionDifferential(32, 6, 22, control.session);
    rows.push(`control: history ${h.differing}/${h.compared}, session ${s.differing}/${s.compared}`);
    assert.equal(h.differing + s.differing, 0, 'the unmodified copy must not differ');
  } finally { control.dispose(); }
  for (const mutant of [...HISTORY_MUTANTS, ...SESSION_MUTANTS]) {
    const copy = await instrumentedModules({ mutations: fixCrLf(mutant.mutations), label: 'mutant' });
    try {
      const h = mutant.mutations[0].file === 'history' ? historyDifferential(31, 12, 18, copy.history) : newTally();
      const s = await sessionDifferential(32, 6, 22, copy.session);
      rows.push(`${mutant.name}: history ${h.differing}/${h.compared}, session ${s.differing}/${s.compared}`);
      assert.ok(h.differing + s.differing > 0, `mutant not detected: ${mutant.name}`);
    } finally { copy.dispose(); }
  }
  console.log('# detection power:\n# ' + rows.join('\n# '));
});

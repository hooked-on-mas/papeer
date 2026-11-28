// B13-d U4: reusing the pure results (session EditGraph, restored history) of an identical catalog read changes NO observable result.
// Compared with the verbatim pre-U4 LibrarySession.ts (tests/support/librarySessionU4Legacy.ts, sha256 of the HEAD blob after LF normalization):
// the U2 session differential (random operations, external commits, reopenings), a playback differential that replays recorded reads with
// variants that keep or break exact identity, and boundaries. Also the call counts that U4 reduces (no timing) and the detection power.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { LibraryEditBatch, LibrarySnapshot } from '../src/runtime/edits/contracts.ts';
import { applyBatch } from '../src/runtime/edits/editModel.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { renameLibraryItem, setLibraryItemsRead, updateLibraryTags } from '../src/features/library/canonicalLibraryOperations.ts';
import * as productSession from '../src/features/library/LibrarySession.ts';
import * as legacySession from './support/librarySessionU4Legacy.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';
import { makeRng, newTally, uuid, type Tally } from './support/libraryHistoryDifferential.ts';
import { compareSessions, type SessionModule } from './support/librarySessionDifferential.ts';
import { makePair, playback, recordWorld, variantOf, type Frame, type World } from './support/catalogReuseDifferential.ts';
import { instrumentedModules, PRODUCT_FILES, type SourceMutation } from './support/libraryHistoryInstrument.ts';

/** sha256 of the pre-U4 LibrarySession.ts as stored in git (HEAD d883c453 blob, LF). Every text is normalized to LF before hashing. */
const PREIMAGE = 'ecbd0db701c92541041322aa5f5a90b0560c0367a4122136df96c70cd7ba3c58';
const LEGACY_FILE = path.join(import.meta.dirname, 'support', 'librarySessionU4Legacy.ts');
const toLf = (text: string) => text.replace(/\r\n/g, '\n');
const sha256 = (text: string) => createHash('sha256').update(toLf(text), 'utf8').digest('hex');
/** The pre-U4 text the legacy copy stands for: header lines dropped, import specifiers mapped back, line endings normalized. */
const originalText = (text: string) => toLf(text).split(/(?<=\n)/).filter(line => !line.startsWith('// LEGACY-COPY ')).join('')
  .replace(/(from ')\.\.\/\.\.\/src\/features\/library\//g, '$1./')
  .replace(/(from ')\.\.\/\.\.\/src\//g, '$1../../');
const show = (tally: Tally) => JSON.stringify(tally.differences.slice(0, 5), null, 1);
const summary = (tally: Tally) => `${tally.compared} compared, ${tally.differing} differing`;

test('the legacy copy is the verbatim pre-U4 LibrarySession.ts (only import specifiers rewritten; line endings normalized to LF)', () => {
  assert.equal(sha256(originalText(readFileSync(LEGACY_FILE, 'utf8'))), PREIMAGE);
  assert.notEqual(sha256(readFileSync(PRODUCT_FILES.session, 'utf8')), PREIMAGE, 'the product file was changed by U4');
});

test('the U4 preimage check gives the same result for CRLF and LF working copies', () => {
  const lf = toLf(readFileSync(LEGACY_FILE, 'utf8')), crlf = lf.replace(/\n/g, '\r\n');
  assert.ok(!lf.includes('\r') && crlf.includes('\r\n') && !/[^\r]\n/.test(crlf), 'the two variants really differ in line endings');
  assert.equal(sha256(originalText(crlf)), PREIMAGE);
  assert.equal(sha256(originalText(lf)), PREIMAGE);
});

// ---------------------------------------------------------------- differentials

async function sessionDifferential(seed: number, runs: number, steps: number, candidate: SessionModule): Promise<Tally> {
  const rng = makeRng(seed), tally = newTally();
  for (let n = 0; n < runs; n++) await compareSessions(tally, `s${n}`, rng, steps, legacySession, candidate, { permute: n % 2 === 1, probeVersions: true });
  return tally;
}
const worldCache = new Map<string, World[]>();
async function worlds(seed: number, count: number): Promise<World[]> {
  const key = `${seed}/${count}`; const known = worldCache.get(key); if (known) return known;
  const rng = makeRng(seed), list: World[] = [];
  for (let n = 0; n < count; n++) list.push(await recordWorld(rng, n < 4 ? n : n % 7 === 0 ? 40 : rng.int(22) + 2));
  worldCache.set(key, list); return list;
}
async function playbackDifferential(seed: number, count: number, steps: number, candidate: SessionModule): Promise<Tally> {
  const list = await worlds(seed, count), rng = makeRng(seed + 1), tally = newTally();
  for (const [n, world] of list.entries()) await playback(tally, `p${n}`, rng, world, steps, legacySession, candidate);
  return tally;
}

test('LibrarySession: random operation sequences (seed 20261130) give the same state, catalog() and versions() as the pre-U4 code', async () => {
  const tally = await sessionDifferential(20261130, 72, 30, productSession);
  console.log(`# session differential: ${summary(tally)}`);
  console.log(`# session operations: ${JSON.stringify([...tally.ops].sort().slice(0, 80))}`);
  for (const op of ['undo ok true', 'redo ok true', 'resolveConflict ok true', 'external conflict ok "durable"', 'external silent ok "durable"', 'reopen ok true', 'refresh ok true'])
    assert.ok(tally.ops.get(`op ${op}`), `operation ${op} never happened`);
  assert.equal(tally.differing, 0, show(tally));
  assert.ok(tally.compared > 20_000, `compared ${tally.compared}`);
});

test('LibrarySession: playback of recorded reads (seed 20261131) with identical and non-identical variants gives the same results as the pre-U4 code', async () => {
  const tally = await playbackDifferential(20261131, 56, 40, productSession);
  const ops = Object.fromEntries([...tally.ops].sort());
  console.log(`# playback differential: ${summary(tally)}`);
  console.log(`# playback variants (variant result: count) and reuse: ${JSON.stringify(ops)}`);
  assert.equal(tally.differing, 0, show(tally));
  assert.ok(tally.compared > 12_000, `compared ${tally.compared}`);
  assert.ok((tally.ops.get('reuse graph') ?? 0) > 1000, 'the graph reuse path ran'); assert.ok((tally.ops.get('reuse history') ?? 0) > 500, 'the history reuse path ran');
  for (const variant of ['same', 'reorder-keys', 'origins-absent', 'origins-empty', 'history-shuffle', 'history-duplicate', 'history-conflict', 'history-drop', 'non-plain-undefined',
    'negative-zero', 'targets-missing', 'targets-reorder-keys', 'target-throw-all'])
    assert.ok(Object.keys(ops).some(key => key.startsWith(variant + ' ')), `variant ${variant} never played`);
});

// ---------------------------------------------------------------- boundaries

/** A frame of `world` changed by `edit` (a clone; the recorded frame is not touched). */
const changed = (frame: Frame, edit: (frame: Frame) => void): Frame => { const next = structuredClone(frame); edit(next); return next; };
async function boundaries(candidate: SessionModule): Promise<Tally> {
  const tally = newTally(), rng = makeRng(77);
  const scenario = async (name: string, frames: Frame[], actions?: (string | undefined)[]) => {
    const pair = await makePair(tally, name, legacySession, candidate, frames[0]);
    for (const [index, frame] of frames.entries()) {
      pair.setFrame(frame); const version = actions?.[index];
      await pair.both(`${index} refresh${version ? '(version)' : ''}`, session => session.refresh(version)); pair.compare(`${index}`);
    }
    return pair;
  };
  const all = await worlds(20261131, 56), frames = all.flatMap(world => world.frames);
  // a frame right after "create, then Undo": its restored history depends on the deleted content graph (contentVersion of the creation Undo)
  const deletedFrame = all.flatMap(world => world.steps.flatMap((step, index) => step === 'create+undo' ? [world.frames[index + 1]] : []))
    .find(frame => frame.library.heads.length === 1 && frame.library.history.some(value => value.action?.kind === 'undo') && frame.targets.some(([, read]) => read.ok));
  const conflictFrame = frames.find(frame => frame.library.heads.length > 1), empty = all[0].frames[0];
  const one = all.find(world => world.frames.length > 1 && world.frames[1].library.checkpoint.batches.length === 1);
  assert.ok(deletedFrame && conflictFrame && one, 'the recorded worlds contain a creation Undo, a conflict and a one-batch library');
  const oneFrame = one!.frames[1];
  await scenario('empty library, read three times', [empty, empty, empty]);
  await scenario('one batch, read twice, then the root-only frame, then the one batch again', [oneFrame, oneFrame, one!.frames[0], oneFrame]);
  { const [h1, h2] = conflictFrame!.library.heads;
    await scenario('conflict: no selection, h1, h2, h1, none', [conflictFrame!, conflictFrame!, conflictFrame!, conflictFrame!, conflictFrame!], [undefined, h1, h2, h1, undefined]); }
  { const broken = changed(deletedFrame!, frame => { frame.library.checkpoint.batches[0] = { ...frame.library.checkpoint.batches[0], libraryId: uuid(0xbad) }; });
    await scenario('EditGraph throws twice, then the valid read twice, then throws again', [broken, broken, deletedFrame!, deletedFrame!, broken]); }
  { const conflict = variantOf(deletedFrame!, 'history-conflict', rng);
    await scenario('restore throws twice, then the valid read, then throws again', [conflict, conflict, deletedFrame!, conflict]); }
  { const undefinedValue = variantOf(deletedFrame!, 'non-plain-undefined', rng);
    await scenario('undefined (schema-invalid) after the plain read and back', [deletedFrame!, undefinedValue, undefinedValue, deletedFrame!, undefinedValue]); }
  { const minusZero = variantOf(oneFrame, 'negative-zero', rng); await scenario('-0 vs 0', [oneFrame, minusZero, minusZero, oneFrame]); }
  { const absent = variantOf(deletedFrame!, 'origins-absent', rng), emptyOrigins = variantOf(deletedFrame!, 'origins-empty', rng);
    await scenario('publication origins: present, absent, empty, absent, present', [deletedFrame!, absent, emptyOrigins, absent, deletedFrame!]); }
  { const missing = changed(deletedFrame!, frame => { frame.targets = frame.targets.map(([id]) => [id, { ok: false, error: 'missing-target' }]); });
    await scenario('deleted content: present, missing, present, missing (same library read)', [deletedFrame!, missing, deletedFrame!, missing, missing]); }
  { const reordered = variantOf(deletedFrame!, 'reorder-keys', rng); await scenario('keys reordered and back', [deletedFrame!, reordered, deletedFrame!, reordered]); }
  // deletedGraphs changed after catalog() and before display() (no current caller does this; the reuse must not hide it)
  for (const mode of ['delete', 'add'] as const) {
    const pair = await makePair(tally, `deletedGraphs ${mode} after catalog()`, legacySession, candidate, deletedFrame!);
    await pair.both('refresh', session => session.refresh()); pair.compare('initial');
    await pair.both(`display after ${mode}`, async session => {
      const p = session as unknown as { catalog(): Promise<{ deletedGraphs: Map<string, unknown> }>; display(read: unknown): void };
      const read = await p.catalog(), first = [...read.deletedGraphs][0];
      if (mode === 'delete' && first) read.deletedGraphs.delete(first[0]);
      if (mode === 'add' && first) { read.deletedGraphs.delete(first[0]); read.deletedGraphs.set(first[0], first[1]); read.deletedGraphs.set(uuid(0xadd), first[1]); }
      p.display(read); return read.deletedGraphs.size;
    }); pair.compare(mode);
  }
  return tally;
}
test('boundaries: empty, one batch, conflicts, failing graph / restore, non-plain values, origins absent vs empty, deleted content toggling, changed deletedGraphs', async () => {
  const tally = await boundaries(productSession);
  console.log(`# boundaries: ${summary(tally)}; reuse ${JSON.stringify([...tally.ops])}`);
  assert.equal(tally.differing, 0, show(tally));
  assert.ok(tally.compared > 300, `compared ${tally.compared}`);
});

// ---------------------------------------------------------------- call counts (regression guard; no timing)

/** The legacy copy as an importable file next to an instrumented libraryHistory copy: specifiers mapped back, then made absolute (except libraryHistory). */
function legacyFiles(): { files: { history: string; session: string }; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'b13d-u4-legacy-')), session = path.join(dir, 'LibrarySession.ts'), from = path.dirname(PRODUCT_FILES.session);
  writeFileSync(session, originalText(readFileSync(LEGACY_FILE, 'utf8')).replace(/(from ')(\.[^']+)(';)/g, (_all, open: string, spec: string, close: string) =>
    spec === './libraryHistory.ts' ? open + spec + close : open + pathToFileURL(path.resolve(from, spec)).href + close));
  return { files: { history: PRODUCT_FILES.history, session }, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
/** 20 proven publications, then a rename, a tag, a read change and a position-only change, each recorded (as U2). */
async function uiShaped() {
  const scope = { accountId: 'b13d-u4-count', libraryId: uuid(0x501), epoch: 'one' };
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
  return { repository, rename: async () => commit(batch(renameLibraryItem(head, first, 'again'))) };
}
async function countRefreshes(files: { history: string; session: string } | undefined, mutations: SourceMutation[] = []) {
  const { repository, rename } = await uiShaped();
  const copy = await instrumentedModules({ ...(files ? { files } : {}), mutations, count: true, label: 'u4-count' });
  try {
    const session = new copy.session.LibrarySession({ repository, isActive: () => true }), rows: Record<string, number>[] = [];
    const step = async (before?: () => Promise<void>) => {
      await before?.(); copy.reset(); assert.equal(await session.refresh(), true);
      const counts = copy.counts(); rows.push({ graph: counts.sessionEditGraph ?? 0, applyBatch: counts.historyApplyBatch ?? 0 });
    };
    await step(); await step(); await step(rename); await step(); await step();
    assert.equal(session.getSnapshot().items.length, 20); assert.equal(session.getSnapshot().canUndo, true);
    return rows;
  } finally { copy.dispose(); }
}
test('call counts: an identical refresh builds no session EditGraph and replays no history (pre-U4: 1 graph and 1 replay per history batch every time)', async () => {
  const legacy = legacyFiles();
  try {
    const before = await countRefreshes(legacy.files), after = await countRefreshes(undefined);
    console.log(`# counts per refresh (initial, identical, after a rename, identical, identical): legacy ${JSON.stringify(before)} product ${JSON.stringify(after)}`);
    assert.deepEqual(before, [{ graph: 1, applyBatch: 24 }, { graph: 1, applyBatch: 24 }, { graph: 1, applyBatch: 25 }, { graph: 1, applyBatch: 25 }, { graph: 1, applyBatch: 25 }]);
    assert.deepEqual(after, [{ graph: 1, applyBatch: 24 }, { graph: 0, applyBatch: 0 }, { graph: 1, applyBatch: 25 }, { graph: 0, applyBatch: 0 }, { graph: 0, applyBatch: 0 }]);
  } finally { legacy.dispose(); }
});

// ---------------------------------------------------------------- detection power of the differential

const MUTANTS: { name: string; mutations: SourceMutation[] }[] = [
  { name: 'graph reused regardless of the checkpoint key', mutations: [
    { file: 'session', anchor: 'let memo: CatalogMemo | undefined = checkpointKey !== null && known?.checkpointKey === checkpointKey ? known : undefined;', replacement: 'let memo: CatalogMemo | undefined = known;' }] },
  { name: 'checkpoint key coarsened to the number of batches', mutations: [
    { file: 'session', anchor: 'const checkpointKey = exactJsonKey(read.checkpoint), known', replacement: 'const checkpointKey = exactJsonKey(read.checkpoint.batches.length), known' }] },
  { name: 'history key without the history records', mutations: [
    { file: 'session', anchor: 'exactJsonKey([value.version, read.read.history, ', replacement: 'exactJsonKey([value.version, null, ' }] },
  { name: 'history key without the selected version', mutations: [
    { file: 'session', anchor: 'exactJsonKey([value.version, read.read.history, ', replacement: 'exactJsonKey([null, read.read.history, ' }] },
  { name: 'history key without the publication origins', mutations: [
    { file: 'session', anchor: 'read.read.publicationOrigins === undefined ? null : [read.read.publicationOrigins],', replacement: 'null,' }] },
  { name: 'history key without the deleted content', mutations: [
    { file: 'session', anchor: 'read.deletedEntries.map(([id, , checkpointKey]) => [id, checkpointKey])]) : null;', replacement: '[]]) : null;' }] },
  { name: 'a deletedGraphs change after catalog() is not checked', mutations: [
    { file: 'session', anchor: 'const intact = !!memo && ids.length === read.deletedEntries.length', replacement: 'const intact = !!memo && ids.length >= 0' },
    { file: 'session', anchor: '&& read.deletedEntries.every(([id, graph, key], index) => key !== null && ids[index] === id && read.deletedGraphs.get(id) === graph);', replacement: '&& read.deletedEntries.every(([, , key]) => key !== null);' }] },
  { name: 'history hit ignores the key', mutations: [
    { file: 'session', anchor: 'if (memo && key !== null && memo.history?.key === key) return memo.history.value;', replacement: 'if (memo && memo.history) return memo.history.value;' }] },
  { name: 'a failed restore is remembered as an empty history', mutations: [
    { file: 'session', anchor: 'const restored = restoreLibraryHistory(this.versions(read), value.version, read.read.history);',
      replacement: 'let restored: RestoredHistory; try { restored = restoreLibraryHistory(this.versions(read), value.version, read.read.history); } catch (error) { if (memo && key !== null) memo.history = { key, value: { undo: [], redo: [] } }; throw error; }' }] },
  { name: 'a failed graph build is remembered as the root-only graph', mutations: [
    { file: 'session', anchor: '      const built = build();',
      replacement: '      let built: EditGraph; try { built = build(); } catch (error) { if (checkpointKey !== null) this.catalogMemo = { checkpointKey, graph: new EditGraph({ ...read.checkpoint, batches: [] }) }; throw error; }' }] },
  { name: 'undefined accepted as plain JSON', mutations: [{ file: 'session', anchor: '      throw NOT_PLAIN;', replacement: '      return current;' }] },
  { name: 'key order ignored (canonicalJson instead of the exact key)', mutations: [
    { file: 'session', anchor: 'const checkpointKey = exactJsonKey(read.checkpoint), known', replacement: 'const checkpointKey = canonicalJson(read.checkpoint), known' }] },
];
test('detection power: the differential catches deliberately broken copies (and not the unmodified copy)', async () => {
  const rows: string[] = [];
  const run = async (module: SessionModule) => {
    const p = await playbackDifferential(20261131, 20, 30, module), b = await boundaries(module), s = await sessionDifferential(33, 4, 20, module);
    return { differing: p.differing + b.differing + s.differing, text: `playback ${p.differing}/${p.compared}, boundaries ${b.differing}/${b.compared}, session ${s.differing}/${s.compared}` };
  };
  const control = await instrumentedModules({ label: 'u4-control' });
  try { const r = await run(control.session); rows.push(`control: ${r.text}`); assert.equal(r.differing, 0, 'the unmodified copy must not differ'); }
  finally { control.dispose(); }
  for (const mutant of MUTANTS) {
    const copy = await instrumentedModules({ mutations: mutant.mutations, label: 'u4-mutant' });
    try {
      const r = await run(copy.session); rows.push(`${mutant.name}: ${r.text}`);
      assert.ok(r.differing > 0, `mutant not detected: ${mutant.name}`);
    } finally { copy.dispose(); }
  }
  // A mutant that only loses the reuse (the memo is never replaced after the first read) is equivalent by design; the counts see it.
  const lazy = await countRefreshes(undefined, [{ file: 'session', anchor: 'if (checkpointKey !== null) this.catalogMemo = memo = { checkpointKey, graph: built };',
    replacement: 'if (checkpointKey !== null) { memo = { checkpointKey, graph: built }; this.catalogMemo ??= memo; }' }]);
  rows.push(`memo never replaced (counts only): ${JSON.stringify(lazy)}`);
  assert.notDeepEqual(lazy, [{ graph: 1, applyBatch: 24 }, { graph: 0, applyBatch: 0 }, { graph: 1, applyBatch: 25 }, { graph: 0, applyBatch: 0 }, { graph: 0, applyBatch: 0 }]);
  console.log('# detection power:\n# ' + rows.join('\n# '));
});

/**
 * Playback differential harness of work B13-d U4 (reuse of the pure results of an identical catalog read).
 * 1. `recordWorld` drives a product LibrarySession on a real repository with random operations (creation, creation Undo, deletion, restore,
 *    organize, external conflicting commits, resolution) and records after every step a FRAME: the library read and the read (or the failure)
 *    of every item's content target.
 * 2. `playback` replays random schedules of these frames, with variants that keep or break exact identity (the same frame again, keys reordered,
 *    publication origins absent vs empty, history records shuffled / duplicated / conflicting, a non-plain value, content targets missing),
 *    into two LibrarySession implementations, each on its OWN repository whose `read` returns a clone of the scheduled frame. After every
 *    refresh the whole state (order-insensitive AND order-sensitive), the selected snapshot, the conflict versions, the flags and the private
 *    restored history are compared. Every input is drawn once, outside the per-side closures.
 */
import { DurableEditRepository } from '../../src/runtime/edits/repository.ts';
import { EditRejected } from '../../src/runtime/edits/editModel.ts';
import type { RepositoryState } from '../../src/runtime/edits/ports.ts';
import type { LibraryChange, LibraryItem } from '../../src/runtime/edits/contracts.ts';
import * as productSession from '../../src/features/library/LibrarySession.ts';
import { EditMemoryDatabase } from './editMemoryDatabase.ts';
import { outcome, outcomeAsync, record, stable, uuid, type Rng, type Tally } from './libraryHistoryDifferential.ts';
import type { PublicSession, SessionModule } from './librarySessionDifferential.ts';

export const LIBRARY = uuid(0xc4a1);
const SCOPE = { accountId: 'b13d-u4', libraryId: LIBRARY, epoch: 'one' };
const ROOT_VERSION = uuid(0xc4a2);
type TargetRead = { ok: true; state: RepositoryState } | { ok: false; error: string };
export type Frame = { library: RepositoryState; targets: [string, TargetRead][] };
export type World = { frames: Frame[]; steps: string[] };

async function newRepository() {
  const repository = new DurableEditRepository(SCOPE, new EditMemoryDatabase(), { inspectPdf: async () => [{ widthPt: 600, heightPt: 800 }] });
  await repository.initialize({ kind: 'library', id: LIBRARY, version: ROOT_VERSION, items: [], folders: [], links: [], deletions: [] });
  return repository;
}
async function capture(repository: DurableEditRepository): Promise<Frame> {
  const library = await repository.read(LIBRARY), ids = new Set<string>();
  for (const batch of library.checkpoint.batches) if (batch.kind === 'library') for (const change of batch.changes) if (change.type === 'put-item') ids.add(change.item.id);
  const targets: [string, TargetRead][] = [];
  for (const id of [...ids].sort()) {
    try { targets.push([id, { ok: true, state: await repository.read(id) }]); }
    catch (error) { targets.push([id, { ok: false, error: error instanceof Error ? error.message : String(error) }]); }
  }
  return { library, targets };
}

/** A recorded world: `steps` random operations on a product session; one frame after each (and one before the first). */
export async function recordWorld(rng: Rng, steps: number): Promise<World> {
  const repository = await newRepository();
  let counter = 0x20000; const makeId = () => uuid(counter++);
  const session: PublicSession = new productSession.LibrarySession({ repository, isActive: () => true, makeId });
  await session.refresh();
  const frames = [await capture(repository)], names: string[] = [];
  for (let step = 0; step < steps; step++) {
    const state = session.getSnapshot(), selected = session.getSelectedSnapshot(), items = state.items as LibraryItem[];
    const choice = rng.int(16); let name = 'skip';
    const any = () => rng.pick(items);
    if (choice <= 3) { name = 'create'; await session.create({ kind: rng.pick(['markdown', 'notebook'] as const), title: `c${step}` }); }
    else if (choice <= 5) { name = 'create+undo'; if (await session.create({ kind: 'markdown', title: `u${step}` })) await session.undo(); }
    else if (choice === 6 && items.length) { name = 'rename'; await session.rename(any().id, `r${step}`); }
    else if (choice === 7 && items.length) { name = 'tag'; await session.updateTags([any().id], { mode: 'add', tags: [rng.pick(['x', 'y'])] }); }
    else if (choice === 8 && items.length) { name = 'read'; await session.setRead([any().id], rng.chance(0.5)); }
    else if (choice === 9) { name = 'folder'; await session.createFolder(`f${step}`, null); }
    else if (choice === 10 && items.length) { name = 'delete'; await session.deleteItems([any().id], rng.chance(0.5) ? 'detach' : 'delete'); }
    else if (choice === 11 && state.deletions.length) { name = 'restore'; await session.restoreDeleted(rng.pick(state.deletions).id); }
    else if (choice === 12) { name = 'undo'; await session.undo(); }
    else if (choice === 13) { name = 'redo'; await session.redo(); }
    else if (choice === 14 && selected && items.length) { // a conflicting sibling commit (two heads), as if it arrived by sync
      const parent = (await repository.read(LIBRARY)).checkpoint.batches.find(batch => batch.id === selected.version)?.parents[0];
      if (parent) {
        name = 'external conflict'; const id = makeId(), target = any();
        const changes: LibraryChange[] = [{ type: 'put-item', item: { ...target, title: `e${step}` } }];
        await repository.commit({ kind: 'library', id, libraryId: LIBRARY, targetId: LIBRARY, parents: [parent], changes }, { operationId: id, beforeVersion: parent, afterVersion: id, undoRequested: false });
        await session.refresh();
      }
    } else if (choice === 15 && state.heads.length > 1) { name = 'resolve'; const heads = [...state.heads]; await session.resolveConflict(rng.pick(heads), heads); }
    if (name === 'skip') continue;
    names.push(name); frames.push(await capture(repository));
  }
  return { frames, steps: names };
}

// ---------------------------------------------------------------- frame variants (applied once per step, to a clone, before both sides read)

/** Every object's keys in reverse order (arrays keep their order): the same data with a different exact key. */
export function reversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversedKeys) as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversedKeys(item)])) as T;
  return value;
}
export type Variant = 'same' | 'reorder-keys' | 'origins-absent' | 'origins-empty' | 'history-shuffle' | 'history-duplicate' | 'history-conflict' | 'history-drop'
  | 'non-plain-undefined' | 'negative-zero' | 'targets-missing' | 'targets-reorder-keys' | 'target-throw-all';
export const VARIANTS: Variant[] = ['same', 'same', 'same', 'same', 'reorder-keys', 'origins-absent', 'origins-empty', 'history-shuffle', 'history-duplicate', 'history-conflict',
  'history-drop', 'non-plain-undefined', 'negative-zero', 'targets-missing', 'targets-missing', 'targets-reorder-keys', 'target-throw-all'];
export function variantOf(frame: Frame, variant: Variant, rng: Rng): Frame {
  const next: Frame = structuredClone(frame), library = next.library;
  switch (variant) {
    case 'same': break;
    case 'reorder-keys': next.library = reversedKeys(library); break;
    case 'origins-absent': delete library.publicationOrigins; break;
    case 'origins-empty': library.publicationOrigins = []; break;
    case 'history-shuffle': { const copy = [...library.history]; for (let i = copy.length - 1; i > 0; i--) { const j = rng.int(i + 1); [copy[i], copy[j]] = [copy[j], copy[i]]; }
      library.history = copy; break; }
    case 'history-duplicate': if (library.history.length) library.history.push(structuredClone(rng.pick(library.history))); break;
    case 'history-conflict': if (library.history.length) library.history.push({ ...structuredClone(rng.pick(library.history)), undoRequested: true }); break;
    case 'history-drop': if (library.history.length) library.history.splice(rng.int(library.history.length), 1); break;
    case 'non-plain-undefined': { const batch = library.checkpoint.batches.find(value => value.kind === 'library' && value.changes.some(change => change.type === 'put-item'));
      const change = batch?.kind === 'library' ? batch.changes.find(value => value.type === 'put-item') : undefined;
      if (change?.type === 'put-item') (change.item.metadata as Record<string, unknown>).author = undefined; else (library.checkpoint.root as unknown as Record<string, unknown>).extra = undefined; break; }
    case 'negative-zero': { const batch = library.checkpoint.batches.find(value => value.kind === 'library' && value.changes.some(change => change.type === 'put-item' && change.item.position === 0));
      const change = batch?.kind === 'library' ? batch.changes.find(value => value.type === 'put-item' && value.item.position === 0) : undefined;
      if (change?.type === 'put-item') change.item.position = -0; break; }
    case 'targets-missing': for (const entry of next.targets) if (rng.chance(0.5)) entry[1] = { ok: false, error: 'missing-target' }; break;
    case 'targets-reorder-keys': next.targets = next.targets.map(([id, read]) => [id, read.ok ? { ok: true, state: reversedKeys(read.state) } : read]); break;
    case 'target-throw-all': next.targets = next.targets.map(([id]) => [id, { ok: false, error: 'storage-read-failed' }]); break;
  }
  return next;
}

/** A repository whose read() returns a clone of the current frame (the rest is the real, empty-journal repository). */
function playbackRepository(real: DurableEditRepository, current: () => Frame): DurableEditRepository {
  return new Proxy(real, { get: (target, key) => {
    if (key === 'read') return async (id: string) => {
      const frame = current();
      if (id === LIBRARY) return structuredClone(frame.library);
      const read = frame.targets.find(([targetId]) => targetId === id)?.[1];
      if (!read) throw new EditRejected('missing-target');
      if (!read.ok) throw new EditRejected(read.error);
      return structuredClone(read.state);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

const ordered = (value: unknown) => JSON.stringify(value, (_key, item) => item === undefined ? '<undefined>' : typeof item === 'number' && Object.is(item, -0) ? '<-0>' : item);
type Side = { session: PublicSession; frame: Frame };
/** Private members read by the probes (the product has catalogMemo; the legacy copy does not). */
type PrivateSession = { history: unknown; catalogMemo?: { graph: unknown; history?: { value: unknown } }; conflictGraph?: unknown;
  catalog(version?: string): Promise<{ deletedGraphs: Map<string, unknown> }>; display(read: unknown): void };
export type Pair = { a: Side; b: Side; setFrame(frame: Frame): void; compare(name: string): void;
  both(name: string, run: (session: PublicSession) => Promise<unknown>): Promise<string> };

/** Two sessions (reference, candidate), each on its own playback repository, reading the same frames. Records whether the candidate reused. */
export async function makePair(tally: Tally, scenario: string, reference: SessionModule, candidate: SessionModule, first: Frame): Promise<Pair> {
  const make = async (module: SessionModule): Promise<Side> => {
    const real = await newRepository(), holder: Side = { session: undefined as unknown as PublicSession, frame: first };
    let counter = 0x30000; const makeId = () => uuid(counter++);
    holder.session = new module.LibrarySession({ repository: playbackRepository(real, () => holder.frame), isActive: () => true, makeId });
    return holder;
  };
  const a = await make(reference), b = await make(candidate);
  const probe = () => { const p = b.session as unknown as PrivateSession; return { history: p.history, graph: p.conflictGraph, memo: p.catalogMemo }; };
  let before = probe();
  const compare = (name: string) => {
    record(tally, scenario, `${name}: state`, stable(a.session.getSnapshot()), stable(b.session.getSnapshot()));
    record(tally, scenario, `${name}: state (ordered)`, ordered(a.session.getSnapshot()), ordered(b.session.getSnapshot()));
    record(tally, scenario, `${name}: selected (ordered)`, outcome(() => ordered(a.session.getSelectedSnapshot())), outcome(() => ordered(b.session.getSelectedSnapshot())));
    record(tally, scenario, `${name}: conflict versions (ordered)`, outcome(() => ordered(a.session.conflictVersions())), outcome(() => ordered(b.session.conflictVersions())));
    record(tally, scenario, `${name}: flags`, stable([a.session.canLeave(), a.session.hasPendingResolution()]), stable([b.session.canLeave(), b.session.hasPendingResolution()]));
    record(tally, scenario, `${name}: history (private)`, stable((a.session as unknown as PrivateSession).history), stable((b.session as unknown as PrivateSession).history));
    // Evidence that the reuse path really ran (candidate only): the same graph instance / the same history object as before this step.
    const after = probe();
    if (after.graph && after.graph === before.graph) tally.ops.set('reuse graph', (tally.ops.get('reuse graph') ?? 0) + 1);
    if (after.memo?.history && after.history === before.history && after.memo.history.value === after.history) tally.ops.set('reuse history', (tally.ops.get('reuse history') ?? 0) + 1);
    before = after;
  };
  return { a, b, compare, setFrame: frame => { a.frame = frame; b.frame = frame; },
    both: async (name, run) => { const left = await outcomeAsync(() => run(a.session)), right = await outcomeAsync(() => run(b.session)); record(tally, scenario, name, left, right); return left; } };
}

/** One playback: `steps` scheduled frames (each one optionally varied) read by both sides; every comparison goes into `tally`. */
export async function playback(tally: Tally, scenario: string, rng: Rng, world: World, steps: number, reference: SessionModule, candidate: SessionModule): Promise<void> {
  const pair = await makePair(tally, scenario, reference, candidate, world.frames[0]), { compare } = pair;
  let index = 0;
  for (let step = 0; step < steps; step++) {
    // Mostly stay on the same frame (identical reads: the reuse path), sometimes move or jump back (A -> B -> A).
    const move = rng.int(10);
    if (move >= 6) index = move >= 9 ? rng.int(world.frames.length) : Math.min(world.frames.length - 1, index + 1);
    const variant = rng.pick(VARIANTS), frame = variantOf(world.frames[index], variant, rng);
    pair.setFrame(frame);
    const heads = frame.library.heads, action = rng.int(10);
    const version = heads.length > 1 && action >= 6 ? rng.pick(heads) : undefined;
    const name = `${step} f${index} ${variant} ${action === 9 ? 'undo' : version ? 'refresh(version)' : 'refresh'}`;
    const left = await pair.both(name, session => action === 9 ? session.undo() : session.refresh(version));
    const key = `${variant} ${left.slice(0, 12)}`; tally.ops.set(key, (tally.ops.get(key) ?? 0) + 1);
    compare(name);
  }
}

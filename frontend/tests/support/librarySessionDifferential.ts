/**
 * Session-level differential harness of work B13-d U2: the same random sequence of user operations, external commits (bare, unsupported,
 * conflicting, or not yet re-read by the session), Undo/Redo, conflict resolution and reopenings is driven through two LibrarySession implementations, each on its OWN
 * repository with identical content and identical deterministic ids. After every step the whole observable state is compared, plus the
 * private catalog()/versions() results for every version of the catalog. Inputs are chosen from the first (reference) side only.
 */
import type { EditDatabase, EditTransaction } from '../../src/runtime/edits/repository.ts';
import { DurableEditRepository } from '../../src/runtime/edits/repository.ts';
import type { EditGraph } from '../../src/runtime/edits/editGraph.ts';
import type { LibraryChange, LibraryItem, LibrarySnapshot } from '../../src/runtime/edits/contracts.ts';
import type { RepositoryState } from '../../src/runtime/edits/ports.ts';
import type { LibrarySession } from '../../src/features/library/LibrarySession.ts';
import { EditMemoryDatabase } from './editMemoryDatabase.ts';
import { outcome, outcomeAsync, record, stable, uuid, type Rng, type Tally } from './libraryHistoryDifferential.ts';

/** Structural (public members only), so the legacy copy and the product class are both accepted. */
export type PublicSession = Pick<LibrarySession, { [K in keyof LibrarySession]: K }[keyof LibrarySession]>;
export type SessionModule = { LibrarySession: new (options: ConstructorParameters<typeof LibrarySession>[0]) => PublicSession };
type Catalog = { read: RepositoryState; value?: LibrarySnapshot; deletedGraphs: Map<string, EditGraph> };
type Versions = { batch(id: string): unknown; snapshot(id: string): unknown; publicationOrigin(id: string): unknown; contentVersion(itemId: string, head: string): boolean };
type Private = { catalog(version?: string): Promise<Catalog>; versions(read: Catalog): Versions };

const fnv = (text: string) => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
/** Returns edits() in a salted hash order instead of the insertion order (the batches' arrival order is not meaningful). */
class PermutedDatabase implements EditDatabase {
  private readonly inner: EditDatabase; private readonly salt: string;
  constructor(inner: EditDatabase, salt: string) { this.inner = inner; this.salt = salt; }
  transaction<T>(run: (transaction: EditTransaction) => Promise<T>): Promise<T> {
    return this.inner.transaction(tx => run(new Proxy(tx, { get: (target, key) => {
      if (key === 'edits') return async (targetId?: string) => (await target.edits(targetId)).sort((a, b) => fnv(this.salt + a.batch.id) - fnv(this.salt + b.batch.id) || (a.batch.id < b.batch.id ? -1 : 1));
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } })));
  }
}

const LIBRARY = uuid(0xa11b);
type Side = { repository: DurableEditRepository; session: PublicSession; module: SessionModule; makeId: () => string };
async function side(module: SessionModule, salt: string | null): Promise<Side> {
  const scope = { accountId: 'b13d-u2', libraryId: LIBRARY, epoch: 'one' };
  const memory = new EditMemoryDatabase(), database = salt === null ? memory : new PermutedDatabase(memory, salt);
  const repository = new DurableEditRepository(scope, database, { inspectPdf: async () => [{ widthPt: 600, heightPt: 800 }] });
  await repository.initialize({ kind: 'library', id: LIBRARY, version: uuid(0xa11c), items: [], folders: [], links: [], deletions: [] });
  let counter = 0x10000; const makeId = () => uuid(counter++);
  const session = new module.LibrarySession({ repository, isActive: () => true, makeId });
  return { repository, session, module, makeId };
}

/** One run: `steps` random operations on both sides; every comparison is recorded into `tally` under `scenario`. */
export async function compareSessions(tally: Tally, scenario: string, rng: Rng, steps: number, reference: SessionModule, candidate: SessionModule, options: { permute: boolean; probeVersions: boolean }): Promise<void> {
  const salt = options.permute ? `salt-${rng.int(1e9)}` : null;
  const a = await side(reference, salt), b = await side(candidate, salt);
  const both = async (name: string, run: (s: Side) => Promise<unknown>) => record(tally, scenario, name, await outcomeAsync(() => run(a)), await outcomeAsync(() => run(b)));
  await both('initial refresh', s => s.session.refresh());
  const compareState = async (name: string) => {
    record(tally, scenario, `${name}: state`, stable(a.session.getSnapshot()), stable(b.session.getSnapshot()));
    record(tally, scenario, `${name}: selected`, stable(a.session.getSelectedSnapshot()), stable(b.session.getSelectedSnapshot()));
    record(tally, scenario, `${name}: conflict versions`, outcome(() => a.session.conflictVersions()), outcome(() => b.session.conflictVersions()));
    record(tally, scenario, `${name}: flags`, stable([a.session.canLeave(), a.session.hasPendingResolution(), a.session.canDiscardRejectedResolution()]),
      stable([b.session.canLeave(), b.session.hasPendingResolution(), b.session.canDiscardRejectedResolution()]));
    record(tally, scenario, `${name}: repository`, await outcomeAsync(() => a.repository.read(LIBRARY)), await outcomeAsync(() => b.repository.read(LIBRARY)));
    if (!options.probeVersions) return;
    const pa = a.session as unknown as Private, pb = b.session as unknown as Private;
    let ca: Catalog | undefined, cb: Catalog | undefined;
    const catalogOf = (c: Catalog) => ({ read: c.read, value: c.value, deleted: [...c.deletedGraphs].map(([id, graph]) => [id, graph.getView(), graph.checkpoint()]) });
    record(tally, scenario, `${name}: catalog()`, await outcomeAsync(async () => catalogOf(ca = await pa.catalog())), await outcomeAsync(async () => catalogOf(cb = await pb.catalog())));
    if (!ca || !cb) return;
    let va: Versions | undefined, vb: Versions | undefined;
    record(tally, scenario, `${name}: versions()`, outcome(() => { va = pa.versions(ca!); return null; }), outcome(() => { vb = pb.versions(cb!); return null; }));
    if (!va || !vb) return;
    const ids = [ca.read.checkpoint.root.version, ...ca.read.checkpoint.batches.map(batch => batch.id), uuid(0xdead)];
    for (const id of ids) record(tally, scenario, `${name}: versions ${id}`, outcome(() => [va!.batch(id), va!.snapshot(id), va!.publicationOrigin(id)]),
      outcome(() => [vb!.batch(id), vb!.snapshot(id), vb!.publicationOrigin(id)]));
    for (const origin of ca.read.publicationOrigins ?? []) for (const head of [origin.contentVersion ?? uuid(0xbeef), ...[...ca.deletedGraphs.get(origin.itemId)?.getView().heads ?? []]])
      record(tally, scenario, `${name}: contentVersion ${origin.itemId}`, outcome(() => va!.contentVersion(origin.itemId, head)), outcome(() => vb!.contentVersion(origin.itemId, head)));
  };
  await compareState('initial');
  for (let step = 0; step < steps; step++) {
    const state = a.session.getSnapshot(), selected = a.session.getSelectedSnapshot();
    const items = state.items as LibraryItem[], folders = state.folders, roots = items.filter(item => !item.ownerId && item.kind !== 'attachment');
    const any = () => rng.pick(items), folder = () => folders.length && rng.chance(0.7) ? rng.pick(folders).id : null;
    const choice = rng.int(26); let name = 'skip';
    const run = async (label: string, op: (s: Side) => Promise<unknown>) => {
      name = label; const left = await outcomeAsync(() => op(a)), right = await outcomeAsync(() => op(b));
      record(tally, scenario, label, left, right); const key = `op ${label} ${left.slice(0, 40)}`; tally.ops.set(key, (tally.ops.get(key) ?? 0) + 1);
    };
    switch (choice) {
      case 0: case 1: { const kind = rng.pick(['markdown', 'notebook'] as const), owner = roots.length && rng.chance(0.25) ? rng.pick(roots).id : null;
        const folderId = owner ? null : folder(); // every input is drawn BEFORE running, never inside the per-side closure
        await run(`create ${kind}`, s => s.session.create({ kind, title: `n${step}`, folderId, ownerId: owner })); break; }
      case 2: { const folderId = folder(); await run('importPdf', s => s.session.importPdf({ name: `p${step}.pdf`, bytes: Uint8Array.of(1, 2, step & 255), folderId })); break; }
      case 3: if (roots.length) { const owner = rng.pick(roots).id; await run('importAttachment', s => s.session.importAttachment({ ownerId: owner, name: `a${step}.txt`, mediaType: 'text/plain', bytes: Uint8Array.of(9, step & 255) })); } break;
      case 4: if (items.length) { const id = any().id; await run('rename', s => s.session.rename(id, `r${step}`)); } break;
      case 5: if (items.length) { const ids = [any().id, any().id], tag = rng.pick(['x', 'y']); const mode = rng.chance(0.7) ? 'add' as const : 'remove' as const;
        await run('updateTags', s => s.session.updateTags(ids, { mode, tags: [tag] })); } break;
      case 6: if (items.length) { const id = any().id, value = rng.chance(0.5); await run('setRead', s => s.session.setRead([id], value)); } break;
      case 7: { const pdfs = items.filter(item => item.kind === 'pdf'); if (pdfs.length) { const id = rng.pick(pdfs).id, author = rng.pick(['A', 'B']);
        await run('updateBibliography', s => s.session.updateBibliography(id, { author })); } break; }
      case 8: { const parent = folder(); await run('createFolder', s => s.session.createFolder(`f${step}`, parent)); break; }
      case 9: if (folders.length) { const id = rng.pick(folders).id; await run('renameFolder', s => s.session.renameFolder(id, `g${step}`)); } break;
      case 10: if (folders.length) { const id = rng.pick(folders).id, parent = folder(); await run('moveFolder', s => s.session.moveFolder(id, parent)); } break;
      case 11: if (folders.length) { const id = rng.pick(folders).id; await run('removeFolder', s => s.session.removeFolder(id)); } break;
      case 12: if (items.length) { const ids = [any().id], to = folder(); await run('moveItems', s => s.session.moveItems(ids, to)); } break;
      case 13: if (roots.length || folders.length) {
        const entries = [...roots.map(item => ({ kind: 'item' as const, id: item.id })), ...folders.map(value => ({ kind: 'folder' as const, id: value.id }))];
        const source = rng.pick(entries), target = rng.chance(0.2) ? null : rng.pick(entries), placement = rng.pick(['inside', 'before', 'after'] as const);
        await run('reorderEntry', s => s.session.reorderEntry(source, target, placement)); } break;
      case 14: { const pdfs = items.filter(item => item.kind === 'pdf' && !item.ownerId), notes = roots.filter(item => item.kind !== 'pdf');
        if (pdfs.length && notes.length) { const link = { pdfId: rng.pick(pdfs).id, noteId: rng.pick(notes).id }; await run('addLinks', s => s.session.addLinks([link])); } break; }
      case 15: if (state.links.length) { const link = rng.pick(state.links); await run('removeLinks', s => s.session.removeLinks([link])); } break;
      case 16: { const owned = items.filter(item => item.ownerId && item.kind !== 'attachment'); if (owned.length) { const id = rng.pick(owned).id; await run('detachNotes', s => s.session.detachNotes([id])); } break; }
      case 17: if (items.length) { const ids = [any().id], mode = rng.chance(0.5) ? 'detach' as const : 'delete' as const; await run(`deleteItems ${mode}`, s => s.session.deleteItems(ids, mode)); } break;
      case 18: if (state.deletions.length) { const id = rng.pick(state.deletions).id; await run('restoreDeleted', s => s.session.restoreDeleted(id)); } break;
      case 19: case 20: await run('undo', s => s.session.undo()); break;
      case 21: await run('redo', s => s.session.redo()); break;
      case 22: { const reopen = rng.chance(0.5); await run(reopen ? 'reopen' : 'refresh', async s => {
        if (reopen) s.session = new s.module.LibrarySession({ repository: s.repository, isActive: () => true, makeId: s.makeId });
        return s.session.refresh(); }); break; }
      case 23: case 24: if (selected && items.length) { // external commits: bare (no history), recorded-but-unsupported, or a conflicting sibling
        const target = any(), mode = rng.pick(['bare', 'silent', 'unsupported', 'conflict'] as const);
        const parent = mode === 'conflict' ? (await a.repository.read(LIBRARY)).checkpoint.batches.find(batch => batch.id === selected.version)?.parents[0] : selected.version;
        if (!parent) break;
        await run(`external ${mode}`, async s => {
          const id = s.makeId(), changes: LibraryChange[] = mode === 'unsupported'
            ? [{ type: 'put-item', item: { ...target, title: `e${step}`, position: target.position + 3 } }, { type: 'put-folder', folder: { id: s.makeId(), title: 'ext', parentId: null, position: 77 } }]
            : [{ type: 'put-item', item: { ...target, title: `e${step}` } }];
          const batch = { kind: 'library' as const, id, libraryId: LIBRARY, targetId: LIBRARY, parents: [parent], changes };
          const result = await s.repository.commit(batch, mode === 'bare' ? undefined : { operationId: id, beforeVersion: parent, afterVersion: id, undoRequested: false });
          if (mode !== 'silent') await s.session.refresh(); // 'silent': a recorded edit arriving like a sync; the session has not re-read yet
          return result.status;
        }); } break;
      case 25: if (state.heads.length > 1) { const heads = [...state.heads], version = rng.pick(heads); await run('resolveConflict', s => s.session.resolveConflict(version, heads)); } break;
    }
    if (name !== 'skip') await compareState(`${step} ${name}`);
  }
}

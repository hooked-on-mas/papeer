/**
 * Support for the differential tests of libraryHistory.ts / LibrarySession.ts (work B13-d U2): a seeded generator of random Library
 * histories (built with the real catalog operations and the LEGACY history functions for Undo/Redo, so the generator never depends on
 * the code under test), tampered variants of them, and the comparison harness. What is compared is the whole observable result:
 * the returned value (stable JSON) or the class name and the complete message of the exception. Deterministic for a given seed.
 */
import type { EditBatch, Folder, HistoryRecord, LibraryChange, LibraryEditBatch, LibraryItem, LibrarySnapshot, ResolutionBatch } from '../../src/runtime/edits/contracts.ts';
import type { PublicationOrigin } from '../../src/runtime/edits/ports.ts';
import { applyBatch } from '../../src/runtime/edits/editModel.ts';
import {
  addLibraryLinks, createLibraryFolder, deleteLibraryItems, detachLibraryNotes, libraryAppendPosition, libraryOwnedAppendPosition,
  moveLibraryFolder, moveLibraryItems, removeLibraryFolder, removeLibraryLinks, renameLibraryFolder, renameLibraryItem,
  restoreDeletedLibraryItems, setLibraryItemsRead, updateLibraryBibliography, updateLibraryTags,
} from '../../src/features/library/canonicalLibraryOperations.ts';
import { reorderLibraryEntry } from '../../src/features/library/tree/canonicalLibraryReorder.ts';
import type { LibraryVersions } from '../../src/features/library/libraryHistory.ts';
import * as legacy from './libraryHistoryLegacy.ts';
import { makeRng, type Rng } from './schemaDifferential.ts';
export { makeRng, type Rng };

export type HistoryImpl = Pick<typeof legacy, 'restoreLibraryHistory' | 'assertLibraryEdit' | 'assertLibraryMetadataEdit' | 'inverseLibraryEdit'>;
export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** Stable serialization that, unlike canonicalJson, also accepts undefined (as a marker) and non-plain leaves. */
export function stable(value: unknown): string {
  if (value === undefined) return '"<undefined>"';
  if (typeof value === 'number' && !Number.isFinite(value)) return `"<${String(value)}>"`;
  if (value instanceof Uint8Array) return `"<bytes:${Array.from(value).join(',')}>"`;
  if (value instanceof Map) return `{"<map>":${stable([...value.entries()])}}`;
  if (value instanceof Set) return `{"<set>":${stable([...value.values()])}}`;
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  if (typeof value === 'function') return '"<function>"';
  return JSON.stringify(value) ?? `"<${typeof value}>"`;
}
/** "ok <stable value>" or "throw <Class>: <message>". */
export function outcome(run: () => unknown): string {
  try { return 'ok ' + stable(run()); }
  catch (error) { return 'throw ' + (error instanceof Error ? `${error.constructor.name}: ${error.message}` : stable(error)); }
}
export async function outcomeAsync(run: () => Promise<unknown>): Promise<string> {
  try { return 'ok ' + stable(await run()); }
  catch (error) { return 'throw ' + (error instanceof Error ? `${error.constructor.name}: ${error.message}` : stable(error)); }
}

// ---------------------------------------------------------------- the versions store

export type Store = {
  batches: Map<string, EditBatch>; snapshots: Map<string, LibrarySnapshot>; origins: Map<string, PublicationOrigin>;
  content: Map<string, string[]>;
  /** false = contentVersion() always fails (observed content heads have not arrived). */
  contentOk: boolean;
  /** true = snapshot() returns a fresh clone (like LibrarySession's EditGraph); false = the internal reference (like the unit-test setup). */
  cloneSnapshots: boolean;
};
export const cloneStore = (store: Store): Store => ({ ...structuredClone({ batches: store.batches, snapshots: store.snapshots, origins: store.origins, content: store.content }),
  contentOk: store.contentOk, cloneSnapshots: store.cloneSnapshots });
export const storeDigest = (store: Store) => stable({ ...store });
export function versionsOf(store: Store): Required<LibraryVersions> {
  return {
    batch: id => store.batches.get(id),
    snapshot: id => { const value = store.snapshots.get(id); return value && store.cloneSnapshots ? structuredClone(value) : value; },
    publicationOrigin: id => store.origins.get(id),
    contentVersion: (itemId, head) => store.contentOk && !!store.content.get(itemId)?.includes(head),
  };
}

export type History = { store: Store; records: HistoryRecord[]; head: string; root: string; libraryId: string; steps: string[] };

// ---------------------------------------------------------------- generator

const KINDS = ['markdown', 'notebook', 'pdf', 'attachment'] as const;
/** A random history of ordinary operations, Undo/Redo (computed with the LEGACY functions), unsupported and unrecorded batches,
 * resolutions (stop the ancestry), side branches and orphans whose parent is missing. */
export function generateHistory(rng: Rng, options: { steps: number; cloneSnapshots?: boolean }): History {
  let counter = 0x100;
  const next = () => uuid(counter++);
  const libraryId = uuid(1), rootVersion = uuid(2);
  const store: Store = { batches: new Map(), snapshots: new Map(), origins: new Map(), content: new Map(), contentOk: true, cloneSnapshots: options.cloneSnapshots ?? rng.chance(0.5) };
  const item = (fields: Partial<LibraryItem> & Pick<LibraryItem, 'kind'>): LibraryItem => ({ id: next(), title: `t${counter}`, ownerId: null, folderId: null,
    position: 0, tags: [], read: false, metadata: {}, ...fields });
  const folders: Folder[] = rng.int(3) ? [{ id: next(), title: 'F1', parentId: null, position: 0 }] : [];
  if (folders.length && rng.chance(0.6)) folders.push({ id: next(), title: 'F2', parentId: folders[0].id, position: 1 });
  const pdf = item({ kind: 'pdf', resourceId: next(), position: 1 });
  const note = item({ kind: 'markdown', position: 2, folderId: folders.length && rng.chance(0.5) ? folders[folders.length - 1].id : null });
  const items: LibraryItem[] = [pdf, note];
  if (rng.chance(0.6)) items.push(item({ kind: 'markdown', ownerId: pdf.id, position: 0 }));
  if (rng.chance(0.4)) items.push(item({ kind: 'attachment', ownerId: note.folderId ? pdf.id : note.id, resourceId: next(), position: 1 }));
  if (rng.chance(0.4)) items.push(item({ kind: 'notebook', position: 3 }));
  for (const value of items) if (value.kind !== 'attachment') store.content.set(value.id, [next()]);
  const root: LibrarySnapshot = { kind: 'library', id: libraryId, version: rootVersion, items, folders, links: rng.chance(0.5) ? [{ pdfId: pdf.id, noteId: note.id }] : [], deletions: [] };
  applyBatch(root, { kind: 'library', id: next(), libraryId, targetId: libraryId, parents: [rootVersion], changes: [{ type: 'put-folder', folder: { id: next(), title: 'probe', parentId: null, position: 9 } }] });
  store.snapshots.set(rootVersion, root);
  const records: HistoryRecord[] = [], steps: string[] = [];
  let head = root;
  const commit = (changes: LibraryChange[], name: string, extra: { record?: boolean; action?: HistoryRecord['action']; origin?: (batch: LibraryEditBatch) => PublicationOrigin | undefined; batchId?: string } = {}): boolean => {
    if (!changes.length) return false;
    const batch: LibraryEditBatch = { kind: 'library', id: extra.batchId ?? next(), libraryId, targetId: libraryId, parents: [head.version], changes };
    let after: LibrarySnapshot;
    try { after = applyBatch(head, batch) as LibrarySnapshot; } catch { return false; }
    store.batches.set(batch.id, batch); store.snapshots.set(batch.id, after);
    const origin = extra.origin?.(batch); if (origin) store.origins.set(batch.id, origin);
    if (extra.record ?? rng.chance(0.85)) {
      const record: HistoryRecord = { operationId: batch.id, beforeVersion: head.version, afterVersion: batch.id, undoRequested: false, ...(extra.action ? { action: extra.action } : {}) };
      records.push(record);
    }
    head = after; steps.push(name); return true;
  };
  const live = () => { const deleted = new Set(head.deletions.filter(value => value.active).flatMap(value => value.itemIds)); return head.items.filter(value => !deleted.has(value.id)); };
  const attempt = (name: string, make: () => LibraryChange[], extra?: Parameters<typeof commit>[2]) => { try { return commit(make(), name, extra); } catch { return false; } };
  const historyVersions = () => versionsOf({ ...store, cloneSnapshots: true, contentOk: true });
  for (let step = 0; step < options.steps; step++) {
    const choice = rng.int(22), liveItems = live(), any = () => rng.pick(liveItems);
    if (!liveItems.length && choice < 14) continue;
    switch (choice) {
      case 0: case 1: { // publication creation (markdown / notebook / pdf / attachment)
        const kind = rng.pick(KINDS), owners = liveItems.filter(value => !value.ownerId && value.kind !== 'attachment');
        const ownerId = kind === 'attachment' || (kind !== 'pdf' && rng.chance(0.3)) ? (owners.length ? rng.pick(owners).id : null) : null;
        if (kind === 'attachment' && !ownerId) break;
        const folderId = ownerId || !head.folders.length || rng.chance(0.5) ? null : rng.pick(head.folders).id;
        const created = item({ kind, ownerId, folderId, ...(kind === 'pdf' || kind === 'attachment' ? { resourceId: next() } : {}),
          position: ownerId ? libraryOwnedAppendPosition(head, ownerId) : libraryAppendPosition(head, folderId) });
        const contentVersion = kind === 'attachment' ? null : next();
        const pdfs = liveItems.filter(value => value.kind === 'pdf' && !value.ownerId);
        const changes: LibraryChange[] = [{ type: 'put-item', item: created }];
        if ((kind === 'markdown' || kind === 'notebook') && !ownerId && pdfs.length && rng.chance(0.4)) changes.push({ type: 'add-link', link: { pdfId: rng.pick(pdfs).id, noteId: created.id } });
        const originMode = rng.int(10); // 0: none, 1: wrong item, otherwise proven
        if (commit(changes, 'create-' + kind, { origin: batch => originMode === 0 ? undefined : { batchId: batch.id, itemId: originMode === 1 ? next() : created.id, kind, contentVersion } })
          && contentVersion) store.content.set(created.id, [contentVersion, ...(rng.chance(0.3) ? [next()] : [])]);
        break;
      }
      case 2: attempt('rename', () => renameLibraryItem(head, any().id, `r${counter}`)); break;
      case 3: attempt('tags', () => updateLibraryTags(head, [any().id, ...(rng.chance(0.3) ? [any().id] : [])], { mode: rng.chance(0.7) ? 'add' : 'remove', tags: [rng.pick(['a', 'b', 'c'])] })); break;
      case 4: attempt('read', () => setLibraryItemsRead(head, [any().id], rng.chance(0.5))); break;
      case 5: { const pdfs = liveItems.filter(value => value.kind === 'pdf'); if (pdfs.length) attempt('bibliography', () => updateLibraryBibliography(head, rng.pick(pdfs).id, { author: rng.pick(['A', 'B', '']), year: rng.pick(['2020', '2021']) })); break; }
      case 6: attempt('folder-create', () => createLibraryFolder(head, next(), `f${counter}`, head.folders.length && rng.chance(0.4) ? rng.pick(head.folders).id : null)); break;
      case 7: if (head.folders.length) attempt('folder-rename', () => renameLibraryFolder(head, rng.pick(head.folders).id, `g${counter}`)); break;
      case 8: if (head.folders.length) attempt('folder-move', () => moveLibraryFolder(head, rng.pick(head.folders).id, rng.chance(0.5) ? null : rng.pick(head.folders).id)); break;
      case 9: if (head.folders.length) attempt('folder-remove', () => removeLibraryFolder(head, rng.pick(head.folders).id)); break;
      case 10: attempt('move', () => moveLibraryItems(head, [any().id], head.folders.length && rng.chance(0.7) ? rng.pick(head.folders).id : null)); break;
      case 11: attempt('reorder', () => {
        const entries = [...liveItems.filter(value => !value.ownerId).map(value => ({ kind: 'item' as const, id: value.id })), ...head.folders.map(value => ({ kind: 'folder' as const, id: value.id }))];
        return reorderLibraryEntry(head, rng.pick(entries), rng.chance(0.2) ? null : rng.pick(entries), rng.pick(['inside', 'before', 'after'] as const));
      }); break;
      case 12: { const pdfs = liveItems.filter(value => value.kind === 'pdf' && !value.ownerId), notes = liveItems.filter(value => (value.kind === 'markdown' || value.kind === 'notebook') && !value.ownerId);
        if (pdfs.length && notes.length) attempt(rng.chance(0.5) || !head.links.length ? 'link-add' : 'link-remove', () => rng.chance(0.5) || !head.links.length
          ? addLibraryLinks(head, [{ pdfId: rng.pick(pdfs).id, noteId: rng.pick(notes).id }]) : removeLibraryLinks(head, [rng.pick(head.links)])); break; }
      case 13: { const owned = liveItems.filter(value => value.ownerId && value.kind !== 'attachment'); if (owned.length) attempt('detach', () => detachLibraryNotes(head, [rng.pick(owned).id])); break; }
      case 14: case 15: { // deletion (detach or delete child notes), observed heads from the content map
        const target = rng.pick(liveItems.length ? liveItems : head.items);
        try {
          const mode = rng.chance(0.5) ? 'detach' as const : 'delete' as const;
          const ids = [target.id, ...head.items.filter(value => value.ownerId === target.id && (mode === 'delete' || value.kind === 'attachment')).map(value => value.id)];
          const observed: Record<string, string[]> = {};
          for (const value of head.items) if (ids.includes(value.id) && value.kind !== 'attachment') observed[value.id] = [store.content.get(value.id)?.[0] ?? next()];
          commit(deleteLibraryItems(head, { id: next(), itemIds: [target.id], childNotes: mode, observed }), 'delete-' + mode);
        } catch { /* not deletable now */ }
        break;
      }
      case 16: { const inactive = head.deletions.filter(value => value.active); if (inactive.length) attempt('restore', () => restoreDeletedLibraryItems(head, rng.pick(inactive).id)); break; }
      case 17: case 18: { // Undo / Redo computed with the LEGACY functions over the history so far
        const kind = choice === 17 ? 'undo' as const : 'redo' as const;
        try {
          const versions = historyVersions(), restored = legacy.restoreLibraryHistory(versions, head.version, records);
          const entry = restored[kind][restored[kind].length - 1]; if (!entry) break;
          const origin = store.origins.get(entry.executionId);
          const observed = origin && origin.kind !== 'attachment' ? [{ targetId: origin.itemId, heads: [store.content.get(origin.itemId)?.[0] ?? next()] }] : [];
          const id = next(), inverse = legacy.inverseLibraryEdit(versions, entry.executionId, head, id, { observed });
          commit(inverse.changes, kind, { record: true, action: { kind, operationId: entry.operationId }, batchId: id });
        } catch { /* nothing to undo/redo */ }
        break;
      }
      case 19: { // unsupported but valid batches
        const target = any();
        const variants: (() => LibraryChange[])[] = [
          () => [{ type: 'put-item', item: { ...target, title: `u${counter}`, position: target.position + 7 } }],
          () => [{ type: 'put-item', item: { ...target, metadata: { ...target.metadata, custom: `m${counter}` } } }],
          () => [...renameLibraryItem(head, target.id, `v${counter}`), { type: 'put-folder', folder: { id: next(), title: 'mixed', parentId: null, position: 50 } }],
          () => [{ type: 'put-item', item: { ...target, tags: [...target.tags, `x${counter}`], read: !target.read, position: target.position + 1 } }],
        ];
        attempt('unsupported', rng.pick(variants)); break;
      }
      case 20: { // resolution of the head with a side branch (stops the ancestry)
        const side: LibraryEditBatch = { kind: 'library', id: next(), libraryId, targetId: libraryId, parents: [head.version], changes: [] };
        try { side.changes = renameLibraryItem(head, any().id, `s${counter}`); } catch { break; }
        let sideAfter: LibrarySnapshot; try { sideAfter = applyBatch(head, side) as LibrarySnapshot; } catch { break; }
        store.batches.set(side.id, side); store.snapshots.set(side.id, sideAfter);
        if (rng.chance(0.5)) records.push({ operationId: side.id, beforeVersion: head.version, afterVersion: side.id, undoRequested: false });
        if (!attempt('pre-resolution', () => renameLibraryItem(head, any().id, `p${counter}`), { record: true })) break;
        const id = next(), chosen = rng.chance(0.5) ? head : sideAfter;
        const resolution: ResolutionBatch = { kind: 'resolution', id, libraryId, targetId: libraryId, parents: [head.version, side.id], snapshot: { ...chosen, version: id } };
        store.batches.set(id, resolution); store.snapshots.set(id, resolution.snapshot as LibrarySnapshot);
        head = resolution.snapshot as LibrarySnapshot; steps.push('resolution'); break;
      }
      case 21: { // an orphan: a recorded batch whose parent never arrived (its ancestry walk stops at the missing parent)
        const missing = next(), orphan: LibraryEditBatch = { kind: 'library', id: next(), libraryId, targetId: libraryId, parents: [missing], changes: [] };
        try { orphan.changes = renameLibraryItem(head, any().id, `o${counter}`); } catch { break; }
        try { store.snapshots.set(orphan.id, { ...(applyBatch({ ...head, version: missing }, orphan) as LibrarySnapshot) }); } catch { break; }
        store.batches.set(orphan.id, orphan); records.push({ operationId: orphan.id, beforeVersion: missing, afterVersion: orphan.id, undoRequested: false }); break;
      }
    }
  }
  return { store, records, head: head.version, root: rootVersion, libraryId, steps };
}

// ---------------------------------------------------------------- tampering (exceptions in the middle of a history, missing data)

export type Tamper = { name: string; store: Store; records: HistoryRecord[] };
export function tamperings(rng: Rng, history: History): Tamper[] {
  const ids = [...history.store.batches.keys()], out: Tamper[] = [];
  if (!ids.length) return out;
  const fresh = () => cloneStore(history.store), pickLibrary = () => {
    const library = ids.filter(id => history.store.batches.get(id)!.kind === 'library'); return library.length ? rng.pick(library) : undefined;
  };
  { const store = fresh(); store.batches.delete(rng.pick(ids)); out.push({ name: 'batch-missing', store, records: history.records }); }
  { const store = fresh(); store.snapshots.delete(rng.pick(ids)); out.push({ name: 'snapshot-missing', store, records: history.records }); }
  const target = pickLibrary();
  if (target) {
    const batch = history.store.batches.get(target) as LibraryEditBatch, parent = history.store.snapshots.get(batch.parents[0]);
    if (parent) { const store = fresh(); store.snapshots.set(target, { ...structuredClone(parent), version: target }); out.push({ name: 'replay-mismatch', store, records: history.records }); }
    { const store = fresh(); store.batches.set(target, { ...structuredClone(batch), changes: [{ type: 'remove-folder', id: uuid(0xfffff) }] }); out.push({ name: 'replay-throws-rejected', store, records: history.records }); }
    { const store = fresh(), broken = structuredClone(batch) as unknown as { changes: unknown[] };
      broken.changes = [{ type: 'put-item', item: { ...(batch.changes.find(change => change.type === 'put-item') as { item?: LibraryItem } | undefined)?.item, title: 42 } }];
      store.batches.set(target, broken as unknown as EditBatch); out.push({ name: 'replay-throws-schema', store, records: history.records }); }
    { const store = fresh(), item = store.snapshots.get(target)!.items[0];
      if (item) { const after = structuredClone(store.snapshots.get(target)!); after.items.push({ ...item }); store.snapshots.set(target, after); out.push({ name: 'after-invalid', store, records: history.records }); } }
  }
  { // a parent cycle through the head: the ancestry walk meets an id it has seen
    const first = ids.find(id => history.store.batches.get(id)!.parents[0] === history.root);
    if (first && first !== history.head) { const store = fresh(); store.batches.set(first, { ...structuredClone(store.batches.get(first)!), parents: [history.head] } as EditBatch); out.push({ name: 'parent-cycle', store, records: history.records }); }
  }
  { const store = fresh(); store.contentOk = false; out.push({ name: 'content-missing', store, records: history.records }); }
  { const store = fresh(); store.cloneSnapshots = !store.cloneSnapshots; out.push({ name: 'snapshot-sharing-flipped', store, records: history.records }); }
  const records = history.records;
  if (records.length) {
    const shuffled = [...records]; for (let i = shuffled.length - 1; i > 0; i--) { const j = rng.int(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    out.push({ name: 'records-shuffled', store: fresh(), records: shuffled });
    const victim = rng.pick(records);
    out.push({ name: 'record-conflict', store: fresh(), records: [...records, { ...victim, undoRequested: !victim.undoRequested }] });
    out.push({ name: 'record-duplicate', store: fresh(), records: [...records, structuredClone(victim)] });
    out.push({ name: 'record-mismatch', store: fresh(), records: records.map(value => value === victim ? { ...value, beforeVersion: uuid(0xeeeee) } : value) });
    out.push({ name: 'record-action-foreign', store: fresh(), records: records.map(value => value === victim ? { ...value, action: { kind: 'undo' as const, operationId: rng.pick(records).operationId } } : value) });
    out.push({ name: 'records-truncated', store: fresh(), records: records.slice(rng.int(records.length)) });
  }
  return out;
}

// ---------------------------------------------------------------- comparison of the history functions

export type Difference = { scenario: string; probe: string; legacy: string; product: string };
/** `differing` counts every mismatch; `differences` keeps the first 50 for the failure message. */
export type Tally = { compared: number; differing: number; differences: Difference[]; outcomes: Map<string, number>; ops: Map<string, number> };
export const newTally = (): Tally => ({ compared: 0, differing: 0, differences: [], outcomes: new Map(), ops: new Map() });
export function record(tally: Tally, scenario: string, probe: string, legacyOutcome: string, productOutcome: string) {
  tally.compared++;
  const kind = legacyOutcome.startsWith('ok') ? 'ok' : legacyOutcome.replace(/ [0-9a-f-]{36}.*$/, '').slice(0, 90);
  tally.outcomes.set(kind, (tally.outcomes.get(kind) ?? 0) + 1);
  if (legacyOutcome === productOutcome) return;
  tally.differing++;
  let at = 0; while (at < legacyOutcome.length && legacyOutcome[at] === productOutcome[at]) at++;
  const excerpt = (text: string) => `@${at}: …${text.slice(Math.max(0, at - 240), at + 160)}…`;
  if (tally.differences.length < 50) tally.differences.push({ scenario, probe, legacy: excerpt(legacyOutcome), product: excerpt(productOutcome) });
}
/** Runs every probe on both implementations, each with its OWN deep copy of the store, then also checks that neither copy was mutated. */
export function compareStore(tally: Tally, scenario: string, store: Store, records: HistoryRecord[], head: string, a: HistoryImpl, b: HistoryImpl, rng: Rng, full: boolean): void {
  const original = storeDigest(store), storeA = cloneStore(store), storeB = cloneStore(store);
  const va = versionsOf(storeA), vb = versionsOf(storeB);
  const probe = (name: string, run: (impl: HistoryImpl, versions: Required<LibraryVersions>, own: Store) => unknown) =>
    record(tally, scenario, name, outcome(() => run(a, va, storeA)), outcome(() => run(b, vb, storeB)));
  const versionIds = [...store.snapshots.keys(), ...store.batches.keys()].filter((value, index, all) => all.indexOf(value) === index);
  const restoreAt = full ? [...versionIds, uuid(0xddddd)] : [head, ...versionIds.filter(() => rng.chance(0.25))];
  for (const version of restoreAt) probe(`restore ${version}`, (impl, versions) => impl.restoreLibraryHistory(versions, version, records));
  const batchIds = [...store.batches.keys()];
  for (const id of full ? [...batchIds, uuid(0xddddd)] : batchIds.filter(() => rng.chance(0.4))) {
    probe(`assert ${id}`, (impl, versions) => impl.assertLibraryEdit(versions, id));
    probe(`assert-restore ${id}`, (impl, versions) => impl.assertLibraryEdit(versions, id, true));
    probe(`assert-metadata ${id}`, (impl, versions) => impl.assertLibraryMetadataEdit(versions, id));
    const origin = store.origins.get(id), batch = store.batches.get(id);
    const observed = origin && origin.kind !== 'attachment' ? [{ targetId: origin.itemId, heads: [store.content.get(origin.itemId)?.[0] ?? uuid(0xccccc)] }] : [];
    const currents = [head, id, ...(batch?.parents ?? [])].filter((value, index, all) => all.indexOf(value) === index && store.snapshots.has(value));
    for (const current of full ? currents : currents.slice(0, 1)) {
      probe(`inverse ${id} on ${current}`, (impl, versions, own) => impl.inverseLibraryEdit(versions, id, structuredClone(own.snapshots.get(current)!), uuid(0xbbbbb), { observed }));
      if (full) probe(`inverse-plain ${id} on ${current}`, (impl, versions, own) => impl.inverseLibraryEdit(versions, id, structuredClone(own.snapshots.get(current)!), uuid(0xbbbbb)));
    }
  }
  record(tally, scenario, 'store not mutated (legacy, product)', String(storeDigest(storeA) === original), String(storeDigest(storeB) === original));
  if (storeDigest(storeA) !== original) throw new Error(`the LEGACY implementation mutated the store in ${scenario}`);
}

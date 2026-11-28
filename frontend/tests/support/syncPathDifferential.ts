// B13-d U5: random differential of the sync paths (installCheckpoint / receiveRecords / receive / receivePublications) between the
// pre-U5 code (tests/support/repositoryLegacy.ts + editGraphLegacy.ts) and a candidate. Each side runs the same operation sequence on its
// OWN deep copy of the same database state, with the same read order. A RecordingDatabase keeps the full write trace (every putRoot /
// putEdit / putProjection / pruneProjections / rememberCheckpoint, serialized at call time, also inside transactions that later abort),
// so partial application before an exception is compared too (not only the rolled-back committed state).
import { applyBatch } from '../../src/runtime/edits/editModel.ts';
import type { ContentPublication, DocumentSnapshot, EditBatch, EditRecord, Folder, HistoryRecord, LibraryEditBatch, LibraryItem, LibrarySnapshot,
  MarkdownSnapshot, RepositoryCheckpoint, ResourceMetadata, Snapshot } from '../../src/runtime/edits/contracts.ts';
import type { EditDatabase, EditTransaction, StoredEdit } from '../../src/runtime/edits/repository.ts';
import type { EditScope } from '../../src/runtime/edits/ports.ts';

// ---------------------------------------------------------------- deterministic randomness

export type Rng = { next(): number; int(n: number): number; chance(p: number): boolean; pick<T>(values: readonly T[]): T; shuffle<T>(values: readonly T[]): T[] };
export function makeRng(seed: number): Rng {
  let state = seed >>> 0 || 1;
  const next = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (n: number) => Math.floor(next() * n);
  return { next, int, chance: p => next() < p, pick: values => values[int(values.length)],
    shuffle: values => { const copy = [...values]; for (let i = copy.length - 1; i > 0; i--) { const j = int(i + 1); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy; } };
}
const hexOf = (rng: Rng, n: number) => Array.from({ length: n }, () => rng.int(16).toString(16)).join('');
export const uuid = (rng: Rng) => `${hexOf(rng, 8)}-${hexOf(rng, 4)}-4${hexOf(rng, 3)}-8${hexOf(rng, 3)}-${hexOf(rng, 12)}`;

/** Stable serialization that also accepts undefined and byte arrays (canonicalJson rejects undefined). */
export function stable(value: unknown): string {
  if (value === undefined) return '"$undefined"';
  if (value instanceof Uint8Array) return `{"$bytes":[${[...value].join(',')}]}`;
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? '"$unserializable"';
}

// ---------------------------------------------------------------- recording database

export type DbState = { roots: Map<string, Snapshot>; edits: Map<string, StoredEdit>; resources: Map<string, ResourceMetadata>; checkpoints: Set<string> };
/** order: how `edits()` / `roots()` list rows — insertion order (EditMemoryDatabase), key order (IndexedDB getAll), reversed, or a salted hash order. */
export type DbOptions = { order: 'insertion' | 'key' | 'reverse' | number; cloneReads: boolean; failReads: string[] };
export class StorageReadFailure extends Error {}
export const cloneState = (state: DbState): DbState => structuredClone(state);
export const stateJson = (state: DbState) => stable({ roots: [...state.roots.entries()].sort(), edits: [...state.edits.entries()].sort(),
  resources: [...state.resources.entries()].sort(), checkpoints: [...state.checkpoints].sort() });
const fnv = (text: string) => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
function ordered<T>(values: T[], key: (value: T) => string, order: DbOptions['order']): T[] {
  if (order === 'insertion') return values;
  if (order === 'reverse') return [...values].reverse();
  if (order === 'key') return [...values].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return [...values].sort((a, b) => fnv(order + key(a)) - fnv(order + key(b)) || (key(a) < key(b) ? -1 : 1));
}
export class RecordingDatabase implements EditDatabase {
  state: DbState;
  readonly trace: string[] = [];
  readonly reads: Record<string, number> = {};
  private readonly options: DbOptions;
  private count = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(state: DbState, options: DbOptions) { this.state = state; this.options = options; }
  async transaction<T>(run: (transaction: EditTransaction) => Promise<T>): Promise<T> {
    const previous = this.tail; let release!: () => void; this.tail = new Promise(resolve => { release = resolve; }); await previous;
    const local = cloneState(this.state), index = this.count++, options = this.options, trace = this.trace, reads = this.reads;
    const out = <V>(value: V): V => options.cloneReads && value !== undefined ? structuredClone(value) : value;
    const keep = <V>(value: V): V => options.cloneReads ? structuredClone(value) : value;
    const read = (kind: string, id?: string) => {
      reads[kind] = (reads[kind] ?? 0) + 1;
      const key = id === undefined ? kind : `${kind}:${id}`;
      if (options.failReads.includes(key)) throw new StorageReadFailure(`storage-read-failed ${key}`);
    };
    const unsupported = (name: string) => () => { throw new Error(`unsupported in RecordingDatabase: ${name}`); };
    trace.push(`tx${index} begin`);
    try {
      const result = await run({
        access: async () => undefined, control: async () => undefined, putControl: unsupported('putControl'),
        scopedState: unsupported('scopedState') as never, putScopedEdit: unsupported('putScopedEdit'),
        datasets: async () => [], putDataset: manifest => { trace.push(`putDataset ${stable(manifest)}`); },
        root: async id => { read('root', id); return out(local.roots.get(id)); },
        roots: async () => { read('roots'); return ordered([...local.roots.values()], root => root.id, options.order).map(out); },
        edits: async targetId => { read('edits');
          return ordered([...local.edits.values()].filter(edit => targetId === undefined || edit.batch.targetId === targetId), edit => edit.batch.id, options.order).map(out); },
        editById: async id => { read('editById', id); return out(local.edits.get(id)); },
        putRoot: root => { trace.push(`putRoot ${stable(root)}`); local.roots.set(root.id, keep(root)); },
        putEdit: edit => { trace.push(`putEdit ${stable(edit)}`); local.edits.set(edit.batch.id, keep(edit)); },
        putProjection: snapshot => { trace.push(`putProjection ${stable(snapshot)}`); },
        pruneProjections: async (targetId, versions) => { trace.push(`prune ${targetId} ${stable(versions)}`); },
        resource: async id => { read('resource', id); return out(local.resources.get(id)); },
        resourceBytes: async () => undefined, putResource: unsupported('putResource'),
        hasCheckpoint: async hash => { read('hasCheckpoint'); return local.checkpoints.has(hash); },
        rememberCheckpoint: hash => { trace.push(`rememberCheckpoint ${hash}`); local.checkpoints.add(hash); },
        intent: async () => undefined, intents: async () => [], putIntent: unsupported('putIntent'),
      });
      this.state = local; trace.push(`tx${index} commit`); return result;
    } catch (error) { trace.push(`tx${index} abort`); throw error; }
    finally { release(); }
  }
}

// ---------------------------------------------------------------- operations, observation, comparison

export type SyncOp = { kind: 'install'; checkpoint: RepositoryCheckpoint } | { kind: 'records'; records: EditRecord[] }
  | { kind: 'batches'; batches: EditBatch[] } | { kind: 'publications'; publications: ContentPublication[]; batches: EditBatch[] };
export type Scenario = { name: string; scope: EditScope; state: DbState; options: DbOptions; ops: SyncOp[]; faults: string[] };
export type SyncRepository = { installCheckpoint(c: RepositoryCheckpoint): Promise<void>; receiveRecords(r: EditRecord[]): Promise<void>;
  receive(b: EditBatch[]): Promise<void>; receivePublications(p: ContentPublication[], b?: EditBatch[]): Promise<void> };
export type SyncRepositoryClass = new (scope: EditScope, database: EditDatabase) => SyncRepository;
export type Observation = { outcomes: string[]; trace: string[]; state: string; argsChanged: boolean[]; reads: Record<string, number> };
export const outcomeOf = (error: unknown) => error instanceof Error ? `${error.constructor.name}: ${error.message}` : `thrown ${stable(error)}`;

export async function observe(Repo: SyncRepositoryClass, scenario: Scenario): Promise<Observation> {
  const db = new RecordingDatabase(cloneState(scenario.state), scenario.options), repo = new Repo(scenario.scope, db);
  const outcomes: string[] = [], argsChanged: boolean[] = [];
  for (const original of scenario.ops) {
    const op = structuredClone(original), before = stable(op);
    try {
      if (op.kind === 'install') await repo.installCheckpoint(op.checkpoint);
      else if (op.kind === 'records') await repo.receiveRecords(op.records);
      else if (op.kind === 'batches') await repo.receive(op.batches);
      else await repo.receivePublications(op.publications, op.batches);
      outcomes.push('ok');
    } catch (error) { outcomes.push(outcomeOf(error)); }
    argsChanged.push(stable(op) !== before);
  }
  return { outcomes, trace: db.trace, state: stateJson(db.state), argsChanged, reads: { ...db.reads } };
}
export type Tally = { compared: number; differing: number; differences: { name: string; field: string; legacy: string; candidate: string }[];
  outcomes: Map<string, number>; faults: Map<string, number>; reads: { legacy: Record<string, number>; candidate: Record<string, number> } };
export const newTally = (): Tally => ({ compared: 0, differing: 0, differences: [], outcomes: new Map(), faults: new Map(), reads: { legacy: {}, candidate: {} } });
const add = (target: Record<string, number>, source: Record<string, number>) => { for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value; };
/** One scenario = ops.length comparisons (outcome of each op); trace, final state and argument immutability are compared for the whole sequence. */
export async function compareScenario(tally: Tally, scenario: Scenario, legacy: SyncRepositoryClass, candidate: SyncRepositoryClass): Promise<void> {
  const [a, b] = [await observe(legacy, scenario), await observe(candidate, scenario)];
  tally.compared += scenario.ops.length;
  for (const outcome of a.outcomes) { const kind = outcome.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>').slice(0, 90); tally.outcomes.set(kind, (tally.outcomes.get(kind) ?? 0) + 1); }
  for (const fault of scenario.faults) tally.faults.set(fault, (tally.faults.get(fault) ?? 0) + 1);
  add(tally.reads.legacy, a.reads); add(tally.reads.candidate, b.reads);
  const fields: [string, string, string][] = [['outcomes', stable(a.outcomes), stable(b.outcomes)], ['argsChanged', stable(a.argsChanged), stable(b.argsChanged)],
    ['state', a.state, b.state]];
  const traceDiff = a.trace.findIndex((line, index) => line !== b.trace[index]);
  if (traceDiff >= 0 || a.trace.length !== b.trace.length) {
    const at = traceDiff >= 0 ? traceDiff : Math.min(a.trace.length, b.trace.length);
    fields.push(['trace', `#${at}/${a.trace.length} ${(a.trace[at] ?? '<end>').slice(0, 200)}`, `#${at}/${b.trace.length} ${(b.trace[at] ?? '<end>').slice(0, 200)}`]);
  }
  let differs = false;
  for (const [field, x, y] of fields) if (x !== y) {
    differs = true;
    if (tally.differences.length < 20) tally.differences.push({ name: scenario.name, field, legacy: x.slice(0, 400), candidate: y.slice(0, 400) });
  }
  if (differs) tally.differing += scenario.ops.length;
}

// ---------------------------------------------------------------- world generator

type ContentInfo = { root: Snapshot; head: string; viaPublication: boolean };
export type World = { scope: EditScope; libraryRoot: LibrarySnapshot; contents: Map<string, ContentInfo>; records: EditRecord[]; resources: ResourceMetadata[];
  states: Map<string, LibrarySnapshot>; heads: string[]; plainItems: string[]; publishedItems: string[] };
const sha = (rng: Rng) => hexOf(rng, 64);

/** A random library history: publications (markdown / pdf / notebook / attachment), plain put-items with separately stored content roots,
 * updates, folders, links, deletions, branches from older versions (several heads), resolutions of two heads, markdown content edits,
 * history records (some with undo actions, valid or not). Every batch is accepted by applyBatch at generation time. */
export function generateWorld(rng: Rng, steps: number): World {
  const libraryId = uuid(rng), scope: EditScope = { accountId: 'acct-u5', libraryId, epoch: 'epoch-u5' };
  const pdf: ResourceMetadata = { id: uuid(rng), sha256: sha(rng), mediaType: 'application/pdf', byteLength: 100, pdfPages: [{ widthPt: 600, heightPt: 800 }] };
  const attachment: ResourceMetadata = { id: uuid(rng), sha256: sha(rng), mediaType: 'application/octet-stream', byteLength: 10 };
  const image: ResourceMetadata = { id: uuid(rng), sha256: sha(rng), mediaType: 'image/png', byteLength: 10 };
  const libraryRoot: LibrarySnapshot = { kind: 'library', id: libraryId, version: uuid(rng), items: [], folders: [], links: [], deletions: [] };
  const states = new Map<string, LibrarySnapshot>([[libraryRoot.version, libraryRoot]]), order: string[] = [libraryRoot.version];
  const contents = new Map<string, ContentInfo>(), records: EditRecord[] = [], plainItems: string[] = [], publishedItems: string[] = [];
  const operations: string[] = [];
  let n = 0;
  const markdownRoot = (id: string): MarkdownSnapshot => ({ kind: 'markdown', id, version: uuid(rng), content: `body ${n}`, appendIds: [],
    imageResources: rng.chance(.2) ? [{ resourceId: image.id, sha256: image.sha256 }] : [] });
  const documentRoot = (id: string, pdfBacked: boolean): DocumentSnapshot => {
    const version = uuid(rng);
    return { kind: 'document', id, version, deletedPages: [], pages: [{ id: uuid(rng), backgroundRevision: version, lifecycleVersion: version, annotationVersion: version,
      widthPt: 600, heightPt: 800, annotations: [], background: pdfBacked ? { kind: 'pdf', resourceId: pdf.id, sourceRevision: pdf.sha256, pdfPage: 1 }
        : { kind: 'paper', spec: { template: 'blank', color: 'white' } } }] };
  };
  const history = (batch: EditBatch): HistoryRecord | undefined => {
    if (!rng.chance(.6)) return undefined;
    const record: HistoryRecord = { operationId: batch.id, beforeVersion: batch.parents[0], afterVersion: batch.id, undoRequested: false };
    // an undo of the operation that made the parent version (valid, or pending when an ancestor has no history), rarely an invalid one
    const parentRecord = records.find(value => value.batch.id === batch.parents[0]);
    if (batch.parents.length === 1 && parentRecord?.history && !parentRecord.history.action && rng.chance(.12)) record.action = { kind: 'undo', operationId: parentRecord.batch.id };
    else if (operations.length && rng.chance(.01)) record.action = { kind: rng.chance(.5) ? 'undo' : 'redo', operationId: rng.chance(.5) ? rng.pick(operations) : uuid(rng) };
    return record;
  };
  const push = (batch: EditBatch, publication?: ContentPublication) => {
    const record: EditRecord = { batch }, h = history(batch);
    if (h) { record.history = h; if (!h.action) operations.push(batch.id); }
    if (publication) record.publication = publication;
    records.push(record);
  };
  const library = (parents: string[], changes: LibraryEditBatch['changes']): LibraryEditBatch => ({ kind: 'library', id: uuid(rng), libraryId, targetId: libraryId, parents, changes });
  for (let step = 0; step < steps; step++) {
    n++;
    const parentVersion = rng.chance(.75) ? order[order.length - 1] : rng.pick(order), parent = states.get(parentVersion)!;
    const items = parent.items, roll = rng.next();
    let batch: EditBatch | undefined, publication: ContentPublication | undefined, content: ContentInfo | undefined;
    const item = (kind: LibraryItem['kind'], extra: Partial<LibraryItem> = {}): LibraryItem => ({ id: uuid(rng), kind, title: `item ${n}`, ownerId: null, folderId: null,
      position: n, tags: [], read: false, metadata: {}, ...extra });
    if (roll < .34) {   // publication
      const owners = items.filter(value => !value.ownerId && value.kind !== 'attachment');
      const kind = rng.pick<LibraryItem['kind']>(owners.length ? ['markdown', 'pdf', 'notebook', 'attachment'] : ['markdown', 'pdf', 'notebook']);
      const created = kind === 'attachment' ? item(kind, { ownerId: rng.pick(owners).id, resourceId: attachment.id }) : kind === 'pdf' ? item(kind, { resourceId: pdf.id }) : item(kind);
      const root = kind === 'markdown' ? markdownRoot(created.id) : kind === 'attachment' ? undefined : documentRoot(created.id, kind === 'pdf');
      batch = library([parentVersion], [{ type: 'put-item', item: created }]);
      publication = { libraryBatch: batch, ...(root ? { content: root } : {}) };
      if (root) content = { root, head: root.version, viaPublication: true };
      publishedItems.push(created.id);
    } else if (roll < .48) {   // plain put-item, content root stored separately
      const kind = rng.pick<LibraryItem['kind']>(['markdown', 'pdf', 'notebook']), created = kind === 'pdf' ? item(kind, { resourceId: pdf.id }) : item(kind);
      const root = kind === 'markdown' ? markdownRoot(created.id) : documentRoot(created.id, kind === 'pdf' && rng.chance(.5));
      batch = library([parentVersion], [{ type: 'put-item', item: created }]); content = { root, head: root.version, viaPublication: false };
      plainItems.push(created.id);
    } else if (roll < .70 && items.length) {   // update one or two items
      const changed = rng.shuffle(items).slice(0, 1 + rng.int(2)).map(old => [{ ...old, title: `${old.title} r${n}` }, { ...old, tags: [`t${n % 4}`] },
        { ...old, read: !old.read }, { ...old, position: old.position + 100 }][rng.int(4)]);
      batch = library([parentVersion], changed.map(value => ({ type: 'put-item' as const, item: value })));
    } else if (roll < .78) {   // folder
      const folder: Folder = parent.folders.length && rng.chance(.4) ? { ...rng.pick(parent.folders), title: `folder ${n}` } : { id: uuid(rng), title: `folder ${n}`, parentId: null, position: n };
      const movable = items.filter(value => !value.ownerId);
      const changes: LibraryEditBatch['changes'] = [{ type: 'put-folder', folder }];
      if (movable.length && rng.chance(.5)) changes.push({ type: 'put-item', item: { ...rng.pick(movable), folderId: folder.id } });
      batch = library([parentVersion], changes);
    } else if (roll < .83 && items.length) {   // link add / remove
      const pdfs = items.filter(value => value.kind === 'pdf' && !value.ownerId), notes = items.filter(value => ['markdown', 'notebook'].includes(value.kind) && !value.ownerId);
      if (parent.links.length && rng.chance(.4)) batch = library([parentVersion], [{ type: 'remove-link', link: rng.pick(parent.links) }]);
      else if (pdfs.length && notes.length) batch = library([parentVersion], [{ type: 'add-link', link: { pdfId: rng.pick(pdfs).id, noteId: rng.pick(notes).id } }]);
    } else if (roll < .87 && items.length) {   // deletion of an item that owns nothing and is in no link
      const free = items.filter(value => !items.some(other => other.ownerId === value.id) && !parent.links.some(link => link.pdfId === value.id || link.noteId === value.id));
      if (free.length) {
        const target = rng.pick(free), observed = target.kind === 'attachment' ? [] : [{ targetId: target.id, heads: [contents.get(target.id)?.head ?? uuid(rng)] }];
        batch = library([parentVersion], [{ type: 'put-deletion', deletion: { id: uuid(rng), itemIds: [target.id], observed, active: true } }]);
      }
    } else if (roll < .93) {   // resolution of two versions (a merge of two heads when there are two)
      const others = order.filter(value => value !== parentVersion);
      if (others.length) {
        const other = rng.pick(others), id = uuid(rng);
        batch = { kind: 'resolution', id, libraryId, targetId: libraryId, parents: rng.shuffle([parentVersion, other]), snapshot: { ...parent, version: id } };
      }
    } else {   // markdown content edit
      const markdown = [...contents.entries()].filter(([, info]) => info.root.kind === 'markdown');
      if (markdown.length) {
        const [id, info] = rng.pick(markdown);
        const edit: EditBatch = { kind: 'markdown', id: uuid(rng), libraryId, targetId: id, parents: [info.head], content: `edit ${n}`,
          imageResources: rng.chance(.2) ? [{ resourceId: image.id, sha256: image.sha256 }] : [] };
        push(edit); info.head = edit.id;
      }
      continue;
    }
    if (!batch) continue;
    let next: Snapshot;
    try { next = applyBatch(parent, batch); } catch { continue; }
    states.set(batch.id, next as LibrarySnapshot); order.push(batch.id);
    if (content) contents.set(content.root.id, content);
    push(batch, publication);
  }
  const parentsOf = new Set(records.filter(record => record.batch.targetId === libraryId).flatMap(record => record.batch.parents));
  const heads = order.filter(version => !parentsOf.has(version));
  return { scope, libraryRoot, contents, records, resources: [pdf, attachment, image], states, heads, plainItems, publishedItems };
}

// ---------------------------------------------------------------- faults and scenarios

/** A harmless valid library change (the schema requires a non-empty `changes`). */
const folderChange = (rng: Rng): LibraryEditBatch['changes'] => [{ type: 'put-folder', folder: { id: uuid(rng), title: 'f', parentId: null, position: 0 } }];
export const harmlessChanges = folderChange;
const receiptOf = (batch: EditBatch, upload: 'pending' | 'accepted') => ({ id: batch.id, targetId: batch.targetId, durable: true as const, upload, importedBy: [] as string[] });
const stored = (record: EditRecord, upload: 'pending' | 'accepted'): StoredEdit => ({ ...structuredClone(record), receipt: receiptOf(record.batch, upload) });
const emptyState = (): DbState => ({ roots: new Map(), edits: new Map(), resources: new Map(), checkpoints: new Set() });
function options(rng: Rng): DbOptions {
  const order = rng.chance(.25) ? 'insertion' : rng.chance(.4) ? 'key' : rng.chance(.15) ? 'reverse' : rng.int(1_000_000);
  return { order, cloneReads: rng.chance(.5), failReads: [] };
}

/** Fault injections (each one named; the tally counts how often each was used). They act on the record list, the roots, the resources
 * of the destination, or its read behaviour. Several may be combined. */
type Draft = { world: World; records: EditRecord[]; roots: Snapshot[]; resources: ResourceMetadata[]; options: DbOptions; faults: string[]; rng: Rng };
const FAULTS: [string, (draft: Draft) => boolean][] = [
  ['missing-content-root', d => { const id = d.world.plainItems.length ? d.rng.pick(d.world.plainItems) : undefined; if (!id) return false; d.roots = d.roots.filter(root => root.id !== id); return true; }],
  ['wrong-kind-root', d => { const id = d.world.plainItems.length ? d.rng.pick(d.world.plainItems) : undefined; if (!id) return false;
    const old = d.roots.find(root => root.id === id); if (!old) return false;
    d.roots = d.roots.map(root => root.id !== id ? root : root.kind === 'markdown' ? { kind: 'document', id, version: root.version, pages: [], deletedPages: [] } satisfies DocumentSnapshot
      : { kind: 'markdown', id, version: root.version, content: '', appendIds: [], imageResources: [] } satisfies MarkdownSnapshot); return true; }],
  ['missing-resource', d => { if (!d.resources.length) return false; const drop = d.rng.pick(d.resources); d.resources = d.resources.filter(value => value !== drop); return true; }],
  ['rejected-batch', d => { const parent = d.rng.pick([...d.world.states.keys()]);
    d.records.push({ batch: { kind: 'library', id: uuid(d.rng), libraryId: d.world.scope.libraryId, targetId: d.world.scope.libraryId, parents: [parent], changes: [{ type: 'remove-folder', id: uuid(d.rng) }] } }); return true; }],
  ['parent-cycle', d => { const a = uuid(d.rng), b = uuid(d.rng), lib = d.world.scope.libraryId;
    d.records.push({ batch: { kind: 'library', id: a, libraryId: lib, targetId: lib, parents: [b], changes: folderChange(d.rng) } }, { batch: { kind: 'library', id: b, libraryId: lib, targetId: lib, parents: [a], changes: folderChange(d.rng) } }); return true; }],
  ['missing-parent', d => { const lib = d.world.scope.libraryId, missing = uuid(d.rng), child = uuid(d.rng);
    d.records.push({ batch: { kind: 'library', id: missing === child ? uuid(d.rng) : child, libraryId: lib, targetId: lib, parents: [missing], changes: folderChange(d.rng) } }); return true; }],
  ['duplicate-identical', d => { if (!d.records.length) return false; d.records.push(structuredClone(d.rng.pick(d.records))); return true; }],
  ['duplicate-changed', d => { const libraryRecords = d.records.filter(record => record.batch.kind === 'library' && !record.publication); if (!libraryRecords.length) return false;
    const copy = structuredClone(d.rng.pick(libraryRecords)); (copy.batch as LibraryEditBatch).changes = folderChange(d.rng); d.records.push(copy); return true; }],
  ['publication-item-exists', d => { const id = d.world.plainItems.find(value => d.roots.some(root => root.id === value)); if (!id) return false;
    const version = [...d.world.states.entries()].find(([, state]) => state.items.some(value => value.id === id)); if (!version) return false;
    const item = version[1].items.find(value => value.id === id)!, root = d.roots.find(value => value.id === id)!;
    const batch: LibraryEditBatch = { kind: 'library', id: uuid(d.rng), libraryId: d.world.scope.libraryId, targetId: d.world.scope.libraryId, parents: [version[0]], changes: [{ type: 'put-item', item: { ...item, title: `${item.title} again` } }] };
    d.records.push({ batch, publication: { libraryBatch: batch, content: root as DocumentSnapshot | MarkdownSnapshot } });
    // variant: the content root travels only with the publication (an arrival then installs it, and reaches the graph-level check)
    if (d.rng.chance(.5)) d.roots = d.roots.filter(value => value.id !== id);
    return true; }],
  ['stale-document-page', d => { const index = d.roots.findIndex(root => root.kind === 'document' && root.pages.some(page => page.background.kind === 'pdf')); if (index < 0) return false;
    const root = structuredClone(d.roots[index]) as DocumentSnapshot;
    for (const page of root.pages) if (page.background.kind === 'pdf') page.background.sourceRevision = sha(d.rng);
    d.roots = d.roots.map((value, at) => at === index ? root : value); return true; }],
  ['schema-invalid', d => { if (!d.records.length) return false; const copy = structuredClone(d.rng.pick(d.records)); (copy.batch as { parents: unknown }).parents = 'not-a-list'; d.records.push(copy); return true; }],
  ['batch-scope', d => { if (!d.records.length) return false; const copy = structuredClone(d.rng.pick(d.records)); copy.batch.id = uuid(d.rng); copy.batch.libraryId = uuid(d.rng); if (copy.batch.kind === 'library') copy.batch.targetId = copy.batch.libraryId;
    delete copy.history; delete copy.publication; d.records.push(copy); return true; }],
  ['read-failure', d => { const candidates = [...d.roots.filter(root => root.kind !== 'library').map(root => `root:${root.id}`), ...d.resources.map(value => `resource:${value.id}`)];
    if (!candidates.length) return false; d.options.failReads.push(d.rng.pick(candidates)); return true; }],
  ['history-action-invalid', d => { const target = d.records.find(record => record.history && !record.history.action); if (!target) return false;
    const copy = structuredClone(target); copy.history!.action = { kind: 'undo', operationId: uuid(d.rng) }; d.records[d.records.indexOf(target)] = copy; return true; }],
];

/** One scenario from one world: a bootstrap (installCheckpoint) or an arrival (receiveRecords / receive / receivePublications), possibly
 * followed by a second operation on the same database (re-install = the checkpoint marker path, or an incremental receive). */
export function scenarioFrom(world: World, rng: Rng, name: string, force: string[] = []): Scenario {
  const draft: Draft = { world, records: structuredClone(world.records), rng, options: options(rng), faults: [],
    roots: [world.libraryRoot, ...[...world.contents.values()].map(info => info.root)], resources: [...world.resources] };
  const faultCount = rng.chance(.45) ? 0 : 1 + rng.int(rng.chance(.3) ? 3 : 1);
  for (let k = 0; k < faultCount; k++) { const [faultName, apply] = rng.pick(FAULTS); if (apply(draft)) draft.faults.push(faultName); }
  for (const forced of force) { const entry = FAULTS.find(([faultName]) => faultName === forced); if (!entry) throw new Error(`unknown fault ${forced}`); if (entry[1](draft)) draft.faults.push(forced); }
  const state = emptyState(); for (const value of draft.resources) state.resources.set(value.id, structuredClone(value));
  const ops: SyncOp[] = [];
  const mode = rng.next();
  if (mode < .4) {   // bootstrap of a new (or partially filled) device
    const records = rng.chance(.7) ? [...draft.records].sort((a, b) => a.batch.id < b.batch.id ? -1 : 1) : rng.shuffle(draft.records);
    const checkpoint: RepositoryCheckpoint = { version: 1, libraryId: world.scope.libraryId, roots: rng.chance(.8) ? draft.roots : rng.shuffle(draft.roots), edits: records };
    if (rng.chance(.3)) {   // the device already has some of it, with local pending uploads
      state.roots.set(world.libraryRoot.id, structuredClone(world.libraryRoot));
      for (const record of world.records.slice(0, rng.int(world.records.length + 1))) if (record.batch.targetId === world.scope.libraryId && !record.publication)
        state.edits.set(record.batch.id, stored(record, rng.chance(.5) ? 'pending' : 'accepted'));
    }
    ops.push({ kind: 'install', checkpoint });
    if (rng.chance(.25)) ops.push({ kind: 'install', checkpoint: structuredClone(checkpoint) });
  } else {   // an arrival into a device that has the roots and part of the history
    for (const root of draft.roots) if (root.kind === 'library' || !world.contents.get(root.id)?.viaPublication) state.roots.set(root.id, structuredClone(root));
    if (!state.roots.has(world.libraryRoot.id) || rng.chance(.03)) state.roots.delete(world.libraryRoot.id);
    const known = rng.int(draft.records.length + 1), present = new Set<string>();
    for (const record of world.records.slice(0, known)) {
      if (record.publication?.content) state.roots.set(record.publication.content.id, structuredClone(record.publication.content));
      state.edits.set(record.batch.id, stored(record, rng.chance(.3) ? 'pending' : 'accepted')); present.add(record.batch.id);
    }
    const incoming = draft.records.filter(record => !present.has(record.batch.id) || rng.chance(.15));
    const shuffled = rng.chance(.8) ? rng.shuffle(incoming) : incoming;
    const kind = rng.next();
    if (kind < .8) ops.push({ kind: 'records', records: shuffled });
    else if (kind < .9) ops.push({ kind: 'batches', batches: shuffled.map(record => record.batch) });
    else ops.push({ kind: 'publications', publications: shuffled.flatMap(record => record.publication ? [record.publication] : []), batches: shuffled.filter(record => !record.publication).map(record => record.batch) });
    if (rng.chance(.2) && world.heads.length) {   // one more increment on top of a head
      const head = rng.pick(world.heads), item = world.states.get(head)?.items[0];
      if (item) ops.push({ kind: 'records', records: [{ batch: { kind: 'library', id: uuid(rng), libraryId: world.scope.libraryId, targetId: world.scope.libraryId, parents: [head],
        changes: [{ type: 'put-item', item: { ...item, position: item.position + 1 } }] } }] });
    }
  }
  for (const root of draft.roots) if (ops[0].kind === 'install' && rng.chance(.05)) state.roots.set(root.id, structuredClone(root));
  return { name, scope: world.scope, state, options: draft.options, ops, faults: draft.faults };
}

/** Boundary inputs: empty history, one batch, only waiting batches, only rejected batches, an empty arrival, a duplicate-only arrival,
 * a missing library root, a checkpoint installed twice, content records whose root has not arrived, two heads, and one long chain (B = 60). */
export function boundaryScenarios(rng: Rng): Scenario[] {
  const out: Scenario[] = [];
  const base = (world: World, records: EditRecord[], ops: (state: DbState) => SyncOp[], name: string, withRoots = true, extra: (state: DbState) => void = () => undefined) => {
    for (const order of ['insertion', 'key', 'reverse', 7] as const) for (const cloneReads of [false, true]) {
      const state = emptyState(); for (const value of world.resources) state.resources.set(value.id, structuredClone(value));
      if (withRoots) { state.roots.set(world.libraryRoot.id, structuredClone(world.libraryRoot)); for (const info of world.contents.values()) if (!info.viaPublication) state.roots.set(info.root.id, structuredClone(info.root)); }
      extra(state);
      out.push({ name: `${name}/${order}/${cloneReads}`, scope: world.scope, state, options: { order, cloneReads, failReads: [] }, ops: ops(state), faults: [] });
      void records;
    }
  };
  const checkpointOf = (world: World, records: EditRecord[]): RepositoryCheckpoint => ({ version: 1, libraryId: world.scope.libraryId,
    roots: [world.libraryRoot, ...[...world.contents.values()].map(info => info.root)], edits: records });
  for (const steps of [0, 1, 2, 60]) {
    const world = generateWorld(rng, steps), records = world.records;
    base(world, records, () => [{ kind: 'install', checkpoint: checkpointOf(world, records) }], `install-steps${steps}`, false);
    base(world, records, () => [{ kind: 'install', checkpoint: checkpointOf(world, records) }, { kind: 'install', checkpoint: checkpointOf(world, records) }], `install-twice-steps${steps}`, false);
    base(world, records, () => [{ kind: 'records', records }], `receive-all-steps${steps}`);
    base(world, records, () => [{ kind: 'records', records: [] }], `receive-empty-steps${steps}`);
    base(world, records, () => [{ kind: 'records', records }, { kind: 'records', records }], `receive-duplicate-only-steps${steps}`);
    base(world, records, () => [{ kind: 'records', records }], `receive-no-library-root-steps${steps}`, false);
    const lib = world.scope.libraryId;
    const waiting: EditRecord[] = Array.from({ length: 3 }, () => ({ batch: { kind: 'library', id: uuid(rng), libraryId: lib, targetId: lib, parents: [uuid(rng)], changes: folderChange(rng) } }));
    base(world, waiting, () => [{ kind: 'records', records: waiting }], `receive-only-waiting-steps${steps}`);
    base(world, waiting, () => [{ kind: 'install', checkpoint: checkpointOf(world, waiting) }], `install-only-waiting-steps${steps}`, false);
    const rejected: EditRecord[] = [{ batch: { kind: 'library', id: uuid(rng), libraryId: lib, targetId: lib, parents: [world.libraryRoot.version], changes: [{ type: 'remove-folder', id: uuid(rng) }] } }];
    base(world, rejected, () => [{ kind: 'records', records: rejected }], `receive-only-rejected-steps${steps}`);
    base(world, rejected, () => [{ kind: 'install', checkpoint: checkpointOf(world, rejected) }], `install-only-rejected-steps${steps}`, false);
    base(world, records, () => [{ kind: 'records', records }], `receive-existing-rejected-steps${steps}`, true, state => {
      for (const record of rejected) state.edits.set(record.batch.id, stored(record, 'accepted')); });
    const contentOnly = records.filter(record => record.batch.targetId !== lib);
    base(world, contentOnly, () => [{ kind: 'records', records: contentOnly }], `receive-content-before-root-steps${steps}`, true, state => {
      for (const info of world.contents.values()) state.roots.delete(info.root.id); });
  }
  return out;
}

// Large-Library support (work B13-c). The ONLY writer in the ordinary-Web support files: it seeds a large catalog directly into IndexedDB
// (rows shaped exactly like the product's own writer produces: roots / projections / edits). The seed is a plan computed here, never read back
// from the product; every functional assertion compares the real DOM / real IndexedDB with the plan's independently computed expectations.
// A seeded catalog is NOT a UI-created catalog (no per-item publication, no history, no Undo entry): every report must say so.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { EditGraph } from '../../src/runtime/edits/editGraph.ts';
import type { Folder, LibraryChange, LibraryEditBatch, LibraryItem, LibrarySnapshot, MarkdownSnapshot, Snapshot } from '../../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../../src/runtime/edits/repository.ts';

export type LargeSpec = {
  rootFolders: number; subFolders: number; directPerFolder: number; subItems: number; rootItems: number; owners: number; ownedPer: number;
  /** The seed's catalog history is split into this many linear batches (1 = one bulk batch). */
  batches: number; missingEvery: number;
};
/** 2,000 items (220 independent root + 80 owned + 1,700 in folders) in 100 folders (20 top-level, 80 nested). Every item has a saved Markdown body. */
export const DEFAULT_SPEC: LargeSpec = { rootFolders: 20, subFolders: 4, directPerFolder: 45, subItems: 10, rootItems: 220, owners: 10, ownedPer: 8, batches: 20, missingEvery: 0 };
/** Same shape, but every 80th item (25) is seeded WITHOUT a saved body. Seed-only state: the product refuses every catalog commit while a catalog row lacks its content root
 * (observed: "変更の完了を確認できません", one pending intent), so this spec is for read-only observation of the "not retrieved" notice. */
export const UNRETRIEVED_SPEC: LargeSpec = { ...DEFAULT_SPEC, missingEvery: 80 };
export const WORDS = ['alpha', 'beta', 'gamma', 'delta'] as const;

const pad = (value: number, width = 4) => String(value).padStart(width, '0');
const uid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export type PlannedItem = LibraryItem & { index: number; body: string | null; path: string };
export type Sibling = { kind: 'folder' | 'item'; id: string; title: string };
export type LargePlan = {
  spec: LargeSpec; libraryId: string; rootVersion: string; folders: Folder[]; items: PlannedItem[]; batches: LibraryEditBatch[];
  headVersion: string; contents: MarkdownSnapshot[];
  /** Sibling order of the root, and of every folder (persisted `position` order, folders and independent items interleaved). */
  rootSiblings: Sibling[]; childrenOf: Map<string, Sibling[]>; ownedOf: Map<string, string[]>;
  missingContentIds: string[];
};

export function planLargeCatalog(libraryId: string, rootVersion: string, spec: LargeSpec = DEFAULT_SPEC): LargePlan {
  const folders: Folder[] = [], items: PlannedItem[] = [], childrenOf = new Map<string, Sibling[]>(), ownedOf = new Map<string, string[]>();
  let folderN = 0, itemN = 0;
  const makeItem = (title: (index: number) => string, folderId: string | null, ownerId: string | null, position: number, path: string): PlannedItem => {
    const index = itemN++, id = uid('a1a1a1a1', index + 1), name = title(index);
    const missing = spec.missingEvery > 0 && index % spec.missingEvery === 1;
    const item: PlannedItem = { id, kind: 'markdown', title: name, ownerId, folderId, position, tags: [`topic-${index % 5}`], read: index % 7 === 0, metadata: {}, index,
      body: missing ? null : `lorem ${name} bn${pad(index)}${index % 10 === 0 ? ' sharedbody' : ''}`, path };
    items.push(item); return item;
  };
  const itemTitle = (index: number) => `Item ${pad(index)} ${WORDS[index % 4]}`;
  /** Interleave `folderCount` folders among `count` siblings: a folder every `floor(count / folderCount)` positions, from position 0. */
  const layout = (count: number, folderCount: number) => { const period = Math.max(1, Math.floor(count / Math.max(1, folderCount)));
    return Array.from({ length: count }, (_, position) => folderCount && position % period === 0 && Math.floor(position / period) < folderCount ? 'folder' as const : 'item' as const); };
  // Root: independent items and top-level folders.
  const rootKinds = layout(spec.rootItems + spec.rootFolders, spec.rootFolders), rootSiblings: Sibling[] = [];
  const topFolders: Folder[] = [];
  const owners: PlannedItem[] = [];
  rootKinds.forEach((kind, position) => {
    if (kind === 'folder') {
      const id = uid('f0f0f0f0', ++folderN), folder: Folder = { id, title: `Folder ${pad(topFolders.length + 1, 2)}`, parentId: null, position };
      folders.push(folder); topFolders.push(folder); rootSiblings.push({ kind: 'folder', id, title: folder.title });
    } else {
      const item = makeItem(itemTitle, null, null, position, 'root'); rootSiblings.push({ kind: 'item', id: item.id, title: item.title });
      if (owners.length < spec.owners) owners.push(item);
    }
  });
  for (const owner of owners) ownedOf.set(owner.id, Array.from({ length: spec.ownedPer }, (_, position) =>
    makeItem(index => `Owned ${pad(index)} of ${owner.title.slice(5, 9)}`, null, owner.id, position, `owned:${owner.id}`).id));
  for (const top of topFolders) {
    const kinds = layout(spec.directPerFolder + spec.subFolders, spec.subFolders), siblings: Sibling[] = [];
    let sub = 0;
    kinds.forEach((kind, position) => {
      if (kind === 'folder') {
        const id = uid('f0f0f0f0', ++folderN), folder: Folder = { id, title: `${top.title} / Sub ${++sub}`, parentId: top.id, position };
        folders.push(folder); siblings.push({ kind: 'folder', id, title: folder.title });
        childrenOf.set(id, Array.from({ length: spec.subItems }, (_, p) => { const item = makeItem(itemTitle, id, null, p, `${top.title}/${folder.title}`); return { kind: 'item' as const, id: item.id, title: item.title }; }));
      } else { const item = makeItem(itemTitle, top.id, null, position, top.title); siblings.push({ kind: 'item', id: item.id, title: item.title }); }
    });
    childrenOf.set(top.id, siblings);
  }
  // History: one linear chain. Folders first (parents before children), then the items in `batches` slices.
  const changes: LibraryChange[] = [...folders.map(folder => ({ type: 'put-folder' as const, folder })),
    ...items.map(({ index: _index, body: _body, path: _path, ...item }) => ({ type: 'put-item' as const, item }))];
  const size = Math.ceil(changes.length / spec.batches), batches: LibraryEditBatch[] = [];
  for (let n = 0; n < spec.batches; n++) batches.push({ kind: 'library', id: uid('b0b0b0b0', n + 1), libraryId, targetId: libraryId,
    parents: [n === 0 ? rootVersion : uid('b0b0b0b0', n)], changes: changes.slice(n * size, (n + 1) * size) });
  const contents: MarkdownSnapshot[] = items.filter(item => item.body !== null).map(item =>
    ({ kind: 'markdown', id: item.id, version: uid('c0c0c0c0', item.index + 1), content: item.body!, appendIds: [], imageResources: [] }));
  return { spec, libraryId, rootVersion, folders, items, batches: batches.filter(batch => batch.changes.length), headVersion: batches.filter(batch => batch.changes.length).slice(-1)[0].id,
    contents, rootSiblings, childrenOf, ownedOf, missingContentIds: items.filter(item => item.body === null).map(item => item.id) };
}

/** Plain-loop expectations (independent of the product's matcher). */
export const planMatches = (plan: LargePlan, predicate: (item: PlannedItem) => boolean) => plan.items.filter(predicate);
export const normalized = (text: string) => text.normalize('NFKC').toLowerCase();
export const titleOrder = (items: readonly PlannedItem[], descending = false) =>
  [...items].sort((a, b) => { const x = normalized(a.title), y = normalized(b.title); return (x < y ? -1 : x > y ? 1 : 0) * (descending ? -1 : 1) || (a.id < b.id ? -1 : 1); });

type Row = { key: string; scope: string; value: unknown };
const rowOf = (namespace: string, id: string, value: unknown): Row => ({ key: JSON.stringify([namespace, id]), scope: namespace, value });

/** Writes the plan into the browser profile's canonical database (one IndexedDB transaction). The page must have the Library catalog already created by the UI. */
export async function seedLargeCatalog(page: Page, namespace: string, plan: LargePlan): Promise<{ rows: number; payloadBytes: number }> {
  const root = { kind: 'library', id: plan.libraryId, version: plan.rootVersion, items: [], folders: [], links: [], deletions: [] } as LibrarySnapshot;
  // Validate the plan with the product's own graph before anything is written (a plan the product rejects is a test bug, not a product finding).
  const graph = new EditGraph({ version: 1, libraryId: plan.libraryId, root, batches: plan.batches });
  const view = graph.getView(); assert.deepEqual(view.rejected, {}, 'the planned history is accepted by the product graph'); assert.deepEqual(view.heads, [plan.headVersion]);
  const head = graph.snapshot(plan.headVersion) as LibrarySnapshot;
  assert.equal(head.items.length, plan.items.length); assert.equal(head.folders.length, plan.folders.length);
  const stores = { roots: [] as Row[], projections: [] as Row[], edits: [] as Row[] };
  for (const content of plan.contents) { stores.roots.push(rowOf(namespace, content.id, content)); stores.projections.push(rowOf(namespace, `${content.id}:${content.version}`, content)); }
  stores.projections.push(rowOf(namespace, `${plan.libraryId}:${plan.headVersion}`, head));
  for (const batch of plan.batches) stores.edits.push(rowOf(namespace, batch.id, { batch, receipt: { id: batch.id, targetId: plan.libraryId, durable: true, upload: 'pending', importedBy: [] } } satisfies StoredEdit));
  const payloadBytes = JSON.stringify(stores).length;
  await page.evaluate(async stores => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-shared-edits');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing database required')); };
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['roots', 'projections', 'edits'], 'readwrite');
        for (const name of ['roots', 'projections', 'edits'] as const) for (const row of stores[name]) tx.objectStore(name).add(row);
        tx.onabort = () => reject(tx.error ?? new Error('seed aborted')); tx.oncomplete = () => resolve();
      });
    } finally { db.close(); }
  }, stores);
  return { rows: stores.roots.length + stores.projections.length + stores.edits.length, payloadBytes };
}

// ---- Observation of the real database / DOM ----
export type IdbCounts = Record<string, number>;
/** Row counts per store in the canonical database (read-only). */
export function idbCounts(page: Page): Promise<IdbCounts> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-shared-edits');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing database required')); };
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    try {
      const out: Record<string, number> = {};
      for (const name of ['roots', 'edits', 'projections', 'checkpoints', 'intents']) out[name] = await new Promise<number>((resolve, reject) => {
        const request = db.transaction(name, 'readonly').objectStore(name).count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      return out;
    } finally { db.close(); }
  });
}

/** The catalog after seeding, ignoring that the seeded batches carry no history record (`catalogUntil` in ordinaryCatalog requires one for every batch). */
export async function waitDurable(page: Page, count: number, what: string) {
  const deadline = Date.now() + 300_000; // upper limit against a hang (a commit on a long history can take minutes; see B13-c measurements)
  for (;;) {
    const state = await idbCounts(page);
    if (state.edits === count && !state.intents) return state;
    assert.ok(Date.now() < deadline, `${what} did not settle at ${count} batches (now ${state.edits}, intents ${state.intents})`); await delay(100);
  }
}

export type TreeMetrics = { rendered: number; setSize: number | null; scrollTop: number; scrollHeight: number; clientHeight: number; first: string | null; last: string | null };
/** Rendered treeitems (the DOM window) and the tree's scroll geometry. */
export function treeMetrics(page: Page): Promise<TreeMetrics> {
  return page.evaluate(() => {
    const tree = document.querySelector('[role="tree"][aria-label="資料の階層"]') as HTMLElement | null;
    const rows = tree ? [...tree.querySelectorAll('[role="treeitem"]')] as HTMLElement[] : [];
    const id = (row?: HTMLElement) => row ? row.getAttribute('data-library-item') ?? row.getAttribute('data-folder-id') ?? row.getAttribute('data-library-more') ?? row.getAttribute('aria-label') : null;
    return { rendered: rows.length, setSize: Number(rows[0]?.getAttribute('aria-setsize')) || null, scrollTop: tree?.scrollTop ?? -1, scrollHeight: tree?.scrollHeight ?? -1,
      clientHeight: tree?.clientHeight ?? -1, first: id(rows[0]), last: id(rows[rows.length - 1]) };
  });
}

export type FocusedRow = { id: string | null; folderId: string | null; more: string | null; label: string | null; visible: boolean; tabbable: number };
/** The treeitem that holds keyboard focus, whether it lies inside the tree's visible clip, and how many rows are tab stops. */
export function focusedRow(page: Page): Promise<FocusedRow> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null, tree = document.querySelector('[role="tree"][aria-label="資料の階層"]') as HTMLElement | null;
    const row = active?.getAttribute('role') === 'treeitem' ? active : null;
    let visible = false;
    if (row && tree) {
      const box = row.getBoundingClientRect(), clip = tree.getBoundingClientRect();
      visible = box.height > 0 && box.top >= clip.top - 1 && box.bottom <= clip.bottom + 1;
    }
    return { id: row?.getAttribute('data-library-item') ?? null, folderId: row?.getAttribute('data-folder-id') ?? null, more: row?.getAttribute('data-library-more') ?? null,
      label: row?.getAttribute('aria-label') ?? null, visible, tabbable: tree ? [...tree.querySelectorAll('[role="treeitem"]')].filter(node => (node as HTMLElement).tabIndex === 0).length : 0 };
  });
}

/** Observation-bounded wait for the focused row to satisfy `predicate` (upper limit only, never a fixed pause). */
export async function focusUntil(page: Page, predicate: (row: FocusedRow) => boolean, what: string, limitMs = 30_000): Promise<FocusedRow> {
  const deadline = Date.now() + limitMs;
  let row = await focusedRow(page);
  while (!predicate(row) && Date.now() < deadline) { await delay(20); row = await focusedRow(page); }
  assert.ok(predicate(row), `${what}: ${JSON.stringify(row)}`);
  return row;
}

/** Heap (Chromium only) and storage estimate. Both are measurements, never assertions. */
export function memoryProbe(page: Page): Promise<{ usedJsHeapMb: number | null; storageUsageMb: number | null; storageQuotaMb: number | null }> {
  return page.evaluate(async () => {
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    let usage: number | null = null, quota: number | null = null;
    try { const estimate = await navigator.storage.estimate(); usage = estimate.usage ?? null; quota = estimate.quota ?? null; } catch { /* unsupported */ }
    const mb = (value: number | null | undefined) => value == null ? null : Math.round(value / 1048576 * 10) / 10;
    return { usedJsHeapMb: mb(heap), storageUsageMb: mb(usage), storageQuotaMb: mb(quota) };
  });
}

export const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { n: values.length, min: Math.round(sorted[0]), median: Math.round(sorted[Math.floor(sorted.length / 2)]), max: Math.round(sorted[sorted.length - 1]), mean: Math.round(mean), values: values.map(Math.round) };
};

/** Seeded snapshot of the real catalog from IndexedDB for post-seed / post-action comparison. */
export type CatalogCounts = { items: number; folders: number; edits: number; heads: number };
export async function catalogCounts(page: Page, namespace: string, libraryId: string): Promise<{ counts: CatalogCounts; snapshot: LibrarySnapshot; edits: StoredEdit[] }> {
  const data = await page.evaluate(async ({ namespace, libraryId }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-shared-edits');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing database required')); };
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise<{ root: Snapshot; edits: StoredEdit[] }>((resolve, reject) => {
        const tx = db.transaction(['roots', 'edits'], 'readonly'), roots = tx.objectStore('roots').getAll(), edits = tx.objectStore('edits').getAll();
        tx.onabort = () => reject(tx.error ?? new Error('catalog read aborted'));
        tx.oncomplete = () => {
          const root = (roots.result as Row[]).find(row => row.scope === namespace && (row.value as Snapshot).id === libraryId);
          if (!root) { reject(new Error('catalog root missing')); return; }
          resolve({ root: root.value as Snapshot, edits: (edits.result as Row[]).filter(row => row.scope === namespace && (row.value as StoredEdit).batch.targetId === libraryId).map(row => row.value as StoredEdit) });
        };
      });
    } finally { db.close(); }
  }, { namespace, libraryId });
  const graph = new EditGraph({ version: 1, libraryId, root: data.root, batches: data.edits.map(edit => edit.batch) });
  const view = graph.getView(); assert.equal(view.heads.length, 1, 'one catalog head'); assert.deepEqual(view.rejected, {});
  const snapshot = graph.snapshot(view.heads[0]) as LibrarySnapshot;
  return { counts: { items: snapshot.items.length, folders: snapshot.folders.length, edits: data.edits.length, heads: view.heads.length }, snapshot, edits: data.edits };
}

// ---- Shared setup ----
import { catalogOf, locateCatalog, type CatalogHandle } from './ordinaryCatalog.ts';

export const TREE = '[role="tree"][aria-label="資料の階層"]';
export const rowSelector = (id: string) => `${TREE} [data-library-item="${id}"], ${TREE} [data-folder-id="${id}"]`;
export const rowIdOf = (row: FocusedRow) => row.id ?? row.folderId ?? (row.more ? `more:${row.more}` : null);

export type LargeApp = { page: Page; restartLibrary(options?: { showCatalog?: boolean; timings?: { libraryClickedAt?: number }; timeoutMs?: number }): Promise<Page> };
export type OpenedLarge = { handle: CatalogHandle; plan: LargePlan; seed: { rows: number; payloadBytes: number; seedMs: number }; page: Page; timings: { libraryClickedAt?: number; firstRowMs?: number } };

/** UI-created empty Library (ordinaryWeb) -> seeded with the plan -> cold restart -> wait until the product renders the first planned root row. */
export async function seedAndReopen(app: LargeApp, spec: LargeSpec = DEFAULT_SPEC, restartTimeoutMs?: number): Promise<OpenedLarge> {
  const handle = await locateCatalog(app.page), base = await catalogOf(app.page, handle);
  assert.equal(base.edits.length, 0, 'the UI-created Library is still empty before seeding');
  const plan = planLargeCatalog(handle.libraryId, base.root.version, spec);
  const started = Date.now(), seed = await seedLargeCatalog(app.page, handle.namespace, plan);
  await waitDurable(app.page, plan.batches.length, 'seeded catalog');
  const timings: OpenedLarge['timings'] = {};
  const page = await app.restartLibrary({ showCatalog: true, timings, timeoutMs: restartTimeoutMs });
  await waitFirstRow(page, plan, timings);
  return { handle, plan, seed: { ...seed, seedMs: Date.now() - started }, page, timings };
}

/** Wait (observation-bounded) until the tree's first rendered row is the plan's first root sibling and the root sibling count is the plan's. */
export async function waitFirstRow(page: Page, plan: LargePlan, timings?: { libraryClickedAt?: number; firstRowMs?: number }, limitMs = 300_000) {
  const first = plan.rootSiblings[0], size = plan.rootSiblings.length;
  await page.waitForFunction(({ id, size, tree }) => {
    const row = document.querySelector(`${tree} [role="treeitem"]`);
    return !!row && (row.getAttribute('data-folder-id') === id || row.getAttribute('data-library-item') === id) && Number(row.getAttribute('aria-setsize')) === size;
  }, { id: first.id, size, tree: TREE }, { timeout: limitMs });
  if (timings?.libraryClickedAt !== undefined) timings.firstRowMs = Date.now() - timings.libraryClickedAt;
}

// Read-only observation of a UI-created Library catalog (IndexedDB) and of the rendered tree (DOM). Never writes, seeds or injects a session.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { EditGraph } from '../../src/runtime/edits/editGraph.ts';
import type { LibrarySnapshot, Snapshot } from '../../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../../src/runtime/edits/repository.ts';

type Row<T> = { key: string; scope: string; value: T };
export type CatalogHandle = { namespace: string; libraryId: string };
export type CatalogObservation = { root: Snapshot; edits: StoredEdit[]; intents: number; snapshot: LibrarySnapshot };

/** The one UI-created Library of this browser profile: its catalog root (kind "library") names the scope. */
export async function locateCatalog(page: Page): Promise<CatalogHandle> {
  const found = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-shared-edits');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing database required')); };
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise<{ scope: string; id: string }[]>((resolve, reject) => {
        const tx = db.transaction(['roots'], 'readonly'), roots = tx.objectStore('roots').getAll();
        tx.onabort = () => reject(tx.error ?? new Error('catalog location aborted'));
        tx.oncomplete = () => resolve((roots.result as Row<{ kind: string; id: string }>[]).filter(row => row.value.kind === 'library').map(row => ({ scope: row.scope, id: row.value.id })));
      });
    } finally { db.close(); }
  });
  assert.equal(found.length, 1, 'exactly one UI-created Library catalog');
  return { namespace: found[0].scope, libraryId: found[0].id };
}

export async function catalogOf(page: Page, handle: CatalogHandle): Promise<CatalogObservation> {
  const { namespace, libraryId } = handle;
  const data = await page.evaluate(async ({ namespace, libraryId }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-shared-edits');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing database required')); };
      request.onblocked = () => reject(new Error('catalog observation blocked'));
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    try { return await new Promise<{ root: Snapshot; edits: StoredEdit[]; intents: number }>((resolve, reject) => {
      const tx = db.transaction(['roots', 'edits', 'intents'], 'readonly');
      const roots = tx.objectStore('roots').getAll(), edits = tx.objectStore('edits').getAll(), intents = tx.objectStore('intents').getAll();
      tx.onabort = () => reject(tx.error ?? new Error('catalog read aborted'));
      tx.oncomplete = () => {
        const root = (roots.result as Row<Snapshot>[]).find(row => row.scope === namespace && row.value.id === libraryId);
        if (!root) { reject(new Error('catalog root missing')); return; }
        resolve({ root: root.value,
          edits: (edits.result as Row<StoredEdit>[]).filter(row => row.scope === namespace && row.value.batch.targetId === libraryId).map(row => row.value),
          intents: (intents.result as Row<unknown>[]).filter(row => row.scope === namespace && JSON.parse(row.key)[1] === libraryId).length });
      };
    }); } finally { db.close(); }
  }, { namespace, libraryId });
  const graph = new EditGraph({ version: 1, libraryId, root: data.root, batches: data.edits.map(value => value.batch) });
  const heads = graph.getView().heads; assert.equal(heads.length, 1, 'the ordinary catalog has one head');
  const snapshot = graph.snapshot(heads[0]); assert.equal(snapshot?.kind, 'library');
  return { ...data, snapshot: snapshot as LibrarySnapshot };
}

/** Wait (bounded by the observation, not by a fixed pause) until every edit is durable with history, no intent is pending and the predicate holds. */
export async function catalogUntil(page: Page, handle: CatalogHandle, predicate: (value: LibrarySnapshot) => boolean, what = 'catalog transaction') {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await catalogOf(page, handle);
    if (!value.intents && value.edits.every(edit => edit.receipt.durable && edit.history) && predicate(value.snapshot)) return value;
    assert.ok(Date.now() < deadline, `${what} did not settle`); await delay(50);
  }
}

/** Wait until the catalog holds exactly `count` durable batches with history and nothing is pending. */
export async function editsUntil(page: Page, handle: CatalogHandle, count: number, what = 'catalog batch count') {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await catalogOf(page, handle);
    if (!value.intents && value.edits.length === count && value.edits.every(edit => edit.receipt.durable && edit.history)) return value;
    assert.ok(value.edits.length <= count, `${what}: more batches than expected (${value.edits.length} > ${count})`);
    assert.ok(Date.now() < deadline, `${what} did not settle at ${count} (now ${value.edits.length}, intents ${value.intents})`); await delay(50);
  }
}

/** Siblings of one parent in persisted order: folders and non-owned items share `position`. Independent of the rendered tree. */
export function persistedChildren(snapshot: LibrarySnapshot, parentId: string | null) {
  const deleted = new Set(snapshot.deletions.filter(value => value.active).flatMap(value => value.itemIds));
  return [
    ...snapshot.folders.filter(folder => folder.parentId === parentId).map(folder => ({ kind: 'folder' as const, id: folder.id, title: folder.title, position: folder.position })),
    ...snapshot.items.filter(item => item.ownerId === null && item.folderId === parentId && !deleted.has(item.id)).map(item => ({ kind: item.kind, id: item.id, title: item.title, position: item.position })),
  ].sort((a, b) => a.position - b.position || (a.kind === 'folder' ? -1 : 0) - (b.kind === 'folder' ? -1 : 0) || (a.id < b.id ? -1 : 1));
}

export type RenderedRow = { role: string; id: string | null; folderId: string | null; label: string; level: number; expanded: string | null; tabIndex: number };

/** Every rendered tree row in DOM order (identity comes from the data attributes the product renders). */
export function renderedRows(page: Page): Promise<RenderedRow[]> {
  return page.locator('[role="tree"][aria-label="資料の階層"] [role="treeitem"]').evaluateAll(nodes => nodes.map(node => ({
    role: node.getAttribute('role')!, id: node.getAttribute('data-library-item'), folderId: node.getAttribute('data-folder-id'),
    label: node.getAttribute('aria-label') ?? '', level: Number(node.getAttribute('aria-level')), expanded: node.getAttribute('aria-expanded'),
    tabIndex: (node as HTMLElement).tabIndex })));
}

/** Direct children (ids, in DOM order) of the folder or item row with this id, read from the rendered tree. */
export async function renderedChildIds(page: Page, folderId: string | null): Promise<string[]> {
  const rows = await renderedRows(page), out: string[] = [];
  let level = 1;
  if (folderId !== null) {
    const index = rows.findIndex(row => row.folderId === folderId || row.id === folderId); assert.ok(index >= 0, `row ${folderId} is rendered`);
    level = rows[index].level + 1; rows.splice(0, index + 1);
  }
  for (const row of rows) {
    if (row.level < level) break;
    if (row.level === level) out.push(row.id ?? row.folderId ?? row.label);
  }
  return out;
}

/** Poll the rendered tree (observation-bounded, 30 s) until the direct children of a folder equal `expected`, then assert it. */
export async function expectRenderedChildren(page: Page, folderId: string | null, expected: string[], what: string) {
  const deadline = Date.now() + 30_000;
  let actual = await renderedChildIds(page, folderId);
  while (JSON.stringify(actual) !== JSON.stringify(expected) && Date.now() < deadline) { await delay(50); actual = await renderedChildIds(page, folderId); }
  assert.deepEqual(actual, expected, what);
}

export type FocusObservation = { tag: string; treeItemId: string | null; treeItemFolderId: string | null; treeItemLabel: string | null; isTreeItem: boolean; inTree: boolean; label: string | null };

/** What really holds keyboard focus right now (document.activeElement), and which tree row (if any) it belongs to. */
export function activeElementState(page: Page): Promise<FocusObservation> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const row = active?.closest('[role="treeitem"]') ?? null;
    return { tag: active?.tagName ?? 'none', treeItemId: row?.getAttribute('data-library-item') ?? null, treeItemFolderId: row?.getAttribute('data-folder-id') ?? null,
      treeItemLabel: row?.getAttribute('aria-label') ?? null, isTreeItem: active?.getAttribute('role') === 'treeitem', inTree: !!active?.closest('[role="tree"]'),
      label: active?.getAttribute('aria-label') ?? active?.textContent?.slice(0, 40) ?? null };
  });
}

// ---- Ordinary UI steps (real clicks and typing only) ----
/** The product collapses the catalog once a created or imported document has been opened; wait for that before reopening it. */
export async function waitCatalogClosed(page: Page) {
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '資料一覧' && button.getAttribute('aria-expanded') === 'false'));
}

export async function showCatalog(page: Page) {
  const toggle = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

/** Creates a folder under the currently selected folder (the product selects the new folder afterwards). Returns its id. */
export async function createFolderUi(page: Page, name: string): Promise<string> {
  await showCatalog(page);
  await page.getByRole('button', { name: 'フォルダーを作成', exact: true }).click();
  const form = page.getByRole('form', { name: 'フォルダーの操作', exact: true });
  await form.getByLabel('フォルダー名', { exact: true }).fill(name);
  await form.getByRole('button', { name: 'フォルダーを保存', exact: true }).click(); await form.waitFor({ state: 'hidden' });
  const folder = page.getByRole('treeitem', { name: `フォルダー「${name}」`, exact: true });
  const id = await folder.getAttribute('data-folder-id'); assert.ok(id);
  return id;
}

export async function selectRoot(page: Page) {
  await showCatalog(page);
  await page.getByRole('button', { name: '未分類を選択', exact: true }).click();
  await page.getByText('選択中: 未分類', { exact: true }).waitFor();
}

/** Creates a Markdown or hand-written note in the current creation target; the product then opens it and closes the catalog. */
export async function createItemUi(page: Page, title: string, kind: 'markdown' | 'notebook'): Promise<string> {
  await showCatalog(page);
  const surface = page.locator('[data-content-document]');
  const previous = await surface.count() ? await surface.getAttribute('data-content-document') : null;
  await page.getByLabel('新しい資料の名前', { exact: true }).fill(title);
  await page.getByLabel('資料の種類', { exact: true }).selectOption(kind);
  await page.getByRole('button', { name: '資料を作成', exact: true }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  await page.waitForFunction(old => { const id = document.querySelector('[data-content-document]')?.getAttribute('data-content-document'); return !!id && id !== old; }, previous);
  const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
  await waitCatalogClosed(page);
  return id;
}

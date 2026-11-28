// Actual ordinary UI creation only. Catalog inspection is read-only; no fixture bindings or seeds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { ordinaryMarkdownSaved } from '../../support/ordinaryMarkdown.ts';
import { EditGraph } from '../../../src/runtime/edits/editGraph.ts';
import type { LibrarySnapshot, Snapshot } from '../../../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../../../src/runtime/edits/repository.ts';

async function catalog(page: Page, namespace: string, libraryId: string) {
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
        const root = roots.result.find((row: { scope: string; value: Snapshot }) => row.scope === namespace && row.value.id === libraryId);
        if (!root) { reject(new Error('catalog root missing')); return; }
        resolve({ root: root.value, edits: edits.result.filter((row: { scope: string; value: StoredEdit }) => row.scope === namespace && row.value.batch.targetId === libraryId).map((row: { value: StoredEdit }) => row.value),
          intents: intents.result.filter((row: { scope: string; key: string }) => row.scope === namespace && JSON.parse(row.key)[1] === libraryId).length });
      };
    }); } finally { db.close(); }
  }, { namespace, libraryId });
  const graph = new EditGraph({ version: 1, libraryId, root: data.root, batches: data.edits.map(value => value.batch) });
  const heads = graph.getView().heads; assert.equal(heads.length, 1);
  const snapshot = graph.snapshot(heads[0]); assert.equal(snapshot?.kind, 'library');
  return { ...data, snapshot: snapshot as LibrarySnapshot };
}
async function catalogUntil(page: Page, namespace: string, libraryId: string, predicate: (value: LibrarySnapshot) => boolean) {
  const deadline = Date.now() + 30_000;
  for (;;) { const value = await catalog(page, namespace, libraryId);
    if (!value.intents && value.edits.every(edit => edit.receipt.durable && edit.history) && predicate(value.snapshot)) return value;
    assert.ok(Date.now() < deadline, 'catalog transaction did not settle'); await delay(50);
  }
}
function orderedEdits(value: Awaited<ReturnType<typeof catalog>>) {
  const rest = [...value.edits], ordered: StoredEdit[] = []; let version = value.root.version;
  while (rest.length) {
    const index = rest.findIndex(edit => edit.batch.parents.length === 1 && edit.batch.parents[0] === version);
    assert.ok(index >= 0, 'ordinary catalog history must form a complete linear chain');
    const edit = rest.splice(index, 1)[0]; ordered.push(edit); version = edit.batch.id;
  }
  return ordered;
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary owned children More reveal and journaled mixed hierarchy reorder (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page, ownerTitle = `Tree owner ${engine}`;
  let observedPage = page;
  const showCatalog = async (p = page) => {
    const toggle = p.getByRole('button', { name: '資料一覧', exact: true });
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  };
  const createNote = async (title: string) => {
    const surface = page.locator('[data-content-document]');
    const previous = await surface.count() ? await surface.getAttribute('data-content-document') : null;
    await page.getByLabel('新しい資料の名前', { exact: true }).fill(title);
    await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
    await page.getByRole('button', { name: '資料を作成', exact: true }).click();
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
    await page.waitForFunction(old => { const id = document.querySelector('[data-content-document]')?.getAttribute('data-content-document'); return !!id && id !== old; }, previous);
    await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
    const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
    return id;
  };
  let phase = 'ordinary-owner-and-seven-owned-children';
  try {
    const ownerId = await createNote(ownerTitle);
    const editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true });
    await editor.fill('Stable owner body');
    const ownerBody = await ordinaryMarkdownSaved(page, ownerId, 'Stable owner body', 1);
    const namespace = ownerBody.namespace, libraryId = JSON.parse(namespace)[1] as string;
    const childIds: string[] = [];
    for (let index = 0; index < 7; index++) {
      await showCatalog();
      await page.getByLabel(`「${ownerTitle}」に付属ノートを作成`, { exact: true }).click();
      const childId = await createNote(`Owned ${index}`); assert.ok(!childIds.includes(childId) && childId !== ownerId);
      childIds.push(childId); await ordinaryMarkdownSaved(page, childId, '', 0);
    }
    await showCatalog();
    await page.getByRole('button', { name: ownerTitle, exact: true }).click();
    await page.waitForFunction(expected => document.querySelector('[data-content-document]')?.getAttribute('data-content-document') === expected, ownerId);
    await page.getByRole('heading', { name: ownerTitle, exact: true }).waitFor();
    await showCatalog();
    let owner = page.locator(`[data-library-item="${ownerId}"]`);
    if (await owner.getAttribute('aria-expanded') === 'true') await owner.getByLabel(`「${ownerTitle}」を閉じる`, { exact: true }).click();
    await owner.getByLabel(`「${ownerTitle}」を開く`, { exact: true }).click();
    const beforeMore = await catalogUntil(page, namespace, libraryId, value => value.items.filter(item => item.ownerId === ownerId).length === 7);
    const more = page.locator(`[data-library-more="item:${ownerId}"]`);
    await more.waitFor(); assert.equal(await page.locator(`[data-library-item="${childIds[6]}"]`).count(), 0);
    phase = 'more-keyboard-is-disclosure-not-open';
    await more.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(expected => document.activeElement?.getAttribute('data-library-item') === expected, childIds[6]);
    assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), ownerId);
    assert.equal(await more.count(), 0);
    assert.deepEqual(await catalog(page, namespace, libraryId), beforeMore, 'More changes no persisted catalog, receipt or history');
    phase = 'selected-hidden-child-reveal';
    await page.keyboard.press('Enter');
    await page.waitForFunction(expected => document.querySelector('[data-content-document]')?.getAttribute('data-content-document') === expected, childIds[6]);
    await page.getByRole('heading', { name: 'Owned 6', exact: true }).waitFor();
    await showCatalog(); owner = page.locator(`[data-library-item="${ownerId}"]`);
    await owner.getByLabel(`「${ownerTitle}」を閉じる`, { exact: true }).click();
    await owner.getByLabel(`「${ownerTitle}」を開く`, { exact: true }).click();
    await more.waitFor();
    await page.getByRole('button', { name: '表示中の資料を一覧で表示', exact: true }).click();
    await page.waitForFunction(expected => document.activeElement?.getAttribute('data-library-item') === expected, childIds[6]);
    assert.equal(await more.count(), 0);
    assert.deepEqual(await catalog(page, namespace, libraryId), beforeMore);
    phase = 'create-two-normal-folders';
    const folderIds: string[] = [];
    for (const name of ['Tree A', 'Tree B']) {
      await page.getByRole('button', { name: '未分類を選択', exact: true }).click();
      await page.getByText('選択中: 未分類', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'フォルダーを作成', exact: true }).click();
      const form = page.getByRole('form', { name: 'フォルダーの操作', exact: true });
      await form.getByLabel('フォルダー名', { exact: true }).fill(name);
      await form.getByRole('button', { name: 'フォルダーを保存', exact: true }).click(); await form.waitFor({ state: 'hidden' });
      const folder = page.getByRole('treeitem', { name: `フォルダー「${name}」`, exact: true });
      const id = await folder.getAttribute('data-folder-id'); assert.ok(id); folderIds.push(id);
      await catalogUntil(page, namespace, libraryId, value => value.folders.some(folder => folder.id === id && folder.parentId === null));
    }
    const baseline = await catalogUntil(page, namespace, libraryId, value => value.folders.length === 2);
    const placement = (snapshot: LibrarySnapshot) => ({
      items: snapshot.items.map(item => ({ id: item.id, ownerId: item.ownerId, folderId: item.folderId, position: item.position })),
      folders: snapshot.folders.map(folder => ({ id: folder.id, parentId: folder.parentId, position: folder.position })),
    });
    phase = 'keyboard-reorder-mixed-root-siblings';
    await page.getByLabel('「Tree B」を移動・並べ替え', { exact: true }).focus(); await page.keyboard.press('Enter');
    await page.getByLabel(`「${ownerTitle}」の前へ移動`, { exact: true }).focus(); await page.keyboard.press('Enter');
    const ordered = await catalogUntil(page, namespace, libraryId, value => value.folders.find(folder => folder.id === folderIds[1])!.position < value.items.find(item => item.id === ownerId)!.position);
    assert.equal(ordered.edits.length, baseline.edits.length + 1);
    phase = 'keyboard-hierarchy-move-retains-owned-children';
    await page.getByLabel(`「${ownerTitle}」を移動・並べ替え`, { exact: true }).focus(); await page.keyboard.press('Enter');
    await page.getByLabel('「Tree A」の中へ移動', { exact: true }).focus(); await page.keyboard.press('Enter');
    const moved = await catalogUntil(page, namespace, libraryId, value => value.items.find(item => item.id === ownerId)?.folderId === folderIds[0]);
    assert.equal(moved.edits.length, baseline.edits.length + 2);
    assert.deepEqual(moved.snapshot.items.filter(item => item.ownerId === ownerId), baseline.snapshot.items.filter(item => item.ownerId === ownerId));
    assert.deepEqual(moved.snapshot.items.map(item => item.id), baseline.snapshot.items.map(item => item.id));
    phase = 'undo-redo-same-operation-identity';
    for (let step = 0; step < 2; step++) {
      const previous = (await catalog(page, namespace, libraryId)).snapshot.version;
      await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
      await catalogUntil(page, namespace, libraryId, value => value.version !== previous);
      const state = await catalog(page, namespace, libraryId); assert.equal(state.edits.length, moved.edits.length + step + 1);
    }
    const undone = await catalog(page, namespace, libraryId); assert.deepEqual(placement(undone.snapshot), placement(baseline.snapshot));
    for (let step = 0; step < 2; step++) {
      const previous = (await catalog(page, namespace, libraryId)).snapshot.version;
      await page.getByRole('button', { name: '資料の変更をやり直す', exact: true }).click();
      const state = await catalogUntil(page, namespace, libraryId, value => value.version !== previous);
      assert.equal(state.edits.length, undone.edits.length + step + 1);
    }
    const final = await catalog(page, namespace, libraryId); assert.deepEqual(placement(final.snapshot), placement(moved.snapshot));
    const operations = orderedEdits(moved).slice(-2).map(edit => edit.batch.id);
    assert.deepEqual(orderedEdits(final).slice(-4).map(edit => edit.history?.action?.operationId), [operations[1], operations[0], operations[0], operations[1]]);
    phase = 'complete-browser-restart';
    const reopened = await app.restartLibrary();
    observedPage = reopened;
    await reopened.getByRole('heading', { name: 'Owned 6', exact: true }).waitFor();
    assert.equal(await reopened.locator('[data-content-document]').getAttribute('data-content-document'), childIds[6]);
    const destinationFolder = reopened.locator(`[data-folder-id="${folderIds[0]}"]`);
    if (await destinationFolder.getAttribute('aria-expanded') !== 'true') await destinationFolder.getByLabel('「Tree A」を開く', { exact: true }).click();
    assert.equal(await destinationFolder.getAttribute('aria-expanded'), 'true');
    await reopened.getByRole('button', { name: ownerTitle, exact: true }).click();
    await reopened.getByRole('heading', { name: ownerTitle, exact: true }).waitFor();
    assert.equal(await reopened.locator('[data-content-document]').getAttribute('data-content-document'), ownerId);
    assert.deepEqual(await catalog(reopened, namespace, libraryId), final);
    assert.deepEqual(await ordinaryMarkdownSaved(reopened, ownerId, 'Stable owner body', 1), ownerBody);
    for (const childId of childIds) await ordinaryMarkdownSaved(reopened, childId, '', 0);
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, body: observedPage.isClosed() ? '<previous page closed>' : await observedPage.locator('body').innerText().catch(() => '<body unavailable>'), originalError: String(error) })); throw error;
  }
});


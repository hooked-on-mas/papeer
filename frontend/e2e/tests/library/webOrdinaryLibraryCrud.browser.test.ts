import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { ordinaryMarkdownSaved } from '../../support/ordinaryMarkdown.ts';
import { resource } from '../reader/p2/ordinaryStorage.ts';
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

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary library hierarchy and metadata (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page, title = `P4 owner ${engine}`;
  let phase = 'create-owner';
  let diagnosticCatalog: { namespace: string; libraryId: string; ownerId: string } | undefined;
  try {
  await page.getByRole('button', { name: '新規', exact: true }).click();
  let createDialog = page.getByRole('dialog', { name: '新しい資料を作成', exact: true });
  await createDialog.getByLabel('新しい資料の名前', { exact: true }).fill(title);
  await createDialog.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
  await createDialog.getByRole('button', { name: '資料を作成', exact: true }).click();
  await createDialog.waitFor({ state: 'hidden' });
  const editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true }); await editor.waitFor();
  const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
  await editor.fill('Owner body'); const ownerBody = await ordinaryMarkdownSaved(page, id, 'Owner body', 1);
  const namespace = ownerBody.namespace, libraryId = JSON.parse(namespace)[1] as string;
  diagnosticCatalog = { namespace, libraryId, ownerId: id };
  phase = 'folder-cycle';
  await page.getByRole('button', { name: 'フォルダーを作成', exact: true }).click();
  let form = page.getByRole('form', { name: 'フォルダーの操作', exact: true });
  await form.getByLabel('フォルダー名', { exact: true }).fill('P4 folder');
  await form.getByRole('button', { name: 'フォルダーを保存', exact: true }).click(); await form.waitFor({ state: 'hidden' });
  const folder = page.getByRole('treeitem', { name: 'フォルダー「P4 folder」', exact: true }); await folder.waitFor();
  const folderId = await folder.getAttribute('data-folder-id'); assert.ok(folderId);
  await folder.getByRole('button', { name: '「P4 folder」を選択', exact: true }).click();
  await page.waitForFunction(expected => document.querySelector(`[data-folder-id="${expected}"]`)?.getAttribute('aria-selected') === 'true', folderId);
  await page.getByRole('button', { name: 'フォルダーを作成', exact: true }).click();
  form = page.getByRole('form', { name: 'フォルダーの操作', exact: true });
  await form.getByLabel('フォルダー名', { exact: true }).fill('P4 child folder');
  await form.getByRole('button', { name: 'フォルダーを保存', exact: true }).click(); await form.waitFor({ state: 'hidden' });
  const afterChild = await catalogUntil(page, namespace, libraryId, value => value.folders.some(entry => entry.title === 'P4 child folder'));
  const childFolder = afterChild.snapshot.folders.find(entry => entry.title === 'P4 child folder')!;
  assert.equal(childFolder.parentId, folderId, 'the actual committed child folder belongs to the intended parent');
  await page.waitForFunction(expected => document.querySelector(`[data-folder-id="${expected}"]`)?.getAttribute('aria-selected') === 'true', childFolder.id);
  await folder.getByRole('button', { name: '「P4 folder」を選択', exact: true }).click();
  await page.waitForFunction(expected => document.querySelector(`[data-folder-id="${expected}"]`)?.getAttribute('aria-selected') === 'true', folderId);
  await folder.getByLabel('フォルダー「P4 folder」の操作', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'フォルダーを移動', exact: true }).click();
  form = page.getByRole('form', { name: 'フォルダーの操作', exact: true });
  const destination = form.getByLabel('移動先のフォルダー', { exact: true });
  const descendant = destination.locator('option').filter({ hasText: 'P4 child folder' });
  const cycleOption = await descendant.evaluate(option => ({ disabled: (option as HTMLOptionElement).disabled,
    attribute: option.getAttribute('disabled'), value: (option as HTMLOptionElement).value, html: option.outerHTML }));
  t.diagnostic(JSON.stringify({ phase, folderId, childFolderId: childFolder.id, selected: await destination.inputValue(), cycleOption,
    playwrightDisabled: await descendant.isDisabled() }));
  assert.equal(cycleOption.disabled, true, 'a folder cannot move below its own descendant');
  await form.getByRole('button', { name: 'フォルダー操作を取り消す', exact: true }).click();
  phase = 'move-rename-tags';
  await page.getByLabel(`「${title}」を選択`, { exact: true }).check();
  await page.getByRole('button', { name: '選択した資料を移動', exact: true }).click();
  form = page.getByRole('form', { name: 'フォルダーの操作', exact: true });
  await form.getByLabel('移動先のフォルダー', { exact: true }).selectOption(folderId);
  await form.getByRole('button', { name: '移動する', exact: true }).click(); await form.waitFor({ state: 'hidden' });
  await page.getByLabel(`「${title}」の操作`, { exact: true }).click();
  await page.getByRole('menuitem', { name: '改名', exact: true }).click();
  await page.getByLabel('資料の新しい名前', { exact: true }).fill(`${title} renamed`);
  await page.getByRole('button', { name: '名前を保存', exact: true }).click();
  await page.getByLabel(`「${title} renamed」の操作`, { exact: true }).click();
  await page.getByRole('menuitem', { name: 'タグを編集', exact: true }).click();
  await page.getByLabel('タグ（1行に1つ）', { exact: true }).fill('research\nreview');
  await page.getByRole('button', { name: 'タグを適用', exact: true }).click();
  await page.getByLabel(`「${title} renamed」を選択`, { exact: true }).check();
  await page.getByRole('button', { name: '既読にする', exact: true }).click();
  phase = 'owned-child';
  await page.getByLabel(`「${title} renamed」の操作`, { exact: true }).click();
  await page.getByRole('menuitem', { name: '付属ノートを作成', exact: true }).click();
  createDialog = page.getByRole('dialog', { name: '新しい資料を作成', exact: true });
  await createDialog.getByLabel('新しい資料の名前', { exact: true }).fill('P4 owned child');
  await createDialog.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
  await createDialog.getByRole('button', { name: '資料を作成', exact: true }).click();
  await createDialog.waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'P4 owned child', exact: true }).waitFor();
  await page.waitForFunction(original => { const current = document.querySelector('[data-content-document]')?.getAttribute('data-content-document'); return !!current && current !== original; }, id);
  const child = page.getByRole('textbox', { name: 'Markdownノート', exact: true }); await child.waitFor();
  const childId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(childId && childId !== id);
  await child.fill('Owned child body'); await ordinaryMarkdownSaved(page, childId, 'Owned child body', 1);
  const beforeAttachment = await catalogUntil(page, namespace, libraryId, value => {
    const owner = value.items.find(item => item.id === id), owned = value.items.find(item => item.id === childId);
    return !!owner && owner.title === `${title} renamed` && owner.folderId === folderId && owner.read
      && owner.tags.includes('research') && owner.tags.includes('review') && owned?.ownerId === id;
  });
  phase = 'attachment-failure-retry';
  const expectedHash = createHash('sha256').update('P4 resource bytes').digest('hex');
  await page.evaluate(({ namespace, expectedHash }) => {
    const probe: { enabled: boolean; attempts: { id: string; sha256: string }[] } = { enabled: true, attempts: [] };
    (globalThis as unknown as { attachmentFault: typeof probe }).attachmentFault = probe;
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
      const row = value as { scope?: string; value?: { id: string; sha256: string; mediaType: string } };
      if (this.name === 'resources' && row.scope === namespace && row.value?.mediaType === 'text/plain' && row.value.sha256 === expectedHash) {
        probe.attempts.push({ id: row.value.id, sha256: row.value.sha256 });
        if (probe.enabled) { this.transaction.abort(); throw new DOMException('P4 resource abort', 'AbortError'); }
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  }, { namespace, expectedHash });
  await page.getByLabel(`「${title} renamed」の操作`, { exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'ファイルを添付', exact: true }).click();
  await (await chooser).setFiles({ name: 'evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('P4 resource bytes') });
  await page.getByRole('button', { name: '添付を再試行', exact: true }).waitFor();
  const failedAttempts = await page.evaluate(() => (globalThis as unknown as { attachmentFault: { attempts: { id: string; sha256: string }[] } }).attachmentFault.attempts);
  assert.ok(failedAttempts.length > 0);
  const failed = await catalog(page, namespace, libraryId);
  assert.deepEqual(failed.snapshot, beforeAttachment.snapshot, 'aborted resource storage publishes no catalog item');
  assert.deepEqual(failed.edits, beforeAttachment.edits, 'aborted resource storage publishes no receipt or history');
  await page.evaluate(() => { (globalThis as unknown as { attachmentFault: { enabled: boolean } }).attachmentFault.enabled = false; });
  await page.getByRole('button', { name: '添付を再試行', exact: true }).click();
  await page.getByRole('button', { name: '添付を再試行', exact: true }).waitFor({ state: 'hidden' });
  const attached = await catalogUntil(page, namespace, libraryId, value => value.items.some(item => item.title === 'evidence.txt' && item.ownerId === id));
  const attachment = attached.snapshot.items.find(item => item.title === 'evidence.txt' && item.ownerId === id)!;
  await page.waitForFunction(expected => document.querySelector('[data-content-document]')?.getAttribute('data-content-document') === expected, attachment.id);
  const toggle = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.getByRole('button', { name: 'evidence.txt', exact: true }).waitFor();
  const allAttempts = await page.evaluate(() => (globalThis as unknown as { attachmentFault: { attempts: { id: string; sha256: string }[] } }).attachmentFault.attempts);
  assert.ok(allAttempts.length >= 2); for (const attempt of allAttempts) assert.deepEqual(attempt, failedAttempts[0]);
  assert.equal(attachment.kind, 'attachment'); assert.ok(attachment.resourceId);
  assert.equal(attachment.resourceId, failedAttempts[0].id);
  const stored = await resource(page, namespace, attachment.resourceId);
  assert.equal(stored.metadata.byteLength, Buffer.byteLength('P4 resource bytes'));
  assert.equal(stored.actualSha256, expectedHash);
  assert.equal(stored.actualSha256, stored.metadata.sha256);
  const publications = attached.edits.filter(edit => edit.publication && edit.batch.kind === 'library'
    && edit.batch.changes.some(change => change.type === 'put-item' && change.item.id === attachment.id));
  assert.equal(publications.length, 1); assert.equal(publications[0].receipt.durable, true);
  await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
  await catalogUntil(page, namespace, libraryId, value => value.deletions.some(deletion => deletion.active && deletion.itemIds.includes(attachment.id)));
  await page.getByRole('button', { name: '資料の変更をやり直す', exact: true }).click();
  const finalCatalog = await catalogUntil(page, namespace, libraryId, value => value.items.some(item => item.id === attachment.id)
    && !value.deletions.some(deletion => deletion.active && deletion.itemIds.includes(attachment.id)));
  phase = 'restart';
  const reopened = await app.restartLibrary();
  // Wait for the specific document restored by this restart before reopening its owner.
  await reopened.waitForFunction(expected => document.querySelector('[data-content-document]')?.getAttribute('data-content-document') === expected, attachment.id);
  await reopened.getByRole('heading', { name: 'evidence.txt', exact: true }).waitFor();
  const restoredFolder = reopened.getByRole('treeitem', { name: 'フォルダー「P4 folder」', exact: true }); await restoredFolder.waitFor();
  // ArrowRight opens a collapsed row or focuses its child when already open; it never closes it.
  await restoredFolder.press('ArrowRight');
  await reopened.waitForFunction(expected => Array.from(document.querySelectorAll('[data-folder-id]')).some(node =>
    node.getAttribute('data-folder-id') === expected && node.getAttribute('aria-expanded') === 'true'), folderId);
  await reopened.getByRole('button', { name: `${title} renamed`, exact: true }).click();
  await reopened.getByRole('heading', { name: `${title} renamed`, exact: true }).waitFor();
  assert.equal(await reopened.locator('[data-content-document]').getAttribute('data-content-document'), id);
  await ordinaryMarkdownSaved(reopened, id, 'Owner body', 1);
  await ordinaryMarkdownSaved(reopened, childId, 'Owned child body', 1);
  assert.deepEqual(await catalog(reopened, namespace, libraryId), finalCatalog);
  assert.deepEqual(await resource(reopened, namespace, attachment.resourceId), stored);
  } catch (error) {
    try {
    // Failure-only diagnostics: never turn an observation error into an empty DOM.
    // The observer is separately bounded and may perturb IDB scheduling after the failure.
    const observe = async (label: string, run: () => Promise<unknown>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([run(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} observation timeout`)), 2_000);
        })]);
        return { value };
      } catch (observationError) { return { error: String(observationError) }; }
      finally { if (timer) clearTimeout(timer); }
    };
    const current = app.currentPage();
    const pageState = current ? { closed: current.isClosed(), url: current.url() } : null;
    const dom = current && !current.isClosed() ? await observe('DOM', () => current.evaluate(() => ({
      body: document.body?.innerText.slice(0, 12_000) ?? null,
      alerts: Array.from(document.querySelectorAll('[role="alert"]')).slice(0, 50).map(node => node.textContent?.slice(0, 500)),
      folders: Array.from(document.querySelectorAll('[data-folder-id]')).slice(0, 100).map(node => ({
        id: node.getAttribute('data-folder-id'), expanded: node.getAttribute('aria-expanded'),
        selected: node.getAttribute('aria-selected'), text: node.textContent?.slice(0, 500),
      })),
      buttons: Array.from(document.querySelectorAll('button')).slice(0, 200).map(node => ({
        text: node.innerText.slice(0, 300), label: node.getAttribute('aria-label'),
        expanded: node.getAttribute('aria-expanded'), hidden: node.hidden,
      })),
    }))) : { error: 'current page unavailable or closed' };
    const storage = current && !current.isClosed() && diagnosticCatalog
      ? await observe('failure-only catalog', async () => {
        const observed = await catalog(current, diagnosticCatalog!.namespace, diagnosticCatalog!.libraryId);
        return { owner: observed.snapshot.items.find(item => item.id === diagnosticCatalog!.ownerId) ?? null,
          folders: observed.snapshot.folders.slice(0, 100), editCount: observed.edits.length,
          allDurableWithHistory: observed.edits.every(edit => edit.receipt.durable && !!edit.history), intents: observed.intents };
      })
      : { error: 'current page or catalog identifiers unavailable' };
    t.diagnostic(JSON.stringify({ phase, error: String(error), originalPageClosed: page.isClosed(),
      currentPage: pageState, browserErrors: app.browserErrors(), dom, storage,
      storageObserver: 'failure-only, separately bounded; may perturb IDB scheduling' }));
    } catch (diagnosticError) { t.diagnostic(JSON.stringify({ phase, error: String(error), diagnosticError: String(diagnosticError) })); }
    throw error;
  }
});

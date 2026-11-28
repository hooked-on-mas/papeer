// Candidate for frontend/e2e/tests/library/webOrdinaryLibraryRecovery.browser.test.ts.
// Ordinary UI creates all roots/resources. Only readonly IDB observations and exact scoped real transaction aborts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { ordinaryWeb, createNotebook, gesture } from '../reader/p2/ordinaryWeb.ts';
import { ordinaryMarkdown, ordinaryMarkdownSaved } from '../../support/ordinaryMarkdown.ts';
import { committed, durable, inks, resource } from '../reader/p2/ordinaryStorage.ts';
import { EditGraph } from '../../../src/runtime/edits/editGraph.ts';
import type { LibrarySnapshot, Snapshot, EditIntentRecord } from '../../../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../../../src/runtime/edits/repository.ts';

async function catalog(page: Page, namespace: string, libraryId: string) {
  const data = await page.evaluate(async ({ namespace, libraryId }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-shared-edits');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing database required')); };
      request.onblocked = () => reject(new Error('catalog observation blocked'));
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    try { return await new Promise<{ root: Snapshot; edits: StoredEdit[]; intents: EditIntentRecord[] }>((resolve, reject) => {
      const tx = db.transaction(['roots', 'edits', 'intents'], 'readonly');
      const roots = tx.objectStore('roots').getAll(), edits = tx.objectStore('edits').getAll(), intents = tx.objectStore('intents').getAll();
      tx.onabort = () => reject(tx.error ?? new Error('catalog read aborted'));
      tx.oncomplete = () => {
        const root = roots.result.find((row: { scope: string; value: Snapshot }) => row.scope === namespace && row.value.id === libraryId);
        if (!root) { reject(new Error('catalog root missing')); return; }
        resolve({ root: root.value, edits: edits.result.filter((row: { scope: string; value: StoredEdit }) => row.scope === namespace && row.value.batch.targetId === libraryId).map((row: { value: StoredEdit }) => row.value),
          intents: intents.result.filter((row: { scope: string; key: string }) => row.scope === namespace && JSON.parse(row.key)[1] === libraryId).map((row: { value: EditIntentRecord }) => row.value) });
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
    if (!value.intents.length && value.edits.every(edit => edit.receipt.durable && edit.history) && predicate(value.snapshot)) return value;
    assert.ok(Date.now() < deadline, 'catalog transaction did not settle'); await delay(50);
  }
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary owner deletion recovery preserves roots and restores one catalog operation (${engine})`, { timeout: 300_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  const toggle = () => page.getByRole('button', { name: '資料一覧', exact: true });
  const showCatalog = async () => { if (await toggle().getAttribute('aria-expanded') !== 'true') await toggle().click(); };
  const closeCatalog = async () => { if (await toggle().getAttribute('aria-expanded') === 'true') await toggle().click(); };
  const opened = async (title: string, previous: string | null) => {
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
    await page.waitForFunction(old => { const id = document.querySelector('[data-content-document]')?.getAttribute('data-content-document'); return !!id && id !== old; }, previous);
    await page.locator('button[aria-expanded="false"]').filter({ hasText: /^資料一覧$/ }).waitFor();
    const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id); return id;
  };
  const createMarkdown = async (title: string, body: string) => {
    const surface = page.locator('[data-content-document]'), previous = await surface.count() ? await surface.getAttribute('data-content-document') : null;
    await page.getByLabel('新しい資料の名前', { exact: true }).fill(title);
    await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
    await page.getByRole('button', { name: '資料を作成', exact: true }).click();
    const id = await opened(title, previous), editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true });
    await editor.fill(body); const saved = await ordinaryMarkdownSaved(page, id, body, 1); return { id, saved };
  };
  let phase = 'setup', namespace = '', libraryId = '';
  const finalContents: { id: string; kind: 'markdown' | 'notebook'; value: unknown }[] = [];
  const finalResources: { id: string; value: Awaited<ReturnType<typeof resource>> }[] = [];
  try {
    for (const policy of ['detach', 'delete'] as const) {
      phase = `${policy}-owner`;
      await showCatalog(); await page.getByRole('button', { name: '未分類を選択', exact: true }).click();
      await page.getByText('選択中: 未分類', { exact: true }).waitFor();
      const ownerTitle = `${policy} owner ${engine}`, childTitle = `${policy} child ${engine}`, ownerBody = `${policy} retained owner body`;
      let ownerId: string, ownerValue: Awaited<ReturnType<typeof committed>> | Awaited<ReturnType<typeof ordinaryMarkdown>>;
      if (policy === 'detach') {
        ownerId = await createNotebook(page, ownerTitle); await closeCatalog();
        await page.getByRole('button', { name: 'ペン', exact: true }).click();
        await gesture(page, [[.22, .26], [.46, .31]]);
        const inkIds = (await inks(page)).map(ink => ink.id); assert.equal(inkIds.length, 1);
        ownerValue = await durable(page, ownerId, inkIds, 1);
      } else {
        const created = await createMarkdown(ownerTitle, ownerBody); ownerId = created.id; ownerValue = created.saved;
      }
      namespace = ownerValue.namespace; libraryId = JSON.parse(namespace)[1] as string;
      await showCatalog(); await page.getByLabel(`「${ownerTitle}」に付属ノートを作成`, { exact: true }).click();
      const childBody = `${policy} child content at deletion`, child = await createMarkdown(childTitle, childBody);
      let childValue = child.saved;
      await showCatalog();
      const filename = `${policy}-retained.txt`, bytes = Buffer.from(`${policy} exact attachment bytes`), hash = createHash('sha256').update(bytes).digest('hex');
      const chooser = page.waitForEvent('filechooser');
      await page.getByLabel(`「${ownerTitle}」にファイルを添付`, { exact: true }).click();
      await (await chooser).setFiles({ name: filename, mimeType: 'text/plain', buffer: bytes });
      const attached = await catalogUntil(page, namespace, libraryId, value => value.items.some(item => item.ownerId === ownerId && item.title === filename));
      const attachment = attached.snapshot.items.find(item => item.ownerId === ownerId && item.title === filename)!; assert.ok(attachment.resourceId);
      await opened(filename, child.id);
      const storedResource = await resource(page, namespace, attachment.resourceId); assert.equal(storedResource.actualSha256, hash);
      await showCatalog();
      phase = `${policy}-delete-owner`;
      await page.getByLabel(`「${ownerTitle}」を削除`, { exact: true }).click();
      await page.getByLabel('子ノートの扱い', { exact: true }).selectOption(policy);
      await page.getByRole('button', { name: '削除を確定', exact: true }).click();
      const deleted = await catalogUntil(page, namespace, libraryId, value => value.deletions.some(record => record.active && record.itemIds.includes(ownerId)));
      const deletion = deleted.snapshot.deletions.find(record => record.active && record.itemIds.includes(ownerId))!;
      assert.deepEqual([...deletion.itemIds].sort(), [ownerId, attachment.id, ...(policy === 'delete' ? [child.id] : [])].sort());
      assert.equal(deletion.observed.some(value => value.targetId === attachment.id), false);
      assert.equal(deletion.observed.find(value => value.targetId === ownerId)?.heads.length, 1);
      assert.deepEqual(await resource(page, namespace, attachment.resourceId), storedResource);
      assert.deepEqual(await ordinaryMarkdown(page, child.id), childValue);
      assert.deepEqual(policy === 'detach' ? await committed(page, ownerId) : await ordinaryMarkdown(page, ownerId), ownerValue);
      if (policy === 'detach') {
        assert.equal(deleted.snapshot.items.find(item => item.id === child.id)?.ownerId, null);
        await page.getByRole('button', { name: childTitle, exact: true }).click(); await opened(childTitle, attachment.id);
        const text = childBody + '\nEdit after detachment; this child was not deleted.';
        await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).fill(text);
        childValue = await ordinaryMarkdownSaved(page, child.id, text, 2); await showCatalog();
      } else {
        await page.getByLabel(`削除された「${childTitle}」の内容を確認`, { exact: true }).click(); await opened(childTitle, attachment.id);
        await page.getByText('この資料は削除されています。新しい編集はできません。', { exact: true }).waitFor();
        assert.equal(await page.locator('[data-content-document] [contenteditable="true"]').count(), 0);
        await showCatalog();
      }
      phase = `${policy}-readonly-comparison-and-keep`;
      const targetId = policy === 'detach' ? ownerId : child.id, targetTitle = policy === 'detach' ? ownerTitle : childTitle;
      await page.getByLabel(`削除された「${targetTitle}」を削除時点と比較`, { exact: true }).click();
      const panel = page.getByRole('region', { name: '削除した資料の比較', exact: true }); await panel.waitFor();
      const observed = panel.getByLabel('削除時点の版を選択', { exact: true }), current = panel.getByLabel('現在の版を選択', { exact: true });
      const version = deletion.observed.find(value => value.targetId === targetId)!.heads[0];
      await page.waitForFunction(({ version }) => { const selects = [...document.querySelectorAll('[aria-label="削除した資料の比較"] select')].filter(node => node.getAttribute('aria-label')?.endsWith('版を選択'));
        return selects.length === 2 && selects.every(node => (node as HTMLSelectElement).value === version); }, { version });
      assert.equal(await observed.inputValue(), version); assert.equal(await current.inputValue(), version);
      assert.equal(await panel.locator('[contenteditable="true"], [data-ink-overlay]').count(), 0);
      if (policy === 'delete') {
        await panel.getByRole('region', { name: '削除時点の版', exact: true }).getByText(childBody, { exact: true }).first().waitFor();
        assert.equal(await panel.getByRole('list', { name: '一緒に復元する資料', exact: true }).getByRole('listitem').count(), 3);
      } else await panel.locator('[data-comparison-page]').first().waitFor();
      const beforeKeep = await catalog(page, namespace, libraryId);
      await panel.getByRole('button', { name: '比較を閉じる', exact: true }).click(); await panel.waitFor({ state: 'hidden' });
      assert.deepEqual(await catalog(page, namespace, libraryId), beforeKeep, 'retaining/closing comparison writes nothing and does not revive a deleted item');
      await page.getByLabel(`削除された「${targetTitle}」を削除時点と比較`, { exact: true }).click(); await panel.waitFor();
      const beforeRestore = await catalog(page, namespace, libraryId);
      if (policy === 'delete') {
        phase = 'real-catalog-restore-transaction-abort';
        await page.evaluate(({ namespace, libraryId, deletionId }) => {
          const probe = { enabled: true, attempts: [] as StoredEdit[], trustedRetry: [] as boolean[] };
          (globalThis as unknown as { recoveryFault: typeof probe }).recoveryFault = probe;
          const put = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
            const row = value as { scope?: string; value?: StoredEdit }, batch = row.value?.batch;
            if (this.name === 'edits' && this.transaction.mode === 'readwrite' && row.scope === namespace && batch?.targetId === libraryId && batch.kind === 'library'
              && batch.changes.some(change => change.type === 'put-deletion' && change.deletion.id === deletionId && !change.deletion.active)) {
              probe.attempts.push(structuredClone(row.value!));
              if (probe.enabled) { this.transaction.abort(); throw new DOMException('actual exact catalog restoration abort', 'AbortError'); }
            }
            return key === undefined ? put.call(this, value) : put.call(this, value, key);
          };
        }, { namespace, libraryId, deletionId: deletion.id });
      }
      await panel.getByRole('button', { name: '比較した資料を復元', exact: true }).click();
      if (policy === 'delete') {
        // pendingId exposes a disabled retry button before the asynchronous commit has reached IDB.
        // Observe the actual completed failure, not merely an in-flight pending action.
        await panel.getByRole('alert').filter({ hasText: '復元できませんでした。比較内容は保持しています。' }).waitFor();
        await page.getByRole('button', { name: '変更を再試行', exact: true }).waitFor();
        const failed = await catalog(page, namespace, libraryId); assert.deepEqual(failed.snapshot, beforeRestore.snapshot); assert.deepEqual(failed.edits, beforeRestore.edits);
        assert.equal(failed.intents.length, 1);
        const retained = failed.intents[0].intent.request; assert.ok('batch' in retained);
        const attempts = await page.evaluate(() => (globalThis as unknown as { recoveryFault: { attempts: StoredEdit[] } }).recoveryFault.attempts);
        assert.ok(attempts.length > 0); assert.deepEqual(retained.batch, attempts[0].batch); assert.deepEqual(retained.history, attempts[0].history);
        assert.deepEqual(await ordinaryMarkdown(page, child.id), childValue);
        assert.deepEqual(await resource(page, namespace, attachment.resourceId), storedResource);
        const retry = page.getByRole('button', { name: '変更を再試行', exact: true });
        await retry.evaluate(button => button.addEventListener('click', event => { const probe = (globalThis as unknown as { recoveryFault: { enabled: boolean; trustedRetry: boolean[] } }).recoveryFault;
          probe.trustedRetry.push(event.isTrusted); probe.enabled = false; }, { capture: true, once: true }));
        await retry.click();
        const recovered = await catalogUntil(page, namespace, libraryId, value => value.deletions.find(record => record.id === deletion.id)?.active === false);
        const probe = await page.evaluate(() => (globalThis as unknown as { recoveryFault: { attempts: StoredEdit[]; trustedRetry: boolean[] } }).recoveryFault);
        assert.deepEqual(probe.trustedRetry, [true]); assert.ok(probe.attempts.length >= 2);
        for (const attempt of probe.attempts) { assert.deepEqual(attempt.batch, attempts[0].batch); assert.deepEqual(attempt.history, attempts[0].history); }
        assert.equal(recovered.edits.filter(edit => edit.batch.id === attempts[0].batch.id).length, 1);
        await panel.getByRole('button', { name: '比較を閉じる', exact: true }).click();
      }
      const restored = await catalogUntil(page, namespace, libraryId, value => value.deletions.find(record => record.id === deletion.id)?.active === false);
      assert.equal(restored.edits.length, beforeRestore.edits.length + 1);
      assert.deepEqual(restored.snapshot.items, beforeRestore.snapshot.items, 'direct restore changes no catalog relationship fields');
      assert.deepEqual(restored.snapshot.links, beforeRestore.snapshot.links, 'direct restore does not recreate removed links');
      assert.deepEqual(await ordinaryMarkdown(page, child.id), childValue);
      assert.deepEqual(policy === 'detach' ? await committed(page, ownerId) : await ordinaryMarkdown(page, ownerId), ownerValue);
      assert.deepEqual(await resource(page, namespace, attachment.resourceId), storedResource);
      if (policy === 'delete') {
        phase = 'restore-undo-redo-retains-current-content';
        await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
        const undone = await catalogUntil(page, namespace, libraryId, value => value.deletions.find(record => record.id === deletion.id)?.active === true);
        assert.equal(undone.edits.length, restored.edits.length + 1);
        assert.deepEqual(undone.edits.find(edit => edit.batch.id === undone.snapshot.version)?.history?.action, { kind: 'undo', operationId: restored.snapshot.version });
        await page.getByRole('button', { name: '資料の変更をやり直す', exact: true }).click();
        const redone = await catalogUntil(page, namespace, libraryId, value => value.deletions.find(record => record.id === deletion.id)?.active === false);
        assert.equal(redone.edits.length, restored.edits.length + 2);
        assert.deepEqual(redone.edits.find(edit => edit.batch.id === redone.snapshot.version)?.history?.action, { kind: 'redo', operationId: restored.snapshot.version });
        assert.deepEqual(await ordinaryMarkdown(page, child.id), childValue);
      }
      finalContents.push({ id: ownerId, kind: policy === 'detach' ? 'notebook' : 'markdown', value: ownerValue }, { id: child.id, kind: 'markdown', value: childValue });
      finalResources.push({ id: attachment.resourceId, value: storedResource });
    }
    phase = 'complete-browser-restart';
    const finalCatalog = await catalog(page, namespace, libraryId), reopened = await app.restartLibrary();
    assert.deepEqual(await catalog(reopened, namespace, libraryId), finalCatalog);
    for (const expected of finalContents) assert.deepEqual(expected.kind === 'notebook' ? await committed(reopened, expected.id) : await ordinaryMarkdown(reopened, expected.id), expected.value);
    for (const expected of finalResources) assert.deepEqual(await resource(reopened, namespace, expected.id), expected.value);
    t.diagnostic(JSON.stringify({ engine, detachAndDeletePolicies: true, actualReadOnlyComparison: true, targetedBrowserAbortSameBatchRetry: true,
      exactCatalogAndContentAndResourceRestart: true, trueRemoteArrivalClaimed: false }));
  } catch (error) { t.diagnostic(JSON.stringify({ phase, body: await page.locator('body').innerText().catch(() => '') })); throw error; }
});


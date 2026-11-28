import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { EditGraph } from '../../../src/runtime/edits/editGraph.ts';
import type { CanonicalLibraryProfile, LibrarySnapshot } from '../../../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../../../src/runtime/edits/repository.ts';
import { createNotebook, ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { committed, durable, inks, resource } from '../reader/p2/ordinaryStorage.ts';
import { assertOrdinaryMarkdownText, ordinaryMarkdown, ordinaryMarkdownSaved } from '../../support/ordinaryMarkdown.ts';

async function catalog(page: Page) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}
async function child(page: Page, owner: string, title: string, kind: 'markdown' | 'notebook') {
  await catalog(page);
  await page.getByLabel(`「${owner}」に付属ノートを作成`, { exact: true }).click();
  await page.getByLabel('新しい資料の名前', { exact: true }).fill(title);
  await page.getByLabel('資料の種類', { exact: true }).selectOption(kind);
  await page.getByRole('button', { name: '資料を作成', exact: true }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  if (kind === 'markdown') await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
  else await page.getByLabel('ノート書き込みレイヤー', { exact: true }).waitFor();
  const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id); return id;
}
async function panel(page: Page, next: boolean) {
  const button = page.locator('button[aria-controls="workspace-related-panel"]');
  if ((await button.getAttribute('aria-expanded') === 'true') !== next) await button.click();
  await page.waitForFunction(next => document.querySelector('button[aria-controls="workspace-related-panel"]')?.getAttribute('aria-expanded') === String(next), next);
  assert.equal(await page.locator('#workspace-related-panel').isVisible(), next);
}
/** Read only one UI-created Library's actual root and batches, without app bindings. */
async function storedCatalog(page: Page) {
  const observed = await page.evaluate(async () => {
    type Row<T> = { scope: string; value: T };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-shared-edits');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing UI-created database required')); };
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise<{ root: LibrarySnapshot; edits: StoredEdit[]; namespace: string }>((resolve, reject) => {
        const tx = db.transaction(['canonicalProfiles', 'roots', 'edits'], 'readonly');
        const profiles = tx.objectStore('canonicalProfiles').getAll(), roots = tx.objectStore('roots').getAll(), edits = tx.objectStore('edits').getAll();
        tx.onabort = () => reject(tx.error);
        tx.oncomplete = () => {
          if (profiles.result.length !== 1) { reject(new Error('exactly one UI-created Library required')); return; }
          const identity = (profiles.result as Row<CanonicalLibraryProfile>[])[0].value.identity;
          const root = (roots.result as Row<LibrarySnapshot>[]).find(row => row.value.kind === 'library' && row.value.id === identity.libraryId);
          if (!root) { reject(new Error('UI-created Library root missing')); return; }
          resolve({ root: root.value, namespace: root.scope, edits: (edits.result as Row<StoredEdit>[])
            .filter(row => row.scope === root.scope && row.value.batch.targetId === root.value.id).map(row => row.value) });
        };
      });
    } finally { db.close(); }
  });
  assert.ok(observed.edits.every(edit => edit.receipt.durable));
  const graph = new EditGraph({ version: 1, libraryId: observed.root.id, root: observed.root, batches: observed.edits.map(edit => edit.batch) });
  const view = graph.getView(); assert.equal(view.heads.length, 1);
  const snapshot = graph.snapshot(view.heads[0]); assert.equal(snapshot?.kind, 'library');
  if (snapshot?.kind !== 'library') throw new Error('Library snapshot required');
  return { ...observed, snapshot };
}

for (const engine of ['chromium', 'webkit'] as const) {
  test(`ordinary related panel opens exact child notes and readonly attachment without extra edits (${engine})`, { timeout: 240_000 }, async t => {
    const app = await ordinaryWeb(t, engine), page = app.page;
    let phase = 'create-owner';
    try {
      const owner = `Panel owner ${engine}`, markdownTitle = `Panel Markdown ${engine}`, notebookTitle = `Panel notebook ${engine}`;
      const ownerId = await createNotebook(page, owner);
      const markdownId = await child(page, owner, markdownTitle, 'markdown');
      const body = 'Exact child body retained through the real related panel';
      await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).fill(body);
      await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).blur();
      const markdownBefore = await ordinaryMarkdownSaved(page, markdownId, body, 1);
      const notebookId = await child(page, owner, notebookTitle, 'notebook');
      const notebookBefore = await committed(page, notebookId);
      phase = 'attach'; await catalog(page);
      const choosing = page.waitForEvent('filechooser');
      await page.getByLabel(`「${owner}」にファイルを添付`, { exact: true }).click();
      const attachmentBytes = Buffer.from('Exact attachment bytes; never the first note');
      await (await choosing).setFiles({ name: 'panel-exact.txt', mimeType: 'text/plain', buffer: attachmentBytes });
      await page.getByRole('heading', { name: 'panel-exact.txt', exact: true }).waitFor();
      const catalogBefore = await storedCatalog(page), attachment = catalogBefore.snapshot.items.find(item => item.kind === 'attachment' && item.title === 'panel-exact.txt');
      assert.ok(attachment?.resourceId); assert.equal(attachment.ownerId, ownerId);
      assert.equal(catalogBefore.snapshot.items.find(item => item.id === markdownId)?.ownerId, ownerId);
      assert.equal(catalogBefore.snapshot.items.find(item => item.id === notebookId)?.ownerId, ownerId);
      const attachmentBefore = await resource(page, catalogBefore.namespace, attachment.resourceId);
      assert.equal(attachmentBefore.actualSha256, createHash('sha256').update(attachmentBytes).digest('hex'));
      phase = 'panel-owner'; await catalog(page); await page.getByRole('button', { name: owner, exact: true }).click();
      await page.getByLabel('ノート書き込みレイヤー', { exact: true }).waitFor();
      const ownerRoot = await page.locator('[data-reader-root]').elementHandle(); assert.ok(ownerRoot);
      await panel(page, true);
      const aside = page.locator('#workspace-related-panel'), region = page.getByRole('region', { name: '付属ノート・添付', exact: true });
      const readerBox = await page.locator('[data-reader-root]').boundingBox(), sideBox = await aside.boundingBox();
      assert.ok(readerBox && sideBox && sideBox.width > 0 && sideBox.x >= readerBox.x + readerBox.width - 1, 'the panel is beside the same reader');
      assert.equal(await ownerRoot.evaluate(element => element.isConnected && document.querySelector('[data-reader-root]') === element), true);
      assert.equal(await region.getByRole('button', { name: `Markdown: ${markdownTitle}`, exact: true }).count(), 1);
      assert.equal(await region.getByRole('button', { name: `手書きノート: ${notebookTitle}`, exact: true }).count(), 1);
      assert.equal(await region.getByRole('button', { name: '添付: panel-exact.txt', exact: true }).count(), 1);
      phase = 'open-markdown'; await region.getByRole('button', { name: `Markdown: ${markdownTitle}`, exact: true }).click();
      await page.getByRole('heading', { name: markdownTitle, exact: true }).waitFor();
      await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
      assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), markdownId);
      assert.equal(await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).count(), 1);
      await page.getByRole('button', { name: '右側で編集', exact: true }).click();
      await page.locator('[data-editor-placement="right"]').waitFor();
      await region.getByRole('button', { name: '中央で編集', exact: true }).click();
      await page.locator('[data-editor-placement="center"]').waitFor();
      assert.deepEqual(await ordinaryMarkdownSaved(page, markdownId, body, 1), markdownBefore);
      phase = 'open-notebook'; await region.getByRole('button', { name: `手書きノート: ${notebookTitle}`, exact: true }).click();
      await page.getByRole('heading', { name: notebookTitle, exact: true }).waitFor();
      await page.getByLabel('ノート書き込みレイヤー', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), notebookId);
      assert.deepEqual(await committed(page, notebookId), notebookBefore);
      phase = 'open-attachment'; await region.getByRole('button', { name: '添付: panel-exact.txt', exact: true }).click();
      await page.getByText(attachmentBytes.toString(), { exact: true }).waitFor();
      assert.equal(await page.locator('[data-attachment-id]').getAttribute('data-attachment-id'), attachment.id);
      assert.equal(await page.locator('[data-reader-root]').count(), 0);
      const pane = await aside.elementHandle(); assert.ok(pane);
      await page.getByRole('button', { name: '集中表示', exact: true }).click();
      await aside.waitFor({ state: 'hidden' }); assert.equal(await pane.evaluate(element => element.isConnected), true);
      await page.getByRole('button', { name: '集中表示を終了', exact: true }).click(); await aside.waitFor();
      assert.equal(await page.locator('button[aria-controls="workspace-related-panel"]').getAttribute('aria-expanded'), 'true');
      assert.deepEqual(await storedCatalog(page), catalogBefore);
      phase = 'cold-restart'; const restarted = await app.restartLibrary({ showCatalog: false });
      await restarted.getByText(attachmentBytes.toString(), { exact: true }).waitFor();
      assert.equal(await restarted.locator('[data-attachment-id]').getAttribute('data-attachment-id'), attachment.id);
      assert.equal(await restarted.locator('button[aria-controls="workspace-related-panel"]').getAttribute('aria-expanded'), 'false');
      assert.deepEqual(await storedCatalog(restarted), catalogBefore);
      assert.deepEqual(await resource(restarted, catalogBefore.namespace, attachment.resourceId), attachmentBefore);
      assert.deepEqual(await ordinaryMarkdownSaved(restarted, markdownId, body, 1), markdownBefore);
      t.diagnostic(JSON.stringify({ engine, ownerId, markdownId, notebookId, attachmentId: attachment.id, exactIdsAndBytes: true, noExtraCatalogOrContentEdits: true, coldRestart: true }));
    } catch (error) { t.diagnostic(JSON.stringify({ phase, error: String(error), body: await page.locator('body').innerText().catch(String) })); throw error; }
  });

  test(`ordinary related panel retains a failed save and rejects both width changes during contact (${engine})`, { timeout: 240_000 }, async t => {
    const app = await ordinaryWeb(t, engine), { page } = app;
    let phase = 'setup';
    try {
      const owner = `Guard owner ${engine}`, firstTitle = `Guard source ${engine}`, secondTitle = `Guard destination ${engine}`;
      const ownerId = await createNotebook(page, owner), firstId = await child(page, owner, firstTitle, 'markdown');
      const initial = 'Original retained body', changed = initial + '\nFailed save stays in its own document';
      const editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true }); await editor.fill(initial); await editor.blur();
      const saved = await ordinaryMarkdownSaved(page, firstId, initial, 1);
      const secondId = await child(page, owner, secondTitle, 'markdown'); await panel(page, true);
      const region = page.getByRole('region', { name: '付属ノート・添付', exact: true });
      await region.getByRole('button', { name: `Markdown: ${firstTitle}`, exact: true }).click();
      await page.getByRole('heading', { name: firstTitle, exact: true }).waitFor();
      await page.waitForFunction(id => document.querySelector('[data-content-document]')?.getAttribute('data-content-document') === id, firstId);
      await editor.waitFor();
      phase = 'scoped-real-abort';
      await page.evaluate(({ namespace, id }) => {
        const probe = { enabled: true, batchIds: [] as string[] };
        (globalThis as unknown as { relatedPanelFault: typeof probe }).relatedPanelFault = probe;
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(value, key) {
          if (this.name === 'edits' && this.transaction.mode === 'readwrite' && value?.scope === namespace && value?.value?.batch?.targetId === id && probe.enabled) {
            probe.batchIds.push(value.value.batch.id); this.transaction.abort();
            throw new DOMException('actual scoped panel-navigation commit abort', 'AbortError');
          }
          return put.call(this, value, key);
        };
      }, { namespace: saved.namespace, id: firstId });
      await editor.fill(changed); await editor.blur();
      const failure = page.getByRole('alert').filter({ hasText: '入力内容を保持しています' }); await failure.waitFor();
      const beforeGuard = await ordinaryMarkdown(page, firstId); assert.equal(beforeGuard.edits.length, 1); assert.equal(beforeGuard.intents.length, 1);
      await region.getByRole('button', { name: `Markdown: ${secondTitle}`, exact: true }).click();
      await region.getByRole('alert').filter({ hasText: '資料を開けません' }).waitFor();
      assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), firstId);
      await assertOrdinaryMarkdownText(editor, changed);
      assert.deepEqual((await ordinaryMarkdown(page, firstId)).intents, beforeGuard.intents);
      const retry = failure.getByRole('button', { name: '再試行', exact: true });
      await retry.evaluate(button => button.addEventListener('click', () => { (globalThis as unknown as { relatedPanelFault: { enabled: boolean } }).relatedPanelFault.enabled = false; }, { capture: true, once: true }));
      const attempts = await page.evaluate(() => (globalThis as unknown as { relatedPanelFault: { batchIds: string[] } }).relatedPanelFault.batchIds);
      assert.ok(attempts.length > 0); assert.equal(new Set(attempts).size, 1);
      await retry.click(); const recovered = await ordinaryMarkdownSaved(page, firstId, changed, 2);
      assert.ok(recovered.edits.some(edit => edit.batch.id === attempts[0]));
      await region.getByRole('button', { name: `Markdown: ${secondTitle}`, exact: true }).click();
      await page.getByRole('heading', { name: secondTitle, exact: true }).waitFor();
      await editor.waitFor(); assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), secondId);
      phase = 'contact'; await catalog(page); await page.getByRole('button', { name: owner, exact: true }).click();
      const layer = page.getByLabel('ノート書き込みレイヤー', { exact: true }); await layer.waitFor();
      const root = await page.locator('[data-reader-root]').elementHandle(); assert.ok(root);
      const toggle = page.locator('button[aria-controls="workspace-related-panel"]');
      for (const currentlyOpen of [true, false]) {
        await panel(page, currentlyOpen); await page.getByRole('button', { name: 'ペン', exact: true }).click();
        await layer.scrollIntoViewIfNeeded(); const box = await layer.boundingBox(); assert.ok(box && box.width > 0 && box.height > 0);
        await page.mouse.move(box.x + box.width * .25, box.y + box.height * .6); await page.mouse.down();
        try {
          await page.mouse.move(box.x + box.width * .4, box.y + box.height * .6, { steps: 5 });
          await toggle.evaluate(button => (button as HTMLButtonElement).click());
          assert.equal(await toggle.getAttribute('aria-expanded'), String(currentlyOpen));
          const after = await layer.boundingBox(); assert.ok(after);
          assert.ok(Math.abs(after.x - box.x) < 1 && Math.abs(after.y - box.y) < 1 && Math.abs(after.width - box.width) < 1 && Math.abs(after.height - box.height) < 1, 'refusal does not resize the held paper');
        } finally { await page.mouse.up(); }
        const count = currentlyOpen ? 1 : 2;
        await page.waitForFunction(count => document.querySelectorAll('[data-ink-id]').length === count, count);
        await durable(page, ownerId, (await inks(page)).map(ink => ink.id), count);
        await panel(page, !currentlyOpen);
      }
      phase = 'narrow'; await page.getByRole('button', { name: '表示設定', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'このライブラリの表示設定', exact: true });
      await settings.getByLabel('文字の大きさ', { exact: true }).selectOption('1.25');
      await settings.getByRole('button', { name: '表示設定を閉じる', exact: true }).click(); await settings.waitFor({ state: 'hidden' });
      await panel(page, true); const beforeWidths = await committed(page, ownerId);
      for (const width of [1000, 600]) {
        await page.setViewportSize({ width, height: 910 });
        await page.waitForFunction(() => { const paper = document.querySelector('[data-paper-page]')?.getBoundingClientRect(); return !!paper && paper.height > 0 && paper.bottom <= innerHeight + 1; });
        const paper = await page.locator('[data-reader-root]').boundingBox(), aside = await page.locator('#workspace-related-panel').boundingBox();
        assert.ok(paper && aside && paper.width > 0 && aside.width > 0 && aside.x >= paper.x + paper.width - 1 && aside.x + aside.width <= width + 1);
        assert.equal(await root.evaluate(element => element.isConnected && document.querySelector('[data-reader-root]') === element), true);
        assert.ok(await region.getByRole('button', { name: `Markdown: ${firstTitle}`, exact: true }).evaluate(element => element.getBoundingClientRect().height >= 44));
      }
      assert.deepEqual(await committed(page, ownerId), beforeWidths);
      t.diagnostic(JSON.stringify({ engine, actualCommitAbortSameIdRetry: true, exactDestinationId: secondId, heldContactRefusedOpeningAndClosing: true, widths: [1000, 600], uiScale: 1.25, extraEditsFromWidthChanges: 0 }));
    } catch (error) { t.diagnostic(JSON.stringify({ phase, error: String(error), body: await page.locator('body').innerText().catch(String) })); throw error; }
  });
}

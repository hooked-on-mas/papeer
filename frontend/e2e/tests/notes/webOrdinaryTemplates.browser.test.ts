import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { ordinaryMarkdownSaved } from '../../support/ordinaryMarkdown.ts';
import type { LibrarySnapshot, MarkdownSnapshot, Snapshot } from '../../../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../../../src/runtime/edits/repository.ts';
import { EditGraph } from '../../../src/runtime/edits/editGraph.ts';

async function observed(page: Page, id: string) {
  const data = await page.evaluate(async target => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-shared-edits');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('database missing')); };
      request.onblocked = () => reject(new Error('database blocked'));
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    try { return await new Promise<{ root: Snapshot; edits: StoredEdit[]; scope: string }>((resolve, reject) => {
      const tx = db.transaction(['roots', 'edits'], 'readonly'), roots = tx.objectStore('roots').getAll(), edits = tx.objectStore('edits').getAll();
      tx.onabort = () => reject(tx.error ?? new Error('read aborted'));
      tx.oncomplete = () => { const row = roots.result.find((v: { value: Snapshot }) => v.value.id === target);
        if (!row) { reject(new Error('root absent')); return; }
        resolve({ root: row.value, scope: row.scope, edits: edits.result.filter((v: { scope: string; value: StoredEdit }) => v.scope === row.scope && v.value.batch.targetId === target).map((v: { value: StoredEdit }) => v.value) }); };
    }); } finally { db.close(); }
  }, id);
  const graph = new EditGraph({ version: 1, libraryId: JSON.parse(data.scope)[1], root: data.root, batches: data.edits.map(value => value.batch) });
  const heads = graph.getView().heads; assert.equal(heads.length, 1);
  return { ...data, snapshot: graph.snapshot(heads[0])! };
}


/** Wait for the selected, enabled UI and its exact resolved body. */
async function waitTemplateReady(page: Page, id: string, body: string) {
  await page.waitForFunction(({ id, body }) => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const select = dialog?.querySelector<HTMLSelectElement>('[aria-label="\u30c6\u30f3\u30d7\u30ec\u30fc\u30c8"]');
    const preview = dialog?.querySelector<HTMLElement>('pre');
    const append = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(button => button.textContent === '\u30ce\u30fc\u30c8\u306b\u8ffd\u52a0');
    return !!select && select.value === id && !select.disabled && !!preview && preview.getClientRects().length > 0
      && preview.textContent === body && !!append && !append.disabled;
  }, { id, body });
}

/** Test-only IDB lock: no writes. Keeps a real roots transaction open until explicitly released. */
async function holdTemplateReads(page: Page) {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('papeer-shared-edits');
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('roots', 'readwrite'), store = tx.objectStore('roots'); let held = true, first = true;
        const finished = new Promise<string>(done => {
          tx.oncomplete = () => { db.close(); done('complete'); };
          tx.onabort = () => { db.close(); reject(tx.error ?? new Error('hold-aborted')); done('aborted'); };
        });
        (window as unknown as { templateReadHold: { release(): Promise<string> } }).templateReadHold = {
          release: () => { held = false; return finished; },
        };
        const keep = () => {
          const read = store.get('__template_read_hold__');
          read.onsuccess = () => { if (first) { first = false; resolve(); } if (held) keep(); };
          read.onerror = () => reject(read.error ?? new Error('hold-read-failed'));
        };
        keep();
      });
    } catch (error) { db.close(); throw error; }
  });
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary library-scoped template creation, copy, edit, insert and delete (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page, title = `Templates ${engine}`;
  let phase = 'create-note';
  try {
  await page.getByLabel('新しい資料の名前', { exact: true }).fill(title);
  await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
  await page.getByRole('button', { name: '資料を作成', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true }); await editor.waitFor();
  const noteId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(noteId);
  await editor.fill('Original note'); await ordinaryMarkdownSaved(page, noteId, 'Original note', 1);
  await page.getByRole('button', { name: 'テンプレートを使う', exact: true }).click();
  phase = 'create-template-publication-retry';
  const modal = page.getByRole('dialog', { name: 'このライブラリのテンプレート', exact: true }); await modal.waitFor();
  await modal.getByRole('button', { name: '新規作成', exact: true }).click();
  await modal.getByLabel('テンプレート名', { exact: true }).fill('Custom A');
  await modal.getByLabel('テンプレート本文', { exact: true }).fill('First custom body');
  await page.keyboard.press('Escape'); await modal.waitFor();
  assert.equal(await modal.getByLabel('テンプレート本文', { exact: true }).inputValue(), 'First custom body');
  await page.evaluate(() => {
    const probe: { enabled: boolean; attempts: StoredEdit[] } = { enabled: true, attempts: [] };
    (globalThis as unknown as { templateFault: typeof probe }).templateFault = probe;
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
      const edit = (value as { value?: StoredEdit }).value;
      if (this.name === 'edits' && edit?.publication && edit.batch.kind === 'library'
        && edit.batch.changes.some(change => change.type === 'put-item' && change.item.metadata['papeer.note-template'] === 'v1')) {
        probe.attempts.push(structuredClone(edit));
        if (probe.enabled) { this.transaction.abort(); throw new DOMException('template publication abort', 'AbortError'); }
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  });
  await modal.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
  await modal.getByRole('alert').waitFor();
  assert.equal(await modal.getByLabel('テンプレート本文', { exact: true }).inputValue(), 'First custom body');
  const failed = await page.evaluate(() => (globalThis as unknown as { templateFault: { enabled: boolean; attempts: StoredEdit[] } }).templateFault.attempts);
  assert.ok(failed.length > 0);
  await page.evaluate(() => { (globalThis as unknown as { templateFault: { enabled: boolean } }).templateFault.enabled = false; });
  await modal.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
  const select = modal.getByLabel('テンプレート', { exact: true }); await select.waitFor();
  const firstId = await select.inputValue(); assert.ok(firstId);
  assert.equal(await page.getByRole('button', { name: '作成した資料を開く', exact: true, includeHidden: true }).count(), 0);
  const attempts = await page.evaluate(() => (globalThis as unknown as { templateFault: { attempts: StoredEdit[] } }).templateFault.attempts);
  assert.ok(attempts.length >= 2); for (const attempt of attempts) { assert.deepEqual(attempt.batch, failed[0].batch); assert.deepEqual(attempt.publication, failed[0].publication); }
  const first = await observed(page, firstId); assert.equal(first.snapshot.kind, 'markdown');
  assert.equal(first.scope, (await observed(page, noteId)).scope, 'template and note use the same admitted library scope');
  assert.equal((first.snapshot as MarkdownSnapshot).content, 'First custom body');
  phase = 'edit-template-retry';
  await modal.getByRole('button', { name: '編集', exact: true }).click();
  await modal.getByLabel('テンプレート本文', { exact: true }).fill('![bad](papeer://bad)');
  await modal.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
  await modal.getByRole('alert').waitFor();
  assert.equal(await modal.getByLabel('テンプレート本文', { exact: true }).getAttribute('readonly'), null);
  assert.equal((await observed(page, firstId)).edits.length, 0, 'invalid content is rejected before an edit is admitted');
  await modal.getByLabel('テンプレート本文', { exact: true }).fill('Edited custom body');
  await page.evaluate(target => {
    const probe: { enabled: boolean; attempts: StoredEdit[] } = { enabled: true, attempts: [] };
    (globalThis as unknown as { templateEditFault: typeof probe }).templateEditFault = probe;
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
      const edit = (value as { value?: StoredEdit }).value;
      if (this.name === 'edits' && edit?.batch.kind === 'markdown' && edit.batch.targetId === target) {
        probe.attempts.push(structuredClone(edit));
        if (probe.enabled) { this.transaction.abort(); throw new DOMException('template edit abort', 'AbortError'); }
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  }, firstId);
  await modal.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
  await modal.getByRole('alert').waitFor();
  assert.equal(await modal.getByLabel('テンプレート本文', { exact: true }).inputValue(), 'Edited custom body');
  assert.equal(await modal.getByLabel('テンプレート本文', { exact: true }).getAttribute('readonly'), '');
  const failedEdit = await page.evaluate(() => (globalThis as unknown as { templateEditFault: { attempts: StoredEdit[] } }).templateEditFault.attempts);
  assert.ok(failedEdit.length > 0);
  await page.evaluate(() => { (globalThis as unknown as { templateEditFault: { enabled: boolean } }).templateEditFault.enabled = false; });
  await modal.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
  await modal.getByLabel('テンプレート本文', { exact: true }).waitFor({ state: 'hidden' });
  await select.waitFor();
  await waitTemplateReady(page, firstId, 'Edited custom body');
  assert.equal(await modal.locator('pre').innerText(), 'Edited custom body');
  const retriedEdit = await page.evaluate(() => (globalThis as unknown as { templateEditFault: { attempts: StoredEdit[] } }).templateEditFault.attempts);
  assert.ok(retriedEdit.length >= 2); for (const attempt of retriedEdit) { assert.deepEqual(attempt.batch, failedEdit[0].batch); assert.deepEqual(attempt.history, failedEdit[0].history); }
  const edited = await observed(page, firstId); assert.equal((edited.snapshot as MarkdownSnapshot).content, 'Edited custom body');
  phase = 'copy-current-and-insert';
  await modal.getByRole('button', { name: 'コピーして作成', exact: true }).click();
  await modal.getByLabel('テンプレート名', { exact: true }).fill('Custom copy');
  await modal.getByRole('button', { name: 'テンプレートを保存', exact: true }).click(); await select.waitFor();
  const copyId = await select.inputValue(); assert.ok(copyId && copyId !== firstId);
  assert.equal(((await observed(page, copyId)).snapshot as MarkdownSnapshot).content, 'Edited custom body');
  await modal.getByRole('button', { name: '現在のノートから作成', exact: true }).click();
  await modal.getByLabel('テンプレート名', { exact: true }).fill('From current');
  await modal.getByRole('button', { name: 'テンプレートを保存', exact: true }).click(); await select.waitFor();
  const currentId = await select.inputValue(); assert.ok(currentId && currentId !== copyId);
  assert.equal(((await observed(page, currentId)).snapshot as MarkdownSnapshot).content, 'Original note');
  await modal.getByRole('button', { name: 'ノートに追加', exact: true }).click(); await modal.waitFor({ state: 'hidden' });
  await ordinaryMarkdownSaved(page, noteId, 'Original note\n\nOriginal note\n', 2);
  assert.match(await editor.innerText(), /Original note[\s\S]*Original note/);
  await page.getByRole('button', { name: '\u30c6\u30f3\u30d7\u30ec\u30fc\u30c8\u3092\u4f7f\u3046', exact: true }).click(); await modal.waitFor();
  await waitTemplateReady(page, currentId, 'Original note');
  phase = 'edited-original-loading-and-insert';
  // Hold a real readonly consumer behind a no-write IDB transaction to make
  // asynchronous selection observable without a sleep or a fake result.
  await holdTemplateReads(page);
  try {
    await select.selectOption(firstId);
    await page.waitForFunction(id => {
      const selected = document.querySelector<HTMLSelectElement>('[role="dialog"] [aria-label="\u30c6\u30f3\u30d7\u30ec\u30fc\u30c8"]');
      return selected?.value === id && selected.disabled;
    }, firstId);
    assert.equal(await modal.locator('pre').count(), 0, 'previous body must not be shown as the newly selected template');
    await modal.getByRole('status').filter({ hasText: '\u30c6\u30f3\u30d7\u30ec\u30fc\u30c8\u3092\u8aad\u307f\u8fbc\u3093\u3067\u3044\u307e\u3059\u2026' }).waitFor();
    assert.equal(await modal.getByRole('button', { name: '\u30ce\u30fc\u30c8\u306b\u8ffd\u52a0', exact: true }).isDisabled(), true);
    assert.equal(await modal.getByRole('button', { name: '\u30b3\u30d4\u30fc\u3057\u3066\u4f5c\u6210', exact: true }).isDisabled(), true);
  } finally {
    assert.equal(await page.evaluate(() => (window as unknown as { templateReadHold: { release(): Promise<string> } }).templateReadHold.release()), 'complete');
  }
  await waitTemplateReady(page, firstId, 'Edited custom body');
  assert.equal(((await observed(page, firstId)).snapshot as MarkdownSnapshot).content, 'Edited custom body');
  await modal.getByRole('button', { name: '\u30ce\u30fc\u30c8\u306b\u8ffd\u52a0', exact: true }).click(); await modal.waitFor({ state: 'hidden' });
  await ordinaryMarkdownSaved(page, noteId, 'Original note\n\nOriginal note\n\nEdited custom body\n', 3);
  await page.getByRole('button', { name: '\u30c6\u30f3\u30d7\u30ec\u30fc\u30c8\u3092\u4f7f\u3046', exact: true }).click(); await modal.waitFor();
  await select.selectOption(currentId); await waitTemplateReady(page, currentId, 'Original note');
  phase = 'delete-and-restart';
  await modal.getByRole('button', { name: '削除', exact: true }).click();
  await modal.getByRole('button', { name: '削除を確定', exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('[aria-label="テンプレート"]') as HTMLSelectElement | null)?.value === '');
  assert.equal(((await observed(page, currentId)).snapshot as MarkdownSnapshot).content, 'Original note');
  await modal.getByRole('button', { name: '閉じる', exact: true }).click();
  const reopened = await app.restart(title); const after = await observed(reopened, noteId);
  assert.equal(after.snapshot.kind, 'markdown'); assert.equal((after.snapshot as MarkdownSnapshot).content, 'Original note\n\nOriginal note\n\nEdited custom body\n');
  assert.equal(((await observed(reopened, copyId)).snapshot as MarkdownSnapshot).content, 'Edited custom body');
  const catalog = await observed(reopened, JSON.parse(after.scope)[1]); assert.equal(catalog.snapshot.kind, 'library');
  const library = catalog.snapshot as LibrarySnapshot;
  assert.ok(library.deletions.some(record => record.active && record.itemIds.includes(currentId)));
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, error: String(error), alerts: await page.getByRole('alert').allTextContents().catch(() => []),
      dialogs: await page.getByRole('dialog').allTextContents().catch(() => []), body: await page.locator('body').innerText().catch(() => '') }));
    throw error;
  }
});

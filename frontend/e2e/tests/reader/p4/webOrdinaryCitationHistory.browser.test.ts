// Ordinary UI quote production, stored citation navigation, and recovery.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import type { StoredEdit } from '../../../../src/runtime/edits/repository.ts';
import { parseMarkdownCitationUri } from '../../../../src/runtime/markdown/markdownCitations.ts';
import { ordinarySaved, ordinarySnapshot } from '../../../support/ordinaryDocument.ts';
import { ordinaryMarkdown, ordinaryMarkdownSaved, ordinaryMarkdownSnapshot } from '../../../support/ordinaryMarkdown.ts';
import { committed } from '../p2/ordinaryStorage.ts';
import { ordinaryWeb } from '../p2/ordinaryWeb.ts';


async function openItem(page: Page, title: string) {
  const toggle = page.getByRole('button', { name: '\u8cc7\u6599\u4e00\u89a7', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
}
async function produceQuote(page: Page, surface: 'original' | 'translated', noteId: string) {
  await page.getByRole('button', { name: surface === 'original' ? '\u539f\u6587' : '\u8a33\u6587', exact: true }).click();
  const number = page.getByLabel('\u30da\u30fc\u30b8\u756a\u53f7', { exact: true });
  await number.fill('2'); await number.press('Enter');
  await page.getByRole('button', { name: '\u8aad\u3080', exact: true }).click();
  const pane = page.locator(`[data-reader-surface="${surface}"]`);
  const layer = pane.locator('.react-pdf__Page[data-page-number="2"] .textLayer[tabindex="0"]');
  await pane.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="2"] canvas').waitFor();
  await layer.locator('span[role="presentation"]').first().waitFor();
  await layer.focus(); assert.equal(await layer.evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Enter');
  const live = page.locator('[data-managed-pdf-selection-overlay] [aria-live="polite"]');
  await live.filter({ hasText: '\u672c\u6587\u306e\u9078\u629e\u64cd\u4f5c\u3092\u958b\u59cb\u3057\u307e\u3057\u305f' }).waitFor({ state: 'attached' });
  for (let index = 0; index < 8; index++) await page.keyboard.press('Shift+ArrowRight');
  await live.filter({ hasText: /^8\u6587\u5b57\u3092\u9078\u629e\u3057\u307e\u3057\u305f/ }).waitFor({ state: 'attached' });
  await page.getByRole('button', { name: '\u9078\u629e\u3057\u305f\u6587\u7ae0\u3092\u30ce\u30fc\u30c8\u3078\u8ffd\u52a0', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '\u5f15\u7528\u3092\u30ce\u30fc\u30c8\u3078\u8ffd\u52a0', exact: true });
  await dialog.getByLabel('\u8ffd\u52a0\u5148\u306e\u30ce\u30fc\u30c8', { exact: true }).selectOption(noteId);
  await dialog.getByRole('button', { name: '\u30ce\u30fc\u30c8\u3078\u8ffd\u52a0', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: '\u30ce\u30fc\u30c8\u306b\u8ffd\u52a0\u3057\u307e\u3057\u305f' }).waitFor();
  const deadline = Date.now() + 30_000;
  for (;;) {
    const stored = await ordinaryMarkdown(page, noteId), snapshot = ordinaryMarkdownSnapshot(stored);
    const appends = stored.edits.filter(edit => edit.batch.kind === 'markdown' && edit.batch.appendId);
    if (stored.intents.length === 0 && appends.length === 1 && stored.edits.length === 1 && stored.edits.every(edit => edit.receipt.durable && edit.history)) {
      assert.equal(snapshot.appendIds.length, 1);
      if (appends[0].batch.kind !== 'markdown') throw new Error('ordinary append batch required');
      assert.equal(snapshot.appendIds[0], appends[0].batch.appendId);
      const links = snapshot.content.match(/papeer:\/\/citation\/[^\s)]+/g); assert.equal(links?.length, 1);
      const uri = links![0], target = parseMarkdownCitationUri(uri); assert.ok(target?.anchor);
      await dialog.getByRole('button', { name: '\u9589\u3058\u308b', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      return { stored, snapshot, uri, target };
    }
    assert.ok(Date.now() < deadline, 'actual quote append did not become durable exactly once'); await delay(50);
  }
}


async function leaveDuringCitationRead(page: Page, namespace: string, targetId: string, libraryTitle: string, noteId: string, expectedNote: Awaited<ReturnType<typeof ordinaryMarkdown>>) {
  await page.evaluate(({ namespace, targetId }) => {
    const marked = new WeakSet<IDBTransaction>(), descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    if (!descriptor?.get || !descriptor.set) throw new Error('real IDB completion descriptor required');
    const get = IDBObjectStore.prototype.get, probe = { armed: false, waiting: false, completed: false, release: null as null | (() => void) };
    (globalThis as unknown as { citationReadProbe: typeof probe }).citationReadProbe = probe;
    IDBObjectStore.prototype.get = function(key: IDBValidKey | IDBKeyRange) {
      if (probe.armed && this.transaction.mode === 'readonly' && this.name === 'roots' && typeof key === 'string') {
        try { const parts = JSON.parse(key) as string[]; if (parts[0] === namespace && parts[1] === targetId) marked.add(this.transaction); } catch { /* unrelated key */ }
      }
      return get.call(this, key);
    };
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { configurable: descriptor.configurable, enumerable: descriptor.enumerable, get: descriptor.get,
      set: function(this: IDBTransaction, handler: ((event: Event) => unknown) | null) {
        const transaction = this;
        descriptor.set!.call(transaction, handler ? function(this: IDBTransaction, event: Event) {
          if (probe.armed && marked.has(transaction)) {
            probe.armed = false; probe.waiting = true;
            probe.release = () => { probe.waiting = false; handler.call(transaction, event); probe.completed = true; }; return;
          }
          handler.call(transaction, event);
        } : null);
      } });
  }, { namespace, targetId });
  return async (link: import('playwright-core').Locator) => {
    await page.evaluate(() => { (globalThis as unknown as { citationReadProbe: { armed: boolean } }).citationReadProbe.armed = true; });
    await link.click();
    await page.waitForFunction(() => (globalThis as unknown as { citationReadProbe: { waiting: boolean } }).citationReadProbe.waiting);
    await page.getByRole('status').filter({ hasText: '\u8cc7\u6599\u3092\u958b\u3044\u3066\u3044\u307e\u3059' }).waitFor();
    await page.getByRole('button', { name: '\u30e9\u30a4\u30d6\u30e9\u30ea\u3092\u5207\u308a\u66ff\u3048\u308b', exact: true }).click();
    // Scope close drains the pending real read before admitting another Library.
    await page.getByRole('status').filter({ hasText: /^ライブラリの変更を確認しています。編集は一時停止しています。$/ }).waitFor();
    assert.deepEqual(await page.evaluate(() => {
      const probe = (globalThis as unknown as { citationReadProbe: { waiting: boolean; completed: boolean } }).citationReadProbe;
      return { waiting: probe.waiting, completed: probe.completed };
    }), { waiting: true, completed: false });
    assert.equal(await page.getByLabel('\u65b0\u3057\u3044\u30e9\u30a4\u30d6\u30e9\u30ea\u306e\u540d\u524d').isVisible(), false);
    await page.evaluate(async () => {
      const probe = (globalThis as unknown as { citationReadProbe: { release: null | (() => void); completed: boolean } }).citationReadProbe;
      if (!probe.release || probe.completed) throw new Error('pending real target read required'); probe.release();
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await page.waitForFunction(() => (globalThis as unknown as { citationReadProbe: { completed: boolean } }).citationReadProbe.completed);
    await page.getByLabel('\u65b0\u3057\u3044\u30e9\u30a4\u30d6\u30e9\u30ea\u306e\u540d\u524d').waitFor();
    await page.getByLabel('\u65b0\u3057\u3044\u30e9\u30a4\u30d6\u30e9\u30ea\u306e\u540d\u524d').fill(libraryTitle);
    await page.getByRole('button', { name: '\u4f5c\u6210', exact: true }).click();
    await page.getByRole('button', { name: '\u78ba\u8a8d\u3057\u307e\u3057\u305f', exact: true }).click();
    await page.getByRole('button', { name: libraryTitle, exact: true }).click();
    await page.getByText('\u8cc7\u6599\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-content-document]:not([data-content-document=""])').count(), 0, 'drained old scope completion must not select any target in the new Library');
    assert.equal(await page.getByRole('heading', { name: 'citation-source.pdf', exact: true }).count(), 0);
    const evidence = await page.evaluate(async ({ namespace, noteId, libraryTitle }) => {
      type Row<T> = { key: string; scope: string; value: T };
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('papeer-shared-edits');
        request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing database required')); };
        request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
      });
      try { return await new Promise<{ identity: { libraryId: string }; old: { root: unknown; edits: StoredEdit[]; intents: unknown[] } }>((resolve, reject) => {
        const tx = db.transaction(['canonicalProfiles', 'roots', 'edits', 'intents'], 'readonly');
        const profiles = tx.objectStore('canonicalProfiles').getAll(), roots = tx.objectStore('roots').getAll(), edits = tx.objectStore('edits').getAll(), intents = tx.objectStore('intents').getAll();
        tx.onabort = () => reject(tx.error);
        tx.oncomplete = () => {
          const profile = (profiles.result as Row<{ title: string; identity: { libraryId: string } }>[]).filter(row => row.value.title === libraryTitle);
          const root = (roots.result as Row<{ id: string }>[]).find(row => row.scope === namespace && row.value.id === noteId);
          if (profile.length !== 1 || !root) { reject(new Error('new UI Library or retained note absent')); return; }
          resolve({ identity: profile[0].value.identity, old: { root: root.value,
            edits: (edits.result as Row<StoredEdit>[]).filter(row => row.scope === namespace && row.value.batch.targetId === noteId).map(row => row.value),
            intents: (intents.result as Row<unknown>[]).filter(row => row.scope === namespace && JSON.parse(row.key)[1] === noteId).map(row => row.value) } });
        };
      }); } finally { db.close(); }
    }, { namespace, noteId, libraryTitle });
    assert.notEqual(evidence.identity.libraryId, JSON.parse(namespace)[1]);
    assert.deepEqual(evidence.old, { root: expectedNote.root, edits: expectedNote.edits, intents: expectedNote.intents }, 'drained completion cannot mutate the old note/receipt/intent graph');

    await page.getByText('\u8cc7\u6599\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002', { exact: true }).waitFor();
  };
}

for (const engine of ['chromium', 'webkit'] as const) for (const surface of ['original', 'translated'] as const)
  test(`ordinary Markdown citation ${surface} keeps its target through document history (${engine})`, { timeout: 240_000 }, async t => {
    const app = await ordinaryWeb(t, engine); let page = app.page; let phase = 'pdf-import';
    const started = Date.now(), events: { ms: number; type: string; url?: string; detail?: string }[] = [];
    const noteEvent = (event: { type: string; url?: string; detail?: string }) => { if (events.length < 300) events.push({ ms: Date.now() - started, ...event }); };
    page.on('requestfailed', request => noteEvent({ type: 'requestfailed', url: request.url(), detail: request.failure()?.errorText }));
    page.on('response', response => { if (response.status() >= 400) noteEvent({ type: 'http-error', url: response.url(), detail: String(response.status()) }); });
    page.on('console', message => { if (message.type() === 'error') noteEvent({ type: 'console-error', detail: message.text() }); });
    page.on('pageerror', error => noteEvent({ type: 'page-error', detail: error.stack ?? String(error) }));
    try {
      const root = path.resolve(import.meta.dirname, '../../../../..'), file = path.join(app.scratch, 'citation-source.pdf');
      const authored = spawnSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'frontend/e2e/fixtures/p2PdfNavigation.py'), file], { encoding: 'utf8', windowsHide: true });
      assert.equal(authored.status, 0, authored.stderr);
      await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(file); noteEvent({ type: 'file-selected' });
      await page.getByRole('heading', { name: 'citation-source.pdf', exact: true }).waitFor();
      noteEvent({ type: 'pdf-heading-visible' });
      const documentId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(documentId);
      await page.getByRole('button', { name: '資料一覧', exact: true }).click();
      const original = await committed(page, documentId), ids = original.root.pages.map(p => p.id); assert.equal(ids.length, 2);
      const chooser = page.waitForEvent('filechooser'); await page.getByLabel('取り込む訳文PDF', { exact: true }).click();
      await (await chooser).setFiles(file);
      for (let i = 0; i < ids.length; i++) await page.getByLabel(`訳文${i + 1}ページに対応する原文ページ`, { exact: true }).selectOption(ids[i]);
      await page.getByRole('button', { name: '訳文PDFを登録する', exact: true }).click();
      await page.getByRole('button', { name: '訳文PDFの取込を取り消す', exact: true }).waitFor({ state: 'hidden' });
      const mapped = await ordinarySaved(page, documentId, 1), document = ordinarySnapshot(mapped);
      const targetPage = surface === 'original' ? document.pages[1] : document.translation!.pages[1];
      phase = 'note-and-link';
      const toggle = page.getByRole('button', { name: '資料一覧', exact: true });
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      const noteTitle = `Citation note ${surface} ${engine}`;
      await page.getByLabel('新しい資料の名前', { exact: true }).fill(noteTitle);
      await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
      await page.getByRole('button', { name: '資料を作成', exact: true }).click();
      await page.getByRole('heading', { name: noteTitle, exact: true }).waitFor();
      const noteId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(noteId && noteId !== documentId);
      if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();

      await openItem(page, 'citation-source.pdf');
      phase = 'real-quote-producer';
      const produced = await produceQuote(page, surface, noteId), uri = produced.uri, content = produced.snapshot.content, saved = produced.stored;
      assert.equal(produced.target.libraryId, original.identity.libraryId);
      assert.equal(produced.target.documentId, documentId); assert.equal(produced.target.pageId, targetPage.id);
      assert.equal(produced.target.backgroundRevision, targetPage.backgroundRevision); assert.equal(produced.target.surface, surface);
      assert.ok(produced.target.anchor && produced.target.anchor.xPt >= 0 && produced.target.anchor.xPt <= targetPage.widthPt
        && produced.target.anchor.yPt >= 0 && produced.target.anchor.yPt <= targetPage.heightPt);
      assert.deepEqual(await committed(page, documentId), mapped, 'quoting never edits the PDF');
      await openItem(page, noteTitle);
      assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), noteId);
      if (surface === 'translated') {
        await page.getByRole('button', { name: '\u53f3\u5074\u3067\u7de8\u96c6', exact: true }).click();
        await page.getByRole('complementary', { name: '\u53f3\u5074\u306e\u7de8\u96c6', exact: true }).waitFor();
      }
      await page.getByRole('button', { name: '\u30d7\u30ec\u30d3\u30e5\u30fc', exact: true }).click();
      const preview = surface === 'translated' ? page.getByRole('complementary', { name: '\u53f3\u5074\u306e\u7de8\u96c6', exact: true }) : page.getByRole('region', { name: '\u4e2d\u592e\u306e\u7de8\u96c6', exact: true });
      const link = preview.locator(`a[href="${uri}"]`); await link.waitFor(); assert.equal(await link.count(), 1);
      phase = 'citation-back-forward';
      await link.click(); await page.getByRole('heading', { name: 'citation-source.pdf', exact: true }).waitFor();
      await page.locator(`[data-reader-surface="${surface}"] [data-rendered="true"] .react-pdf__Page[data-page-number="2"] canvas`).waitFor();
      const expectedPlace = { documentId, surface, pageId: targetPage.id, x: produced.target.anchor!.xPt / targetPage.widthPt, y: produced.target.anchor!.yPt / targetPage.heightPt };
      await page.waitForFunction(expected => Object.keys(localStorage).some(key => {
        if (!key.startsWith('paper-desk.reader.v1:')) return false;
        const parts = JSON.parse(key.slice('paper-desk.reader.v1:'.length)); if (parts[3] !== expected.documentId) return false;
        const value = JSON.parse(localStorage.getItem(key)!); const landing = value.landing;
        return value.activeSurface === expected.surface && value.surfacePageId === expected.pageId
          && Math.abs((landing?.place?.x ?? -1) - expected.x) < 1e-7 && Math.abs((landing?.place?.y ?? -1) - expected.y) < 1e-7;
      }), expectedPlace);
      assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), documentId);
      assert.deepEqual(await committed(page, documentId), mapped);
      await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
      await page.getByRole('heading', { name: noteTitle, exact: true }).waitFor();
      if (surface === 'translated') await page.getByRole('complementary', { name: '右側の編集', exact: true }).waitFor();
      else assert.equal(await page.getByRole('complementary', { name: '右側の編集', exact: true }).count(), 0);
      assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), noteId);
      await page.getByRole('button', { name: '次の資料に進む', exact: true }).click();
      await page.getByRole('heading', { name: 'citation-source.pdf', exact: true }).waitFor();
      await page.locator(`[data-reader-surface="${surface}"] [data-rendered="true"] .react-pdf__Page[data-page-number="2"] canvas`).waitFor();
      await page.waitForFunction(expected => Object.keys(localStorage).some(key => {
        if (!key.startsWith('paper-desk.reader.v1:')) return false;
        const parts = JSON.parse(key.slice('paper-desk.reader.v1:'.length)); if (parts[3] !== expected.documentId) return false;
        const value = JSON.parse(localStorage.getItem(key)!); const landing = value.landing;
        return value.activeSurface === expected.surface && value.surfacePageId === expected.pageId
          && Math.abs((landing?.place?.x ?? -1) - expected.x) < 1e-7 && Math.abs((landing?.place?.y ?? -1) - expected.y) < 1e-7;
      }), expectedPlace);
      assert.deepEqual(await committed(page, documentId), mapped);
      await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
      await page.getByRole('heading', { name: noteTitle, exact: true }).waitFor();
      phase = 'dirty-abort-and-retry';
      const editButton = page.getByRole('button', { name: '編集', exact: true });
      if (await editButton.isVisible()) await editButton.click();
      const currentEditor = page.getByRole('textbox', { name: 'Markdownノート', exact: true }); await currentEditor.waitFor();
      await page.evaluate(({ namespace, noteId }) => {
        const probe: { enabled: boolean; attempts: StoredEdit[] } = { enabled: true, attempts: [] };
        (globalThis as unknown as { citationFault: typeof probe }).citationFault = probe;
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
          const row = value as { scope?: string; value?: StoredEdit };
          if (this.name === 'edits' && row.scope === namespace && row.value?.batch.targetId === noteId) {
            probe.attempts.push(structuredClone(row.value)); if (probe.enabled) { this.transaction.abort(); throw new DOMException('citation guard abort', 'AbortError'); }
          }
          return key === undefined ? put.call(this, value) : put.call(this, value, key);
        };
      }, { namespace: saved.namespace, noteId });
      const dirty = `${content}\nheld draft`; await currentEditor.fill(dirty);
      await page.getByRole('button', { name: 'プレビュー', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '入力内容を保持しています' }).waitFor();
      await link.click();
      await page.getByRole('alert').filter({ hasText: '入力を確定または取り消し' }).waitFor();
      assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), noteId);
      const failed = await ordinaryMarkdown(page, noteId); assert.equal(failed.intents.length, 1); assert.equal(failed.edits.length, 1);
      const attempts = await page.evaluate(() => (globalThis as unknown as { citationFault: { attempts: StoredEdit[] } }).citationFault.attempts); assert.ok(attempts.length > 0);
      const retry = page.getByRole('alert').filter({ hasText: '入力内容を保持しています' }).getByRole('button', { name: '再試行', exact: true });
      await retry.evaluate(button => button.addEventListener('click', () => { (globalThis as unknown as { citationFault: { enabled: boolean } }).citationFault.enabled = false; }, { capture: true, once: true }));
      await retry.click(); const recovered = await ordinaryMarkdownSaved(page, noteId, dirty, 2);
      assert.ok(recovered.edits.some(edit => edit.batch.id === attempts[0].batch.id));
      for (const attempt of attempts) assert.deepEqual(attempt.batch, attempts[0].batch, 'every retry uses the exact pending batch');
      await link.click();
      await page.getByRole('heading', { name: 'citation-source.pdf', exact: true }).waitFor();
      phase = 'cold-restart-emitted-citation';
      page = await app.restart(noteTitle);
      assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), noteId);
      assert.deepEqual(await ordinaryMarkdownSaved(page, noteId, dirty, 2), recovered);
      assert.ok(ordinaryMarkdownSnapshot(recovered).content.includes(uri));
      assert.deepEqual(await committed(page, documentId), mapped);

      if (surface === 'original') {
        phase = 'old-scope-read-completion';
        const previewButton = page.getByRole('button', { name: '\u30d7\u30ec\u30d3\u30e5\u30fc', exact: true });
        if (await previewButton.isVisible()) await previewButton.click();
        const oldLink = page.getByRole('region', { name: '\u4e2d\u592e\u306e\u7de8\u96c6', exact: true }).locator(`a[href="${uri}"]`); await oldLink.waitFor();
        const runScopeTransition = await leaveDuringCitationRead(page, recovered.namespace, documentId, `Citation new scope ${engine}`, noteId, recovered);
        await runScopeTransition(oldLink);
      }
    } catch (error) {
      const observation = await page.evaluate(async () => {
        const result: { url: string; ready: string; contentId: string | null; resources: { name: string; duration: number; responseEnd: number }[]; storage?: unknown; storageError?: string } = {
          url: location.href, ready: document.readyState, contentId: document.querySelector('[data-content-document]')?.getAttribute('data-content-document') ?? null,
          resources: performance.getEntriesByType('resource').map(entry => ({ name: entry.name, duration: entry.duration, responseEnd: (entry as PerformanceResourceTiming).responseEnd })).slice(-100),
        };
        try {
          const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('papeer-shared-edits');
            request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('database absent')); }; request.onblocked = () => reject(new Error('database blocked'));
            request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result); });
          try { result.storage = await new Promise((resolve, reject) => { const tx = db.transaction(['roots', 'edits', 'resources', 'intents'], 'readonly');
            const roots = tx.objectStore('roots').getAll(), edits = tx.objectStore('edits').getAll(), resources = tx.objectStore('resources').getAll(), intents = tx.objectStore('intents').getAll();
            tx.onabort = () => reject(tx.error); tx.oncomplete = () => resolve({ roots: roots.result.map((row: { value: { id: string; kind: string } }) => ({ id: row.value.id, kind: row.value.kind })),
              edits: edits.result.map((row: { value: { batch: { id: string; targetId: string; kind: string }; receipt?: { durable: boolean } } }) => ({ id: row.value.batch.id, targetId: row.value.batch.targetId, kind: row.value.batch.kind, durable: row.value.receipt?.durable })),
              resources: resources.result.map((row: { value: { id: string; sha256: string; mediaType: string } }) => ({ id: row.value.id, sha256: row.value.sha256, mediaType: row.value.mediaType })), intentCount: intents.result.length }); }); }
          finally { db.close(); }
        } catch (cause) { result.storageError = String(cause); }
        return result;
      }).catch(cause => ({ observationError: String(cause) }));
      t.diagnostic(JSON.stringify({ phase, elapsedMs: Date.now() - started, error: String(error), events, observation,
        alerts: await page.getByRole('alert').allTextContents().catch(() => []), body: await page.locator('body').innerText().catch(() => '') }));
      throw error;
    }
  });

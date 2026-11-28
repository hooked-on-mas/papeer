import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { EditGraph } from '../../../../src/runtime/edits/editGraph.ts';
import type { Page as CanonicalPage, TranslationState } from '../../../../src/runtime/edits/contracts.ts';
import { committed } from './ordinaryStorage.ts';
import { ordinaryWeb } from './ordinaryWeb.ts';

const pane = (page: Page, side: 'original' | 'translated') => page.locator(`[data-reader-surface="${side}"]`);
const reference = (page: Page) => page.locator('[data-reader-reference]');
const searchStatus = (page: Page, text: RegExp) => page.getByRole('status').filter({ hasText: text });
const pageContent = ({ annotationVersion: _annotationVersion, ...page }: CanonicalPage) => page;
const translatedContent = ({ annotationVersion: _annotationVersion, lifecycleVersion: _lifecycleVersion, ...page }: CanonicalPage) => page;
const translationContent = (value: TranslationState) => ({ pages: value.pages.map(translatedContent), bindings: value.bindings });
async function snapshot(page: Page, id: string, count: number) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await committed(page, id);
    if (value.edits.length === count && !value.pendingIntents && value.edits.every(edit => edit.receipt.durable)) {
      await page.getByRole('status').filter({ hasText: /^端末保存済み/ }).first().waitFor();
      const graph = new EditGraph({ version: 1, libraryId: value.identity.libraryId, root: value.root, batches: value.edits.map(edit => edit.batch) });
      const heads = graph.getView().heads; assert.equal(heads.length, 1);
      const document = graph.snapshot(heads[0]); assert.ok(document?.kind === 'document');
      return { ...value, document };
    }
    assert.ok(Date.now() < deadline, `expected exactly ${count} durable edits`); await delay(50);
  }
}
async function jump(page: Page, number: number) {
  const input = page.getByLabel('ページ番号', { exact: true });
  await input.fill(String(number)); await input.press('Enter');
  assert.equal(await input.inputValue(), String(number));
}
async function mapPdf(page: Page, file: string, destinations: [string, string]) {
  const choosing = page.waitForEvent('filechooser');
  await page.getByLabel('取り込む訳文PDF', { exact: true }).click();
  await (await choosing).setFiles(file);
  for (const [index, value] of destinations.entries())
    await page.getByLabel(`訳文${index + 1}ページに対応する原文ページ`, { exact: true }).selectOption(value);
  const region = page.getByRole('region', { name: '訳文PDFの取込', exact: true });
  await region.getByRole('button', { name: /訳文PDFを(?:登録する|入れ替える)/ }).click();
}
type Reads = Record<string, number>;
async function observeReads(page: Page) {
  await page.evaluate(() => {
    const reads: Reads = {};
    (globalThis as unknown as { completionPdfReads: Reads }).completionPdfReads = reads;
    const original = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === 'resources' && typeof key === 'string') {
        const id = (JSON.parse(key) as string[])[1]; reads[id] = (reads[id] ?? 0) + 1;
      }
      return original.call(this, key);
    };
  });
}
async function pendingQuery(page: Page, resourceId: string, query: string) {
  const previous = await page.evaluate(id => (globalThis as unknown as { completionPdfReads: Reads }).completionPdfReads[id] ?? 0, resourceId);
  await page.getByLabel('PDF本文検索', { exact: true }).fill(query);
  await searchStatus(page, /^検索中…$/).waitFor();
  await page.waitForFunction(({ id, previous }) => ((globalThis as unknown as { completionPdfReads: Reads }).completionPdfReads[id] ?? 0) > previous,
    { id: resourceId, previous });
  assert.equal(await searchStatus(page, /^検索中…$/).count(), 1, 'the actual old-pool query remains pending after starting its resource read');
}
async function expectReference(page: Page, id: string, revision: string) {
  await reference(page).locator(`[data-canonical-page="${id}"][data-background-revision="${revision}"] .react-pdf__Page__canvas`).waitFor();
  assert.equal(await reference(page).locator('[data-ink-overlay], [aria-label$="書き込みレイヤー"]').count(), 0);
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary translation pool cancellation, ambiguous/empty mapping and pinned identity (${engine})`, { timeout: 300_000 }, async t => {
  const app = await ordinaryWeb(t, engine); let page = app.page;
  const root = path.resolve(import.meta.dirname, '../../../../..');
  let phase = 'file-authoring';
  try {
    for (const [generator, argument] of [
      ['p2PdfNavigationFailures.py', app.scratch], ['p2PdfNavigation.py', path.join(app.scratch, 'translated.pdf')],
    ]) {
      const generated = spawnSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'frontend/e2e/fixtures', generator), argument], { encoding: 'utf8', windowsHide: true });
      assert.equal(generated.status, 0, generated.stderr);
    }
    phase = 'original-import';
    await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(path.join(app.scratch, 'navigation-failures.pdf'));
    await page.getByRole('heading', { name: 'navigation-failures.pdf', exact: true }).waitFor();
    const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
    const catalog = page.getByRole('button', { name: '資料一覧', exact: true });
    if (await catalog.getAttribute('aria-expanded') === 'true') await catalog.click();
    const initial = await snapshot(page, id, 0); assert.equal(initial.document.pages.length, 32);
    const originals = initial.document.pages;
    assert.equal(originals[0].background.kind, 'pdf');
    if (originals[0].background.kind !== 'pdf') throw new Error('PDF required');
    const originalResource = originals[0].background.resourceId;
    phase = 'sparse-mapping';
    await mapPdf(page, path.join(app.scratch, 'translated.pdf'), [originals[0].id, originals[31].id]);
    const mapped = await snapshot(page, id, 1); assert.ok(mapped.document.translation);
    const originalTranslation = mapped.document.translation, translated = originalTranslation.pages;
    assert.equal(translated[0].background.kind, 'pdf');
    if (translated[0].background.kind !== 'pdf') throw new Error('translated PDF required');
    const translatedResource = translated[0].background.resourceId;
    await page.getByRole('button', { name: '読む', exact: true }).click();
    await page.getByRole('button', { name: '本文検索', exact: true }).click();
    await observeReads(page);
    phase = 'original-pending-to-translated';
    await pendingQuery(page, originalResource, 'OldNeedle');
    await page.getByRole('button', { name: '訳文', exact: true }).click();
    await searchStatus(page, /^0件$/).waitFor();
    assert.equal(await page.getByRole('button', { name: '次の結果', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('[data-pdf-search-hit]').count(), 0);
    await page.getByLabel('PDF本文検索', { exact: true }).fill('反復検索');
    await searchStatus(page, /^4件$/).waitFor();
    await page.getByRole('button', { name: '次の結果', exact: true }).click();
    await pane(page, 'translated').locator('[data-pdf-search-hit]').first().waitFor();
    await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).click();
    await expectReference(page, translated[0].id, translated[0].backgroundRevision);
    phase = 'translated-pending-to-original';
    await pendingQuery(page, translatedResource, '反復検索 upper');
    await page.getByRole('button', { name: '原文', exact: true }).click();
    await searchStatus(page, /^0件$/).waitFor();
    assert.equal(await page.locator('[data-pdf-search-hit]').count(), 0);
    await expectReference(page, translated[0].id, translated[0].backgroundRevision);
    await page.getByLabel('PDF本文検索', { exact: true }).fill('OldNeedle');
    await searchStatus(page, /^32件$/).waitFor();
    await page.getByRole('button', { name: '次の結果', exact: true }).click();
    await pane(page, 'original').locator('[data-pdf-search-hit]').first().waitFor();
    assert.equal(await reference(page).locator('[data-pdf-search-hit]').count(), 0);
    phase = 'sparse-filter-pin';
    await page.getByLabel('訳文があるページだけ', { exact: true }).check();
    await page.getByRole('button', { name: '次のページ', exact: true }).click();
    assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '32');
    await expectReference(page, translated[0].id, translated[0].backgroundRevision);
    await page.getByLabel('訳文があるページだけ', { exact: true }).uncheck();
    await jump(page, 2);
    await page.getByRole('button', { name: '訳文', exact: true }).click();
    await pane(page, 'translated').getByRole('status').filter({ hasText: 'このページの訳文はまだありません' }).waitFor();
    await expectReference(page, translated[0].id, translated[0].backgroundRevision);
    assert.deepEqual((await snapshot(page, id, 1)).edits, mapped.edits, 'reading/filter/pool changes do not add content edits');
    await page.getByRole('button', { name: '原文', exact: true }).click(); await jump(page, 1);
    phase = 'ambiguous-replacement';
    await mapPdf(page, path.join(app.scratch, 'translated.pdf'), [originals[0].id, originals[0].id]);
    const ambiguous = await snapshot(page, id, 2); assert.ok(ambiguous.document.translation);
    assert.equal(ambiguous.document.translation.bindings[0].candidates.length, 2);
    assert.ok(ambiguous.document.translation.pages.every(p => !translated.some(old => old.id === p.id || old.backgroundRevision === p.backgroundRevision)));
    await reference(page).getByRole('status').filter({ hasText: '固定されたページを表示できません' }).waitFor();
    await page.getByText(`参照固定中：訳文・${translated[0].id}（この閲覧中）`, { exact: true }).waitFor();
    await page.getByRole('button', { name: '訳文', exact: true }).click();
    await pane(page, 'translated').getByRole('status').filter({ hasText: '対応する訳文が複数あるため' }).waitFor();
    await page.getByLabel('訳文があるページだけ', { exact: true }).check();
    assert.equal(await page.getByRole('button', { name: '次のページ', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '前のページ', exact: true }).isDisabled(), true);
    phase = 'ambiguous-undo';
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    const restored = await snapshot(page, id, 3);
    assert.ok(restored.document.translation);
    assert.deepEqual(translationContent(restored.document.translation), translationContent(originalTranslation));
    assert.notEqual(restored.document.translation.revision, originalTranslation.revision);
    assert.equal(restored.document.translation.revision, restored.document.version);
    assert.ok(restored.document.translation.pages.every(p => p.lifecycleVersion === restored.document.version));
    // Undo revives the exact page/background/resource contents under a new
    // lifecycle. The old explicit pin must not silently bind to that new lifetime.
    await reference(page).getByRole('status').filter({ hasText: '固定されたページを表示できません' }).waitFor();
    await page.getByText(`参照固定中：訳文・${translated[0].id}（この閲覧中）`, { exact: true }).waitFor();
    await pane(page, 'translated').locator(`[data-canonical-page="${translated[0].id}"] .react-pdf__Page__canvas`).waitFor();
    await page.getByRole('button', { name: '現在のページに置き換える', exact: true }).click();
    await expectReference(page, translated[0].id, translated[0].backgroundRevision);
    await page.getByRole('button', { name: '固定を解除', exact: true }).click();
    await page.getByRole('button', { name: '原文', exact: true }).click(); await jump(page, 1);
    await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).click();
    await expectReference(page, originals[0].id, originals[0].backgroundRevision);
    phase = 'unmapped-empty-filter';
    await page.getByLabel('訳文があるページだけ', { exact: true }).check();
    await mapPdf(page, path.join(app.scratch, 'translated.pdf'), ['none', 'none']);
    const unmapped = await snapshot(page, id, 4); assert.ok(unmapped.document.translation);
    assert.deepEqual(unmapped.document.translation.bindings, []);
    await page.getByRole('button', { name: '訳文', exact: true }).click();
    await pane(page, 'translated').getByRole('status').filter({ hasText: 'このページの訳文はまだありません' }).waitFor();
    assert.equal(await page.getByLabel('訳文があるページだけ', { exact: true }).isChecked(), true);
    assert.equal(await page.getByRole('button', { name: '次のページ', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '前のページ', exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '1');
    await expectReference(page, originals[0].id, originals[0].backgroundRevision);
    await searchStatus(page, /^0件$/).waitFor();
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    const final = await snapshot(page, id, 5);
    assert.ok(final.document.translation);
    assert.deepEqual(translationContent(final.document.translation), translationContent(originalTranslation));
    assert.equal(final.document.translation.revision, final.document.version);
    assert.ok(final.document.translation.pages.every(p => p.lifecycleVersion === final.document.version));
    assert.deepEqual(final.document.pages.map(pageContent), initial.document.pages.map(pageContent));
    assert.equal(new Set(final.edits.map(edit => edit.batch.id)).size, 5);
    assert.ok(final.edits.every(edit => edit.batch.kind !== 'page'));
    await expectReference(page, originals[0].id, originals[0].backgroundRevision);
    phase = 'restart';
    page = await app.restart('navigation-failures.pdf');
    const restarted = await snapshot(page, id, 5); assert.deepEqual(restarted.edits, final.edits);
    await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).waitFor();
    t.diagnostic(JSON.stringify({ engine, documentId: id, originalPages: 32, poolSwitchDirections: 2, sparsePages: [1, 32],
      ambiguousCandidates: 2, allUnmapped: true, translatedPinnedId: translated[0].id, originalPinnedId: originals[0].id,
      exactDurableOperations: 5, sameReceiptsAfterRestart: true, pendingSearchReadObserved: true, workerStageClaimed: false }));
  } catch (error) {
    console.error(JSON.stringify({ engine, phase, error: String(error), body: await page.locator('body').innerText().catch(String) }));
    throw error;
  }
});

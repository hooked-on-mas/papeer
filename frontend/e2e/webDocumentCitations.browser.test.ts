import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication } from '../src/runtime/edits/contracts.ts';
import type { DocumentEditState } from '../src/features/reader/edit/DocumentEditSession.ts';
import type { MarkdownEditState } from '../src/features/notes/markdown/MarkdownEditSession.ts';
import { markdownCitationLink, type CitationTarget } from '../src/runtime/markdown/markdownCitations.ts';
import { openComposition, markdownEvidence, markdownSync } from './support/documentComposition.ts';

type NavigationEvidence = { documentId: string | null; document?: DocumentEditState; markdown?: MarkdownEditState;
  observedDocuments: string[]; observedMarkdown: string[] };
const navigation = (page: Page) => page.evaluate(() => (window as unknown as {
  compositionNavigationEvidence(): NavigationEvidence;
}).compositionNavigationEvidence());
const active = '[aria-label="中央の編集"], [aria-label="右側の編集"]';
async function selected(page: Page, id: string) {
  await page.locator(`[data-content-document="${id}"]`).waitFor();
}
async function preview(page: Page) {
  await page.getByRole('button', { name: /^(プレビュー|編集)$/ }).waitFor();
  const toggle = page.getByRole('button', { name: 'プレビュー', exact: true });
  if (await toggle.count()) await toggle.click();
}
async function atAnchor(page: Page, y: number) {
  await page.locator(active).locator('[data-rendered="true"] .react-pdf__Page__canvas').waitFor();
  await page.waitForFunction(y => {
    const pane = document.querySelector('[aria-label="中央の編集"] [data-pdf-scroller], [aria-label="中央の編集"] .web-pdf-pane');
    const surface = pane?.querySelector('.ink-page, [data-pdf-surface]'); if (!pane || !surface) return false;
    const frame = pane.getBoundingClientRect(), box = surface.getBoundingClientRect();
    return pane.scrollTop > 30 && Math.abs((frame.top + pane.clientTop - box.top) / box.height - y) < .015;
  }, y);
}

for (const engine of ['chromium', 'webkit'] as const) test(`production citation navigation, exact page anchors and current-draft guard (${engine})`, { timeout: 300_000 }, async t => {
  let target!: CitationTarget, markdownId = '', originalBody = '';
  const setup = (pdf: ContentPublication) => {
    assert.ok(pdf.content?.kind === 'document');
    const page = pdf.content.pages[1], deleted = { ...structuredClone(page), id: crypto.randomUUID() };
    pdf.content.deletedPages.push(deleted);
    target = { libraryId: pdf.libraryBatch.libraryId, documentId: pdf.content.id, pageId: page.id,
      backgroundRevision: page.backgroundRevision, surface: 'original', anchor: { xPt: page.widthPt / 2, yPt: page.heightPt * .12 } };
    markdownId = crypto.randomUUID();
    originalBody = '# Canonical citations\n\n' + [
      markdownCitationLink(target, '上の引用'),
      markdownCitationLink({ ...target, anchor: { xPt: page.widthPt / 2, yPt: page.heightPt * .32 } }, '下の引用'),
      markdownCitationLink({ ...target, pageId: crypto.randomUUID() }, '存在しないページ'),
      markdownCitationLink({ ...target, pageId: deleted.id }, '削除済みページ'),
      markdownCitationLink({ ...target, backgroundRevision: crypto.randomUUID() }, '古い背景'),
      markdownCitationLink({ ...target, surface: 'translated' }, '訳文の引用'),
    ].join('\n\n');
    const item = pdf.libraryBatch.changes.find(change => change.type === 'put-item'); assert.ok(item?.type === 'put-item');
    const markdownItem = { ...structuredClone(item.item), id: markdownId, kind: 'markdown' as const, title: 'Canonical Markdown composition' };
    delete markdownItem.resourceId;
    const publication: ContentPublication = {
      libraryBatch: { ...structuredClone(pdf.libraryBatch), id: crypto.randomUUID(), parents: [pdf.libraryBatch.id], changes: [{ type: 'put-item', item: markdownItem }] },
      content: { kind: 'markdown', id: markdownId, version: crypto.randomUUID(), content: originalBody, appendIds: [], imageResources: [] },
    };
    return { publications: [publication], initialDocumentId: markdownId };
  };
  const { pages, beginContentNavigation, finish } = await openComposition(t, engine, undefined, { additionalPublications: setup });
  try {
    for (const page of pages) assert.deepEqual((await navigation(page)).observedDocuments, [], 'initial Markdown creates no phantom document authority');
    beginContentNavigation();
    for (const [index, page] of pages.entries()) {
      t.diagnostic(`${index ? 'Web' : 'Native'} citation source navigation and guarded draft`);
      await preview(page); await page.getByRole('link', { name: '上の引用', exact: true }).click();
      await selected(page, target.documentId);
      await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '2');
      await page.getByLabel('倍率', { exact: true }).selectOption('2');
      await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click(); await selected(page, markdownId);
      for (const [label, y] of [['上の引用', .12], ['下の引用', .32]] as const) {
        await preview(page); await page.getByRole('link', { name: label, exact: true }).click(); await selected(page, target.documentId);
        await atAnchor(page, y);
        assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '2');
        assert.equal(await page.getByLabel('倍率', { exact: true }).inputValue(), '2');
        assert.equal((await navigation(page)).document!.document!.pages[1].id, target.pageId);
        await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click(); await selected(page, markdownId);
      }
      await preview(page);
      for (const label of ['存在しないページ', '削除済みページ', '古い背景', '訳文の引用']) {
        await page.getByRole('link', { name: label, exact: true }).click();
        // This fixture has no translated collection: an original UUID on that surface remains invalid.
        // Valid translated UUIDs are covered separately; translation support is no longer globally unavailable.
        await page.getByRole('alert').filter({ hasText: '引用先や資料' }).waitFor();
        assert.equal((await navigation(page)).documentId, markdownId);
      }
      await page.getByRole('button', { name: '編集', exact: true }).click();
      await page.evaluate(() => (window as unknown as { compositionScratchQuota(fail: boolean): void }).compositionScratchQuota(true));
      const draft = originalBody + `\n\nHeld ${index} draft`;
      await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).fill(draft); await preview(page);
      await page.getByRole('button', { name: '再試行', exact: true }).waitFor();
      await page.getByRole('link', { name: '上の引用', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '入力を確定または取り消し' }).waitFor();
      assert.equal((await navigation(page)).documentId, markdownId);
      assert.equal((await markdownEvidence(page)).session.content, draft);
      assert.equal((await markdownEvidence(page)).session.dirty, true);
      // Remove the injected storage fault and activate the real UI retry in one task:
      // the independent autosave timer must not remove the button between those steps.
      await page.getByRole('button', { name: '再試行', exact: true }).evaluate(button => {
        (window as unknown as { compositionScratchQuota(fail: boolean): void }).compositionScratchQuota(false);
        (button as HTMLButtonElement).click();
      });
      await markdownSync(page);
      await markdownSync(pages[1 - index]);
      assert.equal((await markdownEvidence(page)).session.accepted!.content, draft);
    }
    await finish();
  } catch (error) {
    for (const page of pages) console.error('Citation failure', page.url(), await navigation(page).catch(String), await markdownEvidence(page).catch(String));
    throw error;
  }
});

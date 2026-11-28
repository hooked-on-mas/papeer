import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication, ResourceMetadata } from '../src/runtime/edits/contracts.ts';
import type { SavedReaderState } from '../src/features/reader/ReaderSession.ts';
import { markdownCitationLink, type CitationTarget } from '../src/runtime/markdown/markdownCitations.ts';
import { openComposition, markdownEvidence } from './support/documentComposition.ts';
import { waitForSnapshot } from './support/waitForSnapshot.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8')) as {
  resource: { metadata: ResourceMetadata };
};
async function preview(page: Page) {
  await page.getByRole('button', { name: /^(プレビュー|編集)$/ }).waitFor();
  const button = page.getByRole('button', { name: 'プレビュー', exact: true });
  if (await button.count()) await button.click();
}
async function readingState(page: Page, documentId: string): Promise<SavedReaderState | null> {
  return page.evaluate(id => {
    const key = Object.keys(localStorage).find(value => value.startsWith('paper-desk.reader.v1:')
      && JSON.parse(value.slice('paper-desk.reader.v1:'.length))[3] === id);
    return key ? JSON.parse(localStorage.getItem(key)!) : null;
  }, documentId);
}
const translated = (page: Page) => page.locator('[data-reader-surface="translated"]');
async function actualPosition(page: Page) {
  return translated(page).locator('[data-pdf-scroller], .web-pdf-pane').evaluate(pane => {
    const surface = pane.querySelector('.ink-page, [data-pdf-surface]')!;
    const frame = pane.getBoundingClientRect(), box = surface.getBoundingClientRect();
    return { y: (frame.top + pane.clientTop - box.top) / box.height, scrollTop: pane.scrollTop,
      height: box.height, width: box.width };
  });
}
async function atCitation(page: Page, target: CitationTarget, y: number) {
  await page.locator(`[data-content-document="${target.documentId}"]`).waitFor();
  await translated(page).locator(`[data-canonical-page="${target.pageId}"][data-background-revision="${target.backgroundRevision}"]`).waitFor();
  await translated(page).locator('[data-rendered="true"] .react-pdf__Page[data-page-number="2"] canvas').waitFor();
  await waitForSnapshot(() => actualPosition(page), value => value.scrollTop > 20 && Math.abs(value.y - y) < .015);
  assert.equal(await translated(page).getAttribute('data-active-surface'), 'true');
  assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '3', 'mapped original logical page differs from physical translated page 2');
  assert.equal(await page.getByRole('button', { name: '訳文', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-reader-surface="original"]').count(), 0, 'a translated citation never renders a fabricated original substitute');
}

for (const engine of ['chromium', 'webkit'] as const) test(`production translated citations preserve exact pool identity and refuse ambiguous routes (${engine})`, { timeout: 300_000 }, async t => {
  let target!: CitationTarget, sourceId = '', body = '', originalRoute = '';
  const seed = (publication: ContentPublication) => {
    assert.ok(publication.content?.kind === 'document');
    const document = publication.content, template = document.pages[0];
    assert.ok(template.background.kind === 'pdf');
    document.pages = Array.from({ length: 3 }, () => ({ ...structuredClone(template), id: crypto.randomUUID(), annotations: [] }));
    originalRoute = document.pages[2].id;
    const pool = [2, 3, 4].map(pdfPage => ({ ...structuredClone(template),
      ...fixture.resource.metadata.pdfPages![pdfPage - 1], id: crypto.randomUUID(), annotations: [],
      background: { ...template.background, pdfPage } }));
    const reference = (index: number) => ({ pageId: pool[index].id, backgroundRevision: pool[index].backgroundRevision });
    // pool[1] has no route. pool[2] is referenced by two originals and must not pick either one.
    document.translation = { revision: crypto.randomUUID(), pages: pool, bindings: [
      { original: { pageId: originalRoute, backgroundRevision: document.pages[2].backgroundRevision }, candidates: [reference(0)] },
      ...[0, 1].map(index => ({ original: { pageId: document.pages[index].id, backgroundRevision: document.pages[index].backgroundRevision }, candidates: [reference(2)] })),
    ] };
    target = { libraryId: publication.libraryBatch.libraryId, documentId: document.id, ...reference(0), surface: 'translated',
      anchor: { xPt: pool[0].widthPt / 2, yPt: pool[0].heightPt * .18 } };
    body = '# 訳文引用\n\n' + [
      markdownCitationLink(target, '訳文の上側'),
      markdownCitationLink({ ...target, anchor: { xPt: pool[0].widthPt / 2, yPt: pool[0].heightPt * .34 } }, '訳文の下側'),
      markdownCitationLink({ ...target, ...reference(1), anchor: undefined }, '対応のない訳文'),
      markdownCitationLink({ ...target, ...reference(2), anchor: undefined }, '対応が曖昧な訳文'),
    ].join('\n\n');
  };
  const additionalPublications = (pdf: ContentPublication) => {
    const change = pdf.libraryBatch.changes.find(value => value.type === 'put-item'); assert.ok(change?.type === 'put-item');
    sourceId = crypto.randomUUID();
    const item = { ...structuredClone(change.item), id: sourceId, kind: 'markdown' as const, title: 'Translated citation source' };
    delete item.resourceId;
    const publication: ContentPublication = {
      libraryBatch: { ...structuredClone(pdf.libraryBatch), id: crypto.randomUUID(), parents: [pdf.libraryBatch.id], changes: [{ type: 'put-item', item }] },
      content: { kind: 'markdown', id: sourceId, version: crypto.randomUUID(), content: body, imageResources: [], appendIds: [] },
    };
    return { publications: [publication], initialDocumentId: sourceId };
  };
  const { pages, repository, beginContentNavigation, reloadContent, finish } = await openComposition(t, engine, seed, { additionalPublications });
  const before = await Promise.all([target.documentId, sourceId].map(id => repository.read(id)));
  beginContentNavigation();
  try {
    for (const [host, page] of pages.entries()) {
      t.diagnostic(`${host ? 'Web' : 'Native'} translated UUID/physical page/anchor, rejected route and reload`);
      await preview(page); await page.getByRole('link', { name: '訳文の上側', exact: true }).click();
      await translated(page).locator('[data-rendered="true"] .react-pdf__Page[data-page-number="2"] canvas').waitFor();
      await page.getByLabel('倍率', { exact: true }).selectOption('2');
      await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
      await page.locator(`[data-content-document="${sourceId}"]`).waitFor();
      for (const [label, y] of [['訳文の上側', .18], ['訳文の下側', .34]] as const) {
        await preview(page); await page.getByRole('link', { name: label, exact: true }).click();
        await atCitation(page, target, y);
        const state = await waitForSnapshot(() => readingState(page, target.documentId), value => value?.pageId === originalRoute
          && value.activeSurface === 'translated' && value.surfacePageId === target.pageId && Math.abs((value.landing?.place?.y ?? -1) - y) < 1e-9);
        assert.equal(state!.landing!.backgroundRevision, target.backgroundRevision);
        await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
        await page.locator(`[data-content-document="${sourceId}"]`).waitFor();
      }
      await preview(page);
      assert.equal(await page.getByRole('button', { name: '前の資料に戻る', exact: true }).count(), 0);
      for (const label of ['対応のない訳文', '対応が曖昧な訳文']) {
        await page.getByRole('link', { name: '訳文の下側', exact: true }).click(); await atCitation(page, target, .34);
        await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
        await page.locator(`[data-content-document="${sourceId}"]`).waitFor(); await preview(page);
        assert.equal(await page.getByRole('alert').count(), 0, 'each invalid request starts with its preceding error cleared');
        const history = await readingState(page, target.documentId);
        await page.getByRole('link', { name: label, exact: true }).click();
        await waitForSnapshot(() => page.evaluate(() => ({
          id: document.querySelector('[data-content-document]')?.getAttribute('data-content-document'),
          error: [...document.querySelectorAll('[role="alert"]')].some(value => value.textContent?.includes('引用先や資料を確認できません')),
          busy: [...document.querySelectorAll('[role="status"]')].some(value => value.textContent === '資料を開いています…'),
        })), value => value.id === sourceId && value.error && !value.busy);
        assert.equal(await page.getByRole('button', { name: '前の資料に戻る', exact: true }).count(), 0, 'rejected navigation cannot push content history');
        assert.deepEqual(await readingState(page, target.documentId), history, 'rejected routes cannot change page/anchor/history');
        assert.equal((await markdownEvidence(page)).session.content, body);
      }
      await page.getByRole('link', { name: '訳文の下側', exact: true }).click(); await atCitation(page, target, .34);
      await waitForSnapshot(() => readingState(page, target.documentId), value => value?.activeSurface === 'translated' && Math.abs((value.landing?.place?.y ?? -1) - .34) < 1e-9);
      // The host explicitly supplies the same initial document; automatic workspace selection persistence is separate.
      await reloadContent(page, target.documentId);
      await atCitation(page, target, .34);
      assert.equal(await page.getByLabel('倍率', { exact: true }).inputValue(), '2');
      const restored = await readingState(page, target.documentId);
      assert.equal(restored!.pageId, originalRoute); assert.equal(restored!.surfacePageId, target.pageId);
      assert.equal(restored!.landing!.backgroundRevision, target.backgroundRevision);
      await reloadContent(page, sourceId); await preview(page);
    }
    for (const [index, id] of [target.documentId, sourceId].entries()) {
      const after = await repository.read(id);
      assert.deepEqual(after.checkpoint, before[index].checkpoint); assert.deepEqual(after.history, before[index].history);
    }
    await finish();
  } catch (error) {
    for (const page of pages) console.error('Translated citation failure', page.url(), await page.locator('body').innerText().catch(String), await readingState(page, target.documentId).catch(String));
    throw error;
  }
});

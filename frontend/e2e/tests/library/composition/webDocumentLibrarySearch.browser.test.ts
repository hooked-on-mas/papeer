import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication } from '../../../../src/runtime/edits/contracts.ts';
import type { RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import { openComposition } from '../../../support/documentComposition.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';

const catalog = (page: Page): Promise<{ state: RepositoryState }> => page.evaluate(() => (window as unknown as {
  compositionLibraryEvidence(): Promise<{ state: RepositoryState }>;
}).compositionLibraryEvidence());
const content = (page: Page, id: string): Promise<{ state: RepositoryState }> => page.evaluate(id => (window as unknown as {
  compositionObservedEvidence(id: string): Promise<{ state: RepositoryState }>;
}).compositionObservedEvidence(id), id);
async function expand(page: Page) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  await page.getByRole('search', { name: '資料検索', exact: true }).waitFor();
}
const resultIds = (page: Page) => page.getByRole('tree', { name: '資料の階層', exact: true })
  .locator('[data-library-item]').evaluateAll(rows => rows.map(row => row.getAttribute('data-library-item')));
async function results(page: Page, ids: string[]) {
  await page.getByRole('status').filter({ hasText: new RegExp(`^${ids.length}件の資料が一致$`) }).waitFor();
  await waitForSnapshot(async () => ({ ids: await resultIds(page), searching: await page.getByRole('status')
    .filter({ hasText: /^保存済み本文を検索しています…$/ }).count() }), value => value.searching === 0 && JSON.stringify(value.ids) === JSON.stringify(ids));
  assert.equal(await page.getByRole('alert').count(), 0);
}
async function search(page: Page, text: string, scope: 'metadata' | 'content' | 'all', ids: string[]) {
  await page.getByLabel('資料の検索範囲', { exact: true }).selectOption(scope);
  await page.getByLabel('資料の検索語', { exact: true }).fill(text);
  await results(page, ids);
}
async function clear(page: Page) {
  await page.getByRole('button', { name: '表示条件を解除', exact: true }).click();
  await waitForSnapshot(async () => ({ text: await page.getByLabel('資料の検索語', { exact: true }).inputValue(),
    scope: await page.getByLabel('資料の検索範囲', { exact: true }).inputValue(), tag: await page.getByLabel('資料のタグ条件', { exact: true }).inputValue(),
    read: await page.getByLabel('資料の読書状態', { exact: true }).inputValue(), sort: await page.getByLabel('資料の並び順', { exact: true }).inputValue(),
    descending: await page.getByLabel('資料を降順に表示', { exact: true }).isChecked() }),
  value => value.text === '' && value.scope === 'metadata' && value.tag === '' && value.read === 'all' && value.sort === 'position' && !value.descending);
}

for (const engine of ['chromium', 'webkit'] as const) test(`production library search corpus, filters, order and readonly navigation (${engine})`, { timeout: 240_000 }, async t => {
  let pdfId = '', noteId = '', ownedId = '';
  const noteBody = '# Saved note\n\nCobalt independent manuscript needle.';
  const ownedBody = '# Saved owned note\n\nCobalt satellite ownedneedle.';
  const additionalPublications = (pdf: ContentPublication) => {
    assert.ok(pdf.content); pdfId = pdf.content.id;
    const change = pdf.libraryBatch.changes.find(value => value.type === 'put-item'); assert.ok(change?.type === 'put-item');
    change.item.title = 'Zulu source'; change.item.tags = ['science']; change.item.read = true;
    change.item.metadata = { author: 'Zed', year: '2024', venue: 'MetadataOnlyOrchid' };
    noteId = crypto.randomUUID(); ownedId = crypto.randomUUID();
    let parent = pdf.libraryBatch.id;
    const publications = [
      { id: noteId, title: 'Alpha note', ownerId: null, tags: ['science'], author: 'Able', year: '2020', body: noteBody },
      { id: ownedId, title: 'Beta owned', ownerId: pdfId, tags: ['owned'], author: 'Baker', year: '2022', body: ownedBody },
    ].map((entry, index): ContentPublication => {
      const item = { ...structuredClone(change.item), id: entry.id, kind: 'markdown' as const, title: entry.title,
        ownerId: entry.ownerId, folderId: null, position: index + 1, tags: entry.tags, read: false, metadata: { author: entry.author, year: entry.year } };
      delete item.resourceId;
      const publication: ContentPublication = { libraryBatch: { ...structuredClone(pdf.libraryBatch), id: crypto.randomUUID(), parents: [parent],
        changes: [{ type: 'put-item', item }] }, content: { kind: 'markdown', id: entry.id, version: crypto.randomUUID(),
        content: entry.body, appendIds: [], imageResources: [] } };
      parent = publication.libraryBatch.id; return publication;
    });
    return { publications, initialDocumentId: pdfId };
  };
  const { pages, finish } = await openComposition(t, engine, undefined, { pdfFixture: 'text', additionalPublications });
  const ids = [pdfId, noteId, ownedId];
  const baselines = await Promise.all(pages.map(async page => ({ catalog: (await catalog(page)).state,
    contents: await Promise.all(ids.map(async id => ({ id, state: (await content(page, id)).state }))) })));
  try {
    for (const [index, page] of pages.entries()) {
      t.diagnostic(`${index ? 'Web' : 'Native'} metadata, saved Markdown, real PDF text, owned results and readonly display conditions`);
      await expand(page);
      await search(page, 'metadataonlyorchid', 'metadata', [pdfId]);
      await search(page, 'manuscript needle', 'metadata', []);
      await search(page, 'manuscript needle', 'content', [noteId]);
      await search(page, 'Adaptive Control for Automated Systems', 'metadata', []);
      await search(page, 'Adaptive Control for Automated Systems', 'content', [pdfId]);
      assert.equal(await page.getByRole('status').filter({ hasText: /本文の未取得|一部のみ取得|未対応の添付/ }).count(), 0,
        'all seeded corpus is locally available and the real PDF was extracted');
      await search(page, 'cobalt', 'all', [noteId, ownedId]);
      await page.getByRole('checkbox', { name: '「Alpha note」を選択', exact: true }).check();
      await page.getByRole('checkbox', { name: '「Beta owned」を選択', exact: true }).check();
      await page.getByLabel('資料のタグ条件', { exact: true }).selectOption('science'); await results(page, [noteId]);
      await page.getByRole('button', { name: 'タグを追加', exact: true }).click();
      await page.getByRole('form', { name: 'タグ編集', exact: true }).getByText('1件の資料のタグを追加します。', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'タグ編集を取り消す', exact: true }).click();
      await page.getByLabel('資料のタグ条件', { exact: true }).selectOption(''); await results(page, [noteId, ownedId]);
      assert.equal(await page.getByRole('checkbox', { name: '「Beta owned」を選択', exact: true }).isChecked(), true);
      await page.getByRole('button', { name: '選択を解除', exact: true }).click();
      await search(page, 'ownedneedle', 'content', [ownedId]);

      // Conditions and the same result survive unmounting the collapsed catalog surface.
      await page.getByRole('button', { name: '資料一覧', exact: true }).click(); await expand(page);
      assert.equal(await page.getByLabel('資料の検索語', { exact: true }).inputValue(), 'ownedneedle');
      assert.equal(await page.getByLabel('資料の検索範囲', { exact: true }).inputValue(), 'content');
      await results(page, [ownedId]);
      await page.getByRole('tree', { name: '資料の階層', exact: true }).getByRole('button', { name: 'Beta owned', exact: true }).click();
      await page.locator(`[data-content-document="${ownedId}"]`).waitFor();
      const editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true }); await editor.waitFor();
      assert.equal(await editor.evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n')), ownedBody);
      await expand(page);
      assert.equal(await page.getByLabel('資料の検索語', { exact: true }).inputValue(), 'ownedneedle');
      await results(page, [ownedId]);

      await clear(page);
      await page.getByLabel('資料のタグ条件', { exact: true }).selectOption('science'); await results(page, [pdfId, noteId]);
      await page.getByLabel('資料の読書状態', { exact: true }).selectOption('read'); await results(page, [pdfId]);
      await page.getByLabel('資料の読書状態', { exact: true }).selectOption('unread'); await results(page, [noteId]);
      assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), ownedId, 'filtering never navigates the editor');
      await page.getByRole('button', { name: '表示中の資料を一覧で表示', exact: true }).click();
      await waitForSnapshot(async () => ({ query: await page.getByLabel('資料の検索語', { exact: true }).inputValue(),
        tag: await page.getByLabel('資料のタグ条件', { exact: true }).inputValue(), read: await page.getByLabel('資料の読書状態', { exact: true }).inputValue(),
        focused: await page.locator(`[data-library-item="${ownedId}"]`).evaluate(node => node === document.activeElement) }),
      value => value.query === '' && value.tag === '' && value.read === 'all' && value.focused);
      assert.ok((await resultIds(page)).includes(ownedId), 'reveal opens the owning PDF and shows its saved owned note');

      for (const sort of ['title', 'year', 'author']) {
        await page.getByLabel('資料の並び順', { exact: true }).selectOption(sort); await results(page, [noteId, ownedId, pdfId]);
        await page.getByLabel('資料を降順に表示', { exact: true }).check(); await results(page, [pdfId, ownedId, noteId]);
        await page.getByLabel('資料を降順に表示', { exact: true }).uncheck(); await results(page, [noteId, ownedId, pdfId]);
      }
      await clear(page);
      await search(page, 'absent-corpus-token', 'all', []);
      await clear(page);
      await page.getByRole('button', { name: '資料一覧', exact: true }).click();
      await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
      await page.locator(`[data-content-document="${pdfId}"]`).waitFor();
      await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();

      const baseline = baselines[index], after = (await catalog(page)).state;
      assert.deepEqual(after.checkpoint, baseline.catalog.checkpoint, 'queries never write the catalog');
      assert.deepEqual(after.history, baseline.catalog.history, 'display commands never enter catalog Undo history');
      for (const entry of baseline.contents) {
        const current = (await content(page, entry.id)).state;
        assert.deepEqual(current.checkpoint, entry.state.checkpoint, 'search/open never changes saved content');
        assert.deepEqual(current.history, entry.state.history);
      }
    }
    await finish();
  } catch (error) {
    console.error('library search failure', error);
    for (const page of pages) console.error(page.url(), JSON.stringify(await page.evaluate(() => ({
      text: document.querySelector<HTMLInputElement>('[aria-label="資料の検索語"]')?.value,
      rows: [...document.querySelectorAll('[role="treeitem"]')].map(node => ({ id: node.getAttribute('data-library-item'), label: node.getAttribute('aria-label') })),
      statuses: [...document.querySelectorAll('[role="status"], [role="alert"]')].map(node => node.textContent),
    })).catch(String)));
    throw error;
  }
});

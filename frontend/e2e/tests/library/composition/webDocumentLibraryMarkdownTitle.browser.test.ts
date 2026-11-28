import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication } from '../../../../src/runtime/edits/contracts.ts';
import type { LibrarySessionState } from '../../../../src/features/library/LibrarySession.ts';
import type { RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import { openComposition, markdownEvidence, sync as deliver } from '../../../support/documentComposition.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';

function seed(publication: ContentPublication) {
  assert.ok(publication.content);
  publication.content = { kind: 'markdown', id: publication.content.id, version: publication.content.version,
    content: '# Catalog title isolation\n\nInitial body', appendIds: [], imageResources: [] };
  const change = publication.libraryBatch.changes.find(value => value.type === 'put-item'); assert.ok(change?.type === 'put-item');
  change.item.kind = 'markdown'; delete change.item.resourceId;
}
type Catalog = { state: RepositoryState; session?: LibrarySessionState; pending: unknown[]; replication: { running: boolean } };
const catalog = (page: Page): Promise<Catalog> => page.evaluate(() => (window as unknown as {
  compositionLibraryEvidence(): Promise<Catalog>;
}).compositionLibraryEvidence());
async function expand(page: Page) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}
async function titleIs(page: Page, id: string, title: string) {
  await waitForSnapshot(() => catalog(page), value => !!value.session?.ready && !value.session.busy && !value.session.pendingId
    && value.session.items.some(item => item.id === id && item.title === title));
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
}
async function sync(page: Page) {
  await waitForSnapshot(() => catalog(page), value => !value.replication.running);
  await deliver(page);
  await waitForSnapshot(() => catalog(page), value => !value.replication.running && value.pending.length === 0);
}

for (const engine of ['chromium', 'webkit'] as const) test(`production catalog titles preserve the dirty Markdown editor (${engine})`, { timeout: 240_000 }, async t => {
  const { native, web, pages, documentId, finish } = await openComposition(t, engine, seed);
  let currentTitle = 'Canonical Markdown composition';
  try {
    for (const [index, page] of pages.entries()) {
      const peer = page === native ? web : native;
      const before = await markdownEvidence(page);
      const body = `${before.session.content}\n\n${index ? 'Web' : 'Native'} draft survives metadata changes.`;
      const editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true });
      const originalNode = await editor.elementHandle(); assert.ok(originalNode);
      await page.evaluate(() => (window as unknown as { compositionScratchQuota(fail: boolean): void }).compositionScratchQuota(true));
      await editor.fill(body);
      await waitForSnapshot(() => markdownEvidence(page), value => value.session.content === body && value.session.dirty && !value.session.durable);
      const retained = async () => {
        const value = await markdownEvidence(page);
        assert.equal(value.session.content, body); assert.equal(value.session.dirty, true);
        assert.equal(await editor.evaluate((node, original) => node === original && original.isConnected, originalNode), true);
        assert.equal(await editor.evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n')), body);
        assert.deepEqual(value.state.checkpoint, before.state.checkpoint);
        assert.deepEqual(value.state.history, before.state.history);
      };
      const renamed = `${index ? 'Web' : 'Native'} dirty Markdown title`;
      await expand(page);
      await page.getByRole('button', { name: `「${currentTitle}」を改名`, exact: true }).click();
      await page.getByRole('textbox', { name: '資料の新しい名前', exact: true }).fill(renamed);
      await page.getByRole('button', { name: '名前を保存', exact: true }).click();
      await titleIs(page, documentId, renamed); await retained();
      await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
      await titleIs(page, documentId, currentTitle); await retained();
      await page.getByRole('button', { name: '再試行', exact: true }).waitFor();
      await page.evaluate(() => {
        (window as unknown as { compositionScratchQuota(fail: boolean): void }).compositionScratchQuota(false);
        const button = [...document.querySelectorAll('button')].find(value => value.textContent === '再試行');
        if (!button) throw new Error('actual Markdown retry control is required'); button.click();
      });
      const saved = await waitForSnapshot(() => markdownEvidence(page), value => value.session.content === body && value.session.accepted?.content === body
        && !value.session.dirty && !value.session.saving && value.session.durable);
      assert.equal(saved.state.history.length, before.state.history.length + 1, 'only the actual Markdown retry adds content history');
      assert.equal(await editor.evaluate((node, original) => node === original && original.isConnected, originalNode), true);
      await page.getByRole('button', { name: '資料の変更をやり直す', exact: true }).click();
      await titleIs(page, documentId, renamed);
      const afterRedo = await markdownEvidence(page);
      assert.deepEqual(afterRedo.state.checkpoint, saved.state.checkpoint);
      assert.deepEqual(afterRedo.state.history, saved.state.history);
      assert.equal(await editor.evaluate((node, original) => node === original && original.isConnected, originalNode), true);
      await sync(page); await sync(peer);
      await titleIs(peer, documentId, renamed);
      const received = await waitForSnapshot(() => markdownEvidence(peer), value => value.session.accepted?.content === body && value.session.content === body && !value.session.dirty);
      assert.deepEqual(received.state.checkpoint, saved.state.checkpoint);
      currentTitle = renamed;
      await originalNode.dispose();
    }
    await finish();
  } catch (error) {
    console.error('dirty Markdown title failure', error);
    for (const page of pages) console.error(page.url(), JSON.stringify({ catalog: await catalog(page).catch(String), markdown: await markdownEvidence(page).catch(String) }));
    throw error;
  }
});

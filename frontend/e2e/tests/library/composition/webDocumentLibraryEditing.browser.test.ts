import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { LibrarySessionState } from '../../../../src/features/library/LibrarySession.ts';
import type { RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import { openComposition, sync as deliver } from '../../../support/documentComposition.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';

type Catalog = { state: RepositoryState; session?: LibrarySessionState; pending: unknown[]; replication: { running: boolean } };
const catalog = (page: Page): Promise<Catalog> => page.evaluate(() => (window as unknown as {
  compositionLibraryEvidence(): Promise<Catalog>;
}).compositionLibraryEvidence());
const content = (page: Page, id: string): Promise<{ state: RepositoryState }> => page.evaluate(id => (window as unknown as {
  compositionObservedEvidence(id: string): Promise<{ state: RepositoryState }>;
}).compositionObservedEvidence(id), id);
async function expand(page: Page) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  await page.getByRole('region', { name: '資料一覧', exact: true }).waitFor();
}
async function named(page: Page, id: string, title: string) {
  const value = await waitForSnapshot(() => catalog(page), value => !!value.session?.ready && !value.session.busy && !value.session.pendingId
    && value.session.items.some(item => item.id === id && item.title === title));
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  return value;
}
async function synchronize(page: Page) {
  await waitForSnapshot(() => catalog(page), value => !value.replication.running);
  await deliver(page);
  await waitForSnapshot(() => catalog(page), value => !value.replication.running && value.pending.length === 0);
}

for (const engine of ['chromium', 'webkit'] as const) test(`production library rename, recovery and durable undo redo (${engine})`, { timeout: 600_000 }, async t => {
  const fixture = await openComposition(t, engine);
  const { native, web, pages, documentId, repository, reload, finish, committed, committedPayloads, setCommitReplyLoss } = fixture;
  const originalContent = (await content(native, documentId)).state;
  const initialCatalog = await waitForSnapshot(() => catalog(native), value => !!value.session?.ready && !value.session.busy
    && value.session.items.some(item => item.id === documentId));
  let currentTitle = initialCatalog.session!.items.find(item => item.id === documentId)!.title;
  try {
    for (const [index, page] of pages.entries()) {
      const peer = page === native ? web : native;
      const beforeTitle = currentTitle, title = `${index ? 'Web' : 'Native'} renamed canonical source`;
      await expand(page);
      await page.getByRole('button', { name: `「${beforeTitle}」を改名`, exact: true }).click();
      await page.getByRole('textbox', { name: '資料の新しい名前', exact: true }).fill(title);
      const start = committed.length;
      if (page === native) setCommitReplyLoss(true);
      await page.getByRole('button', { name: '名前を保存', exact: true }).click();
      if (page === native) {
        const failed = await waitForSnapshot(() => catalog(page), value => !!value.session?.pendingId && !value.session.busy && !!value.session.error);
        const pendingId = failed.session!.pendingId!;
        assert.ok(await repository.readIntent(repository.scope.libraryId));
        await reload(page);
        await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
        await page.getByRole('button', { name: '読む', exact: true }).waitFor();
        await expand(page);
        await waitForSnapshot(() => catalog(page), value => value.session?.pendingId === pendingId && !value.session.busy);
        setCommitReplyLoss(false);
        await page.getByRole('button', { name: '変更を再試行', exact: true }).click();
        const recovered = await named(page, documentId, title);
        assert.ok(committed.length - start >= 2);
        assert.deepEqual([...new Set(committed.slice(start))], [pendingId]);
        const payloads = committedPayloads.slice(start).map(value => JSON.parse(value));
        for (const payload of payloads) assert.deepEqual(payload, payloads[0], 'retry preserves every field and array order');
        assert.equal(recovered.state.checkpoint.batches.filter(batch => batch.id === pendingId).length, 1);
        assert.equal(await repository.readIntent(repository.scope.libraryId), undefined);
      } else await named(page, documentId, title);
      await synchronize(page); await synchronize(peer); await named(peer, documentId, title);
      const afterRename = (await catalog(page)).state;
      assert.deepEqual((await catalog(peer)).state.checkpoint, afterRename.checkpoint);
      assert.ok(afterRename.history.length > 0, 'rename has a durable history record');
      await reload(page);
      await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
      await expand(page); await named(page, documentId, title);
      assert.deepEqual((await catalog(page)).state.history, afterRename.history, 'history survives a new registry');
      const beforeUndo = (await catalog(page)).state.checkpoint.batches;
      const undoButton = page.getByRole('button', { name: '資料の変更を元に戻す', exact: true });
      if (page === native) { await undoButton.focus(); await page.keyboard.press('Control+z'); }
      else await undoButton.click();
      const undone = await named(page, documentId, beforeTitle);
      const inverse = undone.state.checkpoint.batches.filter(batch => !beforeUndo.some(previous => previous.id === batch.id));
      assert.equal(inverse.length, 1, 'one catalog shortcut produces one inverse, never a duplicate global-editor operation');
      assert.equal(inverse[0].kind, 'library');
      assert.equal(inverse[0].targetId, repository.scope.libraryId);
      await synchronize(page); await synchronize(peer); await named(peer, documentId, beforeTitle);
      await reload(page);
      await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
      await expand(page); await named(page, documentId, beforeTitle);
      const beforeRedo = (await catalog(page)).state.checkpoint.batches;
      const redoButton = page.getByRole('button', { name: '資料の変更をやり直す', exact: true });
      if (page === native) { await redoButton.focus(); await page.keyboard.press('Control+Shift+z'); }
      else await redoButton.click();
      const redone = await named(page, documentId, title);
      assert.equal(redone.state.checkpoint.batches.filter(batch => !beforeRedo.some(previous => previous.id === batch.id)).length, 1);
      await synchronize(page); await synchronize(peer); await named(peer, documentId, title);
      currentTitle = title;
      for (const target of pages) {
        const stored = (await content(target, documentId)).state;
        assert.deepEqual(stored.checkpoint, originalContent.checkpoint, 'catalog changes never mutate PDF pages or annotations');
        assert.deepEqual(stored.history, originalContent.history, 'catalog history stays separate from content history');
        const state = await catalog(target);
        assert.equal(state.session!.items.length, 1);
        assert.equal(state.session!.items[0].id, documentId);
      }
    }
    for (const page of pages) {
      await reload(page); await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
      await expand(page); await named(page, documentId, currentTitle);
      await page.getByRole('region', { name: '資料一覧', exact: true }).getByRole('button', { name: currentTitle, exact: true }).click();
      await page.locator(`[data-content-document="${documentId}"]`).waitFor();
    }
    assert.deepEqual((await catalog(native)).state.checkpoint, (await catalog(web)).state.checkpoint);
    await finish();
  } catch (error) {
    console.error('library rename failure', error, JSON.stringify({ committed, committedPayloads }));
    for (const page of pages) console.error(page.url(), JSON.stringify(await catalog(page).catch(String)));
    throw error;
  }
});

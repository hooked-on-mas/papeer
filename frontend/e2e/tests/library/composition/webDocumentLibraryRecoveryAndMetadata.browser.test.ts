import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { LibrarySnapshot } from '../../../../src/runtime/edits/contracts.ts';
import type { LibrarySessionState } from '../../../../src/features/library/LibrarySession.ts';
import type { RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import { EditGraph } from '../../../../src/runtime/edits/editGraph.ts';
import { openComposition, sync as deliver } from '../../../support/documentComposition.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';

type Catalog = { state: RepositoryState; session?: LibrarySessionState; pending: unknown[]; replication: { running: boolean } };
const catalog = (page: Page): Promise<Catalog> => page.evaluate(() => (window as unknown as {
  compositionLibraryEvidence(): Promise<Catalog>;
}).compositionLibraryEvidence());
function snapshot(value: Catalog): LibrarySnapshot | undefined {
  const version = value.session?.selectedVersion;
  const result = version ? new EditGraph(value.state.checkpoint).snapshot(version) : undefined;
  return result?.kind === 'library' ? result : undefined;
}
async function settled(page: Page, accepts: (value: LibrarySnapshot, session: LibrarySessionState) => boolean) {
  const value = await waitForSnapshot(() => catalog(page), value => {
    const state = snapshot(value);
    return !!state && !!value.session?.ready && !value.session.busy && !value.session.pendingId && accepts(state, value.session);
  });
  return { evidence: value, library: snapshot(value)!, session: value.session! };
}
async function expand(page: Page) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}
async function collapse(page: Page) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await button.getAttribute('aria-expanded') === 'true') await button.click();
}
async function sync(page: Page) {
  await waitForSnapshot(() => catalog(page), value => !value.replication.running);
  await deliver(page);
  await waitForSnapshot(() => catalog(page), value => !value.replication.running && value.pending.length === 0);
}
function oneBatch(before: RepositoryState, after: RepositoryState) {
  const added = after.checkpoint.batches.filter(batch => !before.checkpoint.batches.some(previous => previous.id === batch.id));
  assert.equal(added.length, 1); assert.equal(added[0].kind, 'library'); return added[0];
}
const beforeUnloadPrevented = (page: Page) =>
  page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));

for (const engine of ['chromium', 'webkit'] as const) test(`production bibliography metadata, creation Undo, unobserved deleted edits and restoration (${engine})`, { timeout: 600_000 }, async t => {
  const { native, web, pages, repository, reload, finish, published, publishedPayloads, setPublishReplyLoss, setIncomingEditListMode } =
    await openComposition(t, engine);
  const initial = (await settled(native, value => value.items.length === 1)).library;
  const pdf = initial.items[0];
  const reopen = async (page: Page) => {
    await waitForSnapshot(() => catalog(page), value => !value.replication.running && !value.session?.busy);
    await reload(page);
    await page.getByRole('button', { name: '読む', exact: true }).waitFor();
    await expand(page);
  };
  try {
    for (const [index, page] of pages.entries()) {
      const peer = page === native ? web : native, prefix = index ? 'Web' : 'Native';
      await expand(page);

      // 1. Create a Markdown note and verify bibliography button is only offered for PDF items
      const noteTitle = `${prefix} Note`;
      await page.getByRole('textbox', { name: '新しい資料の名前', exact: true }).fill(noteTitle);
      await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
      await page.getByRole('button', { name: '資料を作成', exact: true }).click();
      await page.getByRole('heading', { name: noteTitle, exact: true }).waitFor();
      const editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true });
      await editor.waitFor();
      await editor.fill(`# ${noteTitle}\nObserved baseline`);
      await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
      await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
      await expand(page);
      const withNote = await settled(page, value => value.items.some(item => item.title === noteTitle));
      const note = withNote.library.items.find(item => item.title === noteTitle)!;
      assert.equal(await page.getByRole('button', { name: `「${pdf.title}」の書誌情報を編集`, exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: `「${note.title}」の書誌情報を編集`, exact: true }).count(), 0);

      // 2. Bibliography validation, draft retention across collapse/expand, normalization, Undo/Redo, and stale conflict detection
      await page.getByRole('button', { name: `「${pdf.title}」の書誌情報を編集`, exact: true }).click();
      await page.getByRole('textbox', { name: '出版年', exact: true }).fill('24');
      await page.getByRole('alert').filter({ hasText: '出版年は半角数字4桁で入力してください' }).waitFor();
      assert.equal(await page.getByRole('button', { name: '書誌情報を保存', exact: true }).isEnabled(), false);

      const authorName = `${prefix} Author`;
      await page.getByRole('textbox', { name: '筆頭著者', exact: true }).fill(`  ${authorName}  `);
      await page.getByRole('textbox', { name: '出版年', exact: true }).fill(' 2024 ');
      await page.getByRole('textbox', { name: '掲載誌', exact: true }).fill('  ICLR   2024  ');
      await page.getByRole('textbox', { name: 'DOI', exact: true }).fill('https://doi.org/10.1000/xyz123.');
      await page.getByRole('textbox', { name: 'arXiv ID', exact: true }).fill('arXiv:2401.00001v2');

      // Collapse and re-expand retains draft
      await collapse(page);
      await expand(page);
      assert.equal(await page.getByRole('textbox', { name: '筆頭著者', exact: true }).inputValue(), `  ${authorName}  `);

      const beforeBib = await catalog(page);
      await page.getByRole('button', { name: '書誌情報を保存', exact: true }).click();
      const afterBib = await settled(page, value => value.items.find(item => item.id === pdf.id)?.metadata.author === authorName);
      oneBatch(beforeBib.state, afterBib.evidence.state);
      assert.deepEqual(afterBib.library.items.find(item => item.id === pdf.id)?.metadata, {
        author: authorName,
        year: '2024',
        venue: 'ICLR 2024',
        doi: '10.1000/xyz123',
        arxiv_id: '2401.00001',
      });

      // Undo and Redo bibliography edit
      await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
      await settled(page, value => value.items.find(item => item.id === pdf.id)?.metadata.author !== authorName);
      await page.getByRole('button', { name: '資料の変更をやり直す', exact: true }).click();
      await settled(page, value => value.items.find(item => item.id === pdf.id)?.metadata.author === authorName);

      // Sync to peer and test stale bibliography conflict detection
      await sync(page); await sync(peer);
      await expand(peer);
      await peer.getByRole('button', { name: `「${pdf.title}」の書誌情報を編集`, exact: true }).click();
      await peer.getByRole('textbox', { name: '筆頭著者', exact: true }).fill('Stale Draft Author');
      // Now page updates the author and syncs to peer while peer's draft is open
      await page.getByRole('button', { name: `「${pdf.title}」の書誌情報を編集`, exact: true }).click();
      await page.getByRole('textbox', { name: '筆頭著者', exact: true }).fill(`${authorName} Updated`);
      await page.getByRole('button', { name: '書誌情報を保存', exact: true }).click();
      await settled(page, value => value.items.find(item => item.id === pdf.id)?.metadata.author === `${authorName} Updated`);
      await sync(page); await sync(peer);
      await settled(peer, value => value.items.find(item => item.id === pdf.id)?.metadata.author === `${authorName} Updated`);
      await peer.getByRole('button', { name: '書誌情報を保存', exact: true }).click();
      await peer.getByRole('alert').filter({ hasText: '書誌情報が別の操作で変更されています。入力は保持しています。' }).waitFor();
      assert.equal(await peer.getByRole('textbox', { name: '筆頭著者', exact: true }).inputValue(), 'Stale Draft Author');
      await peer.getByRole('button', { name: '書誌情報の編集を閉じる', exact: true }).click();

      // 3. Creation Undo (cancelCreate) after lost publish reply on native
      if (page === native) {
        const startPub = published.length;
        setPublishReplyLoss(true);
        await page.getByRole('textbox', { name: '新しい資料の名前', exact: true }).fill('Cancelled Note');
        await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
        await page.getByRole('button', { name: '資料を作成', exact: true }).click();
        const pendingCreate = await waitForSnapshot(() => catalog(page), value =>
          !value.replication.running && value.session?.pendingKind === 'create' && !!value.session.pendingId && !value.session.busy);
        const pendingPubId = pendingCreate.session!.pendingId!;
        assert.equal(await beforeUnloadPrevented(page), true);
        assert.ok(await repository.readIntent(repository.scope.libraryId));
        setPublishReplyLoss(false);
        await page.getByRole('button', { name: '作成を取り消す', exact: true }).click();
        const afterCancel = await settled(page, (_, session) =>
          session.deletedItems.some(item => item.title === 'Cancelled Note') && !session.items.some(item => item.title === 'Cancelled Note'));
        assert.equal(published.length - startPub, 2);
        assert.deepEqual(published.slice(startPub), [pendingPubId, pendingPubId]);
        assert.deepEqual(JSON.parse(publishedPayloads[startPub]), JSON.parse(publishedPayloads[startPub + 1]));
        assert.equal(afterCancel.session.deletedContent.find(entry =>
          entry.itemId === afterCancel.session.deletedItems.find(item => item.title === 'Cancelled Note')!.id)?.state, 'observed');
      }

      // 4. Unconfirmed post-deletion edit detection ('unobserved'), read-only inspection, and restoration ('復元')
      // Keep the peer unaware of the deletion until its later edit is durable. Without this transport
      // boundary a normal three-second pull can correctly make the peer read-only before fill().
      setIncomingEditListMode(peer,'empty-success');
      await waitForSnapshot(() => catalog(peer), value => !value.replication.running);
      // Peer opens `note` while it is still live, before page deletes it
      await peer.getByRole('button', { name: note.title, exact: true }).click();
      const peerEditor = peer.getByRole('textbox', { name: 'Markdownノート', exact: true });
      await peerEditor.waitFor();

      // Page deletes `note` while only the baseline version exists anywhere
      await page.getByRole('button', { name: `「${note.title}」を削除`, exact: true }).click();
      await page.getByRole('button', { name: '削除を確定', exact: true }).click();
      const afterDeleteNote = await settled(page, (_, session) =>
        !session.items.some(item => item.id === note.id) && session.deletedItems.some(item => item.id === note.id));
      assert.equal(afterDeleteNote.session.deletedContent.find(entry => entry.itemId === note.id)?.state, 'observed');
      const deletionSection = page.getByRole('region', { name: '削除した資料', exact: true });
      await deletionSection.waitFor();

      // Now peer (which still has `note` open before syncing the deletion) edits `note` and saves
      await peerEditor.fill(`# ${noteTitle}\nUnobserved post-delete edit from peer`);
      await peer.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
      await peer.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();

      // Sync peer's post-delete edit to page -> status transitions from 'observed' to 'unobserved' ('未確認の編集あり')
      setIncomingEditListMode(peer,'normal');
      await sync(peer); await sync(page);
      await page.getByRole('button', { name: '一覧を更新', exact: true }).click();
      const afterPeerSync = await settled(page, (_, session) =>
        session.deletedContent.find(entry => entry.itemId === note.id)?.state === 'unobserved');
      assert.equal(afterPeerSync.session.deletedContent.find(entry => entry.itemId === note.id)?.state, 'unobserved');
      await deletionSection.getByText('未確認の編集あり').waitFor();

      // Inspect deleted note in read-only mode ('内容を確認')
      await page.getByRole('button', { name: `削除された「${note.title}」の内容を確認`, exact: true }).click();
      // Both host frames give their title a border; the rendered Markdown can also contain the same h1.
      await page.getByRole('heading', { name: note.title, exact: true }).and(page.locator('h1.border-b')).waitFor();
      await page.getByRole('status').filter({ hasText: 'この資料は削除されています。新しい編集はできません。' }).waitFor();
      await page.getByText('Unobserved post-delete edit from peer').waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).count(), 0);

      // Restore ('復元') from recovery list -> returns to active items and re-enables editing immediately
      await expand(page);
      await page.getByRole('button', { name: `「${note.title}」を復元`, exact: true }).click();
      await settled(page, (_, session) =>
        session.items.some(item => item.id === note.id) && !session.deletedItems.some(item => item.id === note.id));
      await collapse(page);
      await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
      await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
      await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();

      // Undo and Redo of restoration
      await expand(page);
      await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
      await settled(page, (_, session) => session.deletedItems.some(item => item.id === note.id));
      await page.getByRole('button', { name: '資料の変更をやり直す', exact: true }).click();
      const finalHostState = await settled(page, (_, session) => session.items.some(item => item.id === note.id));

      await sync(page); await sync(peer);
      const remote = await settled(peer, value => value.version === finalHostState.library.version);
      assert.deepEqual(remote.library, finalHostState.library);
    }
    for (const page of pages) await reopen(page);
    assert.deepEqual((await settled(native, () => true)).library, (await settled(web, () => true)).library);
    await finish();
  } catch (error) {
    console.error('recovery/metadata failure', error, JSON.stringify({ published, publishedPayloads }));
    for (const page of pages) console.error(page.url(), JSON.stringify(await catalog(page).catch(String)));
    throw error;
  }
});


import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication, LibrarySnapshot } from '../../../../src/runtime/edits/contracts.ts';
import type { LibrarySessionState } from '../../../../src/features/library/LibrarySession.ts';
import type { RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import { EditGraph } from '../../../../src/runtime/edits/editGraph.ts';
import { openComposition, sync as deliver, waitForCompositionReplicationIdle } from '../../../support/documentComposition.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';

type Catalog = { state: RepositoryState; session?: LibrarySessionState; pending: unknown[]; replication: { running: boolean } };
const catalog = (page: Page): Promise<Catalog> => page.evaluate(() => (window as unknown as {
  compositionLibraryEvidence(): Promise<Catalog>;
}).compositionLibraryEvidence());
const content = (page: Page, id: string): Promise<{ state: RepositoryState }> => page.evaluate(id => (window as unknown as {
  compositionObservedEvidence(id: string): Promise<{ state: RepositoryState }>;
}).compositionObservedEvidence(id), id);
function snapshot(value: Catalog): LibrarySnapshot | undefined {
  const version = value.session?.selectedVersion;
  const result = version ? new EditGraph(value.state.checkpoint).snapshot(version) : undefined;
  return result?.kind === 'library' ? result : undefined;
}
async function settled(page: Page, accepts: (value: LibrarySnapshot) => boolean) {
  const value = await waitForSnapshot(() => catalog(page), value => {
    const state = snapshot(value);
    return !!state && !!value.session?.ready && !value.session.busy && !value.session.pendingId && accepts(state);
  });
  return { evidence: value, library: snapshot(value)! };
}
async function expand(page: Page) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}
async function sync(page: Page) {
  await waitForCompositionReplicationIdle(page);
  await deliver(page);
  await waitForSnapshot(() => catalog(page), value => !value.replication.running && value.pending.length === 0);
}
function oneBatch(before: RepositoryState, after: RepositoryState) {
  const added = after.checkpoint.batches.filter(batch => !before.checkpoint.batches.some(previous => previous.id === batch.id));
  assert.equal(added.length, 1); assert.equal(added[0].kind, 'library'); return added[0];
}
async function openFolder(page: Page, title: string) {
  const open = page.getByRole('button', { name: `「${title}」を開く`, exact: true });
  if (await open.count()) await open.click();
}
async function chooseFolder(page: Page, title: string) {
  await page.getByRole('button', { name: `「${title}」を選択`, exact: true }).click();
}

const beforeUnloadPrevented = (page: Page) =>
  page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));

for (const engine of ['chromium', 'webkit'] as const) test(`production folder hierarchy, retained contents and durable recovery (${engine})`, { timeout: 600_000 }, async t => {
  const additionalPublications = (pdf: ContentPublication) => {
    const change = pdf.libraryBatch.changes.find(value => value.type === 'put-item'); assert.ok(change?.type === 'put-item');
    const note = { ...structuredClone(change.item), id: crypto.randomUUID(), kind: 'markdown' as const, title: 'Folder unchanged note', position: 1,
      tags: ['preserved'], metadata: { source: 'folder fixture' } };
    delete note.resourceId;
    const publication: ContentPublication = { libraryBatch: { ...structuredClone(pdf.libraryBatch), id: crypto.randomUUID(), parents: [pdf.libraryBatch.id],
      changes: [{ type: 'put-item', item: note }] }, content: { kind: 'markdown', id: note.id, version: crypto.randomUUID(),
      content: '# Folder moves preserve this body', appendIds: [], imageResources: [] } };
    return { publications: [publication], initialDocumentId: pdf.content!.id };
  };
  const { native, web, pages, repository, reload, reloadUnavailableContent, finish, committed, committedPayloads, setCommitReplyLoss } =
    await openComposition(t, engine, undefined, { additionalPublications });
  const initial = (await settled(native, value => value.items.length === 2)).library;
  const originals = new Map(await Promise.all(initial.items.map(async item => [item.id, (await content(native, item.id)).state] as const)));
  const reopen = async (page: Page) => {
    await waitForSnapshot(() => catalog(page), value => !value.replication.running && !value.session?.busy);
    await reload(page); await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
    await page.getByRole('button', { name: '読む', exact: true }).waitFor(); await expand(page);
  };
  try {
    for (const [index, page] of pages.entries()) {
      const peer = page === native ? web : native, prefix = index ? 'Web' : 'Native';
      await expand(page);
      const create = async (title: string, parentId: string | null, loseReply = false) => {
        const before = await catalog(page), start = committed.length;
        assert.equal(await beforeUnloadPrevented(page), false);
        await page.getByRole('button', { name: 'フォルダーを作成', exact: true }).click();
        await page.getByRole('textbox', { name: 'フォルダー名', exact: true }).fill(title);
        await page.getByLabel('親フォルダー', { exact: true }).selectOption(parentId ?? '');
        if (loseReply) {
          await page.getByRole('button', { name: '資料一覧', exact: true }).click();
          await expand(page);
          assert.equal(await page.getByRole('textbox', { name: 'フォルダー名', exact: true }).inputValue(), title);
          assert.equal(await page.getByLabel('親フォルダー', { exact: true }).inputValue(), parentId ?? '');
          setCommitReplyLoss(true);
        }
        await page.getByRole('button', { name: 'フォルダーを保存', exact: true }).click();
        let pendingId: string | null = null;
        if (loseReply) {
          const failed = await waitForSnapshot(() => catalog(page), value => !value.replication.running && !!value.session?.pendingId && !value.session.busy && !!value.session.error);
          pendingId = failed.session!.pendingId;
          assert.equal(await beforeUnloadPrevented(page), true);
          assert.ok(await repository.readIntent(repository.scope.libraryId));
          let blockDocumentRead = true, blockedLoaderReads = 0, forwardedTargetReads = 0;
          let reloading = false, retiredReadAborts = 0;
          await page.route('**/api/edits/read', async route => {
            const body = route.request().postDataJSON() as { targetId?: string } | null;
            if (blockDocumentRead && body?.targetId === initial.items[0].id) {
              let selected: string | null;
              try {
                selected = await page.evaluate(() => (window as unknown as {
                  compositionNavigationEvidence?: () => { navigation: { documentId: string | null } };
                }).compositionNavigationEvidence?.().navigation.documentId ?? null);
              } catch (error) {
                if (!reloading || !(error instanceof Error) || error.message !== 'page.evaluate: Execution context was destroyed, most likely because of a navigation') throw error;
                retiredReadAborts++;
                await route.abort('aborted');
                return;
              }
              if (selected === body.targetId) {
                blockedLoaderReads++;
                await route.fulfill({ status: 503, contentType: 'text/plain', body: 'fixture body read deferred' });
                return;
              }
              forwardedTargetReads++;
            }
            await route.continue();
          });
          reloading = true;
          try { await reloadUnavailableContent(page); } finally { reloading = false; }
          t.diagnostic('Folders retired navigation reads aborted: ' + retiredReadAborts);
          await page.getByRole('button', { name: '再試行', exact: true }).waitFor();
          assert.ok(blockedLoaderReads > 0, 'actual selected loader read was rejected');
          assert.ok(forwardedTargetReads > 0, 'target navigation prevalidation used the normal read path');
          assert.equal(await page.getByLabel('PDF書き込みレイヤー', { exact: true }).count(), 0);
          await waitForSnapshot(() => catalog(page), value => value.session?.pendingId === pendingId && !value.session.busy);
          assert.equal(await beforeUnloadPrevented(page), true);
          blockDocumentRead = false;
          await page.unroute('**/api/edits/read');
          await page.getByRole('button', { name: '再試行', exact: true }).click();
          await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
          await page.getByRole('button', { name: '読む', exact: true }).waitFor();
          await sync(page); // Full original delivery barrier after the deliberate read-failure window.
          await expand(page);
          assert.equal(await beforeUnloadPrevented(page), true);
          setCommitReplyLoss(false); await page.getByRole('button', { name: '変更を再試行', exact: true }).click();
        }
        const result = await settled(page, value => value.folders.some(folder => folder.title === title && folder.parentId === parentId));
        assert.equal(await beforeUnloadPrevented(page), false);
        oneBatch(before.state, result.evidence.state);
        const matches = result.library.folders.filter(folder => folder.title === title); assert.equal(matches.length, 1);
        if (loseReply) {
          assert.ok(committed.length - start >= 2); assert.deepEqual([...new Set(committed.slice(start))], [pendingId]);
          const requests = committedPayloads.slice(start).map(value => JSON.parse(value));
          for (const request of requests) assert.deepEqual(request, requests[0]);
          assert.equal(await repository.readIntent(repository.scope.libraryId), undefined);
        }
        return matches[0];
      };
      const parent = await create(`${prefix} parent`, null, page === native);
      const child = await create(`${prefix} child`, parent.id);
      const grandchild = await create(`${prefix} grandchild`, parent.id);
      await openFolder(page, parent.title);
      const row = page.getByRole('treeitem', { name: `フォルダー「${parent.title}」`, exact: true });
      await row.focus(); await page.keyboard.press('ArrowLeft'); assert.equal(await row.getAttribute('aria-expanded'), 'false');
      await page.keyboard.press('ArrowRight'); assert.equal(await row.getAttribute('aria-expanded'), 'true');
      await chooseFolder(page, grandchild.title);
      const beforeMove = await catalog(page);
      await page.getByRole('button', { name: 'フォルダーを移動', exact: true }).click();
      await page.getByLabel('移動先のフォルダー', { exact: true }).selectOption(child.id);
      await page.getByRole('button', { name: '移動する', exact: true }).click();
      oneBatch(beforeMove.state, (await settled(page, value => value.folders.find(folder => folder.id === grandchild.id)?.parentId === child.id)).evidence.state);
      await openFolder(page, child.title);
      for (const [itemIndex, item] of initial.items.entries()) {
        // Earlier-host folders remain in the same catalog; expand them to expose their item rows.
        const state = (await settled(page, () => true)).library;
        for (const folder of state.folders) await openFolder(page, folder.title);
        const clear = page.getByRole('button', { name: '選択を解除', exact: true });
        if (await clear.isEnabled()) await clear.click();
        await page.getByRole('checkbox', { name: `「${item.title}」を選択`, exact: true }).check();
        const beforeItemMove = await catalog(page), folderId = itemIndex ? grandchild.id : child.id;
        await page.getByRole('button', { name: '選択した資料を移動', exact: true }).click();
        await page.getByLabel('移動先のフォルダー', { exact: true }).selectOption(folderId);
        await page.getByRole('button', { name: '移動する', exact: true }).click();
        oneBatch(beforeItemMove.state, (await settled(page, value => value.items.find(value => value.id === item.id)?.folderId === folderId)).evidence.state);
      }
      await chooseFolder(page, child.title);
      await page.getByRole('button', { name: 'フォルダー名を変更', exact: true }).click();
      const renamed = `${child.title} renamed`;
      await page.getByRole('textbox', { name: 'フォルダー名', exact: true }).fill(renamed);
      await page.getByRole('button', { name: 'フォルダーを保存', exact: true }).click();
      await settled(page, value => value.folders.find(folder => folder.id === child.id)?.title === renamed);
      await chooseFolder(page, renamed);
      const beforeDelete = await settled(page, () => true);
      await page.getByRole('button', { name: 'フォルダーを削除（内容を残す）', exact: true }).click();
      await page.getByRole('button', { name: '内容を残して削除', exact: true }).click();
      const deleted = await settled(page, value => !value.folders.some(folder => folder.id === child.id));
      oneBatch(beforeDelete.evidence.state, deleted.evidence.state);
      const expected = structuredClone(beforeDelete.library);
      const promotedFolder = deleted.library.folders.find(folder => folder.id === grandchild.id)!;
      const promotedItem = deleted.library.items.find(item => item.id === initial.items[0].id)!;
      assert.ok(promotedFolder.position > Math.max(-1, ...beforeDelete.library.folders
        .filter(folder => folder.parentId === parent.id && folder.id !== child.id).map(folder => folder.position)), 'promoted child is after existing parent siblings');
      assert.ok(promotedItem.position > Math.max(-1, ...beforeDelete.library.items
        .filter(item => item.ownerId === null && item.folderId === parent.id).map(item => item.position)), 'promoted item is after existing parent items');
      expected.folders = expected.folders.filter(folder => folder.id !== child.id).map(folder => folder.id === grandchild.id
        ? { ...folder, parentId: parent.id, position: promotedFolder.position } : folder);
      expected.items = expected.items.map(item => item.id === initial.items[0].id ? { ...item, folderId: parent.id, position: promotedItem.position } : item);
      assert.deepEqual(deleted.library.folders, expected.folders); assert.deepEqual(deleted.library.items, expected.items);
      await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
      const restored = await settled(page, value => value.folders.some(folder => folder.id === child.id));
      // Catalog array insertion order is not display order; compare every field, including the restored positions, by stable ID.
      assert.deepEqual([...restored.library.folders].sort((a, b) => a.id.localeCompare(b.id)), [...beforeDelete.library.folders].sort((a, b) => a.id.localeCompare(b.id)));
      assert.deepEqual(restored.library.items, beforeDelete.library.items);
      await reopen(page);
      await page.getByRole('button', { name: '資料の変更をやり直す', exact: true }).click();
      const redone = await settled(page, value => !value.folders.some(folder => folder.id === child.id));
      assert.deepEqual(redone.library.folders, expected.folders); assert.deepEqual(redone.library.items, expected.items);
      await chooseFolder(page, parent.title);
      const noteTitle = `${prefix} folder note`;
      await page.getByRole('textbox', { name: '新しい資料の名前', exact: true }).fill(noteTitle);
      await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
      await page.getByRole('button', { name: '資料を作成', exact: true }).click();
      await page.getByRole('heading', { name: noteTitle, exact: true }).waitFor();
      await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
      await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
      await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
      await expand(page);
      const withNote = await settled(page, value => value.items.some(item => item.title === noteTitle));
      const createdNote = withNote.library.items.find(item => item.title === noteTitle)!;
      assert.equal(createdNote.folderId, parent.id);
      assert.equal(createdNote.ownerId, null);
      assert.ok(createdNote.position > Math.max(promotedFolder.position, promotedItem.position), 'created note is appended after folder and item siblings');
      await sync(page); await sync(peer);
      const remote = await settled(peer, value => value.items.some(item => item.id === createdNote.id));
      assert.deepEqual(remote.library, withNote.library);
      for (const target of pages) for (const item of initial.items) {
        const stored = (await content(target, item.id)).state;
        assert.deepEqual(stored.checkpoint, originals.get(item.id)!.checkpoint);
        assert.deepEqual(stored.history, originals.get(item.id)!.history);
      }
    }
    for (const page of pages) await reopen(page);
    assert.deepEqual((await settled(native, () => true)).library, (await settled(web, () => true)).library);
    await finish();
  } catch (error) {
    console.error('folder failure', error, JSON.stringify({ committed, committedPayloads }));
    for (const page of pages) console.error(page.url(), JSON.stringify(await catalog(page).catch(String)));
    throw error;
  }
});

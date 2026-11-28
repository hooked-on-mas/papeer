import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication, LibraryItem } from '../../../../src/runtime/edits/contracts.ts';
import type { LibrarySessionState } from '../../../../src/features/library/LibrarySession.ts';
import type { RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import { openComposition, sync as deliver } from '../../../support/documentComposition.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';
import { waitForLibraryWitness } from '../../../support/waitForLibraryWitness.ts';

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
}
async function foldAndReopen(page: Page) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  assert.equal(await button.getAttribute('aria-expanded'), 'true');
  await button.click();
  await page.getByRole('region', { name: '資料一覧', exact: true }).waitFor({ state: 'hidden' });
  await button.click();
  await page.getByRole('region', { name: '資料一覧', exact: true }).waitFor();
}
async function sync(page: Page) {
  await waitForSnapshot(() => catalog(page), value => !value.replication.running);
  await deliver(page);
  await waitForSnapshot(() => catalog(page), value => !value.replication.running && value.pending.length === 0);
}
const sameItems = (actual: readonly LibraryItem[], expected: readonly LibraryItem[]) => {
  try { assert.deepEqual([...actual].sort((a, b) => a.id.localeCompare(b.id)), [...expected].sort((a, b) => a.id.localeCompare(b.id))); return true; }
  catch { return false; }
};
async function itemsAre(page: Page, expected: readonly LibraryItem[]) {
  return waitForLibraryWitness(page, (_, session) => sameItems(session.items, expected));
}
function oneBatch(before: RepositoryState, after: RepositoryState, ids: string[]) {
  const added = after.checkpoint.batches.filter(batch => !before.checkpoint.batches.some(previous => previous.id === batch.id));
  assert.equal(added.length, 1, 'one bulk operation is one batch');
  assert.equal(added[0].kind, 'library');
  if (added[0].kind !== 'library') throw new Error('library batch required');
  assert.equal(added[0].changes.length, ids.length);
  assert.ok(added[0].changes.every(change => change.type === 'put-item'));
  assert.deepEqual(added[0].changes.flatMap(change => change.type === 'put-item' ? [change.item.id] : []).sort(), [...ids].sort());
}

for (const engine of ['chromium', 'webkit'] as const) test(`production bulk tags and read state, history and same-operation recovery (${engine})`, { timeout: 900_000 }, async t => {
  const additionalPublications = (pdf: ContentPublication) => {
    const change = pdf.libraryBatch.changes.find(value => value.type === 'put-item'); assert.ok(change?.type === 'put-item');
    change.item.tags = ['seed']; change.item.read = false; change.item.metadata = { source: 'preserve PDF metadata' };
    const note = { ...structuredClone(change.item), id: crypto.randomUUID(), kind: 'markdown' as const,
      title: 'Bulk metadata note', position: 1, tags: ['seed', 'note-only'], metadata: { source: 'preserve Markdown metadata' } };
    delete note.resourceId;
    const publication: ContentPublication = { libraryBatch: { ...structuredClone(pdf.libraryBatch), id: crypto.randomUUID(), parents: [pdf.libraryBatch.id],
      changes: [{ type: 'put-item', item: note }] }, content: { kind: 'markdown', id: note.id, version: crypto.randomUUID(),
      content: '# Unchanged bulk metadata body', appendIds: [], imageResources: [] } };
    return { publications: [publication], initialDocumentId: pdf.content!.id };
  };
  const { native, web, pages, documentId, repository, reload, finish, committed, committedPayloads, setCommitReplyLoss } =
    await openComposition(t, engine, undefined, { additionalPublications });
  const initial = await waitForSnapshot(() => catalog(native), value => !!value.session?.ready && !value.session.busy && value.session.items.length === 2);
  let expected = structuredClone([...initial.session!.items]);
  const ids = expected.map(item => item.id), originals = new Map(await Promise.all(ids.map(async id => [id, (await content(native, id)).state] as const)));
  const selectAll = async (page: Page) => {
    await expand(page);
    if (page === native) {
      await page.getByRole('checkbox', { name: `「${expected[0].title}」を選択`, exact: true }).focus();
      await page.keyboard.press('Control+a');
    } else await page.getByRole('button', { name: 'すべて選択', exact: true }).click();
    for (const item of expected) assert.equal(await page.getByRole('checkbox', { name: `「${item.title}」を選択`, exact: true }).isChecked(), true);
  };
  const selectionRetained = async (page: Page) => {
    for (const item of expected) assert.equal(await page.getByRole('checkbox', { name: `「${item.title}」を選択`, exact: true }).isChecked(), true);
  };
  const reopen = async (page: Page) => {
    await reload(page); await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
    await page.getByRole('button', { name: '読む', exact: true }).waitFor(); await expand(page);
  };
  try {
    for (const [index, page] of pages.entries()) {
      const peer = page === native ? web : native, tag = `${index ? 'web' : 'native'}-bulk-tag`;
      await selectAll(page);
      const before = await catalog(page), start = committed.length;
      const beforeTags = structuredClone(expected);
      await page.getByRole('button', { name: 'タグを追加', exact: true }).click();
      await page.getByRole('textbox', { name: 'タグ（1行に1つ）', exact: true }).fill(tag);
      await foldAndReopen(page);
      assert.equal(await page.getByRole('textbox', { name: 'タグ（1行に1つ）', exact: true }).inputValue(), tag);
      await selectionRetained(page);
      if (page === native) setCommitReplyLoss(true);
      await page.getByRole('button', { name: 'タグを適用', exact: true }).click();
      let pendingId: string | null = null;
      if (page === native) {
        const failed = await waitForSnapshot(() => catalog(page), value => !!value.session?.pendingId && !value.session.busy && !!value.session.error);
        pendingId = failed.session!.pendingId;
        assert.ok(await repository.readIntent(repository.scope.libraryId));
        await reopen(page);
        await waitForSnapshot(() => catalog(page), value => value.session?.pendingId === pendingId && !value.session.busy);
        setCommitReplyLoss(false);
        await page.getByRole('button', { name: '変更を再試行', exact: true }).click();
      }
      expected = expected.map(item => ({ ...item, tags: [...item.tags, tag] }));
      const after = await itemsAre(page, expected); oneBatch(before.state, after.state, ids);
      if (page === native) {
        assert.ok(committed.length - start >= 2); assert.deepEqual([...new Set(committed.slice(start))], [pendingId]);
        const attempts = committedPayloads.slice(start).map(value => JSON.parse(value));
        for (const attempt of attempts) assert.deepEqual(attempt, attempts[0]);
        assert.equal(await repository.readIntent(repository.scope.libraryId), undefined);
        await selectAll(page); // Selection is local UI state and is deliberately not assumed to survive reload.
      } else await selectionRetained(page);
      await sync(page); await sync(peer); await itemsAre(peer, expected);
      await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
      await itemsAre(page, beforeTags);
      await reopen(page); await itemsAre(page, beforeTags);
      await page.getByRole('button', { name: '資料の変更をやり直す', exact: true }).click();
      await itemsAre(page, expected); await sync(page); await sync(peer); await itemsAre(peer, expected);
      await selectAll(page);

      // Repeating an already present tag must finish without another durable operation.
      const beforeNoop = (await catalog(page)).state;
      const beforeNoopRequests = committed.length;
      await page.getByRole('button', { name: 'タグを追加', exact: true }).click();
      await page.getByRole('textbox', { name: 'タグ（1行に1つ）', exact: true }).fill(tag);
      await page.getByRole('button', { name: 'タグを適用', exact: true }).click();
      await page.getByRole('textbox', { name: 'タグ（1行に1つ）', exact: true }).waitFor({ state: 'hidden' });
      assert.deepEqual((await itemsAre(page, expected)).state.checkpoint, beforeNoop.checkpoint);
      assert.deepEqual((await catalog(page)).state.history, beforeNoop.history); await selectionRetained(page);
      if (page === native) assert.equal(committed.length, beforeNoopRequests, 'no-op does not send a commit');

      const beforeRead = await catalog(page), previous = structuredClone(expected);
      await page.getByRole('button', { name: '既読にする', exact: true }).click();
      expected = expected.map(item => ({ ...item, read: true }));
      const read = await itemsAre(page, expected); oneBatch(beforeRead.state, read.state, ids); await selectionRetained(page);
      await sync(page); await sync(peer); await itemsAre(peer, expected);
      await reopen(page); await itemsAre(page, expected);
      await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
      await itemsAre(page, previous);
      await reopen(page); await itemsAre(page, previous);
      await page.getByRole('button', { name: '資料の変更をやり直す', exact: true }).click();
      await itemsAre(page, expected); await sync(page); await sync(peer); await itemsAre(peer, expected);

      // Return to unread so the second host also performs an actual two-item read transition.
      await selectAll(page);
      await page.getByRole('button', { name: '未読にする', exact: true }).click();
      expected = expected.map(item => ({ ...item, read: false }));
      await itemsAre(page, expected); await selectionRetained(page);
      await sync(page); await sync(peer); await itemsAre(peer, expected);

      const beforeRemove = await catalog(page), tagsBeforeRemove = structuredClone(expected);
      await page.getByRole('button', { name: 'タグを削除', exact: true }).click();
      await page.getByRole('checkbox', { name: `削除するタグ「${tag}」`, exact: true }).check();
      await foldAndReopen(page);
      assert.equal(await page.getByRole('checkbox', { name: `削除するタグ「${tag}」`, exact: true }).isChecked(), true);
      await selectionRetained(page);
      await page.getByRole('button', { name: 'タグを適用', exact: true }).click();
      expected = expected.map(item => ({ ...item, tags: item.tags.filter(value => value !== tag) }));
      oneBatch(beforeRemove.state, (await itemsAre(page, expected)).state, ids); await selectionRetained(page);
      await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
      await itemsAre(page, tagsBeforeRemove);
      await page.getByRole('button', { name: '資料の変更をやり直す', exact: true }).click();
      await itemsAre(page, expected);
      await sync(page); await sync(peer); await itemsAre(peer, expected);

      const singleId = ids[0], single = expected.find(item => item.id === singleId)!;
      const editTags = () => page.getByRole('button', { name: `「${single.title}」のタグを編集`, exact: true }).click();
      await editTags();
      const input = page.getByRole('textbox', { name: 'タグ（1行に1つ）', exact: true });
      assert.equal(await input.inputValue(), single.tags.join('\n'));
      const beforeReplace = await catalog(page), tagsBeforeReplace = structuredClone(expected);
      const replacement = [`replacement-${index}`, 'seed'];
      await input.fill(replacement.join('\n'));
      await foldAndReopen(page);
      assert.equal(await input.inputValue(), replacement.join('\n'));
      await selectionRetained(page);
      await page.getByRole('button', { name: 'タグを適用', exact: true }).click();
      expected = expected.map(item => item.id === singleId ? { ...item, tags: replacement } : item);
      oneBatch(beforeReplace.state, (await itemsAre(page, expected)).state, [singleId]);
      await selectionRetained(page);
      await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
      await itemsAre(page, tagsBeforeReplace);
      await page.getByRole('button', { name: '資料の変更をやり直す', exact: true }).click();
      await itemsAre(page, expected);

      const unchanged = await catalog(page);
      const unchangedRequests = committed.length;
      await editTags(); assert.equal(await input.inputValue(), replacement.join('\n'));
      await page.getByRole('button', { name: 'タグを適用', exact: true }).click();
      await input.waitFor({ state: 'hidden' });
      const noop = await itemsAre(page, expected);
      assert.deepEqual(noop.state.checkpoint, unchanged.state.checkpoint);
      assert.deepEqual(noop.state.history, unchanged.state.history);
      if (page === native) assert.equal(committed.length, unchangedRequests, 'unchanged replacement does not send a commit');

      const beforeEmpty = await catalog(page), tagsBeforeEmpty = structuredClone(expected);
      await editTags(); await input.fill('');
      await page.getByRole('button', { name: 'タグを適用', exact: true }).click();
      expected = expected.map(item => item.id === singleId ? { ...item, tags: [] } : item);
      oneBatch(beforeEmpty.state, (await itemsAre(page, expected)).state, [singleId]);
      await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
      expected = tagsBeforeEmpty; await itemsAre(page, expected);
      await sync(page); await sync(peer); await itemsAre(peer, expected);
      for (const target of pages) for (const id of ids) {
        const current = (await content(target, id)).state;
        assert.deepEqual(current.checkpoint, originals.get(id)!.checkpoint, 'tags/read never modify body or annotations');
        assert.deepEqual(current.history, originals.get(id)!.history);
      }
    }
    // External peer input uses the actual repository, never an editor/session mutation.
    await expand(native);
    const conflictedItem = expected[0];
    await native.getByRole('button', { name: `「${conflictedItem.title}」のタグを編集`, exact: true }).click();
    const unchangedInput = native.getByRole('textbox', { name: 'タグ（1行に1つ）', exact: true });
    const capturedText = await unchangedInput.inputValue();
    assert.equal(capturedText, conflictedItem.tags.join('\n'));
    const currentLibrary = await repository.read(repository.scope.libraryId);
    assert.equal(currentLibrary.heads.length, 1);
    const externalTags = [...conflictedItem.tags, 'external-peer-tag'];
    const externalBatchId = crypto.randomUUID();
    assert.equal((await repository.commit({ kind: 'library', id: externalBatchId, libraryId: repository.scope.libraryId,
      targetId: repository.scope.libraryId, parents: [currentLibrary.heads[0]],
      changes: [{ type: 'put-item', item: { ...structuredClone(conflictedItem), tags: externalTags } }] })).status, 'durable');
    const afterExternal = await repository.read(repository.scope.libraryId), beforeConflictRequests = committed.length;
    await native.getByRole('button', { name: 'タグを適用', exact: true }).click();
    await native.getByRole('alert').filter({ hasText: 'タグが別の操作' }).waitFor();
    await unchangedInput.waitFor(); assert.equal(await unchangedInput.inputValue(), capturedText);
    assert.equal(committed.length, beforeConflictRequests, 'unchanged stale input must not send a commit');
    assert.deepEqual((await repository.read(repository.scope.libraryId)).checkpoint, afterExternal.checkpoint);
    await native.getByRole('button', { name: 'タグ編集を取り消す', exact: true }).click();
    expected = expected.map(item => item.id === conflictedItem.id ? { ...item, tags: externalTags } : item);
    await sync(native); await sync(web); await itemsAre(native, expected); await itemsAre(web, expected);
    for (const target of pages) for (const id of ids) {
      const current = (await content(target, id)).state;
      assert.deepEqual(current.checkpoint, originals.get(id)!.checkpoint);
      assert.deepEqual(current.history, originals.get(id)!.history);
    }
    for (const page of pages) { await reopen(page); await itemsAre(page, expected); }
    assert.deepEqual((await catalog(native)).state.checkpoint, (await catalog(web)).state.checkpoint);
    assert.equal(await native.locator('[data-content-document]').getAttribute('data-content-document'), documentId);
    await finish();
  } catch (error) {
    // Readonly scalar timing rings only; no repository calls or transport probes.
    for (const page of pages) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const evidence = await Promise.race([page.evaluate(() => {
          const value = (window as unknown as { compositionStartupEvidence?: () => { currentTimings?: unknown; deliveryTimeline?: unknown; trace?: Array<{event?:string}> } }).compositionStartupEvidence?.();
          return { currentTimings: value?.currentTimings, deliveryTimeline: value?.deliveryTimeline, libraryEvidenceErrors:value?.trace?.filter(entry=>entry.event==='library-evidence.error').slice(-4) };
        }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('pending-read diagnostic timeout')), 2_000); })]);
        t.diagnostic('Composition pending-read timing: ' + JSON.stringify({ host: new URL(page.url()).searchParams.get('host'), evidence }));
      } catch (diagnosticError) { t.diagnostic('Composition pending-read timing unavailable: ' + String(diagnosticError)); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    }
    console.error('bulk metadata failure', error, JSON.stringify({ committed, committedPayloads }));
    for (const page of pages) console.error(page.url(), JSON.stringify(await catalog(page).catch(String)));
    throw error;
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page, Route } from 'playwright-core';
import type { ContentPublication, LibrarySnapshot } from '../../../../src/runtime/edits/contracts.ts';
import type { RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import { openComposition, sync as deliver } from '../../../support/documentComposition.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';

type Memory = { session: { ready: boolean; busy: boolean; pendingId: string | null; selectedVersion: string | null }; selected?: LibrarySnapshot };
type Catalog = { state: RepositoryState; pending: unknown[]; replication: { running: boolean } };
type Navigation = { navigation: { documentId: string | null }; documentId: string | null; observedDocuments: string[]; observedMarkdown: string[] };
type MarkdownWitness = { owner: string; editor: string | null; canLeave: boolean; ready: boolean; saving: boolean; dirty: boolean; content: string; documentId: string | null };
const memory = (page: Page): Promise<Memory | null> => page.evaluate(() => (window as unknown as { compositionLibraryMemory(): Memory | null }).compositionLibraryMemory());
const catalog = (page: Page): Promise<Catalog> => page.evaluate(() => (window as unknown as { compositionLibraryEvidence(): Promise<Catalog> }).compositionLibraryEvidence());
const navigation = (page: Page): Promise<Navigation> => page.evaluate(() => (window as unknown as { compositionNavigationEvidence(): Navigation }).compositionNavigationEvidence());
const markdown = (page: Page, id: string): Promise<MarkdownWitness | null> => page.evaluate(id => (window as unknown as {
  compositionMarkdownSessionWitness(id: string): MarkdownWitness | null;
}).compositionMarkdownSessionWitness(id), id);
const visibleMarkdown = (page: Page, id: string): Promise<string> => page.evaluate(id => (window as unknown as {
  compositionVisibleMarkdownEditorText(id: string): string;
}).compositionVisibleMarkdownEditorText(id), id);
const unloadPrevented = (page: Page): Promise<boolean> => page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));

async function expand(page: Page) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}

// After this mutation no Native sync/deliver/reload/refresh is called until
// the real Native memory, catalog UI, durable batch and receipt all agree.
async function createAndObserveFolder(native: Page, web: Page, repository: Awaited<ReturnType<typeof openComposition>>['repository'], title: string) {
  const before = await memory(native); assert.ok(before?.selected);
  assert.equal(before.selected.folders.some(folder => folder.title === title), false);
  await web.bringToFront(); await expand(web);
  await web.getByRole('button', { name: 'フォルダーを作成', exact: true }).click();
  await web.getByRole('textbox', { name: 'フォルダー名', exact: true }).fill(title);
  await web.getByLabel('親フォルダー', { exact: true }).selectOption('');
  await web.getByRole('button', { name: 'フォルダーを保存', exact: true }).click();
  const saved = await waitForSnapshot(() => memory(web), value => !!value?.session.ready && !value.session.busy && !value.session.pendingId
    && !!value.selected?.folders.some(folder => folder.title === title));
  assert.ok(saved?.selected);
  const folders = saved.selected.folders.filter(folder => folder.title === title); assert.equal(folders.length, 1);
  const folder = folders[0], writer = await catalog(web);
  const batches = writer.state.checkpoint.batches.filter(batch => batch.kind === 'library'
    && batch.changes.some(change => change.type === 'put-folder' && change.folder.id === folder.id));
  assert.equal(batches.length, 1); const batch = batches[0];
  assert.equal(batch.libraryId, repository.scope.libraryId); assert.equal(batch.targetId, repository.scope.libraryId);
  const writerReceipt = await web.evaluate(id => (window as unknown as {
    compositionRepository(method: string, args: unknown[]): Promise<{ id: string; durable: boolean; targetId: string } | undefined>;
  }).compositionRepository('receipt', [id]), batch.id);
  assert.equal(writerReceipt?.id, batch.id); assert.equal(writerReceipt?.durable, true); assert.equal(writerReceipt?.targetId, repository.scope.libraryId);
  await native.bringToFront();
  const received = await waitForSnapshot(() => memory(native), value => !!value?.session.ready && !value.session.busy && !value.session.pendingId
    && !!value.selected?.folders.some(item => item.id === folder.id && item.title === title), 30_000);
  assert.ok(received?.selected); assert.notEqual(received.selected.version, before.selected.version);
  await native.getByRole('button', { name: `「${title}」を選択`, exact: true }).waitFor({ timeout: 25_000 });
  const durable = await repository.read(repository.scope.libraryId);
  assert.deepEqual(durable.checkpoint.batches.find(value => value.id === batch.id), batch);
  const receipt = await repository.receipt(batch.id);
  assert.equal(receipt?.id, batch.id); assert.equal(receipt?.durable, true); assert.equal(receipt?.targetId, repository.scope.libraryId);
  const peer = await native.evaluate(() => (window as unknown as { compositionAdmittedPeer(): string }).compositionAdmittedPeer());
  assert.ok(receipt?.importedBy.includes(peer));
  return { batchId: batch.id, folderId: folder.id };
}

for (const engine of ['chromium', 'webkit'] as const) test(`Native receive while current Markdown is logically deleted (${engine})`, { timeout: 300_000 }, async t => {
  let noteId = '';
  const additionalPublications = (pdf: ContentPublication) => {
    const change = pdf.libraryBatch.changes.find(value => value.type === 'put-item'); assert.ok(change?.type === 'put-item');
    const note = { ...structuredClone(change.item), id: crypto.randomUUID(), kind: 'markdown' as const, title: 'Receive state note', position: 1,
      tags: [], metadata: { source: 'receive-state fixture' } };
    delete note.resourceId; noteId = note.id;
    const publication: ContentPublication = { libraryBatch: { ...structuredClone(pdf.libraryBatch), id: crypto.randomUUID(), parents: [pdf.libraryBatch.id],
      changes: [{ type: 'put-item', item: note }] }, content: { kind: 'markdown', id: note.id, version: crypto.randomUUID(),
      content: '# Preserved deleted note', appendIds: [], imageResources: [] } };
    return { publications: [publication], initialDocumentId: pdf.content!.id };
  };
  const setup = await openComposition(t, engine, undefined, { additionalPublications });
  const { native, web, repository } = setup;
  try {
    assert.ok(noteId); await expand(native);
    await native.getByRole('button', { name: 'Receive state note', exact: true }).click();
    await native.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
    assert.equal((await navigation(native)).navigation.documentId, noteId);
    await waitForSnapshot(() => native.getByRole('button', { name: '資料一覧', exact: true }).getAttribute('aria-expanded'), value => value === 'false');
    await expand(native);
    assert.equal(await native.getByRole('button', { name: '資料一覧', exact: true }).getAttribute('aria-expanded'), 'true');
    await native.getByRole('button', { name: '「Receive state note」を削除', exact: true }).click();
    await native.getByRole('button', { name: '削除を確定', exact: true }).click();
    await native.getByRole('status').filter({ hasText: 'この資料は削除されています。新しい編集はできません。' }).waitFor();
    await waitForSnapshot(() => memory(native), value => !!value?.selected?.deletions.some(item => item.active && item.itemIds.includes(noteId)));
    // Prepare a common deletion history before the measured writer mutation.
    await deliver(native); await waitForSnapshot(() => catalog(native), value => !value.replication.running && value.pending.length === 0);
    await deliver(web); await waitForSnapshot(() => memory(web), value => !!value?.selected?.deletions.some(item => item.active && item.itemIds.includes(noteId)));
    assert.equal((await navigation(native)).navigation.documentId, noteId);
    const witness = await createAndObserveFolder(native, web, repository, `Deleted current ${engine}`);
    assert.equal((await navigation(native)).navigation.documentId, noteId);
    await native.getByRole('status').filter({ hasText: 'この資料は削除されています。新しい編集はできません。' }).waitFor();
    assert.equal(await native.getByRole('textbox', { name: 'Markdownノート', exact: true }).count(), 0);
    assert.ok((await memory(native))?.selected?.deletions.some(item => item.active && item.itemIds.includes(noteId)));
    t.diagnostic(`Deleted-current durable folder batch ${witness.batchId}; the deleted view may still poll.`);
  } finally { await setup.finish(); }
});

for (const engine of ['chromium', 'webkit'] as const) test(`Native receive while selected PDF loader is unavailable (${engine})`, { timeout: 300_000 }, async t => {
  const setup = await openComposition(t, engine);
  const { native, web, repository, documentId } = setup;
  let blockedReads = 0, forwardedReads = 0, navigationInProgress = false;
  const route = async (handler: Route) => {
    const body = handler.request().postDataJSON() as { targetId?: string } | null;
    if (body?.targetId === documentId) {
      let selected: string | null;
      try { selected = (await navigation(native)).navigation.documentId; }
      catch (error) {
        if (!navigationInProgress || !(error instanceof Error) || !error.message.includes('Execution context was destroyed')) throw error;
        await handler.abort('aborted'); return;
      }
      if (selected === documentId) { blockedReads++; await handler.fulfill({ status: 503, contentType: 'text/plain', body: 'synthetic selected loader unavailable' }); return; }
      forwardedReads++;
    }
    await handler.continue();
  };
  try {
    await native.route('**/api/edits/read', route);
    navigationInProgress = true;
    try { await setup.reloadUnavailableContent(native); } finally { navigationInProgress = false; }
    await native.getByRole('button', { name: '再試行', exact: true }).waitFor();
    assert.ok(blockedReads > 0); assert.ok(forwardedReads > 0);
    assert.equal((await navigation(native)).navigation.documentId, documentId);
    assert.equal(await native.getByLabel('PDF書き込みレイヤー', { exact: true }).count(), 0);
    await expand(native);
    const witness = await createAndObserveFolder(native, web, repository, `Unavailable current ${engine}`);
    assert.equal((await navigation(native)).navigation.documentId, documentId);
    await native.getByRole('button', { name: '再試行', exact: true }).waitFor();
    assert.equal(await native.getByLabel('PDF書き込みレイヤー', { exact: true }).count(), 0);
    // Only after the durable witness may the loader recover and do view sync.
    await native.unroute('**/api/edits/read', route);
    await native.getByRole('button', { name: '再試行', exact: true }).click();
    await native.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
    assert.equal((await navigation(native)).navigation.documentId, documentId);
    t.diagnostic(`Unavailable-loader durable folder batch ${witness.batchId}; loader recovered after witness.`);
  } finally {
    await native.unroute('**/api/edits/read', route);
    await setup.finish();
  }
});

for (const engine of ['chromium', 'webkit'] as const) test(`Native receive while a Markdown commit reply is held (${engine})`, { timeout: 300_000 }, async t => {
  let noteId = '';
  const additionalPublications = (pdf: ContentPublication) => {
    const change = pdf.libraryBatch.changes.find(value => value.type === 'put-item'); assert.ok(change?.type === 'put-item');
    const note = { ...structuredClone(change.item), id: crypto.randomUUID(), kind: 'markdown' as const, title: 'Protected receive note', position: 1,
      tags: [], metadata: { source: 'protected-receive fixture' } };
    delete note.resourceId; noteId = note.id;
    const publication: ContentPublication = { libraryBatch: { ...structuredClone(pdf.libraryBatch), id: crypto.randomUUID(), parents: [pdf.libraryBatch.id],
      changes: [{ type: 'put-item', item: note }] }, content: { kind: 'markdown', id: note.id, version: crypto.randomUUID(),
      content: '# Before held commit', appendIds: [], imageResources: [] } };
    return { publications: [publication], initialDocumentId: pdf.content!.id };
  };
  const setup = await openComposition(t, engine, undefined, { additionalPublications });
  const { native, web, repository } = setup;
  let held: ReturnType<typeof setup.holdNextCommitReply> | undefined;
  let primaryFailure = false;
  try {
    assert.ok(noteId); await expand(native);
    await native.getByRole('button', { name: 'Protected receive note', exact: true }).click();
    const editor = native.getByRole('textbox', { name: 'Markdownノート', exact: true }); await editor.waitFor();
    await waitForSnapshot(() => native.getByRole('button', { name: '資料一覧', exact: true }).getAttribute('aria-expanded'), value => value === 'false');
    await expand(native);
    assert.equal(await native.getByRole('button', { name: '資料一覧', exact: true }).getAttribute('aria-expanded'), 'true');
    const text = '# Protected draft\nCommitted reply remains held';
    held = setup.holdNextCommitReply(); await editor.fill(text);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const commitId = await Promise.race([held.received, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('held Markdown commit did not reach server')), 25_000);
    })]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    const protectedBefore = await waitForSnapshot(() => markdown(native, noteId), value => !!value?.ready && !value.canLeave && value.saving && value.content === text && !!value.editor);
    assert.ok(protectedBefore?.editor); assert.equal(protectedBefore.documentId, noteId);
    assert.equal(await visibleMarkdown(native, noteId), text); assert.equal(await unloadPrevented(native), true);
    const committed = await repository.receipt(commitId);
    assert.equal(committed?.id, commitId); assert.equal(committed?.targetId, noteId); assert.equal(committed?.durable, true);
    const witness = await createAndObserveFolder(native, web, repository, `Protected saving ${engine}`);
    const protectedAfter = await markdown(native, noteId); assert.ok(protectedAfter);
    assert.equal(protectedAfter.owner, protectedBefore.owner); assert.equal(protectedAfter.editor, protectedBefore.editor);
    assert.equal(protectedAfter.documentId, noteId); assert.equal(protectedAfter.canLeave, false); assert.equal(protectedAfter.saving, true);
    assert.equal(protectedAfter.content, text); assert.equal(await visibleMarkdown(native, noteId), text); assert.equal(await unloadPrevented(native), true);
    // Reply release and any consequent editor work happen only after the witness.
    held.release(); held = undefined;
    const settled = await waitForSnapshot(() => markdown(native, noteId), value => !!value?.ready && value.canLeave && !value.saving && !value.dirty && value.content === text);
    assert.ok(settled); assert.equal(settled.owner, protectedBefore.owner); assert.equal(settled.editor, protectedBefore.editor);
    assert.equal(await visibleMarkdown(native, noteId), text); assert.equal(await unloadPrevented(native), false);
    t.diagnostic(`Held-reply durable Markdown ${commitId}; folder ${witness.batchId} received. The same editor could not leave at the two observations.`);
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    if (held) {
      held.release();
      try { await waitForSnapshot(() => markdown(native, noteId), value => !!value?.canLeave && !value.saving, 2500); }
      catch (error) { t.diagnostic('Held-reply cleanup did not settle: ' + String(error)); }
    }
    try { await setup.finish(); }
    catch (error) { if (!primaryFailure) throw error; t.diagnostic('Held-reply cleanup failed after primary error: ' + String(error)); }
  }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Page, Route } from 'playwright-core';
import type { ContentPublication } from '../../../../src/runtime/edits/contracts.ts';
import type { LibrarySessionState } from '../../../../src/features/library/LibrarySession.ts';
import type { RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import { openComposition, sync as deliver } from '../../../support/documentComposition.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';

type Catalog = { state: RepositoryState; session?: LibrarySessionState; pending: unknown[]; replication: { running: boolean } };
const catalog = (page: Page): Promise<Catalog> => page.evaluate(() => (window as unknown as { compositionLibraryEvidence(): Promise<Catalog> }).compositionLibraryEvidence());
async function settled(page: Page, condition: (state: LibrarySessionState) => boolean) {
  return waitForSnapshot(() => catalog(page), value => !!value.session?.ready && !value.session.busy && condition(value.session));
}
async function expand(page: Page) {
  const toggle = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}
async function collapse(page: Page) {
  const toggle = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
}
async function sync(page: Page) {
  await waitForSnapshot(() => catalog(page), value => !value.replication.running);
  await deliver(page);
  await waitForSnapshot(() => catalog(page), value => !value.replication.running && value.pending.length === 0);
}
async function selectFile(page: Page, owner: string, name: string, text: string, mimeType: string) {
  await expand(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 25_000 }),
    page.getByRole('button', { name: `「${owner}」にファイルを添付`, exact: true }).click(),
  ]);
  await chooser.setFiles({ name, mimeType, buffer: Buffer.from(text) });
}
async function attachment(page: Page, id: string, text: string) {
  const view = page.locator(`[data-attachment-id="${id}"]`); await view.waitFor();
  await waitForSnapshot(() => view.locator('pre').textContent(), value => value === text);
  assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), id);
  assert.equal(await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).count(), 0);
  const observed = await page.evaluate(() => (window as unknown as { compositionNavigationEvidence(): { observedDocuments: string[]; observedMarkdown: string[] } }).compositionNavigationEvidence());
  assert.equal(observed.observedDocuments.includes(id), false); assert.equal(observed.observedMarkdown.includes(id), false);
}

for (const engine of ['chromium', 'webkit'] as const) test(`production attachment resource, exact identity, recovery and creation history (${engine})`, { timeout: 600_000 }, async t => {
  let childId = '';
  const additionalPublications = (pdf: ContentPublication) => {
    childId = crypto.randomUUID(); const put = pdf.libraryBatch.changes.find(change => change.type === 'put-item'); assert.ok(put?.type === 'put-item');
    const item = { ...structuredClone(put.item), id: childId, kind: 'markdown' as const, title: 'Child note', ownerId: put.item.id,
      folderId: null, position: 0, metadata: {}, tags: [], read: false }; delete item.resourceId;
    return { initialDocumentId: pdf.content!.id, publications: [{ libraryBatch: { ...structuredClone(pdf.libraryBatch),
      id: crypto.randomUUID(), parents: [pdf.libraryBatch.id], changes: [{ type: 'put-item' as const, item }] },
    content: { kind: 'markdown' as const, id: childId, version: crypto.randomUUID(), content: '# Child note\nNever show this instead of an attachment.', appendIds: [], imageResources: [] } }] };
  };
  const { pages, native, repository, documentId, finish, reload, publishedPayloads, setPublishReplyLoss, setIncomingEditListMode } =
    await openComposition(t, engine, undefined, { additionalPublications, allowAttachmentResources: true });
  const owner = 'Canonical PDF composition', baseline = [(await repository.read(documentId)).checkpoint, (await repository.read(childId)).checkpoint];
  try {
    for (const [index, page] of pages.entries()) {
      const peer = pages[1 - index], prefix = index ? 'Web' : 'Native', name = `${prefix}-reference.md`;
      const text = `# ${prefix} 添付\nA saved attachment with exact bytes, not the child note.\n`;
      await page.evaluate(() => {
        const revoke = URL.revokeObjectURL.bind(URL), released: string[] = [];
        URL.revokeObjectURL = url => { released.push(url); revoke(url); };
        Object.assign(window, { attachmentRevokedUrls: released });
      });
      await expand(page);
      const openOwner = page.getByRole('button', { name: `「${owner}」を開く`, exact: true }); if (await openOwner.count()) await openOwner.click();
      await page.getByRole('button', { name: 'Child note', exact: true }).click();
      await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
      await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
      await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();

      // The real native resource call fails; the browser's real IDB resource transaction hits quota.
      const resourceCalls: unknown[] = [];
      const resourceFault = async (route: Route) => { resourceCalls.push(route.request().postDataJSON()); await route.fulfill({ status: 503, body: 'resource storage unavailable' }); };
      if (page === native) await page.route('**/api/edits/store-resource', resourceFault);
      else await page.evaluate(() => {
        const original = IDBObjectStore.prototype.put;
        Object.assign(window, { attachmentQuota: true, restoreAttachmentStore: () => { IDBObjectStore.prototype.put = original; } });
        IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
          if (this.name === 'resources' && (window as unknown as { attachmentQuota: boolean }).attachmentQuota) throw new DOMException('resource quota', 'QuotaExceededError');
          return original.apply(this, args);
        };
      });
      await selectFile(page, owner, name, text, 'text/markdown');
      const failed = await settled(page, state => state.attachment?.phase === 'failed');
      assert.equal(failed.session!.items.some(item => item.title === name), false);
      assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), true);
      if (page === native) { assert.equal(resourceCalls.length, 1); await page.unroute('**/api/edits/store-resource', resourceFault); }
      else await page.evaluate(() => (window as unknown as { restoreAttachmentStore(): void }).restoreAttachmentStore());
      await page.getByRole('button', { name: '添付を再試行', exact: true }).click();
      const created = await settled(page, state => !state.pendingId && !state.attachment && state.items.some(item => item.title === name));
      const item = created.session!.items.find(item => item.title === name)!;
      assert.equal(item.kind, 'attachment'); assert.equal(item.ownerId, documentId); assert.equal(item.folderId, null);
      await attachment(page, item.id, text);
      const firstUrl = await page.getByRole('link', { name: '元のファイルをダウンロード', exact: true }).getAttribute('href'); assert.ok(firstUrl);
      setIncomingEditListMode(page,'503');
      await page.getByRole('button', { name: '同期', exact: true }).click();
      await page.getByRole('status').filter({ hasText: /^同期できません。内容は保持しています。/ }).waitFor();
      await attachment(page, item.id, text); setIncomingEditListMode(page,'normal');
      await sync(page); await sync(peer);
      await expand(peer); const showPeerOwner = peer.getByRole('button', { name: `「${owner}」を開く`, exact: true }); if (await showPeerOwner.count()) await showPeerOwner.click();
      await peer.getByRole('button', { name, exact: true }).click(); await attachment(peer, item.id, text);
      await collapse(peer); await peer.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
      await waitForSnapshot(() => peer.locator('[data-content-document]').getAttribute('data-content-document'), id => id !== item.id);
      const missingReply = native.waitForResponse(response => {
        const request = response.request();
        return new URL(response.url()).pathname === '/api/edits/read' && request.method() === 'POST'
          && (request.postDataJSON() as { targetId?: string } | null)?.targetId === item.id;
      }, { timeout: 25_000 });
      const [missingResponse] = await Promise.all([missingReply,
        assert.rejects(repository.read(item.id), /native-request-failed/, 'public Native read rejects an attachment content root'),
      ]);
      assert.equal(missingResponse.status(), 422, 'the original exact attachment read is missing, not an authority/network failure');
      assert.equal((await missingResponse.json() as { detail?: string }).detail, 'missing-target', 'an attachment has no invented content root');
      const resource = await repository.readResource(item.resourceId!); assert.ok(resource);
      assert.deepEqual(resource.bytes, new Uint8Array(Buffer.from(text)));
      assert.equal(resource.metadata.sha256, createHash('sha256').update(text).digest('hex'));
      if (page === native) assert.equal((resourceCalls[0] as { resourceId: string }).resourceId, item.resourceId);

      // Normal rename/delete Undo stays distinct from undoing the successful import itself.
      await expand(page); await page.getByRole('button', { name: `「${name}」を改名`, exact: true }).click();
      const renamed = `${prefix}-renamed.md`;
      await page.getByRole('textbox', { name: '資料の新しい名前', exact: true }).fill(renamed);
      await page.getByRole('button', { name: '名前を保存', exact: true }).click();
      await settled(page, state => state.items.some(value => value.id === item.id && value.title === renamed));
      await page.getByRole('button', { name: `「${renamed}」を削除`, exact: true }).click();
      await page.getByRole('button', { name: '削除を確定', exact: true }).click();
      await settled(page, state => state.deletedItems.some(value => value.id === item.id));
      await page.getByRole('status').filter({ hasText: /^この添付は削除されています/ }).waitFor();
      const undo = page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }), redo = page.getByRole('button', { name: '資料の変更をやり直す', exact: true });
      await undo.click(); await settled(page, state => state.items.some(value => value.id === item.id));
      await redo.click(); await settled(page, state => state.deletedItems.some(value => value.id === item.id));
      await undo.click(); await settled(page, state => state.items.some(value => value.id === item.id));
      await undo.click(); await settled(page, state => state.items.some(value => value.id === item.id && value.title === name));
      await undo.click(); const undone = await settled(page, state => state.deletedItems.some(value => value.id === item.id));
      const deletion = undone.session!.deletions.find(record => record.itemIds.includes(item.id))!;
      assert.deepEqual(deletion.observed, []);
      await redo.click(); await settled(page, state => state.items.some(value => value.id === item.id) && state.deletions.every(record => record.id !== deletion.id));
      await attachment(page, item.id, text);
      assert.deepEqual((await repository.readResource(item.resourceId!))?.bytes, resource.bytes);
      await collapse(page); await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
      await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor(); await sync(page);
      assert.equal(await page.evaluate(url => (window as unknown as { attachmentRevokedUrls: string[] }).attachmentRevokedUrls.includes(url), firstUrl), true);

      if (page === native) {
        const lostName = 'lost-reply.html', html = '<h1>Untrusted attachment</h1><script>window.attachmentExecuted=true</script>';
        setPublishReplyLoss(true); const start = publishedPayloads.length;
        await selectFile(page, owner, lostName, html, 'text/html');
        const pending = await settled(page, state => !!state.pendingId && state.pendingKind === 'create');
        const id = pending.session!.pendingId!; assert.ok(await repository.readIntent(repository.scope.libraryId));
        await reload(page); await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor(); await expand(page);
        await settled(page, state => state.pendingId === id); setPublishReplyLoss(false);
        await page.getByRole('button', { name: '作成を再試行', exact: true }).click();
        const restored = await settled(page, state => !state.pendingId && state.items.some(value => value.title === lostName));
        const restoredItem = restored.session!.items.find(value => value.title === lostName)!;
        await attachment(page, restoredItem.id, html);
        const attempts = publishedPayloads.slice(start).map(payload => JSON.parse(payload)); assert.ok(attempts.length >= 2);
        for (const attempt of attempts) assert.deepEqual(attempt, attempts[0]);
        assert.equal(await page.evaluate(() => (window as unknown as { attachmentExecuted?: boolean }).attachmentExecuted), undefined);
        await collapse(page); await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
        await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
      }
      await sync(page); await sync(peer);
      await reload(page); await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor(); await expand(page);
      const expandOwner = page.getByRole('button', { name: `「${owner}」を開く`, exact: true }); if (await expandOwner.count()) await expandOwner.click();
      await page.getByRole('button', { name, exact: true }).click(); await attachment(page, item.id, text);
      await sync(page); await sync(peer);
      assert.deepEqual((await repository.read(documentId)).checkpoint, baseline[0]); assert.deepEqual((await repository.read(childId)).checkpoint, baseline[1]);
      t.diagnostic(`${prefix}: resource failure/retry, exact attachment, bytes, rename/delete/import history and reload passed`);
    }
    await finish();
  } catch (error) {
    // Readonly scalar timing rings only; no repository calls or transport probes.
    for (const page of pages) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const evidence = await Promise.race([page.evaluate(() => {
          const value = (window as unknown as { compositionStartupEvidence?: () => { currentTimings?: unknown; deliveryTimeline?: unknown } }).compositionStartupEvidence?.();
          return { currentTimings: value?.currentTimings, deliveryTimeline: value?.deliveryTimeline };
        }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('pending-read diagnostic timeout')), 2_000); })]);
        t.diagnostic('Composition pending-read timing: ' + JSON.stringify({ host: new URL(page.url()).searchParams.get('host'), evidence }));
      } catch (diagnosticError) { t.diagnostic('Composition pending-read timing unavailable: ' + String(diagnosticError)); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    }
    console.error('attachment failure', error);
    for (const page of pages) console.error(page.url(), await page.locator('body').innerText().catch(String), JSON.stringify(await catalog(page).catch(String)));
    throw error;
  }
});

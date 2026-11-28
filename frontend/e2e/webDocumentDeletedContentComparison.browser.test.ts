import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import type { Page, Route } from 'playwright-core';
import type { ContentPublication, LibrarySnapshot, MarkdownEditBatch } from '../src/runtime/edits/contracts.ts';
import type { LibrarySessionState } from '../src/features/library/LibrarySession.ts';
import type { RepositoryState } from '../src/runtime/edits/ports.ts';
import { EditGraph } from '../src/runtime/edits/editGraph.ts';
import { markdownImageMarkup } from '../src/runtime/markdown/markdownImages.ts';
import { openComposition, sync as deliver, waitForCompositionReplicationIdle } from './support/documentComposition.ts';
import { waitForSnapshot } from './support/waitForSnapshot.ts';

type Catalog = { state: RepositoryState; session?: LibrarySessionState; pending: unknown[]; replication: { running: boolean } };
type SyncDiagnostic = { host?: 'native' | 'web'; hostIndex?: number; syncIndex: number;
  phase: 'before-idle' | 'click' | 'deliver' | 'after-idle' | 'complete'; startedAtMs: number;
  readStarted: number; readCompleted: number; readRejected: number; lastReadStartedAtMs?: number;
  lastReadCompletedAtMs?: number; last?: { pendingCount: number; running: boolean; ready?: boolean;
    busy?: boolean; pendingId: boolean }; observerError?: boolean };
const syncIdentity = new WeakMap<Page, { host: 'native' | 'web'; hostIndex: number }>();
const syncDiagnostics = new WeakMap<Page, SyncDiagnostic>();
const catalog = (page: Page): Promise<Catalog> => {
  const diagnostic = syncDiagnostics.get(page);
  if (diagnostic) { diagnostic.readStarted++; diagnostic.lastReadStartedAtMs = performance.now(); }
  const original = page.evaluate(() => (window as unknown as {
    compositionLibraryEvidence(): Promise<Catalog>;
  }).compositionLibraryEvidence());
  if (diagnostic) void original.then(value => {
    try {
      diagnostic.readCompleted++; diagnostic.lastReadCompletedAtMs = performance.now();
      diagnostic.last = { pendingCount: value.pending.length, running: value.replication.running,
        ready: value.session?.ready, busy: value.session?.busy, pendingId: !!value.session?.pendingId };
    } catch { diagnostic.observerError = true; }
  }, () => { diagnostic.readRejected++; });
  return original;
};
function snapshot(value: Catalog): LibrarySnapshot | undefined {
  const result = value.session?.selectedVersion ? new EditGraph(value.state.checkpoint).snapshot(value.session.selectedVersion) : undefined;
  return result?.kind === 'library' ? result : undefined;
}
async function settled(page: Page, accepts: (value: LibrarySnapshot, session: LibrarySessionState) => boolean) {
  const evidence = await waitForSnapshot(() => catalog(page), value => {
    const state = snapshot(value), session = value.session;
    return !!state && !!session?.ready && !session.busy && !session.pendingId && accepts(state, session);
  });
  return { evidence, library: snapshot(evidence)!, session: evidence.session! };
}
async function expand(page: Page, value = true) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  if ((await button.getAttribute('aria-expanded') === 'true') !== value) await button.click();
}
async function sync(page: Page) {
  const diagnostic: SyncDiagnostic = { ...syncIdentity.get(page), syncIndex: (syncDiagnostics.get(page)?.syncIndex ?? 0) + 1,
    phase: 'before-idle', startedAtMs: performance.now(), readStarted: 0, readCompleted: 0, readRejected: 0 };
  syncDiagnostics.set(page, diagnostic);
  try {
    await waitForCompositionReplicationIdle(page);
    diagnostic.phase = 'click';
    await page.getByRole('button', { name: '同期', exact: true }).click();
    diagnostic.phase = 'deliver';
    await deliver(page);
    diagnostic.phase = 'after-idle';
    await waitForSnapshot(() => catalog(page), value => !value.replication.running && value.pending.length === 0);
    diagnostic.phase = 'complete';
  } catch (error) {
    console.error('deleted-content-sync-last-sample', JSON.stringify({ ...diagnostic, failedAtMs: performance.now() }));
    throw error;
  }
}
function tallPng() {
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(2400, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(Array.from({ length: 2400 }, () => [0, 30, 80, 140]).flat()))), chunk('IEND', Buffer.alloc(0))]);
}

for (const engine of ['chromium', 'webkit'] as const) test(`production deleted Markdown comparison preserves versions, images and catalog restoration (${engine})`, { timeout: 420_000 }, async t => {
  const noteIds: string[] = [];
  const additionalPublications = (pdf: ContentPublication) => {
    const original = pdf.libraryBatch.changes.find(change => change.type === 'put-item'); assert.ok(original?.type === 'put-item');
    let parent = pdf.libraryBatch.id;
    const publications = [0, 1].map(index => {
      const id = crypto.randomUUID(); noteIds.push(id);
      const item = { ...structuredClone(original.item), id, kind: 'markdown' as const,
        title: `Comparison child ${index + 1}`, ownerId: pdf.content!.id, folderId: null, position: index };
      delete item.resourceId;
      const libraryBatch = { ...structuredClone(pdf.libraryBatch), id: crypto.randomUUID(), parents: [parent], changes: [{ type: 'put-item' as const, item }] };
      parent = libraryBatch.id;
      return { libraryBatch, content: { kind: 'markdown' as const, id, version: crypto.randomUUID(),
        content: `# Observed child ${index + 1}\n\n${'Observed paragraph.\n\n'.repeat(80)}`, appendIds: [], imageResources: [] } };
    });
    return { publications, initialDocumentId: pdf.content!.id };
  };
  const { native, web, pages, documentId, repository, publishThirdPeerRecord, finish, committed, committedPayloads, setCommitReplyLoss } =
    await openComposition(t, engine, undefined, { additionalPublications, allowImageResources: true });
  pages.forEach((page, hostIndex) => syncIdentity.set(page, { host: hostIndex === 0 ? 'native' : 'web', hostIndex }));
  const initial = (await settled(native, value => value.items.length === 3)).library;
  const owner = initial.items.find(item => item.id === documentId)!;
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3sAAAAASUVORK5CYII=', 'base64');
  const image = { resourceId: crypto.randomUUID(), sha256: createHash('sha256').update(bytes).digest('hex') };
  await repository.storeResource({ id: image.resourceId, sha256: image.sha256, mediaType: 'image/png', bytes });
  const imageText = markdownImageMarkup(image, 'Late image');
  const tallBytes = tallPng(), tallImage = { resourceId: crypto.randomUUID(), sha256: createHash('sha256').update(tallBytes).digest('hex') };
  await repository.storeResource({ id: tallImage.resourceId, sha256: tallImage.sha256, mediaType: 'image/png', bytes: tallBytes });
  try {
    for (const [index, page] of pages.entries()) {
      const noteId = noteIds[index], title = `Comparison child ${index + 1}`;
      const beforeContent = await repository.read(noteId); assert.equal(beforeContent.heads.length, 1);
      const observedVersion = beforeContent.heads[0];
      await expand(page);
      await page.getByRole('button', { name: `「${owner.title}」を削除`, exact: true }).click();
      await page.getByLabel('子ノートの扱い', { exact: true }).selectOption('delete');
      await page.getByRole('button', { name: '削除を確定', exact: true }).click();
      const deleted = await settled(page, (_, state) => state.deletedItems.length === 3);
      const deletion = deleted.library.deletions.find(record => record.active && record.itemIds.includes(noteId))!;
      assert.deepEqual(new Set(deletion.itemIds), new Set([documentId, ...noteIds]));
      const late: MarkdownEditBatch = { kind: 'markdown', id: crypto.randomUUID(), libraryId: repository.scope.libraryId,
        targetId: noteId, parents: [observedVersion], content: `# Late child ${index + 1}\n\n${imageText}\n\n${'Late paragraph.\n\n'.repeat(80)}`, imageResources: [image] };
      assert.equal((await repository.commit(late)).status, 'durable');
      await sync(native); await sync(web);
      await page.getByRole('button', { name: '一覧を更新', exact: true }).click();
      await settled(page, (_, state) => state.deletedContent.find(value => value.itemId === noteId)?.state === 'unobserved');
      await page.getByRole('button', { name: `削除された「${title}」を削除時点と比較`, exact: true }).click();
      const panel = page.getByRole('region', { name: '削除した資料の比較', exact: true }); await panel.waitFor();
      const left = panel.getByRole('region', { name: '削除時点の版', exact: true });
      const right = panel.getByRole('region', { name: '現在の版', exact: true });
      await left.getByRole('heading', { name: `Observed child ${index + 1}`, exact: true }).waitFor();
      await right.getByRole('heading', { name: `Late child ${index + 1}`, exact: true }).waitFor();
      assert.equal(await panel.getByLabel('削除時点の版を選択', { exact: true }).inputValue(), observedVersion);
      assert.equal(await panel.getByLabel('現在の版を選択', { exact: true }).inputValue(), late.id);
      assert.equal(await panel.getByRole('textbox').count(), 0);
      const observed = await page.evaluate(() => (window as unknown as { compositionNavigationEvidence(): { observedMarkdown: string[] } }).compositionNavigationEvidence());
      assert.deepEqual(observed.observedMarkdown, [], 'comparison must never acquire a Markdown editing session');
      await right.getByRole('img', { name: 'Late image', exact: true }).waitFor();
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>('[aria-label="削除した資料の比較"] img');
        return !!image?.complete && image.naturalWidth === 1;
      });
      await right.getByText('Markdown全文と画像参照', { exact: true }).click();
      await right.getByText(`この版の画像参照（1件）`, { exact: true }).waitFor();
      const rightBody = right.getByLabel('現在の版の本文', { exact: true });
      const geometry = await rightBody.evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight }));
      assert.ok(geometry.content > geometry.height + 160, `comparison needs an independently scrollable viewport: ${JSON.stringify(geometry)}`);
      await rightBody.evaluate(element => { element.scrollTop = 160; });
      await waitForSnapshot(() => rightBody.evaluate(element => element.scrollTop), top => top >= 150);
      await expand(page, false); await panel.waitFor();
      assert.ok(await rightBody.evaluate(element => element.scrollTop) >= 150);
      await expand(page);

      // Two later independent edits must not silently replace the selected pair.
      const branches = [0, 1].map(branch => ({ ...late, id: crypto.randomUUID(), parents: [late.id], content: `${late.content}\nBranch ${branch}` }));
      for (const branch of branches) assert.equal((await repository.commit(branch)).status, 'durable');
      await sync(native); await sync(web);
      await panel.getByRole('button', { name: '比較を再取得', exact: true }).click();
      await panel.getByRole('status').filter({ hasText: '新しい版が届きました' }).waitFor();
      assert.equal(await panel.getByLabel('現在の版を選択', { exact: true }).inputValue(), late.id);
      assert.ok(await rightBody.evaluate(element => element.scrollTop) >= 150);
      await panel.getByRole('button', { name: '比較を閉じる', exact: true }).click();
      await page.getByRole('button', { name: `削除された「${title}」を削除時点と比較`, exact: true }).click();
      await panel.getByText('複数の版があります。比較する版を選んでください。', { exact: true }).waitFor();
      assert.equal(await panel.getByLabel('現在の版を選択', { exact: true }).inputValue(), '');
      await panel.getByLabel('現在の版を選択', { exact: true }).selectOption(branches[0].id);
      await right.getByRole('heading', { name: `Late child ${index + 1}`, exact: true }).waitFor();

      const missingParent = crypto.randomUUID(), waiting = { ...late, id: crypto.randomUUID(), parents: [missingParent],
        content: 'Waiting descendant', imageResources: [] };
      // Parent-waiting edits arrive from another replica; a local writer correctly rejects them.
      const delivered = await publishThirdPeerRecord({ batch: waiting });
      assert.equal(delivered.status, 200);
      await sync(native); await sync(web);
      assert.ok((await repository.read(noteId)).waiting.includes(waiting.id));
      await panel.getByRole('button', { name: '比較を再取得', exact: true }).click();
      await panel.getByRole('status').filter({ hasText: '編集履歴の到着を待っています' }).waitFor();
      assert.equal(await panel.getByLabel('現在の版を選択', { exact: true }).inputValue(), branches[0].id);
      assert.equal((await repository.commit({ ...late, id: missingParent, parents: [late.id], content: 'Arrived parent', imageResources: [] })).status, 'durable');
      await sync(native); await sync(web);
      for (const peer of pages) await waitForSnapshot(() => peer.evaluate(id => (window as unknown as {
        compositionObservedEvidence(id: string): Promise<{ state: RepositoryState }>;
      }).compositionObservedEvidence(id), noteId), value => value.state.waiting.length === 0 && value.state.heads.includes(waiting.id));
      await panel.getByRole('button', { name: '比較を再取得', exact: true }).click();
      await waitForSnapshot(() => panel.getByRole('status').filter({ hasText: '編集履歴の到着を待っています' }).count(), count => count === 0);

      if (!index) {
        const failRead = (route: Route) => route.request().postDataJSON()?.targetId === noteId
          ? route.fulfill({ status: 503, body: 'fixture content unavailable' }) : route.continue();
        await page.route('**/api/edits/read', failRead);
        await panel.getByRole('button', { name: '比較を再取得', exact: true }).click();
        await panel.getByRole('alert').filter({ hasText: '比較する本文を取得できませんでした' }).waitFor();
        assert.equal(await panel.getByLabel('現在の版を選択', { exact: true }).inputValue(), branches[0].id);
        await page.unroute('**/api/edits/read', failRead);
        await panel.getByRole('button', { name: '比較を再取得', exact: true }).click();
        await waitForSnapshot(() => panel.getByRole('alert').count(), count => count === 0);
      }
      // Synthetic pagehide/pageshow exercises the shared lifecycle path with real delayed image bytes and decode.
      const tall: MarkdownEditBatch = { ...late, id: crypto.randomUUID(), parents: [branches[0].id],
        content: markdownImageMarkup(tallImage, 'Tall comparison image'), imageResources: [tallImage] };
      assert.equal((await repository.commit(tall)).status, 'durable'); await sync(native); await sync(web);
      await panel.getByRole('button', { name: '比較を再取得', exact: true }).click();
      await panel.getByLabel('現在の版を選択', { exact: true }).selectOption(tall.id);
      const decodedTall = () => right.getByRole('img', { name: 'Tall comparison image', exact: true }).evaluate(image =>
        (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalHeight === 2400);
      await waitForSnapshot(decodedTall, value => value);
      await rightBody.evaluate(element => { element.scrollTop = 400; });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const remembered = await rightBody.evaluate(element => element.scrollTop); assert.ok(remembered >= 390);
      for (const cancel of [false, true]) {
        const reads = await page.evaluate(id => {
          const windowPort = window as unknown as { compositionResourceReadCounts(): Record<string, number>; compositionHoldResourceReads(id: string): void };
          windowPort.compositionHoldResourceReads(id); return windowPort.compositionResourceReadCounts()[id] ?? 0;
        }, tallImage.resourceId);
        try {
          await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
          await waitForSnapshot(() => right.getByRole('img', { name: 'Tall comparison image', exact: true }).count(), count => count === 0);
          await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
          await waitForSnapshot(() => page.evaluate(id => (window as unknown as { compositionResourceReadCounts(): Record<string, number> }).compositionResourceReadCounts()[id] ?? 0,
            tallImage.resourceId), count => count > reads);
          assert.ok(await rightBody.evaluate(element => element.scrollTop) < remembered, 'held image must reproduce the insufficient scroll extent');
          if (cancel) { await rightBody.focus(); await rightBody.press('Home'); }
        } finally {
          await page.evaluate(id => (window as unknown as { compositionReleaseResourceReads(id: string): void }).compositionReleaseResourceReads(id), tallImage.resourceId);
        }
        await waitForSnapshot(decodedTall, value => value);
        await waitForSnapshot(() => rightBody.evaluate(element => element.scrollTop), top => cancel ? top === 0 : Math.abs(top - remembered) < 1);
        await panel.getByRole('button', { name: '比較を再取得', exact: true }).click();
        assert.equal(await rightBody.evaluate(element => element.scrollTop), cancel ? 0 : remembered);
      }
      const allBefore = await Promise.all([documentId, ...noteIds].map(id => repository.read(id)));
      const beforeRestore = await catalog(page), commitStart = committed.length;
      if (!index) setCommitReplyLoss(true);
      await panel.getByRole('button', { name: '比較した資料を復元', exact: true }).click();
      if (!index) {
        await panel.getByRole('alert').filter({ hasText: '復元できませんでした' }).waitFor();
        await waitForSnapshot(() => catalog(page), value => !!value.session?.pendingId && !value.session.busy);
        assert.equal(await panel.getByLabel('現在の版を選択', { exact: true }).inputValue(), tall.id);
        setCommitReplyLoss(false);
        await page.getByRole('button', { name: '変更を再試行', exact: true }).click();
      }
      const restored = await settled(page, (_, state) => state.items.length === 3 && !state.deletedItems.length);
      const added = restored.evidence.state.checkpoint.batches.filter(batch => !beforeRestore.state.checkpoint.batches.some(before => before.id === batch.id));
      assert.equal(added.length, 1); assert.equal(added[0].kind, 'library');
      assert.deepEqual(restored.library.items, deleted.library.items);
      assert.equal(restored.library.deletions.find(record => record.id === deletion.id)?.active, false);
      if (!index) {
        assert.ok(committed.length - commitStart >= 2);
        assert.equal(new Set(committed.slice(commitStart)).size, 1);
        for (const payload of committedPayloads.slice(commitStart)) assert.deepEqual(JSON.parse(payload), JSON.parse(committedPayloads[commitStart]));
        await panel.getByRole('button', { name: '比較を閉じる', exact: true }).click();
      } else await panel.waitFor({ state: 'hidden' });
      await sync(page); await sync(page === native ? web : native);
      for (const [position, id] of [documentId, ...noteIds].entries()) {
        const after = await repository.read(id), before = allBefore[position];
        assert.deepEqual(after.checkpoint, before.checkpoint); assert.deepEqual(after.heads, before.heads); assert.deepEqual(after.history, before.history);
      }
      await settled(page === native ? web : native, (_, state) => state.items.length === 3 && !state.deletedItems.length);
    }
    await finish();
  } catch (error) {
    console.error('reference-case-error', JSON.stringify({ suite: 'deleted-content', error: error instanceof Error ? { name: error.name.slice(0,80), message: error.message.slice(0,500), stack: error.stack?.slice(0,1600) } : { name: typeof error, message: typeof error === 'string' ? error.slice(0,500) : 'non-Error exception' } }));
    for (const [host, page] of pages.entries()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const state = await Promise.race([page.evaluate(() => {
          const port = window as unknown as {
            compositionBootstrapStatus?: () => { state?: { phase?: string; locked?: boolean; error?: string }; provider?: { phase?: string; connected?: boolean; busy?: boolean; error?: string } | null };
            compositionStartupEvidence?: () => { nativeTransport?: unknown; trace?: { sequence?: number; at?: number; event?: string; lifecycleGeneration?: number; detail?: unknown }[] };
          };
          const status = port.compositionBootstrapStatus?.(), startup = port.compositionStartupEvidence?.(), trace = startup?.trace ?? [];
          const lifecycle = trace.filter(entry => ['pagehide','pageshow','registry.initialize.start','registry.initialize.settled','registry.initialize.error','registry.state'].includes(entry.event ?? '')).slice(-8).map(entry => {
            const detail = entry.detail && typeof entry.detail === 'object' ? entry.detail as Record<string, unknown> : {};
            const registry = detail.state && typeof detail.state === 'object' ? detail.state as Record<string, unknown> : detail;
            return { sequence: entry.sequence, at: entry.at, event: entry.event, lifecycleGeneration: entry.lifecycleGeneration,
              persisted: typeof detail.persisted === 'boolean' ? detail.persisted : undefined,
              ready: typeof registry.ready === 'boolean' ? registry.ready : undefined, active: typeof registry.active === 'boolean' ? registry.active : undefined,
              error: typeof registry.error === 'string' ? registry.error.slice(0,256) : typeof detail.error === 'string' ? detail.error.slice(0,256) : undefined };
          });
          return { bootstrap: status?.state && { phase: status.state.phase, locked: status.state.locked, error: status.state.error?.slice(0,256) },
            provider: status?.provider && { phase: status.provider.phase, connected: status.provider.connected, busy: status.provider.busy, error: status.provider.error?.slice(0,256) }, lifecycle, nativeTransport: startup?.nativeTransport };
        }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('reference lifecycle diagnostic timeout')), 2000); })]);
        console.error('reference-lifecycle-state', JSON.stringify({ host: host === 0 ? 'native' : 'web', state }));
      } catch (diagnosticError) { console.error('reference-lifecycle-state-unavailable', host === 0 ? 'native' : 'web', diagnosticError instanceof Error ? diagnosticError.message.slice(0,256) : 'non-Error diagnostic failure'); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    }
    for (const page of pages) console.error('deleted-comparison', page.url(), JSON.stringify(await catalog(page).catch(String)));
    throw error;
  }
});

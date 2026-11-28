import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication, ResourceMetadata } from '../src/runtime/edits/contracts.ts';
import { openComposition, markdownEvidence, markdownSync, type MarkdownDiagnostics } from './support/documentComposition.ts';

function seed(publication: ContentPublication) {
  assert.ok(publication.content);
  publication.content = { kind: 'markdown', id: publication.content.id, version: publication.content.version,
    content: '# Canonical images', appendIds: [], imageResources: [] };
  const item = publication.libraryBatch.changes.find(change => change.type === 'put-item'); assert.ok(item?.type === 'put-item');
  item.item.kind = 'markdown'; delete item.item.resourceId;
}
// Tiny deterministic real PNGs: 3 by 2 RGB pixels, independent of browser canvas encoders.
function png(rgb: number[]) {
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(3); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.from([0, ...rgb, ...rgb, ...rgb]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))]);
}
async function clean(page: Page) {
  await page.waitForFunction(() => {
    const observe = (window as unknown as { compositionMarkdownDiagnostics?: () => MarkdownDiagnostics }).compositionMarkdownDiagnostics;
    if (!observe) return false;
    const state = observe().session;
    return state.ready && !state.dirty && !state.saving && !state.imagePending && !state.imageSaving && state.durable && !state.editingBlocked;
  });
}
async function preview(page: Page, count: number) {
  await page.getByRole('button', { name: /^(プレビュー|編集)$/ }).waitFor();
  const button = page.getByRole('button', { name: 'プレビュー', exact: true });
  if (await button.count()) await button.click();
  await page.waitForFunction(count => {
    const images = [...document.querySelectorAll<HTMLImageElement>('img[src^="blob:"]')];
    return images.length === count && images.every(image => image.complete && image.naturalWidth === 3 && image.naturalHeight === 2);
  }, count);
}
async function inspectResources(page: Page, images: Buffer[]) {
  const accepted = (await markdownEvidence(page)).session.accepted!;
  assert.equal(accepted.imageResources.length, images.length);
  for (const reference of accepted.imageResources) {
    const expected = images.find(bytes => createHash('sha256').update(bytes).digest('hex') === reference.sha256); assert.ok(expected);
    const stored = await page.evaluate(id => (window as unknown as {
      compositionReadResource(id: string): Promise<{ metadata: ResourceMetadata; bytes: number[] } | undefined>;
    }).compositionReadResource(id), reference.resourceId);
    assert.ok(stored); assert.equal(stored.metadata.mediaType, 'image/png');
    assert.equal(stored.metadata.sha256, reference.sha256); assert.deepEqual(stored.bytes, Array.from(expected));
    assert.ok(accepted.content.includes(reference.resourceId)); assert.ok(accepted.content.includes(reference.sha256));
  }
}
async function assertStableImagesAcrossSync(page: Page) {
  await markdownSync(page);
  assert.equal((await markdownEvidence(page)).pending.length, 0, 'no pending resource upload can contribute a read');
  const images = await page.locator('img[src^="blob:"]').elementHandles(); assert.ok(images.length);
  const before = await Promise.all(images.map(image => image.evaluate(node => ({ src: (node as HTMLImageElement).getAttribute('src'),
    width: (node as HTMLImageElement).naturalWidth, height: (node as HTMLImageElement).naturalHeight }))));
  const counts = await page.evaluate(() => (window as unknown as { compositionResourceReadCounts(): Record<string, number> }).compositionResourceReadCounts());
  await markdownSync(page); await markdownSync(page);
  assert.equal(await page.locator('img[src^="blob:"]').count(), images.length);
  for (const [index, image] of images.entries()) {
    assert.deepEqual(await image.evaluate(node => ({ connected: node.isConnected, src: (node as HTMLImageElement).getAttribute('src'),
      width: (node as HTMLImageElement).naturalWidth, height: (node as HTMLImageElement).naturalHeight })),
    { connected: true, ...before[index] }, 'status updates preserve the same loaded image element and blob URL');
  }
  assert.deepEqual(await page.evaluate(() => (window as unknown as { compositionResourceReadCounts(): Record<string, number> }).compositionResourceReadCounts()), counts,
    'unchanged images must not reread resources on synchronization/status updates');
  for (const image of images) await image.dispose();
}

for (const engine of ['chromium', 'webkit'] as const) test(`production Markdown image bytes, manifest history and replication (${engine})`, { timeout: 300_000 }, async t => {
  const { pages, reload, finish, setCommitReplyLoss, committed, committedPayloads, repository, documentId } = await openComposition(t, engine, seed, { allowImageResources: true });
  const images = [png([220, 20, 40]), png([20, 100, 230])];
  try {
    for (const [index, page] of pages.entries()) {
      t.diagnostic(`${index ? 'Web' : 'Native'} actual PNG file input, paired body/manifest history`);
      const before = (await markdownEvidence(page)).session.accepted!;
      if (!index) setCommitReplyLoss(true);
      await page.getByLabel('追加する画像', { exact: true }).setInputFiles({ name: `canonical-${index}.png`, mimeType: 'image/png', buffer: images[index] });
      if (!index) {
        await page.getByRole('button', { name: '再試行', exact: true }).waitFor();
        const id = committed[committed.length - 1]; assert.ok(await repository.readIntent(documentId));
        assert.deepEqual([...new Set(committed)], [id], 'automatic retries preserve the same image append operation');
        setCommitReplyLoss(false);
        await page.getByRole('button', { name: '再試行', exact: true }).click(); await clean(page);
        assert.ok(committed.filter(value => value === id).length >= 2);
        assert.equal(new Set(committedPayloads).size, 1, 'every replay preserves the entire image append payload');
        assert.equal((await repository.read(documentId)).checkpoint.batches.filter(batch => batch.id === id).length, 1);
        assert.equal((await markdownEvidence(page)).session.accepted!.appendIds.length, 1);
      } else await clean(page);
      const appended = (await markdownEvidence(page)).session.accepted!;
      assert.equal(appended.imageResources.length, index + 1);
      await preview(page, index + 1); await inspectResources(page, images.slice(0, index + 1));
      await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await clean(page);
      const undone = (await markdownEvidence(page)).session.accepted!;
      assert.equal(undone.content, before.content); assert.deepEqual(undone.imageResources, before.imageResources);
      await page.getByRole('button', { name: 'やり直す', exact: true }).click(); await clean(page);
      const redone = (await markdownEvidence(page)).session.accepted!;
      assert.equal(redone.content, appended.content); assert.deepEqual(redone.imageResources, appended.imageResources);
      await markdownSync(page); await markdownSync(pages[1 - index]);
      assert.deepEqual((await markdownEvidence(pages[1 - index])).session.accepted, redone);
      await preview(pages[1 - index], index + 1); await inspectResources(pages[1 - index], images.slice(0, index + 1));
    }
    for (const page of pages) {
      await reload(page); await clean(page); await preview(page, 2); await inspectResources(page, images);
      await assertStableImagesAcrossSync(page);
      assert.equal((await markdownEvidence(page)).leave.status, 'allowed');
    }
    await finish();
  } catch (error) {
    for (const page of pages) console.error('Markdown image failure', page.url(), await markdownEvidence(page).catch(String));
    throw error;
  }
});

for (const engine of ['chromium', 'webkit'] as const) test(`production Markdown SVG remains an inert image resource (${engine})`, { timeout: 180_000 }, async t => {
  const { pages, reload, finish } = await openComposition(t, engine, seed, { allowImageResources: true });
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="7" height="5" onload="top.__canonicalSvgExecuted=true"><script>top.__canonicalSvgExecuted=true</script><rect width="7" height="5" fill="red"/></svg>');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const assertRendered = async (page: Page) => {
    await page.getByRole('button', { name: /^(プレビュー|編集)$/ }).waitFor();
    const toggle = page.getByRole('button', { name: 'プレビュー', exact: true });
    if (await toggle.count()) await toggle.click();
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll<HTMLImageElement>('img[src^="blob:"]')];
      return images.length === 1 && images[0].complete && images[0].naturalWidth === 7 && images[0].naturalHeight === 5;
    });
    assert.equal(await page.evaluate(() => (window as unknown as { __canonicalSvgExecuted?: boolean }).__canonicalSvgExecuted), undefined);
    assert.equal(await page.locator('svg[onload], script').filter({ hasText: 'top.__canonicalSvgExecuted' }).count(), 0);
    const snapshot = (await markdownEvidence(page)).session.accepted!;
    assert.equal(snapshot.imageResources.length, 1); assert.equal(snapshot.imageResources[0].sha256, sha256);
    const stored = await page.evaluate(id => (window as unknown as {
      compositionReadResource(id: string): Promise<{ metadata: ResourceMetadata; bytes: number[] }>;
    }).compositionReadResource(id), snapshot.imageResources[0].resourceId);
    assert.equal(stored.metadata.mediaType, 'image/svg+xml'); assert.equal(stored.metadata.sha256, sha256);
    assert.deepEqual(stored.bytes, Array.from(bytes));
  };
  await pages[0].getByLabel('追加する画像', { exact: true }).setInputFiles({ name: 'inert.svg', mimeType: 'image/svg+xml', buffer: bytes });
  await clean(pages[0]);
  await markdownSync(pages[0]); await markdownSync(pages[1]);
  for (const page of pages) {
    await assertRendered(page);
    await reload(page); await clean(page); await assertRendered(page);
    await assertStableImagesAcrossSync(page);
    assert.equal((await markdownEvidence(page)).leave.status, 'allowed');
  }
  await finish();
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication } from '../../../../src/runtime/edits/contracts.ts';
import { markdownEvidence, markdownSync, openComposition } from '../../../support/documentComposition.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';

function seed(publication: ContentPublication) {
  assert.ok(publication.content);
  publication.content = { kind: 'markdown', id: publication.content.id, version: publication.content.version,
    content: '# Shared base\n\nOriginal content', appendIds: [], imageResources: [] };
  const item = publication.libraryBatch.changes.find(change => change.type === 'put-item');
  assert.ok(item?.type === 'put-item'); item.item.kind = 'markdown'; delete item.item.resourceId;
}
const editor = (page: Page) => page.getByRole('textbox', { name: 'Markdownノート', exact: true });
const body = (page: Page) => editor(page).evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'));
async function receipt(page: Page, id: string) {
  return page.evaluate(async batchId => {
    const api = window as unknown as { compositionAdmittedPeer(): string;
      compositionRepository(method: string, args: unknown[]): Promise<{ id: string; targetId: string; durable: boolean; upload: string; importedBy: string[] } | null> };
    return { peer: api.compositionAdmittedPeer(), receipt: await api.compositionRepository('receipt', [batchId]) };
  }, id);
}

for (const engine of ['chromium', 'webkit'] as const) for (const writerHost of ['native', 'web'] as const) {
  test(`Markdown outbox survives provider list 503 and recovers (${engine}, ${writerHost} writer)`, { timeout: 600_000 }, async t => {
    const setup = await openComposition(t, engine, seed);
    const writer = setup[writerHost], peer = writerHost === 'native' ? setup.web : setup.native;
    const text = `# Saved during provider outage\n\n${writerHost} ${engine} durable body`;
    let primary: unknown, phase = 'initial';
    try {
      const before = await markdownEvidence(writer), peerBefore = await markdownEvidence(peer);
      assert.equal(before.state.heads.length, 1); assert.deepEqual(peerBefore.state.heads, before.state.heads);
      assert.equal(before.pending.length, 0);
      phase = 'provider list 503'; setup.setIncomingEditListMode(writer, '503');
      await writer.bringToFront();
      await writer.getByRole('button', { name: '同期', exact: true }).click();
      await writer.getByRole('alert').filter({ hasText: '同期できません。端末の保存内容は保持しています。再試行してください。' }).waitFor({ timeout: 25_000 });
      await waitForSnapshot(() => writer.evaluate(() => (window as unknown as {
        compositionMarkdownDiagnostics(): { replication: { running: boolean; error: string } };
      }).compositionMarkdownDiagnostics().replication), value => !value.running && !!value.error);
      phase = 'save while unavailable';
      await editor(writer).fill(text);
      await writer.getByRole('heading', { name: 'Canonical Markdown composition', exact: true }).click();
      const saved = await waitForSnapshot(() => markdownEvidence(writer), value => !value.session.dirty && value.session.durable
        && value.session.accepted?.content === text && value.pending.some(record => record.batch.id === value.session.accepted?.version));
      const id = saved.session.accepted!.version;
      const batch = saved.state.checkpoint.batches.find(value => value.id === id);
      assert.ok(batch?.kind === 'markdown'); assert.equal(batch.content, text); assert.deepEqual(batch.parents, before.state.heads);
      assert.equal(saved.pending.filter(record => record.batch.id === id).length, 1);
      const heldReceipt = await receipt(writer, id);
      assert.equal(heldReceipt.receipt?.id, id); assert.equal(heldReceipt.receipt?.targetId, setup.documentId);
      assert.equal(heldReceipt.receipt?.durable, true); assert.equal(heldReceipt.receipt?.upload, 'pending');
      assert.equal(await body(writer), text);
      await writer.getByRole('alert').filter({ hasText: '同期できません。端末の保存内容は保持しています。再試行してください。' }).waitFor({ timeout: 25_000 });
      const absent = await markdownEvidence(peer);
      assert.equal(absent.state.checkpoint.batches.some(value => value.id === id), false);
      assert.equal(absent.session.accepted?.content, peerBefore.session.accepted?.content);
      phase = 'recover and deliver'; setup.setIncomingEditListMode(writer, 'normal');
      await markdownSync(writer); await markdownSync(peer);
      const delivered = await waitForSnapshot(() => markdownEvidence(peer), value => value.session.accepted?.version === id
        && value.session.accepted.content === text && value.state.checkpoint.batches.some(batch => batch.id === id));
      assert.deepEqual(delivered.state.checkpoint.batches.filter(value => value.id === id), [batch]);
      assert.equal(await body(peer), text);
      const writerAfter = await waitForSnapshot(() => markdownEvidence(writer), value => !value.pending.some(record => record.batch.id === id));
      assert.deepEqual(writerAfter.state.checkpoint.batches.filter(value => value.id === id), [batch]);
      const uploaded = await waitForSnapshot(() => receipt(writer, id), value => value.receipt?.id === id && value.receipt.upload === 'accepted');
      assert.equal(uploaded.receipt?.upload, 'accepted');
      for (const page of [writer, peer]) {
        const result = await waitForSnapshot(() => receipt(page, id), value => !!value.peer && value.receipt?.id === id
          && value.receipt.targetId === setup.documentId && value.receipt.durable && value.receipt.importedBy.includes(value.peer));
        assert.equal(result.receipt?.id, id); assert.equal(result.receipt?.durable, true);
        assert.equal(result.receipt?.targetId, setup.documentId); assert.ok(result.receipt?.importedBy.includes(result.peer));
      }
      await writer.getByRole('alert').filter({ hasText: '同期できません。端末の保存内容は保持しています。再試行してください。' }).waitFor({ state: 'hidden', timeout: 25_000 });
    } catch (error) { primary = error; t.diagnostic(`provider list outage phase: ${phase}`); throw error; }
    finally {
      let cleanup: unknown;
      try { setup.setIncomingEditListMode(writer, 'normal'); } catch (error) { cleanup = error; }
      try { await setup.finish(); } catch (error) { cleanup ??= error; }
      if (cleanup) { if (!primary) throw cleanup; t.diagnostic(`cleanup: ${String(cleanup)}`); }
    }
  });
}

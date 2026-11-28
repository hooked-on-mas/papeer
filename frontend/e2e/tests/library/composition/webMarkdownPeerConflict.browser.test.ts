import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication } from '../../../../src/runtime/edits/contracts.ts';
import { EditGraph } from '../../../../src/runtime/edits/editGraph.ts';
import { markdownEvidence, markdownSync, openComposition, sync } from '../../../support/documentComposition.ts';
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
const quota = (page: Page, fail: boolean) => page.evaluate(value => (window as unknown as {
  compositionScratchQuota(value: boolean): void;
}).compositionScratchQuota(value), fail);
async function assertReceipts(page: Page, targetId: string, ids: string[]) {
  const data = await waitForSnapshot(() => page.evaluate(async values => {
    const api = window as unknown as {
      compositionAdmittedPeer(): string;
      compositionRepository(method: string, args: unknown[]): Promise<{ id: string; targetId: string; durable: boolean; importedBy: string[] } | null>;
    };
    return { peer: api.compositionAdmittedPeer(), receipts: await Promise.all(values.map(id => api.compositionRepository('receipt', [id]))) };
  }, ids), value => !!value.peer && value.receipts.every((receipt, index) => receipt?.id === ids[index]
    && receipt.targetId === targetId && receipt.durable && receipt.importedBy.includes(value.peer)));
  assert.ok(data.peer);
  for (const [index, receipt] of data.receipts.entries()) {
    assert.equal(receipt?.id, ids[index]); assert.equal(receipt?.targetId, targetId);
    assert.equal(receipt?.durable, true); assert.ok(receipt?.importedBy.includes(data.peer));
  }
}

for (const engine of ['chromium', 'webkit'] as const) for (const dirtyHost of ['native', 'web'] as const) {
  test(`Markdown dirty base and remote branch through ordinary provider (${engine}, ${dirtyHost} dirty)`, { timeout: 600_000 }, async t => {
    const setup = await openComposition(t, engine, seed);
    const dirty = setup[dirtyHost], peer = dirtyHost === 'native' ? setup.web : setup.native;
    const localText = `# Local draft\n\nRetained ${dirtyHost} text`;
    const remoteText = `# Peer branch\n\nDistinct ${dirtyHost} peer text`;
    let primary: unknown, phase = 'initial';
    try {
      const initial = await markdownEvidence(dirty), otherInitial = await markdownEvidence(peer);
      assert.equal(initial.state.heads.length, 1);
      const base = initial.state.heads[0];
      assert.equal(initial.session.accepted?.version, base);
      assert.equal(otherInitial.session.accepted?.version, base);
      phase = 'hold local draft'; await quota(dirty, true);
      await editor(dirty).fill(localText);
      const held = await waitForSnapshot(() => markdownEvidence(dirty), value => value.session.dirty && !value.session.durable && value.session.content === localText);
      assert.equal(held.session.accepted?.version, base);
      assert.equal(held.leave.status, 'refused');
      phase = 'peer ordinary save'; await peer.bringToFront();
      await editor(peer).fill(remoteText);
      await peer.getByRole('heading', { name: 'Canonical Markdown composition', exact: true }).click();
      const remoteSaved = await waitForSnapshot(() => markdownEvidence(peer), value => !value.session.dirty && value.session.durable && value.session.accepted?.content === remoteText);
      const remoteId = remoteSaved.session.accepted!.version;
      const remoteBatch = remoteSaved.state.checkpoint.batches.find(batch => batch.id === remoteId);
      assert.ok(remoteBatch?.kind === 'markdown'); assert.deepEqual(remoteBatch.parents, [base]);
      phase = 'remote provider delivery'; await markdownSync(peer);
      await dirty.bringToFront(); await sync(dirty);
      const received = await waitForSnapshot(() => markdownEvidence(dirty), value => value.session.pendingRemote?.version === remoteId && value.session.content === localText && value.session.dirty);
      assert.equal(received.session.accepted?.version, base); assert.equal(received.leave.status, 'refused');
      assert.equal(await body(dirty), localText);
      assert.deepEqual(received.state.checkpoint.batches.find(batch => batch.id === remoteId), remoteBatch);
      phase = 'trusted local retry'; const retry = dirty.getByRole('button', { name: '再試行', exact: true });
      await retry.waitFor({ timeout: 25_000 });
      await retry.evaluate(button => {
        const target = window as unknown as { compositionScratchQuota(fail: boolean): void; __peerConflictRetry?: { fired: boolean; dispose(): void } };
        const capture = (event: MouseEvent) => {
          if (!event.isTrusted || !(event.target instanceof Element) || event.target.closest('button') !== button) return;
          target.__peerConflictRetry!.fired = true;
          target.compositionScratchQuota(false); document.removeEventListener('click', capture, true);
        };
        target.__peerConflictRetry = { fired: false, dispose: () => document.removeEventListener('click', capture, true) };
        document.addEventListener('click', capture, true);
      });
      await retry.click();
      assert.equal(await dirty.evaluate(() => (window as unknown as { __peerConflictRetry?: { fired: boolean } }).__peerConflictRetry?.fired), true);
      const branched = await waitForSnapshot(() => markdownEvidence(dirty), value => !value.session.dirty && value.session.durable && value.state.heads.length === 2);
      const localId = branched.session.accepted!.version;
      const localBatch = branched.state.checkpoint.batches.find(batch => batch.id === localId);
      assert.ok(localBatch?.kind === 'markdown'); assert.equal(localBatch.content, localText); assert.deepEqual(localBatch.parents, [base]);
      assert.deepEqual([...branched.state.heads].sort(), [localId, remoteId].sort());
      const graph = new EditGraph(branched.state.checkpoint);
      const localSnapshot = graph.snapshot(localId), remoteSnapshot = graph.snapshot(remoteId);
      assert.ok(localSnapshot?.kind === 'markdown' && remoteSnapshot?.kind === 'markdown');
      assert.equal(localSnapshot.content, localText); assert.equal(remoteSnapshot.content, remoteText);
      phase = 'compare and adopt'; const panel = dirty.getByRole('region', { name: 'ノートの競合', exact: true });
      await panel.getByRole('button', { name: '版を比較', exact: true }).click();
      const localArticle = panel.locator('article').filter({ has: dirty.getByText(localText, { exact: true }) });
      const remoteArticle = panel.locator('article').filter({ has: dirty.getByText(remoteText, { exact: true }) });
      await localArticle.waitFor({ timeout: 25_000 }); await remoteArticle.waitFor({ timeout: 25_000 });
      await localArticle.getByRole('button', { name: 'この内容を採用', exact: true }).click();
      const resolved = await waitForSnapshot(() => markdownEvidence(dirty), value => value.state.heads.length === 1 && value.session.accepted?.content === localText && value.session.durable && !value.session.saving);
      const resolutionId = resolved.state.heads[0];
      const resolution = resolved.state.checkpoint.batches.find(batch => batch.id === resolutionId);
      assert.ok(resolution?.kind === 'resolution'); assert.deepEqual([...resolution.parents].sort(), [localId, remoteId].sort());
      assert.equal(resolution.snapshot.kind, 'markdown'); assert.equal(resolution.snapshot.content, localText);
      phase = 'resolution provider convergence'; await markdownSync(dirty); await markdownSync(peer);
      const converged = await waitForSnapshot(() => markdownEvidence(peer), value => value.state.heads.length === 1 && value.state.heads[0] === resolutionId && value.session.accepted?.content === localText);
      assert.deepEqual(converged.state.checkpoint.batches.find(batch => batch.id === resolutionId), resolution);
      assert.equal(await body(peer), localText);
      await assertReceipts(dirty, setup.documentId, [remoteId, localId, resolutionId]);
      await assertReceipts(peer, setup.documentId, [remoteId, localId, resolutionId]);
    } catch (error) { primary = error; t.diagnostic(`Markdown peer conflict phase: ${phase}`); throw error; }
    finally {
      let cleanupFailure: unknown;
      try {
        await dirty.evaluate(() => { const target = window as unknown as { __peerConflictRetry?: { dispose(): void } };
          target.__peerConflictRetry?.dispose(); delete target.__peerConflictRetry; });
      } catch (error) { cleanupFailure = error; }
      try { await quota(dirty, false); } catch (error) { cleanupFailure ??= error; }
      try { await setup.finish(); } catch (error) { cleanupFailure ??= error; }
      if (cleanupFailure) { if (!primary) throw cleanupFailure; t.diagnostic(`cleanup: ${String(cleanupFailure)}`); }
    }
  });
}

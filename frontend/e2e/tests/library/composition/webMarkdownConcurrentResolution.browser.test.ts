import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication, MarkdownEditBatch } from '../../../../src/runtime/edits/contracts.ts';
import { EditGraph } from '../../../../src/runtime/edits/editGraph.ts';
import { markdownEvidence, markdownSync, openComposition } from '../../../support/documentComposition.ts';
import { assertReceipts, commitOn, driveCount, driveResolutions, sortedHeads } from '../../../support/conflictMatrix.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';

// B11 (P5.2c "同時解決"): two hosts resolve the same two-head Markdown conflict before either sees the other's resolution.
// Neither resolution may be lost, replaced or duplicated; the two resolutions become the next conflict, which then resolves once.
function seed(publication: ContentPublication) {
  assert.ok(publication.content);
  publication.content = { kind: 'markdown', id: publication.content.id, version: publication.content.version,
    content: '# Shared base\n\nOriginal content', appendIds: [], imageResources: [] };
  const item = publication.libraryBatch.changes.find(change => change.type === 'put-item');
  assert.ok(item?.type === 'put-item'); item.item.kind = 'markdown'; delete item.item.resourceId;
}
const panel = (page: Page) => page.getByRole('region', { name: 'ノートの競合', exact: true });
const editor = (page: Page) => page.getByRole('textbox', { name: 'Markdownノート', exact: true });
const body = (page: Page) => editor(page).evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'));
const articleWith = (page: Page, text: string) => panel(page).locator('article').filter({ has: page.getByText(text, { exact: true }) });
const BASE_TEXT = '# Shared base\n\nOriginal content', NATIVE_TEXT = '# Native branch\n\nnative text', WEB_TEXT = '# Web branch\n\nweb text';
const headsOf = (page: Page, want: string[]) => waitForSnapshot(() => markdownEvidence(page),
  value => JSON.stringify(sortedHeads(value.state)) === JSON.stringify([...want].sort()) && !value.session.saving && value.session.durable);
async function converge(pages: Page[]) { for (const page of [...pages, ...pages]) { await page.bringToFront(); await markdownSync(page); } }

for (const engine of ['chromium', 'webkit'] as const) {
  test(`Markdown resolved on both hosts at once: both resolutions survive and resolve once more (${engine})`, { timeout: 600_000 }, async t => {
    const setup = await openComposition(t, engine, seed);
    const { native, web, pages, repository, documentId, finish, driveRecords } = setup;
    const libraryId = repository.scope.libraryId;
    let phase = 'initial';
    try {
      const base = (await markdownEvidence(native)).state.heads[0];
      assert.equal((await markdownEvidence(native)).session.content, BASE_TEXT);
      const batch = (parent: string, content: string): MarkdownEditBatch => ({ kind: 'markdown', id: crypto.randomUUID(), libraryId, targetId: documentId, parents: [parent], content, imageResources: [] });

      phase = 'two competing durable commits on two hosts';
      const a = batch(base, NATIVE_TEXT), b = batch(base, WEB_TEXT);
      assert.equal((await repository.commit(a)).status, 'durable'); assert.equal((await commitOn(web, b)).status, 'durable');
      await converge(pages); await headsOf(native, [a.id, b.id]); await headsOf(web, [a.id, b.id]);
      for (const page of pages) { await page.bringToFront(); await panel(page).waitFor(); await panel(page).getByRole('button', { name: '版を比較', exact: true }).click(); }
      await articleWith(native, NATIVE_TEXT).waitFor(); await articleWith(native, WEB_TEXT).waitFor();
      await articleWith(web, NATIVE_TEXT).waitFor(); await articleWith(web, WEB_TEXT).waitFor();
      assert.equal(driveResolutions(driveRecords(), documentId).length, 0);

      phase = 'both hosts adopt their own version before seeing the other resolution';
      await Promise.all([
        articleWith(native, NATIVE_TEXT).getByRole('button', { name: 'この内容を採用', exact: true }).click(),
        articleWith(web, WEB_TEXT).getByRole('button', { name: 'この内容を採用', exact: true }).click(),
      ]);
      const nativeOwn = await waitForSnapshot(() => markdownEvidence(native), value => value.state.heads.length === 1 && value.session.durable && !value.session.saving);
      const webOwn = await waitForSnapshot(() => markdownEvidence(web), value => value.state.heads.length === 1 && value.session.durable && !value.session.saving);
      const [r1, r2] = [nativeOwn.state.heads[0], webOwn.state.heads[0]];
      assert.notEqual(r1, r2, 'two independent resolution operations');
      for (const [id, state, text] of [[r1, nativeOwn.state, NATIVE_TEXT], [r2, webOwn.state, WEB_TEXT]] as const) {
        const resolution = state.checkpoint.batches.find(value => value.id === id);
        assert.ok(resolution?.kind === 'resolution'); assert.deepEqual([...resolution.parents].sort(), [a.id, b.id].sort());
        assert.ok(resolution.snapshot.kind === 'markdown'); assert.equal(resolution.snapshot.content, text);
      }

      phase = 'resolutions meet: neither is lost or replaced';
      await converge(pages);
      const nativeMeet = await headsOf(native, [r1, r2]), webMeet = await headsOf(web, [r1, r2]);
      for (const state of [nativeMeet.state, webMeet.state]) {
        for (const id of [a.id, b.id, r1, r2]) assert.ok(state.checkpoint.batches.some(value => value.id === id));
        assert.equal(new EditGraph(state.checkpoint).snapshot(r1)?.kind, 'markdown'); assert.equal(new EditGraph(state.checkpoint).snapshot(r2)?.kind, 'markdown');
      }
      assert.deepEqual(driveResolutions(driveRecords(), documentId).map(value => value.id).sort(), [r1, r2].sort());
      for (const id of [a.id, b.id, r1, r2]) assert.equal(driveCount(driveRecords(), id), 1);

      phase = 'the two resolutions are a new conflict; adopt once';
      for (const page of pages) { await page.bringToFront(); await panel(page).waitFor(); }
      await native.bringToFront();
      await panel(native).getByRole('button', { name: '版を比較', exact: true }).click();
      await articleWith(native, NATIVE_TEXT).waitFor(); await articleWith(native, WEB_TEXT).waitFor();
      await articleWith(native, WEB_TEXT).getByRole('button', { name: 'この内容を採用', exact: true }).click();
      const resolved = await waitForSnapshot(() => markdownEvidence(native), value => value.state.heads.length === 1 && value.session.durable && !value.session.saving);
      const r3 = resolved.state.heads[0]; assert.ok(![a.id, b.id, r1, r2].includes(r3));
      const third = resolved.state.checkpoint.batches.find(value => value.id === r3);
      assert.ok(third?.kind === 'resolution'); assert.deepEqual([...third.parents].sort(), [r1, r2].sort());
      assert.ok(third.snapshot.kind === 'markdown'); assert.equal(third.snapshot.content, WEB_TEXT);

      phase = 'convergence';
      await converge(pages);
      const webFinal = await headsOf(web, [r3]); await panel(web).waitFor({ state: 'detached' });
      assert.deepEqual(webFinal.state.checkpoint.batches.find(value => value.id === r3), third);
      assert.equal(await body(native), WEB_TEXT); assert.equal(await body(web), WEB_TEXT);
      assert.deepEqual(driveResolutions(driveRecords(), documentId).map(value => value.id).sort(), [r1, r2, r3].sort());
      for (const id of [a.id, b.id, r1, r2, r3]) assert.equal(driveCount(driveRecords(), id), 1);
      await assertReceipts(pages, [a.id, b.id, r1, r2, r3]);
    } catch (error) { t.diagnostic(`markdown concurrent resolution phase: ${phase}`); throw error; }
    finally { await finish(); }
  });
}

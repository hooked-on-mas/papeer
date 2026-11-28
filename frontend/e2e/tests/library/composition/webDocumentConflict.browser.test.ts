import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication, DocumentSnapshot, PageEditBatch, StickyNote } from '../../../../src/runtime/edits/contracts.ts';
import { EditGraph } from '../../../../src/runtime/edits/editGraph.ts';
import { pageExpectation } from '../../../../src/runtime/edits/documentPages.ts';
import { evidence, openComposition } from '../../../support/documentComposition.ts';
import { assertReceipts, commitOn, converge, driveCount, driveResolutions, readOn, sortedHeads } from '../../../support/conflictMatrix.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';

// B11 (P5.2a / P4.2a / P4.2b-document / P5.2b-resolution): a PDF document gets two competing heads from two different hosts
// through the ordinary provider; the ordinary "文書の競合" panel compares, goes stale on a late head, adopts and converges.
// Heads are made by real durable commits on each host (not a UI gesture); everything after that is the ordinary UI.
const noteId = crypto.randomUUID();
const NATIVE_TEXT = 'branch native text', WEB_TEXT = 'branch web text', CHILD_TEXT = 'branch web child text';
let original!: DocumentSnapshot;
function seed(publication: ContentPublication) {
  assert.ok(publication.content?.kind === 'document');
  original = publication.content;
  const note: StickyNote = { kind: 'sticky', id: noteId, text: 'conflict base text', anchor: { x: 80, y: 100 }, color: null, metadata: { label: 'conflict', createdAt: null } };
  original.pages[0].annotations = [note]; original.pages[1].annotations = [];
}
const panel = (page: Page) => page.getByRole('region', { name: '文書の競合', exact: true });
const article = (page: Page, text: string) => panel(page).locator('article').filter({ hasText: text });

async function branch(page: Page, libraryId: string, parentId: string, text: string): Promise<PageEditBatch> {
  const read = await readOn(page, original.id), snapshot = new EditGraph(read.checkpoint).snapshot(parentId);
  assert.ok(snapshot?.kind === 'document');
  const current = snapshot.pages[0], note = current.annotations.find(value => value.id === noteId);
  assert.ok(note?.kind === 'sticky');
  return { kind: 'page', id: crypto.randomUUID(), libraryId, targetId: original.id, parents: [parentId], expected: pageExpectation(current),
    changes: [{ type: 'update', annotation: { ...note, text } }] };
}
const headsOf = async (page: Page, want: string[]) => waitForSnapshot(() => evidence(page),
  value => JSON.stringify(sortedHeads(value.state)) === JSON.stringify([...want].sort()) && value.session.phase === 'idle');

for (const engine of ['chromium', 'webkit'] as const) {
  test(`PDF conflict heads from two hosts: compare, stale after a late head, adopt once and converge (${engine})`, { timeout: 600_000 }, async t => {
    const setup = await openComposition(t, engine, seed);
    const { native, web, pages, repository, finish, driveRecords } = setup;
    const libraryId = repository.scope.libraryId;
    let phase = 'initial';
    try {
      const baseRead = await readOn(native, original.id);
      assert.deepEqual(baseRead.heads, [original.version]);
      const recordsBefore = driveRecords().length;

      phase = 'two competing durable commits on two hosts';
      const a = await branch(native, libraryId, original.version, NATIVE_TEXT), b = await branch(web, libraryId, original.version, WEB_TEXT);
      assert.equal((await repository.commit(a)).status, 'durable');
      assert.equal((await commitOn(web, b)).status, 'durable');
      await converge(pages);
      const nativeState = await headsOf(native, [a.id, b.id]), webState = await headsOf(web, [a.id, b.id]);
      for (const state of [nativeState.state, webState.state]) {
        const graph = new EditGraph(state.checkpoint);
        for (const [id, text] of [[a.id, NATIVE_TEXT], [b.id, WEB_TEXT]] as const) {
          const value = graph.snapshot(id); assert.ok(value?.kind === 'document');
          assert.equal((value.pages[0].annotations[0] as StickyNote).text, text);
        }
      }
      // The provider holds each competing branch exactly once, and nothing was resolved by itself.
      assert.equal(driveCount(driveRecords(), a.id), 1); assert.equal(driveCount(driveRecords(), b.id), 1);
      assert.equal(driveResolutions(driveRecords(), original.id).length, 0);
      assert.equal(driveRecords().length - recordsBefore, 2, 'only the two branch records were added');

      phase = 'ordinary panel on both hosts';
      for (const page of pages) { await page.bringToFront(); await panel(page).waitFor(); }
      await native.bringToFront();
      await panel(native).getByRole('button', { name: '版を比較', exact: true }).click();
      await article(native, NATIVE_TEXT).waitFor(); await article(native, WEB_TEXT).waitFor();
      assert.equal(await panel(native).locator('article').count(), 2);
      assert.equal(await article(native, WEB_TEXT).getByRole('button', { name: 'この内容を採用', exact: true }).isEnabled(), true);

      phase = 'late head makes the old comparison stale';
      const c = await branch(web, libraryId, b.id, CHILD_TEXT);
      assert.equal((await commitOn(web, c)).status, 'durable');
      await converge(pages);
      await headsOf(native, [a.id, c.id]); await headsOf(web, [a.id, c.id]);
      await native.bringToFront();
      await panel(native).getByRole('status').filter({ hasText: '版が変わりました。もう一度比較してください。' }).waitFor();
      assert.equal(await article(native, WEB_TEXT).getByRole('button', { name: 'この内容を採用', exact: true }).isDisabled(), true);
      assert.equal(await article(native, NATIVE_TEXT).getByRole('button', { name: 'この内容を採用', exact: true }).isDisabled(), true);
      assert.equal(driveResolutions(driveRecords(), original.id).length, 0, 'a stale comparison never produced a resolution');
      assert.deepEqual(sortedHeads((await evidence(native)).state), [a.id, c.id].sort());

      phase = 'fresh comparison and adoption of the other host content';
      await panel(native).getByRole('button', { name: '版を比較', exact: true }).click();
      await article(native, CHILD_TEXT).waitFor(); await article(native, NATIVE_TEXT).waitFor();
      await article(native, CHILD_TEXT).getByRole('button', { name: 'この内容を採用', exact: true }).click();
      const resolved = await waitForSnapshot(() => evidence(native), value => value.state.heads.length === 1 && value.session.phase === 'idle');
      const resolutionId = resolved.state.heads[0];
      const resolution = resolved.state.checkpoint.batches.find(batch => batch.id === resolutionId);
      assert.ok(resolution?.kind === 'resolution'); assert.deepEqual([...resolution.parents].sort(), [a.id, c.id].sort());
      const childSnapshot = new EditGraph(resolved.state.checkpoint).snapshot(c.id);
      assert.ok(childSnapshot?.kind === 'document' && resolution.snapshot.kind === 'document');
      assert.deepEqual({ ...resolution.snapshot, version: '' }, { ...childSnapshot, version: '' }, 'the adopted content is exactly the chosen head content');
      assert.equal(resolution.snapshot.pages[0].annotations.length, 1);
      assert.deepEqual(resolution.snapshot.pages[1], childSnapshot.pages[1]);
      assert.deepEqual(resolution.snapshot.translation, childSnapshot.translation);
      assert.deepEqual(resolution.snapshot.deletedPages, childSnapshot.deletedPages);

      phase = 'convergence';
      await converge(pages);
      const webResolved = await headsOf(web, [resolutionId]);
      assert.deepEqual(webResolved.state.checkpoint.batches.find(batch => batch.id === resolutionId), resolution);
      await panel(web).waitFor({ state: 'detached' });
      // Not mixed, not lost, not duplicated: all four branches stay in both graphs, the provider has one resolution.
      for (const state of [(await evidence(native)).state, webResolved.state]) {
        for (const id of [a.id, b.id, c.id]) assert.ok(state.checkpoint.batches.some(batch => batch.id === id), 'competing branch preserved in the graph');
      }
      const resolutions = driveResolutions(driveRecords(), original.id);
      assert.deepEqual(resolutions.map(value => value.id), [resolutionId]);
      for (const id of [a.id, b.id, c.id, resolutionId]) assert.equal(driveCount(driveRecords(), id), 1);
      await assertReceipts(pages, [a.id, b.id, c.id, resolutionId]);
    } catch (error) { t.diagnostic(`document conflict phase: ${phase}`); throw error; }
    finally { await finish(); }
  });

  test(`PDF conflict adoption whose Native reply is lost stays unknown, guards leaving and lands exactly once (${engine})`, { timeout: 600_000 }, async t => {
    const setup = await openComposition(t, engine, seed);
    const { native, web, pages, repository, finish, driveRecords, committed, committedPayloads, setCommitReplyLoss } = setup;
    const libraryId = repository.scope.libraryId;
    let phase = 'initial';
    try {
      phase = 'two competing heads';
      const a = await branch(native, libraryId, original.version, NATIVE_TEXT), b = await branch(web, libraryId, original.version, WEB_TEXT);
      assert.equal((await repository.commit(a)).status, 'durable'); assert.equal((await commitOn(web, b)).status, 'durable');
      await converge(pages); await headsOf(native, [a.id, b.id]); await headsOf(web, [a.id, b.id]);
      await native.bringToFront();
      await panel(native).getByRole('button', { name: '版を比較', exact: true }).click();
      await article(native, WEB_TEXT).waitFor();

      phase = 'adoption commit reaches the sidecar but the reply is lost';
      const start = committed.length; setCommitReplyLoss(true);
      await article(native, WEB_TEXT).getByRole('button', { name: 'この内容を採用', exact: true }).click();
      const unknown = await waitForSnapshot(() => evidence(native), value => value.session.phase === 'unknown' || value.session.phase === 'aborted');
      assert.equal(unknown.session.phase, 'unknown', 'the lost reply is unknown, never an aborted adoption');
      assert.equal(committed.length - start >= 1, true, 'the commit really reached the sidecar durably');
      const resolutionId = committed[start];
      assert.equal(sortedHeads(unknown.state).includes(resolutionId) || unknown.state.heads.length === 2, true);
      assert.equal((await setup.native.evaluate(() => (window as unknown as { compositionScopeLeave(): Promise<{ status: string }> }).compositionScopeLeave())).status, 'refused',
        'unknown outcome refuses to leave');
      assert.ok(await repository.readIntent(original.id), 'the adoption intent is retained for the same-ID retry');
      await native.getByRole('alert').getByRole('button', { name: '再試行', exact: true }).waitFor();

      phase = 'same-ID retry';
      setCommitReplyLoss(false);
      await native.getByRole('alert').getByRole('button', { name: '再試行', exact: true }).click();
      const done = await waitForSnapshot(() => evidence(native), value => value.session.phase === 'idle' && value.state.heads.length === 1);
      assert.deepEqual(done.state.heads, [resolutionId], 'the retry confirmed the original resolution id');
      const resend = committed.slice(start);
      assert.ok(resend.length >= 2, 'the same operation was re-sent'); assert.equal(new Set(resend).size, 1, 'under one id');
      assert.equal(new Set(committedPayloads.slice(start)).size, 1, 'with the identical payload');
      const resolution = done.state.checkpoint.batches.find(batch => batch.id === resolutionId);
      assert.ok(resolution?.kind === 'resolution'); assert.deepEqual([...resolution.parents].sort(), [a.id, b.id].sort());
      const webSnapshot = new EditGraph(done.state.checkpoint).snapshot(b.id);
      assert.ok(webSnapshot?.kind === 'document' && resolution.snapshot.kind === 'document');
      assert.deepEqual({ ...resolution.snapshot, version: '' }, { ...webSnapshot, version: '' });
      assert.equal((await native.evaluate(() => (window as unknown as { compositionScopeLeave(): Promise<{ status: string }> }).compositionScopeLeave())).status, 'allowed');

      phase = 'convergence and exactly-once on the provider';
      await converge(pages);
      const webDone = await headsOf(web, [resolutionId]);
      assert.deepEqual(webDone.state.checkpoint.batches.find(batch => batch.id === resolutionId), resolution);
      assert.deepEqual(driveResolutions(driveRecords(), original.id).map(value => value.id), [resolutionId]);
      assert.equal(driveCount(driveRecords(), resolutionId), 1);
      await assertReceipts(pages, [a.id, b.id, resolutionId]);
    } catch (error) { t.diagnostic(`document conflict adoption phase: ${phase}`); throw error; }
    finally { setCommitReplyLoss(false); await finish(); }
  });
}

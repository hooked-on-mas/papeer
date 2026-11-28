import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { Folder, LibraryEditBatch, LibrarySnapshot } from '../../../../src/runtime/edits/contracts.ts';
import type { LibrarySessionState } from '../../../../src/features/library/LibrarySession.ts';
import type { RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import { EditGraph } from '../../../../src/runtime/edits/editGraph.ts';
import { openComposition } from '../../../support/documentComposition.ts';
import { assertReceipts, beforeUnloadPrevented, commitOn, converge, driveCount, driveResolutions, readOn, sortedHeads } from '../../../support/conflictMatrix.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';

// B11 (P4.2b / P5.2b-resolution): the Library catalog gets two competing heads from two different hosts through the ordinary provider.
// The ordinary "資料一覧の競合" panel (the Native frontend and the Web frontend are the same React panel on two hosts) compares, goes stale
// on a late head and adopts once; a Native adoption whose reply is lost stays unknown and lands exactly once.
type Catalog = { state: RepositoryState; session?: LibrarySessionState; pending: unknown[]; replication: { running: boolean } };
const catalog = (page: Page): Promise<Catalog> => page.evaluate(() => (window as unknown as { compositionLibraryEvidence(): Promise<Catalog> }).compositionLibraryEvidence());
const panel = (page: Page) => page.getByRole('region', { name: '資料一覧の競合', exact: true });
const article = (page: Page, text: string) => panel(page).locator('article').filter({ hasText: text });
async function expand(page: Page) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}
const folderBatch = (libraryId: string, parentId: string, title: string, position: number): LibraryEditBatch => ({ kind: 'library', id: crypto.randomUUID(), libraryId,
  targetId: libraryId, parents: [parentId], changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title, parentId: null, position } satisfies Folder }] });
const librarySnapshot = (state: RepositoryState, id: string) => { const value = new EditGraph(state.checkpoint).snapshot(id); assert.ok(value?.kind === 'library'); return value as LibrarySnapshot; };
const headsOf = (page: Page, want: string[]) => waitForSnapshot(() => catalog(page), value => JSON.stringify(sortedHeads(value.state)) === JSON.stringify([...want].sort())
  && !!value.session?.ready && !value.session.busy && !value.session.pendingId);
const titles = (value: LibrarySnapshot) => value.folders.map(folder => folder.title).sort();
const NATIVE = 'Native conflict folder', WEB = 'Web conflict folder', LATE = 'Web late conflict folder';

for (const engine of ['chromium', 'webkit'] as const) {
  test(`Library conflict heads from two hosts: compare, stale after a late head, adopt once and converge (${engine})`, { timeout: 600_000 }, async t => {
    const setup = await openComposition(t, engine);
    const { native, web, pages, repository, finish, driveRecords } = setup;
    const libraryId = repository.scope.libraryId;
    let phase = 'initial';
    try {
      const base = await readOn(native, libraryId); assert.equal(base.heads.length, 1);
      const baseHead = base.heads[0], baseTitles = titles(librarySnapshot(base, baseHead));
      const recordsBefore = driveRecords().length;

      phase = 'two competing durable commits on two hosts';
      const a = folderBatch(libraryId, baseHead, NATIVE, 100), b = folderBatch(libraryId, baseHead, WEB, 101);
      assert.equal((await repository.commit(a)).status, 'durable'); assert.equal((await commitOn(web, b)).status, 'durable');
      await converge(pages);
      const nativeState = await headsOf(native, [a.id, b.id]), webState = await headsOf(web, [a.id, b.id]);
      for (const state of [nativeState.state, webState.state]) {
        assert.deepEqual(titles(librarySnapshot(state, a.id)), [...baseTitles, NATIVE].sort());
        assert.deepEqual(titles(librarySnapshot(state, b.id)), [...baseTitles, WEB].sort());
      }
      assert.equal(driveCount(driveRecords(), a.id), 1); assert.equal(driveCount(driveRecords(), b.id), 1);
      assert.equal(driveResolutions(driveRecords(), libraryId).length, 0);
      assert.equal(driveRecords().length - recordsBefore, 2);

      phase = 'ordinary panel on both hosts';
      for (const page of pages) { await page.bringToFront(); await expand(page); await panel(page).waitFor(); }
      await native.bringToFront();
      await panel(native).getByRole('button', { name: '版を比較', exact: true }).click();
      await article(native, NATIVE).waitFor(); await article(native, WEB).waitFor();
      assert.equal(await panel(native).locator('article').count(), 2);

      phase = 'late head makes the old comparison stale';
      const c = folderBatch(libraryId, b.id, LATE, 102);
      assert.equal((await commitOn(web, c)).status, 'durable');
      await converge(pages); await headsOf(native, [a.id, c.id]); await headsOf(web, [a.id, c.id]);
      await native.bringToFront();
      await panel(native).getByRole('status').filter({ hasText: '版が変わりました。もう一度比較してください。' }).waitFor();
      for (const text of [NATIVE, WEB]) assert.equal(await article(native, text).getByRole('button', { name: 'この内容を採用', exact: true }).isDisabled(), true);
      assert.equal(driveResolutions(driveRecords(), libraryId).length, 0, 'a stale comparison never produced a resolution');

      phase = 'fresh comparison and adoption of the other host content';
      await panel(native).getByRole('button', { name: '版を比較', exact: true }).click();
      await article(native, LATE).waitFor(); await article(native, NATIVE).waitFor();
      await article(native, LATE).getByRole('button', { name: 'この内容を採用', exact: true }).click();
      const resolved = await waitForSnapshot(() => catalog(native), value => value.state.heads.length === 1 && !!value.session?.ready && !value.session.busy && !value.session.pendingId);
      const resolutionId = resolved.state.heads[0];
      const resolution = resolved.state.checkpoint.batches.find(batch => batch.id === resolutionId);
      assert.ok(resolution?.kind === 'resolution'); assert.deepEqual([...resolution.parents].sort(), [a.id, c.id].sort());
      assert.ok(resolution.snapshot.kind === 'library');
      const lateSnapshot = librarySnapshot(resolved.state, c.id);
      assert.deepEqual({ ...resolution.snapshot, version: '' }, { ...lateSnapshot, version: '' }, 'the adopted catalog is exactly the chosen head');
      assert.ok(!titles(resolution.snapshot).includes(NATIVE), 'the other branch folder is not silently merged into the adopted catalog');
      assert.ok(titles(resolution.snapshot).includes(WEB) && titles(resolution.snapshot).includes(LATE));

      phase = 'convergence';
      await converge(pages);
      const webResolved = await headsOf(web, [resolutionId]);
      assert.deepEqual(webResolved.state.checkpoint.batches.find(batch => batch.id === resolutionId), resolution);
      await panel(web).waitFor({ state: 'detached' });
      for (const state of [(await catalog(native)).state, webResolved.state]) {
        for (const id of [a.id, b.id, c.id]) assert.ok(state.checkpoint.batches.some(batch => batch.id === id), 'competing branch preserved in the graph');
      }
      assert.deepEqual(driveResolutions(driveRecords(), libraryId).map(value => value.id), [resolutionId]);
      for (const id of [a.id, b.id, c.id, resolutionId]) assert.equal(driveCount(driveRecords(), id), 1);
      await assertReceipts(pages, [a.id, b.id, c.id, resolutionId]);
    } catch (error) { t.diagnostic(`library conflict phase: ${phase}`); throw error; }
    finally { await finish(); }
  });

  test(`Library conflict adoption whose Native reply is lost stays unknown, guards leaving and lands exactly once (${engine})`, { timeout: 600_000 }, async t => {
    const setup = await openComposition(t, engine);
    const { native, web, pages, repository, finish, driveRecords, committed, committedPayloads, setCommitReplyLoss } = setup;
    const libraryId = repository.scope.libraryId;
    let phase = 'initial';
    try {
      const baseHead = (await readOn(native, libraryId)).heads[0];
      phase = 'two competing heads';
      const a = folderBatch(libraryId, baseHead, NATIVE, 100), b = folderBatch(libraryId, baseHead, WEB, 101);
      assert.equal((await repository.commit(a)).status, 'durable'); assert.equal((await commitOn(web, b)).status, 'durable');
      await converge(pages); await headsOf(native, [a.id, b.id]); await headsOf(web, [a.id, b.id]);
      await native.bringToFront(); await expand(native);
      await panel(native).getByRole('button', { name: '版を比較', exact: true }).click();
      await article(native, WEB).waitFor();

      phase = 'adoption commit reaches the sidecar but the reply is lost';
      const start = committed.length; setCommitReplyLoss(true);
      await article(native, WEB).getByRole('button', { name: 'この内容を採用', exact: true }).click();
      const unknown = await waitForSnapshot(() => catalog(native), value => !value.replication.running && !!value.session?.pendingId && !value.session.busy && !!value.session.error);
      const resolutionId = unknown.session!.pendingId!;
      assert.ok(committed.length - start >= 1, 'the commit really reached the sidecar durably'); assert.equal(committed[start], resolutionId);
      assert.equal(await beforeUnloadPrevented(native), true, 'unknown outcome guards leaving');
      assert.ok(await repository.readIntent(libraryId), 'the adoption intent is retained for the same-ID retry');
      await native.getByRole('button', { name: '変更を再試行', exact: true }).waitFor();

      phase = 'same-ID retry';
      setCommitReplyLoss(false);
      await native.getByRole('button', { name: '変更を再試行', exact: true }).click();
      const done = await waitForSnapshot(() => catalog(native), value => value.state.heads.length === 1 && !!value.session?.ready && !value.session.busy && !value.session.pendingId);
      assert.deepEqual(done.state.heads, [resolutionId], 'the retry confirmed the original resolution id');
      const resend = committed.slice(start);
      assert.ok(resend.length >= 2, 'the same operation was re-sent'); assert.equal(new Set(resend).size, 1, 'under one id');
      assert.equal(new Set(committedPayloads.slice(start)).size, 1, 'with the identical payload');
      assert.equal(await beforeUnloadPrevented(native), false);
      assert.equal(await repository.readIntent(libraryId), undefined);
      const resolution = done.state.checkpoint.batches.find(batch => batch.id === resolutionId);
      assert.ok(resolution?.kind === 'resolution'); assert.deepEqual([...resolution.parents].sort(), [a.id, b.id].sort());
      assert.ok(resolution.snapshot.kind === 'library');
      assert.deepEqual({ ...resolution.snapshot, version: '' }, { ...librarySnapshot(done.state, b.id), version: '' });

      phase = 'convergence and exactly-once on the provider';
      await converge(pages);
      const webDone = await headsOf(web, [resolutionId]);
      assert.deepEqual(webDone.state.checkpoint.batches.find(batch => batch.id === resolutionId), resolution);
      assert.deepEqual(driveResolutions(driveRecords(), libraryId).map(value => value.id), [resolutionId]);
      assert.equal(driveCount(driveRecords(), resolutionId), 1);
      await assertReceipts(pages, [a.id, b.id, resolutionId]);
    } catch (error) { t.diagnostic(`library conflict adoption phase: ${phase}`); throw error; }
    finally { setCommitReplyLoss(false); await finish(); }
  });
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { EditGraph } from '../../../../src/runtime/edits/editGraph.ts';
import type { RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import type { LibrarySessionState } from '../../../../src/features/library/LibrarySession.ts';
import { openComposition } from '../../../support/documentComposition.ts';
import { beforeUnloadPrevented } from '../../../support/conflictMatrix.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';
import * as U from '../../../support/unknownNavigation.ts';

// B13-g (P4.3a / T17), Library catalog: the commit of a catalog edit (mark a note as read) is UNKNOWN (durable in the host's store, reply lost).
// WHAT THE PRODUCT DOES (observed, and what these tests pin): the Library's unknown outcome is NOT part of the content navigation leave guard.
// `ContentNavigationSession` only consults the CURRENT document controller's `prepareClose` / `canClose`; the catalog session is guarded by
// `beforeunload` / the scope leave (`DocumentEditSessions.prepareLeave`), not by `current-blocked`. So a citation click, back / forward and a switch through
// the catalog are NOT refused here; what must hold regardless is that the unknown catalog edit survives them (same pending id, same retained intent,
// leave still refused) and that the same-ID retry afterwards confirms it exactly once. Whether navigation should ALSO be refused while the
// catalog is unknown is a product decision (判断事項 G-D1 in IMPL-r161-b13g.md); the "navigation is allowed" assertions below are marked as pinning the current
// behaviour and are the ones to flip if G-D1 decides otherwise.
// Two hosts = two separate compositions / peer IDs (Native: real sidecar, reply dropped on HTTP; Web: IndexedDB, reply lost by the fixture hook).
// Not Native GUI, not real Google, not Safari / iPhone, not the built web-dist.
type Catalog = { state: RepositoryState; session?: LibrarySessionState };
const catalog = (page: Page) => page.evaluate(() => (window as unknown as { compositionLibraryEvidence(): Promise<Catalog> }).compositionLibraryEvidence());
const readIntent = (page: Page, id: string) => page.evaluate(id => (window as unknown as { compositionReadIntent(id: string): Promise<unknown> }).compositionReadIntent(id), id);

for (const engine of ['chromium', 'webkit'] as const) for (const host of ['native', 'web'] as const) {
  test(`Library unknown on ${host}: navigation is not refused by the catalog's unknown (pinned, G-D1), the unknown catalog edit survives it and the same-ID retry confirms (${engine})`, { timeout: 600_000 }, async t => {
    const { ids, seed, additionalPublications } = U.makeSeed();
    const setup = await openComposition(t, engine, seed, { additionalPublications });
    const page = host === 'native' ? setup.native : setup.web;
    const libraryId = setup.repository.scope.libraryId;
    let phase = 'initial';
    const settle = async (id: string) => { await page.locator(`[data-content-document="${id}"]`).waitFor(); };
    const expectAt = async (id: string, back: string[], forward: string[], label: string) => {
      const state = await waitForSnapshot(() => U.nav(page), value => value.documentId === id && !value.navigation.busy && value.navigation.documentId === id);
      assert.equal(await U.shownId(page), id, `${label}: the real DOM shows the document`);
      assert.deepEqual(U.history(state), { back, forward }, `${label}: history`);
      return state;
    };
    try {
      setup.beginContentNavigation();
      await page.bringToFront();

      phase = 'history noteB -> noteA -> pdf -> back to noteA';
      await expectAt(ids.noteB, [], [], 'start');
      await U.openFromCatalog(page, U.TITLE.noteA, ids.noteA);
      await U.showPreview(page); await U.citationLink(page, 'unknown 引用 上').click();
      await settle(ids.pdf); await expectAt(ids.pdf, [ids.noteB, ids.noteA], [], 'pdf by citation');
      await U.backButton(page).click(); await settle(ids.noteA); await expectAt(ids.noteA, [ids.noteB], [ids.pdf], 'back to noteA');
      const before = await catalog(page);
      assert.equal(before.session!.items.find(item => item.id === ids.noteB)!.read, false);

      phase = 'the catalog edit commit is durable but its reply is lost';
      await U.expandCatalog(page);
      await U.setReplyLoss(setup, host, true);
      const mark = await U.markAttempts(setup, host);
      await page.getByRole('checkbox', { name: `「${U.TITLE.noteB}」を選択`, exact: true }).check();
      await page.getByRole('button', { name: '既読にする', exact: true }).click();
      const failed = await waitForSnapshot(() => catalog(page), value => !!value.session?.pendingId && !value.session.busy && !!value.session.error);
      const pendingId = failed.session!.pendingId!;
      const lostIds = [...new Set((await U.attemptsSince(setup, host, mark)).ids)];
      assert.deepEqual(lostIds, [pendingId], 'exactly one batch id reached the store and it is the pending id');
      assert.ok(failed.state.checkpoint.batches.some(batch => batch.id === pendingId), 'the catalog batch is in the host repository');
      const intent = await readIntent(page, libraryId) as { intent?: { dispatched?: boolean; request?: { batch?: { id?: string } } } } | undefined;
      assert.ok(intent); assert.equal(intent.intent?.request?.batch?.id, pendingId); assert.equal(intent.intent?.dispatched, true);

      // The invariants that must hold at every moment of the unknown catalog edit, whatever navigation does.
      const stillUnknown = async (label: string) => {
        const value = await catalog(page);
        assert.equal(value.session!.pendingId, pendingId, `${label}: same pending id`);
        assert.ok(await readIntent(page, libraryId), `${label}: the intent is kept`);
        assert.equal(await beforeUnloadPrevented(page), true, `${label}: beforeunload is still refused`);
        const leave = await U.scopeLeave(page);
        assert.equal(leave.status, 'refused', `${label}: scope leave is still refused`); assert.ok(leave.targets.includes(libraryId));
        assert.deepEqual([...new Set((await U.attemptsSince(setup, host, mark)).ids)], [pendingId], `${label}: only the one id was ever sent`);
      };
      await stillUnknown('after the loss');

      // PINNED CURRENT BEHAVIOUR (G-D1): none of these is refused by the catalog's unknown.
      phase = 'navigation while the catalog edit is unknown (pinned: not refused)';
      await U.showPreview(page);
      await U.proceeds(page, 'citation click', () => U.citationLink(page, 'unknown 引用 上').click(), ids.pdf, [ids.noteB, ids.noteA], []);
      await stillUnknown('after the citation click');
      await U.proceeds(page, 'back', () => U.backButton(page).click(), ids.noteA, [ids.noteB], [ids.pdf]);
      await stillUnknown('after back');
      await U.proceeds(page, 'forward', () => U.forwardButton(page).click(), ids.pdf, [ids.noteB, ids.noteA], []);
      await stillUnknown('after forward');
      await U.expandCatalog(page);
      await U.proceeds(page, 'switch to another document', () => U.catalogItem(page, U.TITLE.pdf2).click(), ids.pdf2, [ids.noteB, ids.noteA, ids.pdf], []);
      await stillUnknown('after the switch');

      phase = 'same-ID retry confirms the catalog edit';
      await U.setReplyLoss(setup, host, false);
      await U.expandCatalog(page);
      await page.getByRole('button', { name: '変更を再試行', exact: true }).click();
      const done = await waitForSnapshot(() => catalog(page), value => !value.session?.pendingId && !value.session?.busy && !value.session?.error);
      assert.equal(done.state.checkpoint.batches.filter(batch => batch.id === pendingId).length, 1, 'one batch with the original id');
      assert.ok(done.state.heads.includes(pendingId) && done.state.heads.length === 1, 'and it is the catalog head');
      const snapshot = new EditGraph(done.state.checkpoint).snapshot(pendingId); assert.ok(snapshot?.kind === 'library');
      assert.equal(snapshot.items.find(item => item.id === ids.noteB)!.read, true, 'the confirmed catalog marks the note as read');
      assert.equal(snapshot.items.filter(item => item.read).length, 1, 'and only that note');
      const attempts = await U.attemptsSince(setup, host, mark);
      assert.deepEqual([...new Set(attempts.ids)], [pendingId]);
      if (host === 'native') { assert.ok(attempts.calls >= 2, 'the same operation was re-sent'); assert.equal(new Set(attempts.payloads).size, 1, 'with the identical request body'); }
      assert.equal(await readIntent(page, libraryId), undefined, 'the intent is released');
      assert.equal(await beforeUnloadPrevented(page), false);
      assert.equal((await U.scopeLeave(page)).status, 'allowed');

      phase = 'after the confirmation navigation still works';
      await U.proceeds(page, 'back after the confirmation', () => U.backButton(page).click(), ids.pdf, [ids.noteB, ids.noteA], [ids.pdf2]);
      await U.proceeds(page, 'forward after the confirmation', () => U.forwardButton(page).click(), ids.pdf2, [ids.noteB, ids.noteA, ids.pdf], []);
      await setup.finish();
    } catch (error) { t.diagnostic(`library unknown navigation phase: ${phase}`); throw error; }
  });
}

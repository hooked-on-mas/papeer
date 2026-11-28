import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { EditGraph } from '../../../../src/runtime/edits/editGraph.ts';
import type { RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import type { DocumentEditState } from '../../../../src/features/reader/edit/DocumentEditSession.ts';
import { gesture, openComposition } from '../../../support/documentComposition.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';
import * as U from '../../../support/unknownNavigation.ts';

// B13-g (P4.3a / T17), PDF document: while a commit of a drawn stroke is UNKNOWN (durable in the host's store, reply lost), the content navigation
// leave guard (`ContentNavigationSession` -> the document controller's `prepareClose` / `canClose`) refuses (a) an annotation-location jump (the
// document view has no citation link of its own; the annotation browser's 「場所へ移動」 is its citation-style navigation, here to ANOTHER PDF),
// (b) back and forward and (c) switching to another document; after the same-ID retry confirms they all go through.
// Two hosts = two separate compositions / peer IDs (Native: real ASGI + SQLite sidecar behind the browser UI, reply dropped on the HTTP response; Web: real
// IndexedDB, reply lost at the IndexedDbPlan boundary by a fixture hook). Not Native GUI (WebView2), not real Google, not Safari / iPhone, not the built web-dist.
type Read = { state: RepositoryState; document?: DocumentEditState };
const observed = (page: Page, id: string) => page.evaluate(id => (window as unknown as { compositionObservedEvidence(id: string): Promise<Read> }).compositionObservedEvidence(id), id);
const readIntent = (page: Page, id: string) => page.evaluate(id => (window as unknown as { compositionReadIntent(id: string): Promise<unknown> }).compositionReadIntent(id), id);
const panel = (page: Page) => page.getByRole('region', { name: '付箋・ハイライト一覧', exact: true });
async function expandAnnotations(page: Page) {
  const toggle = panel(page).getByRole('button', { name: /^付箋・ハイライト一覧/ });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await panel(page).getByLabel('対象', { exact: true }).selectOption('all');
}
const otherPdfRow = (page: Page) => panel(page).locator('li').filter({ hasText: 'unknown-nav sticky B' });
const inkCount = (read: Read, id: string) => {
  const value = new EditGraph(read.state.checkpoint).snapshot(read.state.heads[0]); assert.ok(value?.kind === 'document'); assert.equal(value.id, id);
  return value.pages.flatMap(page => page.annotations).filter(annotation => annotation.kind === 'ink').length;
};

for (const engine of ['chromium', 'webkit'] as const) for (const host of ['native', 'web'] as const) {
  test(`PDF document unknown on ${host}: annotation location, back/forward and switching are refused until the same-ID retry confirms (${engine})`, { timeout: 600_000 }, async t => {
    const { ids, seed, additionalPublications } = U.makeSeed();
    const setup = await openComposition(t, engine, seed, { additionalPublications });
    const page = host === 'native' ? setup.native : setup.web;
    let phase = 'initial';
    const settle = async (id: string) => { await page.locator(`[data-content-document="${id}"]`).waitFor(); };
    const expectAt = async (id: string, back: string[], forward: string[], label: string) => {
      const state = await waitForSnapshot(() => U.nav(page), value => value.documentId === id && !value.navigation.busy && value.navigation.documentId === id);
      assert.equal(await U.shownId(page), id, `${label}: the real DOM shows the document`);
      assert.deepEqual(U.history(state), { back, forward }, `${label}: history`);
      return state;
    };
    const pdfReady = async () => { await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor(); await page.getByRole('button', { name: '読む', exact: true }).waitFor(); };
    try {
      setup.beginContentNavigation();
      await page.bringToFront();

      phase = 'history noteB -> noteA -> pdf -> pdf2 -> back to pdf';
      await expectAt(ids.noteB, [], [], 'start');
      await U.openFromCatalog(page, U.TITLE.noteA, ids.noteA); await expectAt(ids.noteA, [ids.noteB], [], 'noteA');
      await U.showPreview(page); await U.citationLink(page, 'unknown 引用 上').click();
      await settle(ids.pdf); await pdfReady(); await expectAt(ids.pdf, [ids.noteB, ids.noteA], [], 'pdf by citation');
      await U.openFromCatalog(page, U.TITLE.pdf2, ids.pdf2); await pdfReady(); await expectAt(ids.pdf2, [ids.noteB, ids.noteA, ids.pdf], [], 'pdf2');
      await U.backButton(page).click(); await settle(ids.pdf); await pdfReady();
      await expectAt(ids.pdf, [ids.noteB, ids.noteA], [ids.pdf2], 'back to pdf');
      const historyBefore = { back: [ids.noteB, ids.noteA], forward: [ids.pdf2] };
      const baseline = await observed(page, ids.pdf);
      assert.equal(inkCount(baseline, ids.pdf), 0);

      phase = 'the stroke commit is durable but its reply is lost';
      await U.setReplyLoss(setup, host, true);
      const mark = await U.markAttempts(setup, host);
      await page.getByRole('button', { name: 'ペン', exact: true }).click();
      await gesture(page, [[.2, .5], [.5, .5]]);
      await U.retryButton(page).waitFor();
      const unknown = await waitForSnapshot(() => observed(page, ids.pdf), value => value.document?.phase === 'unknown');
      assert.notEqual(unknown.document!.phase, 'aborted');
      const lostIds = [...new Set((await U.attemptsSince(setup, host, mark)).ids)];
      assert.equal(lostIds.length, 1, 'exactly one batch id reached the store');
      const lostId = lostIds[0];
      assert.ok(unknown.state.checkpoint.batches.some(batch => batch.id === lostId), 'the batch is in the host repository');
      const intent = await readIntent(page, ids.pdf) as { intent?: { dispatched?: boolean; request?: { batch?: { id?: string } } } } | undefined;
      assert.ok(intent, 'the intent is retained'); assert.equal(intent.intent?.request?.batch?.id, lostId, 'and it is the intent of the very batch that reached the store'); assert.equal(intent.intent?.dispatched, true);
      const leave = await U.scopeLeave(page);
      assert.equal(leave.status, 'refused'); assert.ok(leave.targets.includes(ids.pdf));
      await expandAnnotations(page); await otherPdfRow(page).waitFor();

      const refused = async (label: string, act: () => Promise<void>) => {
        phase = `refused: ${label}`;
        const before = await U.nav(page), revisionBefore = await U.navRevision(page);
        await act();
        const state = await U.waitOutcome(page, before, revisionBefore);
        assert.equal(state.navigation.error, 'current-blocked', `${label}: refused by the leave guard`);
        assert.equal(state.documentId, ids.pdf, `${label}: still on the document (state)`);
        assert.equal(await U.shownId(page), ids.pdf, `${label}: still on the document (DOM)`);
        assert.deepEqual(U.history(state), historyBefore, `${label}: history untouched`);
        await U.blockedAlert(page).waitFor();
        const read = await observed(page, ids.pdf);
        assert.equal(read.document!.phase, 'unknown', `${label}: still unknown`);
        assert.ok(await readIntent(page, ids.pdf), `${label}: the intent is kept`);
        assert.equal((await U.scopeLeave(page)).status, 'refused');
        const attempts = await U.attemptsSince(setup, host, mark);
        assert.deepEqual([...new Set(attempts.ids)], [lostId], `${label}: every re-send used the one original id`);
      };
      await refused('annotation location of another PDF', () => otherPdfRow(page).getByRole('button', { name: '場所へ移動', exact: true }).click());
      await refused('back', () => U.backButton(page).click());
      await refused('forward', () => U.forwardButton(page).click());
      await U.expandCatalog(page);
      await refused('switch to another document', () => U.catalogItem(page, U.TITLE.noteB).click());
      assert.equal(await U.catalogToggle(page).getAttribute('aria-expanded'), 'true', 'a refused switch leaves the catalog open');

      phase = 'same-ID retry confirms the commit';
      await U.setReplyLoss(setup, host, false);
      await U.retryButton(page).click();
      const done = await waitForSnapshot(() => observed(page, ids.pdf), value => value.document?.phase === 'idle' && !value.document.error && value.state.heads.length === 1);
      assert.deepEqual(done.state.heads, [lostId], 'the retry confirmed the original id');
      assert.equal(done.state.checkpoint.batches.filter(batch => batch.id === lostId).length, 1);
      assert.equal(inkCount(done, ids.pdf), 1, 'the stroke is in the confirmed document');
      const attempts = await U.attemptsSince(setup, host, mark);
      assert.deepEqual([...new Set(attempts.ids)], [lostId]);
      if (host === 'native') {
        assert.ok(attempts.calls >= 2, 'the same operation was re-sent'); assert.equal(new Set(attempts.payloads).size, 1, 'with the identical request body');
      }
      assert.equal(await readIntent(page, ids.pdf), undefined, 'the intent is released');
      assert.equal((await U.scopeLeave(page)).status, 'allowed');

      phase = 'after the confirmation the same operations go through';
      await U.proceeds(page, 'forward', () => U.forwardButton(page).click(), ids.pdf2, [ids.noteB, ids.noteA, ids.pdf], [], pdfReady);
      await U.proceeds(page, 'back', () => U.backButton(page).click(), ids.pdf, [ids.noteB, ids.noteA], [ids.pdf2], pdfReady);
      await expandAnnotations(page);
      await U.proceeds(page, 'annotation location of another PDF', () => otherPdfRow(page).getByRole('button', { name: '場所へ移動', exact: true }).click(), ids.pdf2, [ids.noteB, ids.noteA, ids.pdf], [], pdfReady);
      await U.proceeds(page, 'back again', () => U.backButton(page).click(), ids.pdf, [ids.noteB, ids.noteA], [ids.pdf2], pdfReady);
      await U.expandCatalog(page);
      await U.proceeds(page, 'switch to another document', () => U.catalogItem(page, U.TITLE.noteB).click(), ids.noteB, [ids.noteB, ids.noteA, ids.pdf], []);
      // The confirmed stroke is what the document holds when we come back to it.
      await U.openFromCatalog(page, U.TITLE.pdf, ids.pdf); await pdfReady();
      assert.equal(inkCount(await observed(page, ids.pdf), ids.pdf), 1);
      await setup.finish();
    } catch (error) { t.diagnostic(`document unknown navigation phase: ${phase}`); throw error; }
  });
}

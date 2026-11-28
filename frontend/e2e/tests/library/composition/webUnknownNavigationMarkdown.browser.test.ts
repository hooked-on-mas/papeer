import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { EditGraph } from '../../../../src/runtime/edits/editGraph.ts';
import type { RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import type { MarkdownEditState } from '../../../../src/features/notes/markdown/MarkdownEditSession.ts';
import { openComposition } from '../../../support/documentComposition.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';
import * as U from '../../../support/unknownNavigation.ts';

// B13-g (P4.3a / T17), Markdown note: while a commit of the note body is UNKNOWN (the batch is durable but the reply was lost), the content
// navigation leave guard (`ContentNavigationSession` -> the note's `prepareClose` / `canClose`) refuses (a) a citation click, (b) back and forward
// and (c) switching to another document through the catalog; after the same-ID retry confirms the commit they all go through.
// The unknown is made on one host (Native: the sidecar commit really happens and the reply is dropped; Web: the IndexedDB commit really happens and the
// reply is lost at the IndexedDbPlan boundary — a fixture hook, not a real network loss). Both hosts are separate compositions with separate peer IDs.
// Not Native GUI (WebView2), not real Google (mock provider), not real Safari / iPhone, not the built web-dist, and the unknown is not made by a UI gesture
// of the loss itself (the body is typed through the real editor; the loss is armed by the test).
const SUFFIX = 'unknown navigation suffix: the commit is durable but its reply is lost';
const editor = (page: Page) => page.getByRole('textbox', { name: 'Markdownノート', exact: true });
type Read = { state: RepositoryState; markdown?: MarkdownEditState };
const observed = (page: Page, id: string) => page.evaluate(id => (window as unknown as { compositionObservedEvidence(id: string): Promise<Read> }).compositionObservedEvidence(id), id);
const readIntent = (page: Page, id: string) => page.evaluate(id => (window as unknown as { compositionReadIntent(id: string): Promise<unknown> }).compositionReadIntent(id), id);
const bodyOf = (read: Read, id: string) => { const value = new EditGraph(read.state.checkpoint).snapshot(read.state.heads[0]); assert.ok(value?.kind === 'markdown'); assert.equal(read.state.checkpoint.root.id, id); return value.content; };

for (const engine of ['chromium', 'webkit'] as const) for (const host of ['native', 'web'] as const) {
  test(`Markdown unknown on ${host}: citation, back/forward and switching are refused until the same-ID retry confirms (${engine})`, { timeout: 600_000 }, async t => {
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
    try {
      setup.beginContentNavigation();
      await page.bringToFront();

      phase = 'history noteB -> noteA -> pdf -> back to noteA';
      await expectAt(ids.noteB, [], [], 'start');
      await U.openFromCatalog(page, U.TITLE.noteA, ids.noteA); await expectAt(ids.noteA, [ids.noteB], [], 'noteA');
      await U.showPreview(page); await U.citationLink(page, 'unknown 引用 上').click();
      await settle(ids.pdf); await expectAt(ids.pdf, [ids.noteB, ids.noteA], [], 'pdf by citation');
      await U.backButton(page).click(); await settle(ids.noteA); await expectAt(ids.noteA, [ids.noteB], [ids.pdf], 'back to noteA');
      const historyBefore = { back: [ids.noteB], forward: [ids.pdf] };

      phase = 'the body commit is durable but its reply is lost';
      await U.showEditor(page);
      const original = (await observed(page, ids.noteA)).markdown!.content;
      assert.match(original, /unknown 引用 上/, 'the note carries the citation links');
      const BODY = `${original}

${SUFFIX}`;
      await U.setReplyLoss(setup, host, true);
      const mark = await U.markAttempts(setup, host);
      await editor(page).fill(BODY);
      await U.retryButton(page).waitFor();
      const unknown = await waitForSnapshot(() => observed(page, ids.noteA), value => !!value.markdown && !!value.markdown.error && !value.markdown.saving);
      assert.equal(unknown.markdown!.durable, false, 'the session does not claim a durable body');
      assert.equal(unknown.markdown!.content, BODY, 'the typed body is kept');
      const lostIds = [...new Set((await U.attemptsSince(setup, host, mark)).ids)];
      assert.equal(lostIds.length, 1, 'exactly one batch id reached the store');
      const lostId = lostIds[0];
      // The batch really is durable in the host's own store (that is what makes the outcome "unknown" rather than "aborted").
      assert.ok(unknown.state.checkpoint.batches.some(batch => batch.id === lostId), 'the batch is in the host repository');
      const intent = await readIntent(page, ids.noteA) as { intent?: { dispatched?: boolean; request?: { batch?: { id?: string } } } } | undefined;
      assert.ok(intent, 'the intent is retained'); assert.equal(intent.intent?.request?.batch?.id, lostId, 'and it is the intent of the very batch that reached the store'); assert.equal(intent.intent?.dispatched, true, 'and it was dispatched (so unknown, not aborted)');
      const leave = await U.scopeLeave(page);
      assert.equal(leave.status, 'refused'); assert.ok(leave.targets.includes(ids.noteA));
      await U.showPreview(page);

      // Every attempt is made while the reply is STILL being lost: the guard's own retry re-sends the same batch and cannot confirm it.
      const refused = async (label: string, act: () => Promise<void>) => {
        phase = `refused: ${label}`;
        const before = await U.nav(page), revisionBefore = await U.navRevision(page);
        await act();
        const state = await U.waitOutcome(page, before, revisionBefore);
        assert.equal(state.navigation.error, 'current-blocked', `${label}: refused by the leave guard`);
        assert.equal(state.documentId, ids.noteA, `${label}: still on the note (state)`);
        assert.equal(await U.shownId(page), ids.noteA, `${label}: still on the note (DOM)`);
        assert.deepEqual(U.history(state), historyBefore, `${label}: history untouched`);
        assert.deepEqual(U.history(state), U.history(before));
        await U.blockedAlert(page).waitFor();
        const read = await observed(page, ids.noteA);
        assert.equal(read.markdown!.content, BODY, `${label}: the body is kept`);
        assert.equal(read.markdown!.durable, false);
        assert.ok(await readIntent(page, ids.noteA), `${label}: the intent is kept`);
        assert.equal((await U.scopeLeave(page)).status, 'refused');
        const attempts = await U.attemptsSince(setup, host, mark);
        assert.deepEqual([...new Set(attempts.ids)], [lostId], `${label}: every re-send used the one original id`);
      };
      await refused('citation click', () => U.citationLink(page, 'unknown 引用 上').click());
      await refused('back', () => U.backButton(page).click());
      await refused('forward', () => U.forwardButton(page).click());
      await U.expandCatalog(page);
      await refused('switch to another document', () => U.catalogItem(page, U.TITLE.pdf2).click());
      assert.equal(await U.catalogToggle(page).getAttribute('aria-expanded'), 'true', 'a refused switch leaves the catalog open');

      phase = 'same-ID retry confirms the commit';
      await U.setReplyLoss(setup, host, false);
      await U.retryButton(page).click();
      const done = await waitForSnapshot(() => observed(page, ids.noteA), value => !!value.markdown && !value.markdown.error && value.markdown.durable && !value.markdown.dirty && !value.markdown.saving);
      assert.equal(bodyOf(done, ids.noteA), BODY, 'the confirmed body is the typed body');
      assert.equal(done.state.checkpoint.batches.filter(batch => batch.id === lostId).length, 1, 'one batch with the original id');
      assert.deepEqual(done.state.heads, [lostId], 'and it is the head');
      const attempts = await U.attemptsSince(setup, host, mark);
      assert.deepEqual([...new Set(attempts.ids)], [lostId]);
      if (host === 'native') {
        assert.ok(attempts.calls >= 2, 'the same operation was re-sent'); assert.equal(new Set(attempts.payloads).size, 1, 'with the identical request body');
      }
      assert.equal(await readIntent(page, ids.noteA), undefined, 'the intent is released');
      assert.equal((await U.scopeLeave(page)).status, 'allowed');
      await U.blockedAlert(page).waitFor({ state: 'detached' }).catch(() => undefined);

      phase = 'after the confirmation the same operations go through';
      await U.proceeds(page, 'forward', () => U.forwardButton(page).click(), ids.pdf, [ids.noteB, ids.noteA], []);
      await U.proceeds(page, 'back', () => U.backButton(page).click(), ids.noteA, [ids.noteB], [ids.pdf]);
      await U.showPreview(page);
      await U.proceeds(page, 'citation click', () => U.citationLink(page, 'unknown 引用 上').click(), ids.pdf, [ids.noteB, ids.noteA], []);
      await U.proceeds(page, 'back again', () => U.backButton(page).click(), ids.noteA, [ids.noteB], [ids.pdf]);
      await U.expandCatalog(page);
      await U.proceeds(page, 'switch to another document', () => U.catalogItem(page, U.TITLE.pdf2).click(), ids.pdf2, [ids.noteB, ids.noteA], []);
      // The confirmed body survived leaving and is what the note shows when we come back.
      await U.proceeds(page, 'back to the note', () => U.backButton(page).click(), ids.noteA, [ids.noteB], [ids.pdf2]);
      await U.showPreview(page);
      assert.match(await page.locator(`[data-content-document="${ids.noteA}"]`).innerText(), new RegExp(SUFFIX));
      await setup.finish();
    } catch (error) { t.diagnostic(`markdown unknown navigation phase: ${phase}`); throw error; }
  });
}

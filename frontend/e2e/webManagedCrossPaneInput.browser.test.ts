import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContentPublication, Page as DocumentPage } from '../src/runtime/edits/contracts.ts';
import { openComposition } from './support/documentComposition.ts';
import { managedTextReady } from './support/managedPdfReady.ts';
import { observePointers } from './support/observePointers.ts';
import { openMixedReference, referencePaperPoint, seedMixedReference } from './support/mixedReferenceInput.ts';

type Point = { x: number; y: number };
type PointerObservation = Awaited<ReturnType<Awaited<ReturnType<typeof observePointers>>['read']>>[number];

for (const companionKind of ['pdf', 'paper'] as const) test(`Chromium cross-pane touch drain and activation guard (${companionKind})`, { timeout: 300_000 }, async t => {
  const seed = (publication: ContentPublication) => {
    assert.ok(publication.content?.kind === 'document');
    if (companionKind === 'paper') { seedMixedReference(publication); return; }
    const source = publication.content.pages[0], other = structuredClone(source);
    other.id = crypto.randomUUID(); other.annotations = [];
    publication.content.translation = { revision: crypto.randomUUID(), pages: [other], bindings: [{
      original: { pageId: source.id, backgroundRevision: source.backgroundRevision },
      candidates: [{ pageId: other.id, backgroundRevision: other.backgroundRevision }],
    }] };
  };
  const { pages, publication, documentId, finish } = await openComposition(t, 'chromium', seed, { pdfFixture: 'text', hasTouch: true });
  assert.ok(publication.content?.kind === 'document'); const source = publication.content.pages[0];
  for (const [host, page] of pages.entries()) {
    await page.getByRole('button', { name: '読む', exact: true }).click();
    if (companionKind === 'paper') await openMixedReference(page, publication);
    else await page.getByRole('button', { name: '左右', exact: true }).click();
    const ready = await managedTextReady(page, documentId, publication.libraryBatch.libraryId, source);
    const original = page.locator('[data-reader-surface="original"]'), other = page.locator(companionKind === 'paper' ? '[data-reader-reference]' : '[data-reader-surface="translated"]');
    const companion: DocumentPage = companionKind === 'paper' ? publication.content.pages[1] : publication.content.translation!.pages[0];
    const pageSelector = `[data-canonical-page="${companion.id}"][data-background-revision="${companion.backgroundRevision}"]`;
    const pdfPage = companion.background.kind === 'pdf' ? companion.background.pdfPage : null;
    await other.locator(companionKind === 'pdf' ? `${pageSelector} [data-rendered="true"] .react-pdf__Page[data-page-number="${pdfPage}"] .react-pdf__Page__canvas` : `[data-paper-page="${companion.id}"]`).waitFor();
    const spans = await ready.layer.$$('span[role="presentation"]'); let text = null as typeof spans[number] | null;
    for (const span of spans) { const box = await span.boundingBox(); if (box && box.width > 100) { text = span; break; } }
    assert.ok(text); const first = await text.boundingBox(), second = await other.boundingBox(); assert.ok(first && second);
    if (companionKind === 'paper') await page.waitForFunction(() => {
      const value = (window as unknown as { compositionReferenceInputEvidence?: () => { active: boolean; blocked: boolean } | null }).compositionReferenceInputEvidence?.();
      return !!value?.active && !value.blocked;
    });
    const before = await page.evaluate(id => (window as unknown as { compositionObservedEvidence(id: string): Promise<{ state: { history: unknown[] }; document: { document: unknown } }> }).compositionObservedEvidence(id), documentId);
    const events = await observePointers(page);
    const point: Point = companionKind === 'paper' ? await referencePaperPoint(page, companion.id) : { x: second.x + second.width / 2, y: second.y + second.height / 2 };
    const cdp = await page.context().newCDPSession(page), a = { id: 1, x: first.x + 8, y: first.y + first.height / 2 }, b: Point & { id: number } = { id: 2, ...point };
    let phase = 'first-contact';
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [a] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [a, b] });
      phase = 'second-contact-end';
      // Chromium touchEnd lists contacts to end; b ends while a remains down.
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [b] });
      assert.equal(await original.getAttribute('data-active-surface'), 'true');
      await page.waitForTimeout(500); // A canceled first hold must not fire after the second contact leaves.
      assert.equal(await page.getByRole('button', { name: '本文選択の終了端。左右キーで移動', exact: true }).count(), 0);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...a, x: a.x + 80 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.equal(await original.getAttribute('data-active-surface'), 'true');
      const after = await page.evaluate(id => (window as unknown as { compositionObservedEvidence(id: string): Promise<{ state: { history: unknown[] }; document: { document: unknown } }> }).compositionObservedEvidence(id), documentId);
      assert.deepEqual(after.document.document, before.document.document); assert.deepEqual(after.state.history, before.state.history);
      await ready.layer.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Shift+ArrowRight');
      await page.getByRole('button', { name: '本文選択の終了端。左右キーで移動', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      const pointerEvents = await events.read();
      const near = (event: typeof pointerEvents[number], point: { x: number; y: number }) => Math.hypot(event.x - point.x, event.y - point.y) <= 2;
      const aDown = pointerEvents.find(event => event.type === 'pointerdown' && event.pointerType === 'touch' && event.trusted && near(event, a));
      const bDown: PointerObservation | undefined = pointerEvents.find(event => event.type === 'pointerdown' && event.pointerType === 'touch' && event.trusted && near(event, b));
      assert.ok(aDown && bDown && aDown.pointerId !== bDown.pointerId);
      if (companionKind === 'paper') assert.ok(bDown.reader && bDown.surface === 'reference'
        && bDown.paperPage === companion.id && bDown.pane?.includes('document-paper-pane'));
      const bUp = pointerEvents.findIndex(event => event.type === 'pointerup' && event.pointerId === bDown.pointerId);
      const aMove = pointerEvents.findIndex((event, index) => index > bUp && event.type === 'pointermove' && event.pointerId === aDown.pointerId && near(event, { x: a.x + 80, y: a.y }));
      const aUp = pointerEvents.findIndex((event, index) => index > aMove && event.type === 'pointerup' && event.pointerId === aDown.pointerId);
      assert.ok(bUp >= 0 && aMove > bUp && aUp > aMove);
      assert.equal(pointerEvents.slice(bUp + 1, aUp).some(event => event.pointerId === aDown.pointerId && (event.type === 'pointerup' || event.type === 'pointercancel')), false);
      assert.ok(pointerEvents.some(value => value.type === 'pointerdown' && value.pointerType === 'touch' && value.trusted && value.surface === (companionKind === 'paper' ? 'reference' : 'translated')));
      assert.ok(pointerEvents.some(value => value.type === 'pointerdown' && value.pointerType === 'touch' && value.trusted && value.surface === 'original'));
      assert.ok(pointerEvents.some(value => value.type === 'pointerup' && value.pointerType === 'touch' && value.trusted));
      const firstDown = pointerEvents.find(value => value.type === 'pointerdown' && value.pointerType === 'touch' && value.trusted);
      const lastUp = [...pointerEvents].reverse().find(value => value.type === 'pointerup' && value.pointerType === 'touch' && value.trusted);
      assert.ok(firstDown && lastUp && lastUp.at > firstDown.at);
    } catch (error) {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const data = await Promise.race([Promise.all([events.read(), original.getAttribute('data-active-surface'), other.getAttribute('data-active-surface')]),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('diagnostic-timeout')), 3000); })])
          .finally(() => { if (timer !== undefined) clearTimeout(timer); });
        t.diagnostic('cross-pane-failure ' + JSON.stringify({ host: host ? 'Web' : 'PC', companionKind, phase, a, b, data }).slice(0, 50000));
      } catch (diagnosticError) { t.diagnostic('cross-pane-diagnostic-error ' + String(diagnosticError)); }
      throw error;
    } finally {
      for (const cleanup of [() => events.stop(), () => cdp.detach(), () => ready.dispose()]) {
        try { await cleanup(); } catch (error) { t.diagnostic('cross-pane-cleanup-error ' + String(error)); }
      }
    }
  }
  await finish();
});

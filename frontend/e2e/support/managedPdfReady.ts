import assert from 'node:assert/strict';
import type { Page as BrowserPage } from 'playwright-core';
import type { Page } from '../../src/runtime/edits/contracts.ts';

/** Read-only current DOM and session evidence; never publishes a binding or action port. */
export async function managedTextReady(page: BrowserPage, documentId: string, libraryId: string, source: Page, deadline = Date.now() + 25_000) {
  assert.equal(source.background.kind, 'pdf'); if (source.background.kind !== 'pdf') throw new Error('pdf-required');
  const scopeBudget = deadline - Date.now(); if (scopeBudget <= 0) throw new Error('managed-readiness-budget-exhausted');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observed = await Promise.race([page.evaluate(id => (window as unknown as { compositionObservedEvidence(id: string): Promise<{ state: { checkpoint: { libraryId: string } } }> }).compositionObservedEvidence(id), documentId), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('managed-scope-timeout')), scopeBudget); })]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  assert.equal(observed.state.checkpoint.libraryId, libraryId);
  const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('managed-readiness-budget-exhausted');
  const expected = { documentId, pageId: source.id, revision: source.backgroundRevision, physical: String(source.background.pdfPage) };
  const witness = await page.waitForFunction(expected => {
    const root = document.querySelector(`[data-content-document="${expected.documentId}"]`);
    const active = root?.querySelector('[data-reader-surface][data-active-surface="true"]');
    const canonical = active?.querySelector('[data-canonical-page]');
    const scroller = canonical?.querySelector('[data-pdf-scroller]');
    const pdf = canonical?.querySelector('.react-pdf__Page');
    const layer = pdf?.querySelector<HTMLElement>('.textLayer[role="group"][tabindex="0"]');
    const canvas = pdf?.querySelector<HTMLCanvasElement>('canvas');
    const surface = canonical?.querySelector<HTMLElement>('[data-pdf-surface]');
    const ink = canonical?.querySelector<HTMLElement>('[aria-label="PDF書き込みレイヤー"]');
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === '選択した文章をハイライト');
    const nav = (window as unknown as { compositionNavigationEvidence(): { documentId: string | null; document?: { ready: boolean; phase: string; inputActive: boolean; document?: { pages: Page[] } } } }).compositionNavigationEvidence();
    const model = nav.document?.document?.pages.find(item => item.id === expected.pageId);
    const cb = canvas?.getBoundingClientRect(), sb = surface?.getBoundingClientRect(), ib = ink?.getBoundingClientRect();
    if (!root || !active || nav.documentId !== expected.documentId || !nav.document?.ready || nav.document.phase !== 'idle' || nav.document.inputActive
      || !model || model.backgroundRevision !== expected.revision || model.background.kind !== 'pdf' || String(model.background.pdfPage) !== expected.physical
      || canonical?.getAttribute('data-canonical-page') !== expected.pageId || canonical.getAttribute('data-background-revision') !== expected.revision
      || scroller?.getAttribute('data-rendered') !== 'true' || pdf?.getAttribute('data-page-number') !== expected.physical
      || document.fonts.status !== 'loaded' || !layer?.isConnected || !layer.querySelector('span[role="presentation"]')
      || !canvas?.isConnected || !canvas.width || !canvas.height || !cb || !sb || sb.width <= 0 || sb.height <= 0
      || Math.abs(cb.width - sb.width) > 1 || Math.abs(cb.height - sb.height) > 1
      || !ink?.isConnected || !ib || ib.width <= 0 || ib.height <= 0 || !button || button.disabled) return false;
    return layer;
  }, expected, { timeout: remaining });
  const layer = witness.asElement(); if (!layer) { await witness.dispose(); throw new Error('managed-layer-witness-missing'); }
  return { layer, dispose: () => witness.dispose() };
}

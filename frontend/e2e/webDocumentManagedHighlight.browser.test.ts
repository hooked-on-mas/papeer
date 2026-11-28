import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { DocumentEditState } from '../src/features/reader/edit/DocumentEditSession.ts';
import type { RepositoryState } from '../src/runtime/edits/ports.ts';
import type { ContentPublication, StickyNote } from '../src/runtime/edits/contracts.ts';
import { EditGraph } from '../src/runtime/edits/editGraph.ts';
import { isDeepStrictEqual } from 'node:util';
import { captureReferenceFailure, openComposition, sync as deliver } from './support/documentComposition.ts';
import { waitForSnapshot } from './support/waitForSnapshot.ts';
import { managedTextReady } from './support/managedPdfReady.ts';

type Observed = { state: RepositoryState; document?: DocumentEditState };
const observe = (page: Page, id: string): Promise<Observed> => page.evaluate(id => (window as unknown as {
  compositionObservedEvidence(id: string): Promise<Observed>;
}).compositionObservedEvidence(id), id);
const idle = async (page: Page, id: string): Promise<Observed> => {
  const value = await waitForSnapshot(() => page.evaluate(id => {
    const read = (window as unknown as { compositionObservedEvidence?: (id: string) => Promise<Observed> }).compositionObservedEvidence;
    return read ? read(id) : null;
  }, id), current => !!current?.document?.ready && current.document.phase === 'idle' && !current.document.inputActive
    && !!current.document.document && isDeepStrictEqual(new EditGraph(current.state.checkpoint).snapshot(current.document.document.version), current.document.document));
  assert.ok(value); return value;
};
async function boundedDiagnostic<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('diagnostic-timeout')), 2_000); })])
    .finally(() => { if (timer !== undefined) clearTimeout(timer); });
}
const form = (page: Page) => page.getByRole('region', { name: '注釈を編集', exact: true });

for (const engine of ['chromium', 'webkit'] as const) test(`production managed selection and highlight lifecycle (${engine})`, { timeout: 300_000 }, async t => {
  let sticky!: StickyNote;
  const seed = (publication: ContentPublication) => {
    assert.ok(publication.content?.kind === 'document');
    sticky = { kind: 'sticky', id: crypto.randomUUID(), text: 'preserved sticky', color: null, anchor: { x: 50, y: 70 }, quote: 'preserved', metadata: { label: 'seed', createdAt: null } };
    publication.content.pages[0].annotations.push(sticky);
  };
  const { pages, publication, documentId, reloadContent, finish, browserObservations } = await openComposition(t, engine, seed, { pdfFixture: 'text' });
  let phase = 'setup', activeHost = -1;
  try {
  assert.ok(publication.content?.kind === 'document');
  const source = publication.content.pages[0];
  for (const [host, page] of pages.entries()) {
    activeHost = host; phase = 'host-start';
    await page.evaluate(() => {
      const events: { type: string; key: string; trusted: boolean; target: string; prevented: boolean }[] = [];
      const handler = (event: Event) => { const key = event instanceof KeyboardEvent ? event.key : ''; const target = event.target instanceof Element ? `${event.target.tagName}:${event.target.getAttribute('aria-label') ?? ''}` : '';
        events.push({ type: event.type, key, trusted: event.isTrusted, target, prevented: event.defaultPrevented }); if (events.length > 64) events.shift(); };
      for (const type of ['keydown', 'click', 'focusin']) document.addEventListener(type, handler, true);
      Object.assign(window, { highlightPassiveEvidence: () => events.map(value => ({ ...value })), stopHighlightPassiveEvidence: () => { for (const type of ['keydown', 'click', 'focusin']) document.removeEventListener(type, handler, true); } });
    });
    t.diagnostic(host ? 'Web IndexedDB mount' : 'PC SQLite mount');
    await page.getByRole('button', { name: '読む', exact: true }).click();
    const surface = page.locator(`[aria-label="中央の編集"] [data-canonical-page="${source.id}"][data-background-revision="${source.backgroundRevision}"]`);
    const witness = await managedTextReady(page, documentId, publication.libraryBatch.libraryId, source);
    const actual = await surface.locator('[data-rendered="true"] .react-pdf__Page').getAttribute('data-page-number');
    assert.equal(actual, source.background.kind === 'pdf' ? String(source.background.pdfPage) : '');
    const spans = await witness.layer.$$('span[role="presentation"]');
    let title = null as typeof spans[number] | null;
    for (const span of spans) if (await span.textContent() === 'Adaptive Control for Automated Systems') { title = span; break; }
    assert.ok(title);
    const box = await title.boundingBox(); assert.ok(box && box.width > 4 && box.height > 0);
    const expectedKeyboardQuote = await witness.layer.evaluate(element => {
      const first = [...element.querySelectorAll('span[role="presentation"]')].map(span => span.textContent ?? '').find(Boolean);
      if (!first || !/^[A-Za-z0-9 ]{8}/.test(first)) throw new Error('first-eight-not-ascii');
      return first.slice(0, 8).trim();
    });
    phase = 'selection-input';
    if (host === 0) {
      await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 }); await page.mouse.up();
    } else {
      await witness.layer.focus();
      await page.keyboard.press('Enter');
      for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowRight');
    }
    await witness.dispose();
    phase = 'highlight-click';
    await page.getByRole('button', { name: '選択した文章をハイライト', exact: true }).click();
    phase = 'highlight-form';
    await form(page).waitFor();
    try {
    const success = await boundedDiagnostic(page.evaluate(() => {
      const value = window as unknown as { compositionHighlightEvidence?: () => unknown; compositionNavigationEvidence?: () => { documentId: string | null; document?: { ready?: boolean; phase?: string; inputActive?: boolean; document?: { version?: string } } } };
      const nav = value.compositionNavigationEvidence?.();
      return { highlight: value.compositionHighlightEvidence?.(), documentId: nav?.documentId, version: nav?.document?.document?.version,
        phase: nav?.document?.phase, ready: nav?.document?.ready, inputActive: nav?.document?.inputActive,
        pressedTools: [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"]')].map(button => button.textContent?.trim()).slice(0, 20) };
    }));
    t.diagnostic(`highlight-success ${host ? 'Web' : 'PC'}: ${JSON.stringify(success).slice(0, 20000)}`);
    } catch (cause) { t.diagnostic(`highlight success diagnostic error: ${String(cause)}`); }
    await form(page).getByRole('textbox', { name: '本文ハイライトのコメント', exact: true }).fill(`host-${host} highlight`);
    const before = await observe(page, documentId);
    await form(page).getByRole('button', { name: '確定', exact: true }).click();
    const created = await waitForSnapshot(() => observe(page, documentId), value => !!value.document?.document
      && value.document.phase === 'idle' && value.document.document.version !== before.document?.document?.version
      && value.document.document.pages.some(p => p.annotations.some(a => a.kind === 'highlight' && a.text === `host-${host} highlight`)));
    assert.equal(created.state.history.length, before.state.history.length + 1);
    const annotation = created.document!.document!.pages.flatMap(p => p.annotations).find(a => a.kind === 'highlight' && a.text === `host-${host} highlight`);
    assert.ok(annotation?.kind === 'highlight'); if (host === 0) assert.match(annotation.quote, /Control for Automated/);
    else assert.equal(annotation.quote, expectedKeyboardQuote);
    assert.equal(annotation.range.kind, 'unindexed'); assert.ok(annotation.quads.length > 0);
    await reloadContent(page, documentId); const reloaded = await idle(page, documentId);
    assert.deepEqual(reloaded.document!.document!.pages.flatMap(p => p.annotations).find(a => a.id === annotation.id), annotation);
    await page.getByRole('button', { name: '読む', exact: true }).click();
    const reloadedWitness = await managedTextReady(page, documentId, publication.libraryBatch.libraryId, source); await reloadedWitness.dispose();
    await page.getByRole('button', { name: '注釈を選択', exact: true }).click();
    await page.locator(`[data-annotation-id="${annotation.id}"]`).first().click(); await form(page).waitFor();
    await form(page).getByRole('textbox', { name: '本文ハイライトのコメント', exact: true }).fill(`host-${host} edited`);
    await form(page).getByRole('button', { name: '確定', exact: true }).click();
    const edited = await waitForSnapshot(() => observe(page, documentId), value => value.document?.phase === 'idle'
      && !!value.document.document?.pages.some(p => p.annotations.some(a => a.id === annotation.id && a.kind === 'highlight' && a.text === `host-${host} edited`)));
    assert.equal(edited.state.history.length, created.state.history.length + 1);
    const changed = edited.document!.document!.pages.flatMap(p => p.annotations).find(a => a.id === annotation.id);
    assert.ok(changed?.kind === 'highlight'); assert.deepEqual(changed.quads, annotation.quads); assert.equal(changed.quote, annotation.quote);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await waitForSnapshot(() => observe(page, documentId), value => !!value.document?.document?.pages.some(p => p.annotations.some(a => a.id === annotation.id && a.kind === 'highlight' && a.text === annotation.text)));
    await page.getByRole('button', { name: 'やり直す', exact: true }).click();
    await waitForSnapshot(() => observe(page, documentId), value => !!value.document?.document?.pages.some(p => p.annotations.some(a => a.id === annotation.id && a.kind === 'highlight' && a.text === `host-${host} edited`)));
    const selectTool = page.getByRole('button', { name: '注釈を選択', exact: true });
    if (await selectTool.getAttribute('aria-pressed') !== 'true') await selectTool.click();
    await page.locator(`[data-annotation-id="${annotation.id}"]`).first().click(); await form(page).waitFor();
    await form(page).getByRole('button', { name: 'この注釈を削除', exact: true }).click();
    await form(page).getByRole('button', { name: '確定', exact: true }).click();
    const deleted = await waitForSnapshot(() => observe(page, documentId), value => value.document?.phase === 'idle'
      && !!value.document.document && !value.document.document.pages.some(p => p.annotations.some(a => a.id === annotation.id)));
    assert.deepEqual(deleted.document!.document!.pages.flatMap(p => p.annotations).find(a => a.id === sticky.id), sticky);
    await reloadContent(page, documentId); const afterReload = await idle(page, documentId);
    assert.deepEqual(afterReload.document!.document, deleted.document!.document);
    if (host === 0) {
      await page.getByRole('button', { name: '同期', exact: true }).click();
      await deliver(page);
      const peer = pages[1];
      await peer.getByRole('button', { name: '同期', exact: true }).click();
      await deliver(peer);
      await reloadContent(peer, documentId);
      await waitForSnapshot(() => idle(peer, documentId), value => isDeepStrictEqual(value.document?.document, afterReload.document?.document));
    }
  }
  } catch (error) {
    t.diagnostic(`highlight failure host=${activeHost} phase=${phase} browser=${JSON.stringify(browserObservations())}`);
    for (const [index, page] of pages.entries()) {
      try {
        const details = await boundedDiagnostic(page.evaluate(() => {
          const value = window as unknown as { compositionHighlightEvidence?: () => unknown; compositionNavigationEvidence?: () => { documentId: string | null; document?: { ready?: boolean; phase?: string; error?: string; inputActive?: boolean; document?: { version?: string } } }; highlightPassiveEvidence?: () => unknown };
          const nav = value.compositionNavigationEvidence?.(), active = document.activeElement;
          return { navigation: nav && { documentId: nav.documentId, document: nav.document && { ready: nav.document.ready, phase: nav.document.phase, error: nav.document.error, inputActive: nav.document.inputActive, version: nav.document.document?.version } },
            pressedTools: [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"]')].map(button => button.textContent?.trim()).slice(0, 20),
            highlight: value.compositionHighlightEvidence?.(), events: value.highlightPassiveEvidence?.(),
            active: active && { tag: active.tagName, label: active.getAttribute('aria-label') },
            surfaces: [...document.querySelectorAll('[data-reader-surface], [data-canonical-page], .react-pdf__Page, [role="region"], [role="status"], [role="alert"]')].slice(0, 30).map(element => ({ tag: element.tagName, surface: element.getAttribute('data-reader-surface'), page: element.getAttribute('data-canonical-page'), revision: element.getAttribute('data-background-revision'), physical: element.getAttribute('data-page-number'), label: element.getAttribute('aria-label'), text: element.getAttribute('role') ? element.textContent?.slice(0, 300) : '' })) };
        }));
        t.diagnostic(`highlight diagnostic ${index}: ${JSON.stringify(details)}`);
      } catch (cause) { t.diagnostic(`highlight diagnostic error ${index}: ${String(cause)}`); }
    }
    try { await captureReferenceFailure(t, pages, `highlight:${phase}`); } catch (cause) { t.diagnostic(`highlight screenshot error: ${String(cause)}`); }
    try { await finish(); } catch (cause) { t.diagnostic(`highlight cleanup error: ${String(cause)}`); }
    throw error;
  } finally {
    for (const page of pages) try { await boundedDiagnostic(page.evaluate(() => (window as unknown as { stopHighlightPassiveEvidence?: () => void }).stopHighlightPassiveEvidence?.())); } catch { /* page may already be closed */ }
  }
  await finish();
});

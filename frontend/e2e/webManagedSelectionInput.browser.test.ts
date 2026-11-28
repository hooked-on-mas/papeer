import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElementHandle, JSHandle, Page } from 'playwright-core';
import { openComposition } from './support/documentComposition.ts';
import { managedTextReady } from './support/managedPdfReady.ts';
import { observePointers } from './support/observePointers.ts';
import { waitForSnapshot } from './support/waitForSnapshot.ts';

async function evidence(page: Page, id: string) {
  return page.evaluate(id => (window as unknown as { compositionObservedEvidence(id: string): Promise<{ state: { history: unknown[]; checkpoint: { libraryId: string } }; document: { document: unknown } }> }).compositionObservedEvidence(id), id);
}
async function pageTuple(page: Page) {
  return page.evaluate(() => { const active = document.querySelector('[data-reader-surface][data-active-surface=\"true\"]'); return { surface: active?.getAttribute('data-reader-surface'), page: active?.querySelector('[data-canonical-page]')?.getAttribute('data-canonical-page'), physical: active?.querySelector('.react-pdf__Page')?.getAttribute('data-page-number') }; });
}
async function paneDiagnostics(page: Page) {
  return page.evaluate(() => {
    const panes = [...document.querySelectorAll('[data-reader-surface][data-active-surface="true"] [data-pdf-scroller]')];
    const pane = panes[0], surface = pane?.querySelector<HTMLElement>('[data-pdf-surface]');
    const rect = surface?.getBoundingClientRect(); const parent = surface?.parentElement;
    return { count: panes.length, tuple: { surface: pane?.closest('[data-reader-surface]')?.getAttribute('data-reader-surface'),
      page: pane?.closest('[data-canonical-page]')?.getAttribute('data-canonical-page'), physical: pane?.querySelector('.react-pdf__Page')?.getAttribute('data-page-number') },
      rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      parentZoom: parent ? getComputedStyle(parent).zoom : null };
  });
}
async function readingState(page: Page) {
  return page.evaluate(() => (window as unknown as { compositionNavigationEvidence(): { documentId: string; readerState: { pageId: string; surfacePageId?: string | null; activeSurface?: string } | null } }).compositionNavigationEvidence());
}
for (const engine of ['chromium', 'webkit'] as const) test(`managed keyboard ownership and pointer handle (${engine})`, { timeout: 300_000 }, async t => {
  const { pages, publication, documentId, finish } = await openComposition(t, engine, undefined, { pdfFixture: 'text' });
  assert.ok(publication.content?.kind === 'document'); const source = publication.content.pages[0];
  for (const [hostIndex, page] of pages.entries()) {
    const details: Record<string, unknown> = { host: hostIndex === 0 ? 'PC' : 'Web', phase: 'readiness' };
    let endpoint: { x: number; y: number } | null = null;
    const events = await observePointers(page);
    try {
    await page.getByRole('button', { name: '読む', exact: true }).click();
    const ready = await managedTextReady(page, documentId, publication.libraryBatch.libraryId, source);
    const before = await evidence(page, documentId), navigation = await readingState(page), initialPage = await pageTuple(page);
    await ready.layer.focus(); await page.keyboard.press('Enter');
    for (let index = 0; index < 12; index++) await page.keyboard.press('Shift+ArrowRight');
    const focus = page.getByRole('button', { name: '本文選択の終了端。左右キーで移動', exact: true }); await focus.waitFor();
    const live = page.locator('[data-managed-pdf-selection-overlay] [aria-live="polite"]');
    const initial = await live.textContent(); details.initial = initial; details.phase = 'keyboard'; assert.match(initial ?? '', /文字を選択/);
    await focus.focus(); await page.keyboard.press('ArrowLeft'); const moved = await live.textContent(); assert.notEqual(moved, initial);
    await page.keyboard.press('ArrowRight'); assert.equal(await live.textContent(), initial); details.keyboardMoved = moved; details.phase = 'mouse';
    const box = await focus.boundingBox(); assert.ok(box); details.handleBox = box; endpoint = { x: box.x + box.width / 2 + 12, y: box.y + box.height / 2 };
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 4 }); await page.mouse.up();
    const afterMouse = await live.textContent(); details.afterMouse = afterMouse; assert.notEqual(afterMouse, initial);
    details.phase = 'handle-return';
    const returnBox = await focus.boundingBox(); assert.ok(returnBox);
    const grab = { x: returnBox.x + returnBox.width / 2, y: returnBox.y + returnBox.height / 2 };
    await page.mouse.move(grab.x, grab.y); await page.mouse.down();
    await page.mouse.move(grab.x + 12, grab.y, { steps: 4 });
    await page.mouse.move(grab.x, grab.y, { steps: 4 });
    await page.mouse.up(); assert.equal(await live.textContent(), afterMouse);
    const stillBox = await focus.boundingBox(); assert.ok(stillBox);
    await page.mouse.move(stillBox.x + stillBox.width / 2, stillBox.y + stillBox.height / 2);
    await page.mouse.down(); await page.mouse.up(); assert.equal(await live.textContent(), afterMouse);
    await focus.focus(); await page.keyboard.press('PageDown'); assert.deepEqual(await pageTuple(page), initialPage);
    await page.keyboard.press('PageUp'); assert.deepEqual(await pageTuple(page), initialPage);
    const after = await evidence(page, documentId); assert.deepEqual(after.document.document, before.document.document);
    assert.deepEqual(after.state.history, before.state.history);
    const persisted = await readingState(page);
    if (navigation.readerState && persisted.readerState) for (const key of ['pageId', 'surfacePageId', 'activeSurface'] as const)
      assert.equal(persisted.readerState[key], navigation.readerState[key]);
    await page.keyboard.press('Escape'); await ready.dispose();
    } catch (error) {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const diagnostic = await Promise.race([
          Promise.all([events.read(), page.evaluate(point => {
            const active = document.querySelector('[data-reader-surface][data-active-surface="true"]');
            const layer = active?.querySelector('[role="group"][tabindex="0"]');
            const target = point ? document.elementFromPoint(point.x, point.y) : null;
            const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null; caretRangeFromPoint?: (x: number, y: number) => Range | null };
            const position = point ? doc.caretPositionFromPoint?.(point.x, point.y) : null;
            const range = !position && point ? doc.caretRangeFromPoint?.(point.x, point.y) : null;
            const node = position?.offsetNode ?? range?.startContainer ?? null;
            return {
              tuple: { surface: active?.getAttribute('data-reader-surface'), page: active?.querySelector('[data-canonical-page]')?.getAttribute('data-canonical-page'), revision: active?.querySelector('[data-canonical-page]')?.getAttribute('data-background-revision'), physical: active?.querySelector('.react-pdf__Page')?.getAttribute('data-page-number') },
              layerConnected: layer?.isConnected ?? false,
              target: { tag: target?.tagName ?? null, endpoint: target?.closest<HTMLElement>('[data-pdf-text-endpoint]')?.dataset.pdfTextEndpoint ?? null },
              caret: { nodeName: node?.nodeName ?? null, offset: position?.offset ?? range?.startOffset ?? null, inLayer: !!node && !!layer?.contains(node) },
            };
          }, endpoint)]),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('diagnostic-timeout')), 3000); }),
        ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
        t.diagnostic('managed-keyboard-mouse-failure ' + JSON.stringify({ ...details, endpoint, diagnostic }).slice(0, 50000));
      } catch (diagnosticError) { t.diagnostic('managed-keyboard-mouse-diagnostic-error ' + JSON.stringify({ ...details, error: String(diagnosticError) })); }
      throw error;
    } finally {
      try { await events.stop(); } catch (cleanupError) { t.diagnostic('managed-keyboard-mouse-cleanup-error ' + String(cleanupError)); }
    }
  }
  await finish();
});

test('Chromium trusted touch long press extends selection and pinch drains remaining contact', { timeout: 300_000 }, async t => {
  const { pages, publication, documentId, finish } = await openComposition(t, 'chromium', undefined, { pdfFixture: 'text', hasTouch: true });
  assert.ok(publication.content?.kind === 'document'); const source = publication.content.pages[0];
  for (const [hostIndex, page] of pages.entries()) {
    const started = performance.now(); let phase = 'readiness';
    const details: Record<string, unknown> = { host: hostIndex === 0 ? 'PC' : 'Web', phase };
    const note = (name: string, value?: unknown) => { phase = name; details.phase = name; details.elapsedMs = performance.now() - started; if (value !== undefined) details[name] = value; };
    await page.getByRole('button', { name: '読む', exact: true }).click();
    const ready = await managedTextReady(page, documentId, publication.libraryBatch.libraryId, source);
    const before = await evidence(page, documentId), navigation = await readingState(page);
    const spans = await ready.layer.$$('span[role="presentation"]'); let text = null as typeof spans[number] | null;
    for (const span of spans) { const candidate = await span.boundingBox(); if (candidate && candidate.width > 100) { text = span; break; } } assert.ok(text);
    const box = await text.boundingBox(); assert.ok(box && box.width > 100);
    const events = await observePointers(page);
    const cdp = await page.context().newCDPSession(page), p = { id: 1, x: box.x + 8, y: box.y + box.height / 2 };
    let disposed = false;
    try {
      note('hold-start', { p });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
      const live = page.locator('[data-managed-pdf-selection-overlay] [aria-live="polite"]');
      await page.waitForFunction(() => /\d+文字を選択しました。/.test(document.querySelector('[data-managed-pdf-selection-overlay] [aria-live="polite"]')?.textContent ?? ''), undefined, { timeout: 25_000 });
      const word = await live.textContent(); assert.match(word ?? '', /\d+文字を選択しました。.+/);
      const wordCount = Number(word!.match(/^(\d+)文字/)![1]); note('word', { word, wordCount });
      const focus = page.getByRole('button', { name: '本文選択の終了端。左右キーで移動', exact: true });
      const wordEndpoint = await focus.boundingBox(); assert.ok(wordEndpoint); note('word-endpoint', wordEndpoint);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...p, x: p.x + 80 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.getByRole('button', { name: '本文選択の終了端。左右キーで移動', exact: true }).waitFor();
      const extended = await live.textContent(); assert.match(extended ?? '', /\d+文字を選択しました。.+/);
      assert.ok(Number(extended!.match(/^(\d+)文字/)![1]) > wordCount);
      const extendedEndpoint = await focus.boundingBox(); assert.ok(extendedEndpoint); note('extension', { extended, extendedEndpoint });
      assert.notDeepEqual({ x: extendedEndpoint.x, y: extendedEndpoint.y }, { x: wordEndpoint.x, y: wordEndpoint.y });
      const after = await evidence(page, documentId); assert.deepEqual(after.document.document, before.document.document);
      assert.deepEqual(after.state.history, before.state.history);
    const persisted = await readingState(page);
    if (navigation.readerState && persisted.readerState) for (const key of ['pageId', 'surfacePageId', 'activeSurface'] as const)
      assert.equal(persisted.readerState[key], navigation.readerState[key]);
      const pane = page.locator('[data-reader-surface][data-active-surface="true"] [data-pdf-scroller]');
      const q = { id: 2, x: p.x + 45, y: p.y + 20 };
      const metricReads: { started: number; completed?: number; value?: unknown; error?: string }[] = [];
      details.metricReads = metricReads;
      const metrics = async (withHit = false) => {
        const item: typeof metricReads[number] = { started: performance.now() - started }; metricReads.push(item); if (metricReads.length > 120) metricReads.shift();
        try {
          const value = await pane.evaluate((element, hit) => {
            const target = hit ? element.ownerDocument.elementFromPoint(hit.x, hit.y) : null;
            return { scrollTop: element.scrollTop, scrollLeft: element.scrollLeft, width: element.querySelector<HTMLElement>('[data-pdf-surface]')?.getBoundingClientRect().width,
              ...(hit ? { hit: { tag: target?.tagName ?? null, endpoint: target?.closest<HTMLElement>('[data-pdf-text-endpoint]')?.dataset.pdfTextEndpoint ?? null,
                surface: target?.closest('[data-reader-surface]')?.getAttribute('data-reader-surface') ?? null } } : {}) };
          }, withHit ? q : null);
          item.completed = performance.now() - started; item.value = value; return value;
        } catch (error) { item.completed = performance.now() - started; item.error = String(error); throw error; }
      };
      const priorZoom = await metrics(true), pinchDeadline = Date.now() + 25_000;
      note('pinch-start', { priorZoom, p, q });
      const pinchBaseline = (await events.read()).length;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p, q] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p, { ...q, x: q.x + 25 }] });
      const remaining = pinchDeadline - Date.now(); assert.ok(remaining > 0);
      note('pinch-width-wait');
      const zoomed = await waitForSnapshot(() => metrics(), value => value.width !== priorZoom.width, remaining); assert.notEqual(zoomed.width, priorZoom.width);
      assert.equal(await page.getByRole('button', { name: '本文選択の終了端。左右キーで移動', exact: true }).count(), 0);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [p] });
      const drainedPage = await pageTuple(page), drainedMetrics = await metrics();
      // touchEnd([p]) lifts p; q remains at q.x + 25 after the pinch move.
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...q, x: q.x + 25 + 85 }] });
      assert.deepEqual(await metrics(), drainedMetrics); assert.deepEqual(await pageTuple(page), drainedPage);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const drained = await evidence(page, documentId); assert.deepEqual(drained.document.document, before.document.document);
      assert.deepEqual(drained.state.history, before.state.history);
      await ready.dispose(); disposed = true;
      const afterPinchReady = await managedTextReady(page, documentId, publication.libraryBatch.libraryId, source, pinchDeadline);
      try { await afterPinchReady.layer.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Shift+ArrowRight');
      await page.getByRole('button', { name: '本文選択の終了端。左右キーで移動', exact: true }).waitFor();
      } finally { await afterPinchReady.dispose(); }
      const pointerEvents = await events.read(); note('complete', pointerEvents); t.diagnostic('managed-touch ' + JSON.stringify(details));
      const pinchEvents = pointerEvents.slice(pinchBaseline);
      const near = (event: typeof pinchEvents[number], point: { x: number; y: number }) => Math.hypot(event.x - point.x, event.y - point.y) <= 2;
      const pDown = pinchEvents.find(event => event.type === 'pointerdown' && event.pointerType === 'touch' && event.trusted && near(event, p));
      const qDown = pinchEvents.find(event => event.type === 'pointerdown' && event.pointerType === 'touch' && event.trusted && near(event, q));
      assert.ok(pDown && qDown && pDown.pointerId !== qDown.pointerId);
      const pUp = pinchEvents.findIndex(event => event.type === 'pointerup' && event.pointerId === pDown.pointerId);
      const qMove = pinchEvents.findIndex((event, index) => index > pUp && event.type === 'pointermove' && event.pointerId === qDown.pointerId
        && near(event, { x: q.x + 110, y: q.y }));
      const qUp = pinchEvents.findIndex((event, index) => index > qMove && event.type === 'pointerup' && event.pointerId === qDown.pointerId);
      assert.ok(pUp >= 0 && qMove > pUp && qUp > qMove, 'actual survivor moves then ends after the first contact ends');
      assert.ok(Math.hypot(pinchEvents[qMove].x - (q.x + 25), pinchEvents[qMove].y - q.y) >= 80);
      assert.equal(pinchEvents.slice(pUp + 1, qUp).some(event => event.type === 'pointerdown' || event.type === 'pointercancel'), false);

      assert.ok(pointerEvents.some(value => value.type === 'pointerdown' && value.pointerType === 'touch' && value.trusted && value.surface === 'original'));
      assert.ok(pointerEvents.some(value => value.type === 'pointerup' && value.pointerType === 'touch' && value.trusted));
      const firstDown = pointerEvents.find(value => value.type === 'pointerdown' && value.pointerType === 'touch' && value.trusted);
      const lastUp = [...pointerEvents].reverse().find(value => value.type === 'pointerup' && value.pointerType === 'touch' && value.trusted);
      assert.ok(firstDown && lastUp && lastUp.at > firstDown.at);
    } catch (error) {
      // One bounded readonly diagnostic at the failure boundary. It never substitutes the primary failure.
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const data = await Promise.race([Promise.all([events.read(), readingState(page), evidence(page, documentId), paneDiagnostics(page)]),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('diagnostic-timeout')), 3000); })])
          .finally(() => { if (timer !== undefined) clearTimeout(timer); });
        t.diagnostic('managed-touch-failure ' + JSON.stringify({ ...details, data }).slice(0, 50000));
      } catch (diagnosticError) { t.diagnostic('managed-touch-diagnostic-error ' + JSON.stringify({ ...details, error: String(diagnosticError) })); }
      throw error;
    } finally { await events.stop(); await cdp.detach(); if (!disposed) await ready.dispose(); }
  }
  await finish();
});

test('Chromium finger pan to pinch remains available while pen tool is selected', { timeout: 300_000 }, async t => {
  const { pages, publication, documentId, finish } = await openComposition(t, 'chromium', undefined, { pdfFixture: 'text', hasTouch: true });
  assert.ok(publication.content?.kind === 'document'); const source = publication.content.pages[0];
  assert.equal(source.background.kind, 'pdf'); if (source.background.kind !== 'pdf') throw new Error('pdf-required');
  for (const [index, page] of pages.entries()) {
    await page.getByRole('button', { name: 'ペン', exact: true }).click();
    const deadline = Date.now() + 25_000;
    const expected: { documentId: string; pageId: string; revision: string; physical: string } =
      { documentId, pageId: source.id, revision: source.backgroundRevision, physical: String(source.background.pdfPage) };
    let scopeTimer: ReturnType<typeof setTimeout> | undefined;
    const scope = await Promise.race([evidence(page, documentId), new Promise<never>((_, reject) => {
      scopeTimer = setTimeout(() => reject(new Error('pen-touch-scope-timeout')), Math.max(1, deadline - Date.now()));
    })]).finally(() => { if (scopeTimer !== undefined) clearTimeout(scopeTimer); });
    assert.equal(scope.state.checkpoint.libraryId, publication.libraryBatch.libraryId);
    assert.ok(deadline - Date.now() > 0);
    const currentPane = async (): Promise<{ witness: JSHandle<HTMLElement | false>; pane: ElementHandle<HTMLElement> }> => {
    const remaining = deadline - Date.now(); assert.ok(remaining > 0);
    const witness: JSHandle<HTMLElement | false> = await page.waitForFunction((expected: { documentId: string; pageId: string; revision: string; physical: string }) => {
      const root = document.querySelector(`[data-content-document="${expected.documentId}"]`);
      const active = root?.querySelector('[data-reader-surface][data-active-surface="true"]');
      const canonical = active?.querySelector(`[data-canonical-page="${expected.pageId}"][data-background-revision="${expected.revision}"]`);
      const pane = canonical?.querySelector<HTMLElement>('[data-pdf-scroller][data-rendered="true"]');
      const pdf = pane?.querySelector(`.react-pdf__Page[data-page-number="${expected.physical}"]`);
      const canvas = pdf?.querySelector<HTMLCanvasElement>('canvas'), surface = pane?.querySelector<HTMLElement>('[data-pdf-surface]');
      const ink = pane?.querySelector<HTMLElement>('[aria-label="PDF書き込みレイヤー"]');
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === 'ペン');
      const nav = (window as unknown as { compositionNavigationEvidence(): { documentId: string | null; document?: { ready: boolean; phase: string; inputActive: boolean } } }).compositionNavigationEvidence();
      const cb = canvas?.getBoundingClientRect(), sb = surface?.getBoundingClientRect(), ib = ink?.getBoundingClientRect();
      if (nav.documentId !== expected.documentId || !nav.document?.ready || nav.document.phase !== 'idle' || nav.document.inputActive
        || !pane || !surface || !canvas?.width || !canvas.height || !cb || !sb || sb.width <= 0 || sb.height <= 0
        || Math.abs(cb.width - sb.width) > 1 || Math.abs(cb.height - sb.height) > 1 || !ink || !ib || ib.width <= 0 || ib.height <= 0
        || !button || button.disabled || button.getAttribute('aria-pressed') !== 'true') return false;
      return pane;
    }, expected, { timeout: remaining });
    const pane: ElementHandle<HTMLElement> | null = witness.asElement();
    if (!pane) { await witness.dispose(); throw new Error('pen-pane-witness-missing'); }
    return { witness, pane };
    };
    const { witness, pane } = await currentPane();
    const bounds = await pane.boundingBox(); assert.ok(bounds && bounds.width > 150 && bounds.height > 150);
    const before = await evidence(page, documentId), events = await observePointers(page), cdp = await page.context().newCDPSession(page);
    const a = { id: 11, x: bounds.x + bounds.width * .45, y: bounds.y + bounds.height * .45 };
    const b = { id: 12, x: a.x + 50, y: a.y + 20 };
    const metrics = () => pane.evaluate(element => element.querySelector<HTMLElement>('[data-pdf-surface]')?.getBoundingClientRect().width ?? 0);
    try {
      const initial = await metrics(); assert.ok(initial > 0);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [a] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...a, x: a.x + 12 }] });
      const moved = { ...a, x: a.x + 12 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [moved, b] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [moved, { ...b, x: b.x + 35 }] });
      const remaining = deadline - Date.now(); assert.ok(remaining > 0);
      await waitForSnapshot(metrics, width => width > 0 && width !== initial, remaining);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.equal(await page.getByRole('button', { name: 'ペン', exact: true }).getAttribute('aria-pressed'), 'true');
      const after = await evidence(page, documentId); assert.deepEqual(after.document.document, before.document.document);
      assert.deepEqual(after.state.history, before.state.history);
      const firstEvents = await events.read();
      // Acquire the current sharp drawing after all contacts ended; a stale
      // pre-zoom page/handle cannot stand in for a new gesture.
      const fresh = await currentPane();
      try {
        const geometry = await fresh.pane.evaluate((element: HTMLElement) => {
          const paneBox = element.getBoundingClientRect(), surface = element.querySelector<HTMLElement>('[data-pdf-surface]');
          const box = surface?.getBoundingClientRect(); if (!box) return null;
          const left = Math.max(paneBox.left, box.left), right = Math.min(paneBox.right, box.right);
          const top = Math.max(paneBox.top, box.top), bottom = Math.min(paneBox.bottom, box.bottom);
          return { left, top, width: right - left, height: bottom - top, drawnWidth: box.width };
        });
        assert.ok(geometry && geometry.width > 150 && geometry.height > 100);
        const nextA = { id: 21, x: geometry.left + geometry.width * .4, y: geometry.top + geometry.height * .4 };
        const nextB = { id: 22, x: nextA.x + 50, y: nextA.y + 20 };
        const nextMetrics = () => fresh.pane.evaluate((element: HTMLElement) => element.querySelector<HTMLElement>('[data-pdf-surface]')?.getBoundingClientRect().width ?? 0);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [nextA] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [nextA, nextB] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [nextA, { ...nextB, x: nextB.x + 35 }] });
        const nextRemaining = deadline - Date.now(); assert.ok(nextRemaining > 0);
        await waitForSnapshot(nextMetrics, (width: number) => width > 0 && width !== geometry.drawnWidth, nextRemaining);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } finally { await fresh.witness.dispose(); }
      assert.equal(await page.getByRole('button', { name: 'ペン', exact: true }).getAttribute('aria-pressed'), 'true');
      const next = await evidence(page, documentId); assert.deepEqual(next.document.document, before.document.document);
      assert.deepEqual(next.state.history, before.state.history);
      const observed = await events.read(); t.diagnostic(`pen-touch ${index ? 'Web' : 'PC'} ${JSON.stringify(observed)}`);
      for (const gesture of [firstEvents, observed.slice(firstEvents.length)]) {
        const downs = gesture.filter(event => event.type === 'pointerdown' && event.pointerType === 'touch' && event.trusted && event.surface === 'original');
        assert.ok(downs.length >= 2 && new Set(downs.map(event => event.pointerId)).size >= 2);
      }
      assert.ok(observed.some(event => event.type === 'pointerup' && event.pointerType === 'touch' && event.trusted));
    } finally { await events.stop(); await cdp.detach(); await witness.dispose(); }
  }
  await finish();
});

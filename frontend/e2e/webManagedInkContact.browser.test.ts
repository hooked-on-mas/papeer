import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElementHandle, JSHandle, Page as BrowserPage } from 'playwright-core';
import type { RepositoryState } from '../src/runtime/edits/ports.ts';
import { EditGraph } from '../src/runtime/edits/editGraph.ts';
import { projectInkObject } from '../src/features/reader/ink/canonicalInk.ts';
import { isDeepStrictEqual } from 'node:util';
import type { ContentPublication, DocumentSnapshot } from '../src/runtime/edits/contracts.ts';
import { openComposition, sync as deliver } from './support/documentComposition.ts';
import { waitForSnapshot } from './support/waitForSnapshot.ts';
import { observePointers } from './support/observePointers.ts';
import { openMixedReference, referencePaperPoint, seedMixedReference } from './support/mixedReferenceInput.ts';

type Point = { x: number; y: number };
type PointerObservation = Awaited<ReturnType<Awaited<ReturnType<typeof observePointers>>['read']>>[number];

type Observation = { state: RepositoryState; pending: unknown[]; document: { ready: boolean; phase: string; inputActive: boolean; document: DocumentSnapshot } };
const observe = (page: BrowserPage, id: string): Promise<Observation> => page.evaluate(id => (window as unknown as {
  compositionObservedEvidence(id: string): Promise<Observation>;
}).compositionObservedEvidence(id), id);
const durable = (value: Observation) => value.document.ready && value.document.phase === 'idle' && !value.document.inputActive
  && value.pending.length === 0 && isDeepStrictEqual(new EditGraph(value.state.checkpoint).getView().heads, [value.document.document.version])
  && isDeepStrictEqual(new EditGraph(value.state.checkpoint).snapshot(value.document.document.version), value.document.document);
const metrics = (page: BrowserPage) => page.locator('[data-reader-surface="original"] [data-pdf-scroller]').evaluate(element => {
  const surface = element.querySelector<HTMLElement>('[data-pdf-surface]');
  return { top: element.scrollTop, left: element.scrollLeft, width: surface?.getBoundingClientRect().width,
    page: element.closest('[data-canonical-page]')?.getAttribute('data-canonical-page'),
    physical: element.querySelector('.react-pdf__Page')?.getAttribute('data-page-number') };
});

for (const companionKind of ['pdf', 'paper'] as const) test(`Chromium admitted Ink pen survives same/cross-pane touch (${companionKind})`, { timeout: 300_000 }, async t => {
  const seed = (publication: ContentPublication) => {
    assert.ok(publication.content?.kind === 'document');
    if (companionKind === 'paper') { seedMixedReference(publication); return; }
    const original = publication.content.pages[0], translated = structuredClone(original);
    translated.id = crypto.randomUUID(); translated.annotations = [];
    publication.content.translation = { revision: crypto.randomUUID(), pages: [translated], bindings: [{
      original: { pageId: original.id, backgroundRevision: original.backgroundRevision },
      candidates: [{ pageId: translated.id, backgroundRevision: translated.backgroundRevision }],
    }] };
  };
  const { pages, publication, documentId, finish } = await openComposition(t, 'chromium', seed, { pdfFixture: 'text', hasTouch: true });
  assert.ok(publication.content?.kind === 'document'); const source = publication.content.pages[0];
  assert.equal(source.background.kind, 'pdf'); if (source.background.kind !== 'pdf') throw new Error('pdf-required');
  let previous: Observation | null = null;
  for (const [host, page] of pages.entries()) {
    if (companionKind === 'paper') await openMixedReference(page, publication);
    else await page.getByRole('button', { name: '左右', exact: true }).click();
    await page.getByRole('button', { name: 'ペン', exact: true }).click();
    const deadline = Date.now() + 25_000;
    if (previous) {
      for (const peer of [pages[host - 1], page]) {
        const remaining = deadline - Date.now(); assert.ok(remaining > 0);
        await peer.getByRole('button', { name: '同期', exact: true }).click({ timeout: remaining });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([deliver(peer), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('input synchronization deadline exceeded')), Math.max(0, deadline - Date.now()));
          })]);
        } finally { if (timer !== undefined) clearTimeout(timer); }
      }
    }
    const expected: { documentId: string; pageId: string; revision: string; physical: string; companionKind: 'pdf' | 'paper'; paperId: string } =
      { documentId, pageId: source.id, revision: source.backgroundRevision, physical: String(source.background.pdfPage), companionKind, paperId: publication.content.pages[1].id };
    assert.ok(deadline - Date.now() > 0);
    const before = await waitForSnapshot(() => observe(page, documentId), value => durable(value) && value.state.checkpoint.libraryId === publication.libraryBatch.libraryId
      && (!previous || isDeepStrictEqual(value.document.document, previous.document.document)
        && isDeepStrictEqual(value.state.history, previous.state.history)
        && isDeepStrictEqual(new EditGraph(value.state.checkpoint).getView().heads, new EditGraph(previous.state.checkpoint).getView().heads)
        && previous.state.checkpoint.batches.every(batch => value.state.checkpoint.batches.some(item => item.id === batch.id))), Math.max(1, deadline - Date.now()));
    assert.ok(deadline - Date.now() > 0);
    const ready: JSHandle<SVGSVGElement | false | null | undefined> = await page.waitForFunction((expected: { documentId: string; pageId: string; revision: string; physical: string; companionKind: 'pdf' | 'paper'; paperId: string }) => {
      const root = document.querySelector(`[data-content-document="${expected.documentId}"]`), active = root?.querySelector('[data-reader-surface="original"][data-active-surface="true"]');
      const page = active?.querySelector(`[data-canonical-page="${expected.pageId}"][data-background-revision="${expected.revision}"]`);
      const scroller = page?.querySelector('[data-pdf-scroller][data-rendered="true"]');
      const pdf = scroller?.querySelector(`.react-pdf__Page[data-page-number="${expected.physical}"]`), canvas = pdf?.querySelector<HTMLCanvasElement>('canvas');
      const surface = scroller?.querySelector<HTMLElement>('[data-pdf-surface]'), ink = scroller?.querySelector<SVGSVGElement>('svg[aria-label="PDF書き込みレイヤー"]');
      const other = root?.querySelector(expected.companionKind === 'paper' ? '[data-reader-reference]' : '[data-reader-surface="translated"]');
      const otherReady = expected.companionKind === 'pdf' ? other?.querySelector('[data-rendered="true"] canvas') : other?.querySelector(`[data-paper-page="${expected.paperId}"]`);
      const referenceInput = expected.companionKind === 'paper' ? (window as unknown as { compositionReferenceInputEvidence?: () => { active: boolean; blocked: boolean } | null }).compositionReferenceInputEvidence?.() : null;
      const cb = canvas?.getBoundingClientRect(), sb = surface?.getBoundingClientRect(), ib = ink?.getBoundingClientRect(), ob = other?.getBoundingClientRect();
      const tool = [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === 'ペン');
      if (!canvas?.width || !canvas.height || !cb || !sb || !ib || !ob || sb.width <= 0 || sb.height <= 0 || ib.width <= 0 || ob.width <= 0
        || Math.abs(cb.width - sb.width) > 1 || Math.abs(cb.height - sb.height) > 1 || document.fonts.status !== 'loaded'
        || !otherReady || expected.companionKind === 'paper' && (!referenceInput?.active || referenceInput.blocked) || !tool || tool.disabled || tool.getAttribute('aria-pressed') !== 'true') return false;
      return ink;
    }, expected, { timeout: Math.max(1, deadline - Date.now()) });
    const ink: ElementHandle<SVGSVGElement> | null = ready.asElement(); assert.ok(ink); const box = await ink.boundingBox(); assert.ok(box && box.width > 100 && box.height > 100);
    const other = page.locator(companionKind === 'paper' ? '[data-reader-reference]' : '[data-reader-surface="translated"]');
    const otherBox = await other.boundingBox(); assert.ok(otherBox);
    const a = { x: box.x + box.width * .25, y: box.y + box.height * .25 }, b = { x: box.x + box.width * .4, y: box.y + box.height * .3 };
    const palm = { id: 41, x: box.x + box.width * .65, y: box.y + box.height * .3 };
    const point: Point = companionKind === 'paper' ? await referencePaperPoint(page, publication.content.pages[1].id) : { x: otherBox.x + otherBox.width / 2, y: otherBox.y + otherBox.height / 2 };
    const cross: Point & { id: number } = { id: 42, ...point };
    const cdp = await page.context().newCDPSession(page), events = await observePointers(page), initialMetrics = await metrics(page);
    t.diagnostic('ink-host-baseline ' + JSON.stringify({ host: host ? 'Web' : 'PC', version: before.document.document.version,
      heads: new EditGraph(before.state.checkpoint).getView().heads, history: before.state.history, batchIds: before.state.checkpoint.batches.map(batch => batch.id),
      previousVersion: previous?.document.document.version ?? null }).slice(0, 50000));
    let phase = 'primary';
    try {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', pointerType: 'pen', button: 'left', buttons: 1, clickCount: 1, force: .5, ...a });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', pointerType: 'pen', button: 'left', buttons: 1, force: .5, ...b });
      await waitForSnapshot(() => observe(page, documentId), value => value.document.inputActive);
      const admitted = await events.read();
      assert.ok(admitted.some(event => event.type === 'pointerdown' && event.pointerType === 'pen' && event.trusted && event.pressure > 0 && event.inkLabel === 'PDF書き込みレイヤー'));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [palm] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [palm, cross] });
      const held = await observe(page, documentId);
      assert.equal(held.document.inputActive, true); assert.deepEqual(held.document.document, before.document.document);
      assert.deepEqual(held.state.history, before.state.history);
      assert.equal(await page.locator('[data-reader-surface="original"]').getAttribute('data-active-surface'), 'true');
      const c = { x: b.x + 20, y: b.y + 8 };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', pointerType: 'pen', button: 'left', buttons: 1, force: .5, ...c });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', pointerType: 'pen', button: 'left', buttons: 0, force: 0, ...c });
      const saved = await waitForSnapshot(() => observe(page, documentId), value => durable(value) && value.state.history.length === before.state.history.length + 1);
      const initial = before.document.document.pages[0].annotations, current = saved.document.document.pages[0].annotations;
      assert.deepEqual(current.slice(0, initial.length), initial); assert.equal(current.length, initial.length + 1);
      const stroke = current[current.length - 1]; assert.equal(stroke.kind, 'ink');
      assert.ok(stroke.kind === 'ink' && stroke.geometry.kind === 'path' && stroke.geometry.points.length >= 3);
      if (stroke.kind !== 'ink') throw new Error('ink-required');
      const projected = projectInkObject(stroke, source); const last = projected.points[projected.points.length - 1];
      assert.ok(last && Math.abs(last[0] - (c.x - box.x) / box.width) < .02 && Math.abs(last[1] - (c.y - box.y) / box.height) < .02, 'continued pen endpoint survives in saved stroke');
      const afterPen = await metrics(page); assert.deepEqual(afterPen, initialMetrics);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...palm, x: palm.x + 80 }, cross] });
      assert.deepEqual(await metrics(page), afterPen); assert.equal(await page.locator('[data-reader-surface="original"]').getAttribute('data-active-surface'), 'true');
      phase = 'secondary-pen-during-drain';
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', pointerType: 'pen', button: 'left', buttons: 1, clickCount: 1, force: .5, x: a.x, y: a.y + 25 });
      const downState = await observe(page, documentId);
      assert.equal(downState.document.inputActive, false); assert.ok(durable(downState));
      assert.deepEqual(downState.document.document, saved.document.document); assert.deepEqual(downState.state.history, saved.state.history);
      assert.equal(await page.locator('[data-reader-surface="original"]').getAttribute('data-active-surface'), 'true');
      assert.deepEqual(await metrics(page), afterPen);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', pointerType: 'pen', button: 'left', buttons: 1, force: .5, x: b.x, y: b.y + 25 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', pointerType: 'pen', button: 'left', buttons: 0, force: 0, x: b.x, y: b.y + 25 });
      assert.deepEqual(await metrics(page), afterPen);
      const secondaryEvents = await events.read();
      assert.ok(secondaryEvents.filter(event => event.type === 'pointerdown' && event.pointerType === 'pen' && event.trusted && event.pressure > 0).length >= 2);
      const contacts = secondaryEvents.slice(admitted.length);
      const near = (event: typeof contacts[number], point: { x: number; y: number }) => Math.hypot(event.x - point.x, event.y - point.y) <= 2;
      const palmDown = contacts.find(event => event.type === 'pointerdown' && event.trusted && event.pointerType === 'touch' && near(event, palm));
      const crossTouchDown: PointerObservation | undefined = contacts.find(event => event.type === 'pointerdown' && event.trusted && event.pointerType === 'touch' && near(event, cross));
      assert.ok(palmDown && crossTouchDown && palmDown.pointerId !== crossTouchDown.pointerId);
      if (companionKind === 'paper') assert.ok(crossTouchDown.reader && crossTouchDown.surface === 'reference'
        && crossTouchDown.paperPage === publication.content.pages[1].id && crossTouchDown.pane?.includes('document-paper-pane'));
      const primary = admitted.find(event => event.type === 'pointerdown' && event.trusted && event.pointerType === 'pen');
      assert.ok(primary);
      const primaryUpIndex = contacts.findIndex(event => event.type === 'pointerup' && event.pointerId === primary.pointerId && event.pointerType === 'pen');
      assert.ok(primaryUpIndex > contacts.indexOf(palmDown) && primaryUpIndex > contacts.indexOf(crossTouchDown));
      for (const contact of [palmDown, crossTouchDown]) {
        assert.equal(contacts.slice(contacts.indexOf(contact) + 1).some(event => event.pointerType === 'touch'
          && event.pointerId === contact.pointerId && (event.type === 'pointerup' || event.type === 'pointercancel')), false,
        'each observed touch contact remains down through the secondary pen attempt');
      }
      const still = await observe(page, documentId); assert.equal(still.document.inputActive, false); assert.ok(durable(still));
      assert.equal(await page.locator('[data-reader-surface="original"]').getAttribute('data-active-surface'), 'true'); assert.deepEqual(still.document.document, saved.document.document); assert.deepEqual(still.state.history, saved.state.history);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      // The next admitted stroke must remain possible after every secondary contact has ended.
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', pointerType: 'pen', button: 'left', buttons: 1, clickCount: 1, force: .5, x: a.x, y: a.y + 25 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', pointerType: 'pen', button: 'left', buttons: 1, force: .5, x: b.x, y: b.y + 25 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', pointerType: 'pen', button: 'left', buttons: 0, force: 0, x: b.x, y: b.y + 25 });
      const next = await waitForSnapshot(() => observe(page, documentId), value => durable(value) && value.state.history.length === saved.state.history.length + 1);
      previous = next;
      t.diagnostic('ink-host-saved ' + JSON.stringify({ host: host ? 'Web' : 'PC', primaryVersion: saved.document.document.version,
        version: next.document.document.version, heads: new EditGraph(next.state.checkpoint).getView().heads,
        history: next.state.history, batchIds: next.state.checkpoint.batches.map(batch => batch.id) }).slice(0, 50000));
      assert.deepEqual(next.document.document.pages[0].annotations.slice(0, current.length), current);
      assert.equal(next.document.document.pages[0].annotations.length, current.length + 1);
      assert.equal(initialMetrics.page, source.id); assert.equal(initialMetrics.physical, String(source.background.pdfPage));
      const recorded = await events.read(); t.diagnostic(`ink-contact ${host ? 'Web' : 'PC'} ${JSON.stringify(recorded)}`);
      assert.ok(recorded.some(event => event.type === 'pointerdown' && event.trusted && event.pointerType === 'touch' && event.surface === 'original'));
      assert.ok(recorded.some(event => event.type === 'pointerdown' && event.trusted && event.pointerType === 'touch' && event.surface === (companionKind === 'paper' ? 'reference' : 'translated')));
      const penDown = recorded.find(event => event.type === 'pointerdown' && event.trusted && event.pointerType === 'pen' && event.pressure > 0);
      assert.ok(penDown && recorded.some(event => event.type === 'pointerup' && event.trusted && event.pointerType === 'pen' && event.pointerId === penDown.pointerId));
      const crossDown = recorded.findIndex(event => event.type === 'pointerdown' && event.trusted && event.pointerType === 'touch' && event.surface === (companionKind === 'paper' ? 'reference' : 'translated'));
      const continued = recorded.findIndex((event, index) => index > crossDown && event.type === 'pointermove' && event.trusted
        && event.pointerType === 'pen' && event.pointerId === penDown.pointerId && event.pressure > 0);
      const primaryUp = recorded.findIndex((event, index) => index > continued && event.type === 'pointerup' && event.pointerType === 'pen' && event.pointerId === penDown.pointerId);
      assert.ok(crossDown >= 0 && continued > crossDown && primaryUp > continued, 'the admitted primary pen continues after the other pane is touched');
    } catch (error) {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const data = await Promise.race([Promise.all([events.read(), metrics(page), observe(page, documentId)]),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('diagnostic-timeout')), 3000); })])
          .finally(() => { if (timer !== undefined) clearTimeout(timer); });
        t.diagnostic('ink-contact-failure ' + JSON.stringify({ host: host ? 'Web' : 'PC', phase, data }).slice(0, 50000));
      } catch (diagnosticError) { t.diagnostic('ink-contact-diagnostic-error ' + String(diagnosticError)); }
      throw error;
    } finally { await events.stop(); await cdp.detach(); await ready.dispose(); }
  }
  await finish();
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import type { Page as BrowserPage } from 'playwright-core';
import type { ContentPublication } from '../src/runtime/edits/contracts.ts';
import { openComposition } from './support/documentComposition.ts';
import { observePointers } from './support/observePointers.ts';

let pdfId = '', paperId = '', revision = '', physical = 0;
function seed(publication: ContentPublication) {
  assert.equal(publication.content?.kind, 'document');
  if (publication.content?.kind !== 'document') throw new Error('document required');
  const item = publication.libraryBatch.changes.find(value => value.type === 'put-item');
  assert.ok(item?.type === 'put-item'); item.item.kind = 'notebook'; delete item.item.resourceId;
  const [pdf, paper] = publication.content.pages;
  assert.equal(pdf.background.kind, 'pdf'); if (pdf.background.kind !== 'pdf') throw new Error('pdf required');
  pdf.annotations = []; pdfId = pdf.id; revision = pdf.backgroundRevision; physical = pdf.background.pdfPage;
  paper.background = { kind: 'paper', spec: { template: 'grid5', color: 'cream' } };
  paper.widthPt = 430; paper.heightPt = 750; paper.annotations = []; paperId = paper.id;
  delete publication.content.translation;
}
const observed = (page: BrowserPage, id: string) => page.evaluate(id => (window as any).compositionObservedEvidence(id), id);

// Both real mounts, one trusted Chromium pointer stream per turn. No WebKit hardware claim.
test('main one-finger page turns preserve pinned reference (Chromium PC and Web)', { timeout: 300_000 }, async t => {
  const setup = await openComposition(t, 'chromium', seed, { pdfFixture: 'text', hasTouch: true });
  try {
    for (const [host, page] of setup.pages.entries()) {
      const deadline = Date.now() + 100_000;
      const remaining = () => { const ms = deadline - Date.now(); assert.ok(ms > 0, 'host budget exhausted'); return ms; };
      const library = page.getByRole('button', { name: '資料一覧', exact: true });
      if (await library.getAttribute('aria-expanded') !== 'true') await library.click({ timeout: remaining() });
      await page.getByRole('button', { name: 'Canonical notebook composition', exact: true }).click({ timeout: remaining() });
      const root = page.locator('[data-reader-root]'), reference = root.locator('[data-reader-reference]');
      await root.locator(`[data-canonical-page="${pdfId}"]`).first().waitFor({ timeout: remaining() });
      await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).click({ timeout: remaining() });
      await page.getByRole('button', { name: '次のページ', exact: true }).click({ timeout: remaining() });
      const readTool = page.getByRole('button', { name: '読む', exact: true });
      await readTool.click({ timeout: remaining() });
      assert.equal(await readTool.getAttribute('aria-pressed'), 'true');
      await page.getByLabel('倍率', { exact: true }).selectOption('2', { timeout: remaining() });
      const before = await observed(page, setup.documentId);
      const events = await observePointers(page), cdp = await page.context().newCDPSession(page);
      const trace: unknown[] = [];
      const changes = await page.evaluateHandle(() => {
        const seen: string[] = [];
        const record = () => {
          const active = document.querySelector('[data-reader-surface][data-active-surface="true"]');
          const id = active?.querySelector('[data-canonical-page]')?.getAttribute('data-canonical-page')
            ?? active?.querySelector('[data-paper-page]')?.getAttribute('data-paper-page');
          if (id && seen[seen.length - 1] !== id) seen.push(id);
        };
        const observer = new MutationObserver(record); observer.observe(document.querySelector('[data-reader-root]')!, { childList: true, subtree: true, attributes: true });
        record(); return { read: () => seen.slice(), stop: () => observer.disconnect() };
      });
      try {
        const waitPage = async (id: string, kind: 'pdf' | 'paper') => {
          const witness = await page.waitForFunction(({ id, kind, revision, physical, doc, referenceId }) => {
            const root = document.querySelector(`[data-content-document="${doc}"]`);
            const active = root?.querySelector('[data-reader-surface][data-active-surface="true"]');
            const target = kind === 'pdf' ? active?.querySelector(`[data-canonical-page="${id}"][data-background-revision="${revision}"]`) : active?.querySelector(`[data-paper-page="${id}"]`);
            const pane = kind === 'pdf' ? target?.querySelector<HTMLElement>('[data-pdf-scroller][data-rendered="true"]') : target?.closest<HTMLElement>('.document-paper-pane');
            const canvas = target?.querySelector<HTMLCanvasElement>('canvas'), surface = target?.querySelector<HTMLElement>('[data-pdf-surface]');
            const pageSurface = kind === 'pdf' ? surface : target as HTMLElement | null;
            const cb = canvas?.getBoundingClientRect(), sb = pageSurface?.getBoundingClientRect(), pb = pane?.getBoundingClientRect();
            const proof = (window as any).compositionReferenceInputEvidence();
            const zoom = [...document.querySelectorAll<HTMLSelectElement>('select[aria-label="倍率"]')].find(el => !el.closest('[data-reader-reference]'));

            const nav = (window as any).compositionNavigationEvidence();
            const model = nav.document?.document?.pages.find((p: any) => p.id === id);
            return !!pane && !!target && !!sb && !!pb && sb.width > 0 && sb.height > 0 && pb.width > 200 && pb.height > 100
              && pane.scrollWidth > pane.clientWidth + 1 && pane.scrollHeight > pane.clientHeight + 1
              && zoom?.value === '2' && !!proof?.active && !proof.blocked && nav.documentId === doc && nav.document?.ready && nav.document.phase === 'idle' && !nav.document.inputActive
              && !!model && (kind !== 'pdf' || (model.backgroundRevision === revision && model.background.kind === 'pdf' && model.background.pdfPage === physical
                && !!target.querySelector(`.react-pdf__Page[data-page-number="${physical}"]`) && !!canvas?.width && !!canvas.height && !!cb && !!sb
                && Math.abs(cb.width - sb.width) <= 1 && !!target.querySelector('.textLayer span[role="presentation"]') && document.fonts.status === 'loaded'))
              && !!root?.querySelector(`[data-reader-reference] [data-canonical-page="${referenceId}"][data-background-revision="${revision}"] [data-pdf-scroller][data-rendered="true"]`);
          }, { id, kind, revision, physical, doc: setup.documentId, referenceId: pdfId }, { timeout: remaining() });
          await witness.dispose();
          return root.locator(kind === 'pdf' ? `[data-reader-surface][data-active-surface="true"] [data-canonical-page="${id}"] [data-pdf-scroller]` : `[data-reader-surface][data-active-surface="true"] [data-paper-page="${id}"]`).locator(kind === 'pdf' ? ':scope' : 'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " document-paper-pane ")][1]');
        };
        const turn = async (from: string, kind: 'pdf' | 'paper', to: string, toKind: 'pdf' | 'paper', direction: -1 | 1) => {
          const pane = await waitPage(from, kind);
          assert.equal(await readTool.getAttribute('aria-pressed'), 'true', 'reading tool remains selected');
          const position = await pane.evaluate((el: HTMLElement, dir) => { el.scrollTo({ top: 120, left: dir > 0 ? el.scrollWidth : 0 }); return { top: el.scrollTop, left: el.scrollLeft, max: el.scrollWidth - el.clientWidth, height: el.clientHeight }; }, direction);
          assert.ok(position.top > 0, 'precondition: main pane scrolls vertically');
          assert.ok(direction > 0 ? position.left >= position.max - 20 : position.left <= 1, 'horizontal edge');
          const box = await pane.boundingBox(); assert.ok(box && box.width > 200 && box.height > 100);
          const x = box.x + box.width / 2, y = box.y + Math.min(box.height / 2, 100), dx = direction > 0 ? -100 : 100;
          const beforeTouch = await pane.evaluate((el: HTMLElement, dir) => {
            const style = getComputedStyle(el), gutter = style.scrollbarGutter.includes('stable') ? el.offsetWidth - el.clientWidth : 0;
            return { top: el.scrollTop, left: el.scrollLeft, edge: dir > 0 ? el.scrollLeft + el.clientWidth >= el.scrollWidth - gutter - 1 : el.scrollLeft <= 1, paneClass: el.getAttribute('class') };
          }, direction);
          assert.ok(beforeTouch.top > 0 && beforeTouch.edge, 'settled pre-touch scroll and edge persisted');
          const hit = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return { pane: el?.closest('[data-pdf-scroller], .document-paper-pane')?.getAttribute('class'), surface: el?.closest('[data-reader-surface]')?.getAttribute('data-reader-surface'), reader: !!el?.closest('[data-reader-root]') }; }, { x, y });
          assert.deepEqual(hit, { pane: beforeTouch.paneClass, surface: 'original', reader: true }, 'start hits actual main pane');
          const touchAction = await page.evaluate(({ x, y }) => {
            const target = document.elementFromPoint(x, y), pane = target?.closest<HTMLElement>('[data-pdf-scroller], .document-paper-pane');
            const chain: { tag: string; touchAction: string }[] = [];
            for (let node = target; node; node = node.parentElement) {
              chain.push({ tag: node.tagName, touchAction: getComputedStyle(node).touchAction });
              if (node === pane) break;
            }
            return { target: target && getComputedStyle(target).touchAction, pane: pane && getComputedStyle(pane).touchAction, chain };
          }, { x, y });
          assert.equal(touchAction.pane, 'none', 'canonical pane owns touch gestures');
          const baseline = (await events.read()).length, point = { id: 91, x, y };
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, x: x + dx }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          trace.push({ phase: 'touch-dispatched', from, to, position, beforeTouch, hit, touchAction, stream: (await events.read()).slice(baseline) });
          const nextPane = await waitPage(to, toKind);
          assert.equal(await readTool.getAttribute('aria-pressed'), 'true', 'reading tool remains selected after turn');
          assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), direction > 0 ? '2' : '1');
          assert.equal(await nextPane.evaluate((el: HTMLElement) => el.scrollTop), 0);
          assert.equal(await reference.locator(`[data-canonical-page="${pdfId}"]`).count(), 1);
          const stream = (await events.read()).slice(baseline); trace.push({ from, to, position, stream });
          const touches = stream.filter(e => e.pointerType === 'touch');
          const down = touches.filter(e => e.type === 'pointerdown');
          assert.equal(down.length, 1, 'one observed touch down');
          const first = down[0];
          assert.ok(first.trusted && first.reader && first.surface === 'original' && first.pane === beforeTouch.paneClass
            && Math.abs(first.x - x) <= 2 && Math.abs(first.y - y) <= 2, 'trusted start in actual main pane');
          const startIndex = touches.indexOf(first);
          const moveIndex = touches.findIndex((e, i) => i > startIndex && e.type === 'pointermove' && e.pointerId === first.pointerId && e.trusted);
          const upIndex = touches.findIndex((e, i) => i > moveIndex && e.type === 'pointerup' && e.pointerId === first.pointerId && e.trusted);
          assert.ok(moveIndex > startIndex && upIndex > moveIndex, 'same native pointer down, move, up in order');
          assert.equal(touches.slice(startIndex + 1, upIndex).some(e => e.type === 'pointerdown' || e.type === 'pointercancel'), false);
          const actual = touches.slice(startIndex, upIndex + 1).filter(e => e.pointerId === first.pointerId);
          const end = touches[upIndex], actualDx = end.x - first.x;
          const maxY = Math.max(...actual.map(e => Math.abs(e.y - first.y)));
          assert.ok(Math.sign(actualDx) === -direction && Math.abs(actualDx) >= 72 && Math.abs(actualDx) >= 1.5 * maxY,
            `observed swipe geometry dx=${actualDx}, maxY=${maxY}`);
        };
        // Initial B -> A, then a fresh all-up A -> B. Both directions start off-top.
        await turn(paperId, 'paper', pdfId, 'pdf', -1);
        await turn(pdfId, 'pdf', paperId, 'paper', 1);
        const sequence = await changes.evaluate(value => value.read());
        assert.deepEqual(sequence, [paperId, pdfId, paperId], 'observed visible page sequence after the two touches');
        const after = await observed(page, setup.documentId);
        assert.ok(isDeepStrictEqual(after.document.document, before.document.document), 'document unchanged');
        assert.ok(isDeepStrictEqual(after.state.history, before.state.history), 'edit history unchanged');
        assert.ok(isDeepStrictEqual(after.state.checkpoint.batches, before.state.checkpoint.batches), 'edit batches unchanged');
      } catch (error) {
        const current = await Promise.race([page.evaluate(() => {
          const active = document.querySelector('[data-reader-surface][data-active-surface="true"]');
          const pane = active?.querySelector<HTMLElement>('[data-pdf-scroller], .document-paper-pane');
          const rect = pane?.getBoundingClientRect();
          const tool = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '読む');
          return { tool: tool?.getAttribute('aria-pressed'), page: (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement | null)?.value,
            visibleId: active?.querySelector('[data-canonical-page]')?.getAttribute('data-canonical-page') ?? active?.querySelector('[data-paper-page]')?.getAttribute('data-paper-page'),
            port: (window as any).compositionReferenceInputEvidence(), scroll: pane && { top: pane.scrollTop, left: pane.scrollLeft, width: pane.scrollWidth, height: pane.scrollHeight, clientWidth: pane.clientWidth, clientHeight: pane.clientHeight },
            geometry: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, paneTouchAction: pane && getComputedStyle(pane).touchAction };
        }).catch(reason => ({ error: String(reason) })), new Promise(resolve => setTimeout(() => resolve({ error: 'diagnostic timeout' }), 2000))]);
        t.diagnostic('swipe failure ' + JSON.stringify({ host: host ? 'Web' : 'PC', trace, current, events: await events.read().catch(() => []) })); throw error;
      }
      finally { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }).catch(() => {}); await events.stop(); await changes.evaluate(value => value.stop()); await changes.dispose(); await cdp.detach(); }
    }
  } finally { await setup.finish(); }
});

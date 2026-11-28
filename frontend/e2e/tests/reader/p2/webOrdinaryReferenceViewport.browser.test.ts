import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import type { Locator, Page } from 'playwright-core';
import { committed } from './ordinaryStorage.ts';
import { ordinaryWeb } from './ordinaryWeb.ts';

const refSelector = '[data-reader-reference]';
async function geometry(pane: Locator) {
  return pane.evaluate(element => {
    const scroller = element.querySelector<HTMLElement>('[data-pdf-scroller]')!;
    const surface = element.querySelector<HTMLElement>('[data-pdf-surface]')!;
    const p = scroller.getBoundingClientRect(), s = surface.getBoundingClientRect();
    const padding = getComputedStyle(surface.closest('.react-pdf__Document')!.parentElement!);
    const border = getComputedStyle(surface.parentElement!);
    return { width: s.width, height: s.height, roomWidth: scroller.clientWidth, roomHeight: scroller.clientHeight,
      fitWidth: scroller.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight)
        - parseFloat(border.borderLeftWidth) - parseFloat(border.borderRightWidth),
      top: scroller.scrollTop, left: scroller.scrollLeft,
      x: (p.left + scroller.clientWidth / 2 - s.left) / s.width,
      y: Math.max(0, (p.top - s.top) / s.height) };
  });
}
async function ready(page: Page, width?: number) {
  await page.waitForFunction(({ selector, width }) => {
    const root = document.querySelector(selector), pane = root?.querySelector('[data-pdf-scroller]');
    const surface = root?.querySelector('[data-pdf-surface]');
    return pane?.getAttribute('data-rendered') === 'true' && !!surface
      && (width === undefined || Math.abs(surface.getBoundingClientRect().width - width) < 2);
  }, { selector: refSelector, width });
  // Reject a still-visible old raster before the debounced resize/render starts.
  await page.evaluate(async ({ selector, width }) => {
    const deadline = performance.now() + 10_000;
    let since: number | undefined;
    for (;;) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const root = document.querySelector(selector), pane = root?.querySelector('[data-pdf-scroller]');
      const surface = root?.querySelector('[data-pdf-surface]');
      const now = performance.now();
      const matches = pane?.getAttribute('data-rendered') === 'true' && !!surface
        && (width === undefined || Math.abs(surface.getBoundingClientRect().width - width) < 2);
      if (!matches) since = undefined;
      else { since ??= now; if (now - since >= 250) return; }
      if (now > deadline) throw new Error('reference raster did not remain settled at the expected width');
    }
  }, { selector: refSelector, width });
}
async function wheel(page: Page, pane: Locator, amount: number, control = false) {
  const box = await pane.locator('[data-pdf-scroller]').boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(80, box.height / 2));
  if (control) await page.keyboard.down('Control');
  try { await page.mouse.wheel(0, amount); } finally { if (control) await page.keyboard.up('Control'); }
}
async function settledScroll(pane: Locator) {
  await pane.evaluate(async root => {
    const element = root.querySelector<HTMLElement>('[data-pdf-scroller]')!;
    const deadline = performance.now() + 10_000;
    let top = element.scrollTop, left = element.scrollLeft, since = performance.now();
    for (;;) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const now = performance.now();
      if (top !== element.scrollTop || left !== element.scrollLeft) {
        top = element.scrollTop; left = element.scrollLeft; since = now;
      } else if (now - since >= 250) return;
      if (now > deadline) throw new Error('reference scroll did not settle before resizing');
    }
  });
}

for (const engine of ['chromium', 'webkit'] as const) for (const resize of ['deferred-scroll', 'settled'] as const)
test(`ordinary reference zoom bounds, focus and resize place (${engine}, ${resize})`, { timeout: 180_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  await page.setViewportSize({ width: 1440, height: 1400 });
  const root = path.resolve(import.meta.dirname, '../../../../..'), file = path.join(app.scratch, 'reference-viewport.pdf');
  const generated = spawnSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'frontend/e2e/fixtures/p2PdfNavigation.py'), file], { encoding: 'utf8', windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);
  await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(file);
  await page.getByRole('heading', { name: 'reference-viewport.pdf', exact: true }).waitFor();
  const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
  await page.getByRole('button', { name: '資料一覧', exact: true }).click();
  await page.locator('[data-reader-surface="original"] [data-pdf-scroller][data-rendered="true"]').waitFor();
  await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).click();
  const reference = page.locator(refSelector), main = page.locator('[data-reader-surface="original"]');
  await ready(page);
  const baseline = await geometry(reference);
  assert.ok(baseline.fitWidth > 40 && baseline.width <= baseline.fitWidth + 2 && baseline.height <= baseline.roomHeight);
  const mainBefore = await geometry(main), original = await committed(page, id);

  // Real Ctrl+wheel must saturate at 400%, confined to the pane under the pointer.
  await wheel(page, reference, -2000, true); await ready(page, baseline.fitWidth * 4);
  const maximum = await geometry(reference);
  await wheel(page, reference, -2000, true); await ready(page, maximum.width);
  assert.ok(Math.abs((await geometry(main)).width - mainBefore.width) < 2);
  assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '1');

  await reference.focus(); await page.keyboard.press('End');
  await page.waitForFunction(() => (document.querySelector('[data-reader-reference] [data-pdf-scroller]')?.scrollTop ?? 0) > 100);
  await page.keyboard.press('Home');
  await page.waitForFunction(() => document.querySelector('[data-reader-reference] [data-pdf-scroller]')?.scrollTop === 0);
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('PageDown');
  await page.waitForFunction(() => (document.querySelector('[data-reader-reference] [data-pdf-scroller]')?.scrollTop ?? 0) > 100);
  assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '1', 'reference paging keys scroll without turning the edited page');
  assert.equal((await geometry(main)).top, mainBefore.top);

  // Capture a genuine wheel scroll before resizing, then inspect fractional page position.
  await page.keyboard.press('Home');
  await page.waitForFunction(() => document.querySelector('[data-reader-reference] [data-pdf-scroller]')?.scrollTop === 0);
  await reference.evaluate(root => {
    const pane = root.querySelector<HTMLElement>('[data-pdf-scroller]')!;
    const trace: unknown[] = [];
    (globalThis as unknown as { referenceResizeTrace: unknown[] }).referenceResizeTrace = trace;
    const sample = (event: string) => { if (trace.length < 40) trace.push({ event, at: performance.now(), top: pane.scrollTop,
      width: pane.clientWidth, pageWidth: pane.querySelector('[data-pdf-surface]')?.getBoundingClientRect().width,
      rendered: pane.dataset.rendered }); };
    pane.addEventListener('scroll', () => sample('scroll'));
    new ResizeObserver(() => sample('resize')).observe(pane);
    sample('start');
  });
  if (resize === 'deferred-scroll') await reference.evaluate(root => {
    const pane = root.querySelector<HTMLElement>('[data-pdf-scroller]')!;
    // Model WebKit delivering the notification after layout invalidates the old draw.
    // The actual wheel and native scroll position remain unchanged; no event is forged.
    const defer = (event: Event) => event.stopImmediatePropagation();
    pane.addEventListener('scroll', defer, { capture: true });
    (globalThis as unknown as { releaseReferenceScrollFault?: () => void }).releaseReferenceScrollFault = () => {
      pane.removeEventListener('scroll', defer, true);
    };
  });
  const place = await (async () => {
    try {
      await wheel(page, reference, 350);
      await page.waitForFunction(() => (document.querySelector('[data-reader-reference] [data-pdf-scroller]')?.scrollTop ?? 0) > 200);
      if (resize === 'settled') await settledScroll(reference);
      const at = await geometry(reference);
      await page.setViewportSize({ width: 1280, height: 1080 });
      return at;
    } finally {
      await page.evaluate(() => {
        const state = globalThis as unknown as { releaseReferenceScrollFault?: () => void };
        state.releaseReferenceScrollFault?.(); delete state.releaseReferenceScrollFault;
      });
    }
  })();
  try { await page.waitForFunction(({ width, pageWidth, y }) => {
    const pane = document.querySelector<HTMLElement>('[data-reader-reference] [data-pdf-scroller]');
    const surface = pane?.querySelector<HTMLElement>('[data-pdf-surface]');
    if (!pane || !surface || pane.dataset.rendered !== 'true' || pane.clientWidth === width
      || Math.abs(surface.getBoundingClientRect().width - pageWidth) < 2) return false;
    const p = pane.getBoundingClientRect(), s = surface.getBoundingClientRect();
    return Math.abs(Math.max(0, (p.top - s.top) / s.height) - y) < .01;
  }, { width: place.roomWidth, pageWidth: place.width, y: place.y }); } catch (error) {
    t.diagnostic(JSON.stringify({ resizeFailure: true, mode: resize, before: place, observed: await geometry(reference), main: await geometry(main),
      trace: await page.evaluate(() => (globalThis as unknown as { referenceResizeTrace: unknown[] }).referenceResizeTrace) }));
    throw error;
  }
  await ready(page);
  const resized = await geometry(reference);
  t.diagnostic(JSON.stringify({ beforeResize: place, afterResize: resized }));
  assert.ok(Math.abs(resized.x - place.x) < .01, 'resize keeps the horizontal reading place');

  await reference.focus(); await page.keyboard.press('Control+Digit0'); await ready(page);
  await page.waitForFunction(() => {
    const pane = document.querySelector<HTMLElement>('[data-reader-reference] [data-pdf-scroller]')!;
    const surface = pane.querySelector('[data-pdf-surface]')!.getBoundingClientRect();
    return pane.dataset.rendered === 'true' && surface.width <= pane.clientWidth && surface.height <= pane.clientHeight;
  });
  const minimum = await geometry(reference);
  await wheel(page, reference, 2000, true); await ready(page, minimum.width);
  await reference.focus(); await page.keyboard.press('Control+Minus'); await ready(page, minimum.width);
  assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '1');
  const after = await committed(page, id);
  assert.deepEqual(after.root, original.root); assert.equal(after.edits.length, 0);
  t.diagnostic(JSON.stringify({ baseline, maximum, place, resized, minimum, physicalDeviceAcceptance: false }));
});

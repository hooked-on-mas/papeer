import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createNotebook, ordinaryWeb } from '../p2/ordinaryWeb.ts';

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary notebook fit-page geometry at compact viewport and 125% UI scale (${engine})`, { timeout: 180_000 }, async t => {
  const app = await ordinaryWeb(t, engine), { page } = app;
  await page.setViewportSize({ width: 1382, height: 910 });
  await createNotebook(page, 'Geometry observation');
  await page.getByRole('button', { name: '表示設定', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'このライブラリの表示設定' });
  await dialog.getByLabel('文字の大きさ').selectOption('1.25');
  await dialog.getByRole('button', { name: '表示設定を閉じる' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByLabel('倍率', { exact: true }).selectOption('0');
  const paper = page.locator('.document-paper-pane[aria-label="用紙"] [data-paper-page]');
  await paper.waitFor({ state: 'visible' });
  await paper.evaluate(async element => {
    let previous = '', stableSince = performance.now();
    for (let i = 0; i < 180; i++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const r = element.getBoundingClientRect();
      const next = [r.x, r.y, r.width, r.height].join(',');
      if (next !== previous) { previous = next; stableSince = performance.now(); }
      else if (r.width > 0 && r.height > 0 && performance.now() - stableSince >= 300) return;
    }
    throw new Error('paper geometry did not settle');
  });
  const observation = await paper.evaluate(element => {
    const nodes = []; let current: Element | null = element;
    while (current) {
      const r = current.getBoundingClientRect(), s = getComputedStyle(current);
      nodes.push({ tag: current.tagName, id: current.id, className: current.getAttribute('class'),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom },
        clientWidth: current.clientWidth, clientHeight: current.clientHeight,
        scrollWidth: current.scrollWidth, scrollHeight: current.scrollHeight,
        overflowX: s.overflowX, overflowY: s.overflowY, display: s.display, minHeight: s.minHeight });
      current = current.parentElement;
    }
    return { innerWidth, innerHeight, devicePixelRatio, rootFont: getComputedStyle(document.documentElement).fontSize,
      visualViewport: window.visualViewport && { width: window.visualViewport.width, height: window.visualViewport.height, scale: window.visualViewport.scale },
      nodes };
  });
  t.diagnostic(JSON.stringify(observation));
  assert.ok(observation.nodes[0].rect.bottom <= observation.innerHeight + 1, 'fit-page remains inside the viewport');
  assert.ok(observation.nodes[1].rect.bottom <= observation.innerHeight + 1, 'paper pane remains inside the viewport');
  const within = async (selector: string) => {
    const target = page.locator(selector).first();
    try { await target.waitFor({ state: 'visible', timeout: 8000 }); }
    catch (error) {
      t.diagnostic(JSON.stringify(await target.evaluate(element => {
        const rows = []; let current: Element | null = element;
        while (current) { const r = current.getBoundingClientRect(), s = getComputedStyle(current);
          rows.push({ tag: current.tagName, className: current.getAttribute('class'), x: r.x, y: r.y, width: r.width, height: r.height, overflow: s.overflow });
          current = current.parentElement; }
        return { innerWidth, innerHeight, rows };
      })));
      throw error;
    }
    await target.evaluate(async element => {
      let last = '', stable = performance.now();
      for (let i = 0; i < 180; i++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const r = element.getBoundingClientRect(), value = [r.x, r.y, r.width, r.height].join(',');
        if (value !== last) { last = value; stable = performance.now(); }
        else if (r.width > 0 && r.height > 0 && performance.now() - stable >= 300) return;
      }
      throw new Error('content geometry did not settle');
    });
    const rect = await target.evaluate(element => ({ bottom: element.getBoundingClientRect().bottom, viewport: innerHeight }));
    assert.ok(rect.bottom <= rect.viewport + 1, `${selector} is inside the viewport: ${JSON.stringify(rect)}`);
  };
  await page.getByRole('button', { name: '右側で編集', exact: true }).click();
  await within('.document-paper-pane[aria-label="用紙"]');
  await page.setViewportSize({ width: 1000, height: 680 });
  const catalogForHeight = page.getByRole('button', { name: '\u8cc7\u6599\u4e00\u89a7', exact: true });
  if (await catalogForHeight.getAttribute('aria-expanded') !== 'true') await catalogForHeight.click();
  const headerGeometry = await page.evaluate(() => {
    const focus = document.querySelector<HTMLButtonElement>('button[aria-controls~="workspace-chrome"]');
    const panel = document.querySelector<HTMLButtonElement>('button[aria-controls="workspace-related-panel"]');
    const settings = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '\u8868\u793a\u8a2d\u5b9a');
    const pane = document.querySelector<HTMLElement>('.document-paper-pane[aria-label="\u7528\u7d19"]');
    if (!focus || !panel || !settings || !pane) throw new Error('workspace geometry targets missing');
    return { tops: [focus, panel, settings].map(element => element.getBoundingClientRect().top), paneHeight: pane.getBoundingClientRect().height };
  });
  t.diagnostic(JSON.stringify(headerGeometry));
  assert.ok(Math.max(...headerGeometry.tops) - Math.min(...headerGeometry.tops) < 8, 'three workspace commands share a row at 1000px');
  assert.ok(headerGeometry.paneHeight >= 120, 'expanded catalog leaves a usable paper pane at 1000x680');
  await page.setViewportSize({ width: 1000, height: 910 });
  await within('.document-paper-pane[aria-label="用紙"]');
  await page.setViewportSize({ width: 600, height: 910 });
  await within('.document-paper-pane[aria-label="用紙"]');
  const controls = page.getByLabel('文書操作', { exact: true });
  await controls.focus();
  const pageId = await paper.getAttribute('data-paper-page');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => (document.querySelector('[aria-label="文書操作"]')?.scrollTop ?? 0) > 0);
  assert.equal(await paper.getAttribute('data-paper-page'), pageId);
  await page.keyboard.press('PageDown');
  await page.waitForFunction(() => (document.querySelector('[aria-label="文書操作"]')?.scrollTop ?? 0) > 0);
  const controlScroll = await controls.evaluate(element => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight }));
  assert.ok(controlScroll.max > 0 && controlScroll.top > 0, `keyboard reaches scrollable controls: ${JSON.stringify(controlScroll)}`);
  const zoom = page.getByLabel('倍率', { exact: true });
  await zoom.focus();
  assert.equal(await page.locator('[data-reader-root]').count(), 1);
  assert.ok(await zoom.evaluate(element => element.getBoundingClientRect().height >= 44), 'narrow form controls retain the touch target height');
  await page.keyboard.press('ArrowDown');
  assert.equal(await zoom.inputValue(), '1');
  await page.keyboard.press('ArrowUp');
  assert.equal(await zoom.inputValue(), '0');
  const catalog = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
  await within('main');
  await page.getByLabel('新しい資料の名前', { exact: true }).fill('Geometry Markdown');
  await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
  await page.getByRole('button', { name: '資料を作成', exact: true }).click();
  await page.getByRole('heading', { name: 'Geometry Markdown', exact: true }).waitFor();
  await within('[data-content-document] [data-reader-root]');
  await within('[aria-label="Markdownノート"]');
  assert.equal(await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).count(), 1);
  const root = path.resolve(import.meta.dirname, '../../../../..'), file = path.join(app.scratch, 'geometry.pdf');
  const authored = spawnSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'frontend/e2e/fixtures/p2PdfNavigation.py'), file], { encoding: 'utf8', windowsHide: true });
  assert.equal(authored.status, 0, authored.stderr);
  if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
  await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(file);
  await page.getByRole('heading', { name: 'geometry.pdf', exact: true }).waitFor();
  await page.locator('[data-reader-surface="original"] [data-rendered="true"] canvas').first().waitFor();
  await within('[data-content-document] [data-reader-root]');
  await page.getByLabel('倍率', { exact: true }).selectOption('0');
  await within('[data-reader-surface="original"] [data-rendered="true"] canvas');
});

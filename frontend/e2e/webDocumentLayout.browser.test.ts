import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openComposition } from './support/documentComposition.ts';

const statuses = ['送信済み', '保存中…', '端末保存済み・送信状態を確認中', '端末保存済み・送信を再試行できます'];

for (const engine of ['chromium', 'webkit'] as const) test(`production PC/Web status changes preserve PDF layout (${engine})`, { timeout: 120_000 }, async t => {
  const { native, web, finish } = await openComposition(t, engine);
  const measurements = [];
  for (const [host, page] of [['native', native], ['web', web]] as const) {
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    for (const width of Array.from({ length: 17 }, (_, index) => 640 + index * 40)) {
      await page.setViewportSize({ width, height: 950 });
      const rows = await page.evaluate(values => {
        const toolbar = document.querySelector('[role="toolbar"][aria-label="PDFの操作"]');
        const status = toolbar?.querySelector('[role="status"]');
        const scroller = document.querySelector('[data-pdf-scroller], .web-pdf-pane');
        if (!toolbar || !status || !scroller) throw new Error('Production PDF layout elements missing');
        const original = status.textContent;
        try {
          // Presentation-only stand-in for asynchronous replication status changes.
          // One synchronous evaluation prevents React/network activity interleaving the measurements.
          return values.map(text => {
            status.textContent = text;
            return { text, toolbar: toolbar.getBoundingClientRect().height, scroller: scroller.getBoundingClientRect().height };
          });
        } finally { status.textContent = original; }
      }, statuses);
      measurements.push({ host, width, rows });
    }
  }
  t.diagnostic(JSON.stringify(measurements));
  await finish();
  for (const { host, width, rows } of measurements) {
    for (const row of rows) {
      assert.equal(row.toolbar, rows[0].toolbar, `${host} ${width}px toolbar: ${row.text}`);
      assert.equal(row.scroller, rows[0].scroller, `${host} ${width}px PDF scroller: ${row.text}`);
    }
  }
});

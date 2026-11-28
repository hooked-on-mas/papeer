// B13-c measurement (D1 is undecided): records how long a 2,000-item Library takes on the ordinary Web entry, repeated over cold restarts.
// NOTHING here is judged by time. The only assertions are functional (planned counts / rows), and the waits are upper limits against a hang.
// Values come out as `B13C-MEASURE {json}` test diagnostics. The server is the source dev server (unbundled modules), so startup includes module transforms.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { DEFAULT_SPEC, TREE, focusUntil, idbCounts, memoryProbe, normalized, planMatches, rowIdOf, rowSelector, seedAndReopen, stats, treeMetrics, waitDurable, waitFirstRow, type LargeSpec } from '../../support/ordinaryLargeCatalog.ts';

const REPEATS = Number(process.env.B13C_REPEATS ?? 3);
const spec: LargeSpec = { ...DEFAULT_SPEC, batches: Number(process.env.B13C_BATCHES ?? DEFAULT_SPEC.batches) };
/** Upper limit against a hang for a whole-corpus content scan (not a pass/fail time). */
const CONTENT_LIMIT = 150_000;
/** Playwright default wait after a cold restart (upper limit against a hang; the measured start-up of a long history is far above Playwright's 30 s). */
const LIMIT = 300_000;
const now = () => performance.now();
const timed = async (fn: () => Promise<unknown>) => { const t0 = now(); await fn(); return now() - t0; };

for (const engine of ['chromium', 'webkit'] as const) test(`MEASURE ordinary 2,000-item Library over ${REPEATS} cold restarts, history of ${spec.batches} batches (${engine})`, { timeout: 2_400_000 }, async t => {
  const app = await ordinaryWeb(t, engine);
  const emit = (record: Record<string, unknown>) => t.diagnostic('B13C-MEASURE ' + JSON.stringify({ engine, batches: spec.batches, ...record }));
  let page = app.page;
  // Baseline: the same Library while it is still empty (what the dev server costs without any catalog data).
  const baseline: number[] = [];
  for (let n = 0; n < REPEATS; n++) {
    const timings: { libraryClickedAt?: number } = {};
    page = await app.restartLibrary({ showCatalog: true, timings });
    await page.getByRole('button', { name: '一覧を更新', exact: true }).waitFor();
    baseline.push(Date.now() - timings.libraryClickedAt!);
  }
  emit({ kind: 'baseline-empty-library', clickToCatalogControlsMs: stats(baseline) });

  const opened = await seedAndReopen({ page, restartLibrary: app.restartLibrary }, spec, LIMIT), plan = opened.plan;
  page = opened.page;
  assert.equal(plan.missingContentIds.length, 0);
  const root = plan.rootSiblings, first = root[0], last = root[root.length - 1];
  const alpha = planMatches(plan, item => normalized(item.title).includes('alpha')), shared = planMatches(plan, item => !!item.body?.includes('sharedbody'));
  const withBody = planMatches(plan, item => item.body !== null);
  emit({ kind: 'seed', items: plan.items.length, folders: plan.folders.length, batches: plan.batches.length, rows: opened.seed.rows, payloadMb: Math.round(opened.seed.payloadBytes / 1048576 * 10) / 10, seedMs: opened.seed.seedMs });
  const series: Record<string, number[]> = {};
  const push = (name: string, ms: number) => { (series[name] ??= []).push(ms); };
  for (let n = 0; n < REPEATS; n++) {
    const record: Record<string, unknown> = { kind: 'iteration', n: n + 1 };
    if (n > 0) {
      const timings: { libraryClickedAt?: number; firstRowMs?: number } = {};
      page = await app.restartLibrary({ showCatalog: true, timings, timeoutMs: LIMIT });
      await waitFirstRow(page, plan, timings); opened.timings.firstRowMs = timings.firstRowMs;
    }
    const firstRowMs = opened.timings.firstRowMs!;
    push('clickToFirstRowMs', firstRowMs);
    const metrics = await treeMetrics(page);
    assert.equal(metrics.setSize, root.length); assert.equal(metrics.first, first.id);
    Object.assign(record, { clickToFirstRowMs: firstRowMs, renderedRowsAtStart: metrics.rendered, scrollHeightPx: metrics.scrollHeight, idb: await idbCounts(page), ...await memoryProbe(page) });

    // End / Home / 10 x ArrowDown
    await page.locator(rowSelector(first.id)).first().focus();
    push('endMs', await timed(async () => { await page.keyboard.press('End'); await focusUntil(page, row => rowIdOf(row) === last.id && row.visible, 'End'); }));
    record.renderedRowsAfterEnd = (await treeMetrics(page)).rendered;
    push('homeMs', await timed(async () => { await page.keyboard.press('Home'); await focusUntil(page, row => rowIdOf(row) === first.id && row.visible, 'Home'); }));
    push('arrowDownMeanMs', (await timed(async () => { for (let step = 1; step <= 10; step++) { await page.keyboard.press('ArrowDown'); await focusUntil(page, row => rowIdOf(row) === root[step].id && row.visible, `ArrowDown ${step}`); } })) / 10);
    // Wheel scroll to the end of the first page and back
    await page.locator(TREE).hover();
    push('wheelToBottomMs', await timed(async () => { await page.mouse.wheel(0, 100_000); await page.waitForFunction(tree => { const rows = document.querySelectorAll(`${tree} [role="treeitem"]`); return rows.length > 0 && rows[rows.length - 1].getAttribute('data-library-more') !== null; }, TREE); }));
    // Expand the first folder, then collapse it
    await page.keyboard.press('Home'); await focusUntil(page, row => rowIdOf(row) === first.id, 'Home before expand');
    push('expandMs', await timed(async () => { await page.keyboard.press('ArrowRight'); await page.waitForFunction(({ id, tree }) => document.querySelector(`${tree} [data-folder-id="${id}"]`)?.getAttribute('aria-expanded') === 'true' && !!document.querySelector(`${tree} [role="treeitem"][aria-level="2"]`), { id: first.id, tree: TREE }); }));
    assert.equal((await treeMetrics(page)).rendered > 1, true);
    push('collapseMs', await timed(async () => { await page.keyboard.press('Home'); await page.keyboard.press('ArrowLeft'); await page.waitForFunction(tree => !document.querySelector(`${tree} [role="treeitem"][aria-level="2"]`), TREE); }));

    // Searches
    const input = page.getByLabel('資料の検索語', { exact: true });
    push('searchMetadataMs', await timed(async () => { await input.fill('alpha'); await page.getByText(`${alpha.length}件の資料が一致`, { exact: true }).waitFor(); }));
    push('clearSearchMs', await timed(async () => { await page.getByRole('button', { name: '表示条件を解除', exact: true }).click(); await page.waitForFunction(tree => document.querySelectorAll(`${tree} [role="treeitem"]`).length > 0 && !document.body.innerText.includes('件の資料が一致'), TREE); }));
    await page.getByLabel('資料の検索範囲', { exact: true }).selectOption('content');
    push('searchContentMs', await timed(async () => { await input.fill('sharedbody'); await page.getByText(`${shared.length}件の資料が一致`, { exact: true }).waitFor({ timeout: CONTENT_LIMIT }); }));
    push('searchContentAllBodiesMs', await timed(async () => { await input.fill('lorem'); await page.getByText(`${withBody.length}件の資料が一致`, { exact: true }).waitFor({ timeout: CONTENT_LIMIT }); }));
    await page.getByRole('button', { name: '表示条件を解除', exact: true }).click();
    await page.waitForFunction(tree => document.querySelectorAll(`${tree} [role="treeitem"]`).length > 0 && !document.body.innerText.includes('件の資料が一致'), TREE);

    // One organizing commit and its Undo (net state unchanged), each measured from the click to the durable batch.
    const before = (await idbCounts(page)).edits, moved = root[3], target = root[1];
    await page.locator(rowSelector(first.id)).first().waitFor();
    push('reorderCommitMs', await timed(async () => {
      await page.getByRole('button', { name: `「${moved.title}」を移動・並べ替え`, exact: true }).click();
      await page.getByRole('button', { name: `「${target.title}」の前へ移動`, exact: true }).click();
      await waitDurable(page, before + 1, 'reorder');
    }));
    push('undoCommitMs', await timed(async () => { await page.keyboard.press('Control+z'); await waitDurable(page, before + 2, 'undo'); }));
    Object.assign(record, { editsAfter: (await idbCounts(page)).edits, heapAfter: (await memoryProbe(page)).usedJsHeapMb, nodeRssMb: Math.round(process.memoryUsage().rss / 1048576) });
    emit(record);
  }
  emit({ kind: 'summary', series: Object.fromEntries(Object.entries(series).map(([name, values]) => [name, stats(values)])) });
});

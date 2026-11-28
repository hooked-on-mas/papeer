// B13-c (T07/T09-adjacent, T12): search, filters and an organizing commit on a 2,000-item Library (seeded; see support/ordinaryLargeCatalog.ts).
// Expectations are plain loops over the plan; the product's matcher, sorter, paginator and commit path are what is observed (real DOM, real IndexedDB).
// Some items are seeded WITHOUT a saved Markdown body (a seed-only state: the catalog row exists, the content root does not), so the
// "not yet retrieved" notice of a content search is observed with its real count. No time threshold is asserted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { renderedRows } from '../../support/ordinaryCatalog.ts';
import { DEFAULT_SPEC, UNRETRIEVED_SPEC, TREE, catalogCounts, focusUntil, focusedRow, memoryProbe, normalized, planMatches, rowIdOf, rowSelector, seedAndReopen, titleOrder, treeMetrics, waitDurable,
  type LargePlan } from '../../support/ordinaryLargeCatalog.ts';

const WINDOW_LIMIT = 60;
const search = (page: Page) => page.getByLabel('資料の検索語', { exact: true });
/** Upper limit against a hang; a whole-corpus content scan of 2,000 saved notes can take tens of seconds (measured in the Measure test). */
const countText = (page: Page, count: number) => page.getByText(`${count}件の資料が一致`, { exact: true }).waitFor({ timeout: 150_000 });
const notice = (missing: number) => new RegExp(`^\\s*本文の未取得 ${missing}件、一部のみ取得 0件、未対応の添付 0件。取得できた範囲の結果です。\\s*$`);
async function expectFirstAndLast(page: Page, expected: string[], what: string) {
  const first = expected[0], last = expected[expected.length - 1];
  await page.locator(TREE).waitFor();
  await page.waitForFunction(({ id, tree }) => { const row = document.querySelector(`${tree} [role="treeitem"]`); return row?.getAttribute('data-library-item') === id; }, { id: first, tree: TREE });
  const metrics = await treeMetrics(page);
  assert.equal(metrics.setSize, expected.length, `${what}: aria-setsize is the planned result count`);
  assert.equal(metrics.first, first, `${what}: first row`);
  assert.ok(metrics.rendered < WINDOW_LIMIT, `${what}: the window is bounded (${metrics.rendered} of ${expected.length})`);
  await page.locator(rowSelector(first)).first().focus();
  await page.keyboard.press('End');
  const row = await focusUntil(page, value => rowIdOf(value) === last && value.visible, `${what}: End focuses the last planned result`);
  assert.equal(row.tabbable, 1);
  assert.ok((await treeMetrics(page)).rendered < WINDOW_LIMIT, `${what}: the window stays bounded after End`);
}
const clear = async (page: Page) => { await page.getByRole('button', { name: '表示条件を解除', exact: true }).click(); await page.waitForFunction(tree => document.querySelectorAll(`${tree} [role="treeitem"]`).length > 0 && !document.body.innerText.includes('件の資料が一致'), TREE); };

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary 2,000-item Library: metadata, filter and content searches return the planned results; unretrieved bodies are reported with their count (${engine})`, { timeout: 600_000 }, async t => {
  const app = await ordinaryWeb(t, engine);
  let phase = 'seed', page = app.page, plan: LargePlan | undefined;
  try {
    const opened = await seedAndReopen(app, UNRETRIEVED_SPEC);
    page = opened.page; plan = opened.plan;
    const missing = plan.missingContentIds.length; assert.equal(missing, 25);

    phase = 'metadata-unique-token';
    const unique = planMatches(plan, item => normalized(item.title).includes('0777')); assert.equal(unique.length, 1);
    await search(page).fill('0777'); await countText(page, 1);
    assert.deepEqual((await renderedRows(page)).map(row => row.id), [unique[0].id]);
    const folder = plan.folders.find(value => value.id === unique[0].folderId);
    assert.ok(await page.locator(rowSelector(unique[0].id)).getByText(folder ? `フォルダー: ${folder.title}` : '未分類', { exact: true }).count(), 'the flat row names the real folder of the item');
    assert.equal(await page.getByText(/本文の未取得/).count(), 0, 'a metadata search reports no body retrieval status');

    phase = 'metadata-common-token-sorted-by-title';
    await clear(page);
    const alpha = planMatches(plan, item => normalized(item.title).includes('alpha')); assert.ok(alpha.length > 400 && alpha.length < 600);
    await search(page).fill('alpha'); await countText(page, alpha.length);
    await page.getByLabel('資料の並び順', { exact: true }).selectOption('title');
    await page.getByLabel('資料を降順に表示', { exact: true }).check();
    await expectFirstAndLast(page, titleOrder(alpha, true).map(item => item.id), 'alpha results by title, descending');
    await page.getByLabel('資料を降順に表示', { exact: true }).uncheck();
    await expectFirstAndLast(page, titleOrder(alpha, false).map(item => item.id), 'alpha results by title, ascending');

    phase = 'tag-and-read-filter';
    await clear(page);
    const tagged = planMatches(plan, item => item.tags[0] === 'topic-3' && item.read); assert.ok(tagged.length > 20);
    await page.getByLabel('資料のタグ条件', { exact: true }).selectOption('topic-3');
    await page.getByLabel('資料の読書状態', { exact: true }).selectOption('read');
    await countText(page, tagged.length);
    await page.getByLabel('資料の並び順', { exact: true }).selectOption('title');
    await expectFirstAndLast(page, titleOrder(tagged).map(item => item.id), 'topic-3 and read, by title');
    await page.getByLabel('資料の並び順', { exact: true }).selectOption('position');

    phase = 'content-search-with-unretrieved-bodies';
    await clear(page);
    const shared = planMatches(plan, item => !!item.body?.includes('sharedbody')); assert.equal(shared.length, 200);
    await page.getByLabel('資料の検索範囲', { exact: true }).selectOption('content');
    await search(page).fill('sharedbody'); await countText(page, shared.length);
    await page.getByText(notice(missing)).waitFor({ timeout: 150_000 });
    assert.equal(await page.getByRole('status').filter({ hasText: '本文の未取得' }).count(), 1, 'exactly one retrieval notice');
    await search(page).fill('bn0777'); await countText(page, 1);
    assert.deepEqual((await renderedRows(page)).map(row => row.id), [unique[0].id], 'the body token finds the item whose saved body holds it');
    await page.getByText(notice(missing)).waitFor({ timeout: 150_000 });
    // An item seeded without a saved body is still found by its name (information + body scope) and is counted as not retrieved.
    const noBody = plan.items.find(item => item.body === null)!;
    await page.getByLabel('資料の検索範囲', { exact: true }).selectOption('all');
    await search(page).fill(noBody.title.replace('Item ', '')); await countText(page, 1);
    assert.deepEqual((await renderedRows(page)).map(row => row.id), [noBody.id]);
    await page.getByText(notice(missing)).waitFor({ timeout: 150_000 });
    // Every body is searched: a word in all saved bodies matches exactly the items that have one.
    const withBody = planMatches(plan, item => item.body !== null);
    await search(page).fill('lorem'); await countText(page, withBody.length);
    assert.equal(withBody.length, plan.items.length - missing);
    const metrics = await treeMetrics(page);
    assert.equal(metrics.setSize, withBody.length); assert.ok(metrics.rendered < WINDOW_LIMIT, `the window is bounded for ${withBody.length} results (${metrics.rendered})`);
    await page.getByText(notice(missing)).waitFor({ timeout: 150_000 });
    t.diagnostic(`large-search memory ${engine}: ${JSON.stringify(await memoryProbe(page))}`);
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, metrics: await treeMetrics(page).catch(() => null), focus: await focusedRow(page).catch(() => null) }));
    throw error;
  }
});

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary 2,000-item Library: one reorder, its Undo and Redo are one catalog batch each, leave the other 2,000 items alone and survive a cold restart (${engine})`, { timeout: 280_000 }, async t => {
  const app = await ordinaryWeb(t, engine);
  let phase = 'seed', page = app.page;
  try {
    const opened = await seedAndReopen(app, DEFAULT_SPEC), plan = opened.plan, handle = opened.handle;
    page = opened.page;
    const root = plan.rootSiblings.map(sibling => sibling.id), seeded = plan.batches.length;
    const before = await catalogCounts(page, handle.namespace, handle.libraryId);
    assert.deepEqual([before.counts.items, before.counts.folders, before.counts.edits], [2000, 100, seeded]);
    const persistedRoot = (snapshot: typeof before.snapshot) => [...snapshot.folders.filter(folder => folder.parentId === null).map(folder => ({ id: folder.id, position: folder.position })),
      ...snapshot.items.filter(item => item.ownerId === null && item.folderId === null).map(item => ({ id: item.id, position: item.position }))]
      .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)).map(entry => entry.id);
    assert.deepEqual(persistedRoot(before.snapshot), root, 'the product loaded the seeded order (persisted root order = plan)');
    const moved = plan.rootSiblings[3], target = plan.rootSiblings[1];
    assert.equal(moved.kind, 'item'); assert.equal(target.kind, 'item');
    const expected = [root[0], root[3], ...root.slice(1, 3), ...root.slice(4)];

    phase = 'move-before';
    await page.getByRole('button', { name: `「${moved.title}」を移動・並べ替え`, exact: true }).click();
    await page.getByRole('button', { name: `「${target.title}」の前へ移動`, exact: true }).click();
    await waitDurable(page, seeded + 1, 'reorder');
    const afterMove = await catalogCounts(page, handle.namespace, handle.libraryId);
    assert.deepEqual(persistedRoot(afterMove.snapshot), expected, 'the persisted root order is the planned move');
    assert.deepEqual([afterMove.counts.items, afterMove.counts.folders], [2000, 100], 'no item or folder was added or lost');
    const seededAfter = afterMove.edits.filter(edit => plan.batches.some(batch => batch.id === edit.batch.id));
    assert.equal(seededAfter.length, seeded, 'the seeded batches are untouched'); assert.ok(seededAfter.every(edit => edit.history === undefined));
    const added = afterMove.edits.filter(edit => !plan.batches.some(batch => batch.id === edit.batch.id));
    assert.equal(added.length, 1, 'the move is one catalog batch'); assert.ok(added[0].history && added[0].receipt.durable);
    await page.waitForFunction(({ ids, tree }) => [...document.querySelectorAll(`${tree} [role="treeitem"]`)].slice(0, 4).map(row => row.getAttribute('data-folder-id') ?? row.getAttribute('data-library-item')).join() === ids.join(), { ids: expected.slice(0, 4), tree: TREE });
    await focusUntil(page, row => rowIdOf(row) === moved.id && row.visible, 'the moved row holds focus and is visible');

    phase = 'undo-and-redo';
    await page.keyboard.press('Control+z'); await waitDurable(page, seeded + 2, 'undo');
    assert.deepEqual(persistedRoot((await catalogCounts(page, handle.namespace, handle.libraryId)).snapshot), root, 'Undo restores the planned order');
    await page.waitForFunction(({ ids, tree }) => [...document.querySelectorAll(`${tree} [role="treeitem"]`)].slice(0, 4).map(row => row.getAttribute('data-folder-id') ?? row.getAttribute('data-library-item')).join() === ids.join(), { ids: root.slice(0, 4), tree: TREE });
    await page.keyboard.press('Control+Shift+Z'); await waitDurable(page, seeded + 3, 'redo');
    const redone = await catalogCounts(page, handle.namespace, handle.libraryId);
    assert.deepEqual(persistedRoot(redone.snapshot), expected, 'Redo restores the move');
    assert.deepEqual([redone.counts.items, redone.counts.folders, redone.counts.heads], [2000, 100, 1]);

    phase = 'cold-restart';
    page = await app.restartLibrary({ showCatalog: true });
    await page.waitForFunction(({ ids, tree }) => [...document.querySelectorAll(`${tree} [role="treeitem"]`)].slice(0, 4).map(row => row.getAttribute('data-folder-id') ?? row.getAttribute('data-library-item')).join() === ids.join(), { ids: expected.slice(0, 4), tree: TREE });
    assert.equal((await treeMetrics(page)).setSize, root.length);
    assert.equal((await waitDurable(page, seeded + 3, 'after restart')).edits, seeded + 3, 'opening the Library wrote no catalog batch');
    t.diagnostic(`large-reorder memory ${engine}: ${JSON.stringify(await memoryProbe(page))}`);
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, metrics: await treeMetrics(page).catch(() => null), focus: await focusedRow(page).catch(() => null) }));
    throw error;
  }
});

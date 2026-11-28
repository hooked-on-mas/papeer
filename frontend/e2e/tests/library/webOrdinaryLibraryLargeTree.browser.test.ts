// B13-c (T03): a 2,000-item Library (seeded into the ordinary Web profile's IndexedDB; see support/ordinaryLargeCatalog.ts) on the ordinary Web entry.
// Functional correctness only: the rendered DOM is a bounded window, and keyboard / wheel / disclosure / "more" / reveal return the planned rows.
// No threshold on time is asserted (D1 is undecided); the waits below are observation-bounded upper limits against a hang.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { renderedRows } from '../../support/ordinaryCatalog.ts';
import { DEFAULT_SPEC, TREE, focusUntil, focusedRow, memoryProbe, rowIdOf, rowSelector, seedAndReopen, treeMetrics, type LargePlan } from '../../support/ordinaryLargeCatalog.ts';

/** Bound on how many rows a window may hold (the tree is 480px high; 101 rows are logically displayed at the start). */
const WINDOW_LIMIT = 60;

async function expectFocus(page: Page, id: string, what: string) {
  const row = await focusUntil(page, value => rowIdOf(value) === id && value.visible, what);
  assert.equal(row.tabbable, 1, `${what}: the focused row is the single tab stop`);
}
async function rowAttributes(page: Page, id: string) {
  return page.locator(rowSelector(id)).first().evaluate(node => ({ level: Number(node.getAttribute('aria-level')), posinset: Number(node.getAttribute('aria-posinset')),
    setsize: Number(node.getAttribute('aria-setsize')), expanded: node.getAttribute('aria-expanded') }));
}
/** Rows rendered after the row `id` that belong to its subtree level (direct children), in DOM order. */
async function renderedChildren(page: Page, id: string) {
  const rows = await renderedRows(page), index = rows.findIndex(row => row.folderId === id || row.id === id);
  assert.ok(index >= 0, `row ${id} is rendered`);
  const level = rows[index].level + 1, out: { key: string; label: string; level: number }[] = [];
  for (const row of rows.slice(index + 1)) { if (row.level < level) break; if (row.level === level) out.push({ key: row.id ?? row.folderId ?? `more`, label: row.label, level: row.level }); }
  return out;
}
/** The children are rendered by the virtual window one frame after the folder row reports aria-expanded; poll (observation-bounded) until `count` direct children are rendered. */
async function renderedChildrenUntil(page: Page, id: string, count: number) {
  const deadline = Date.now() + 30_000;
  let rows = await renderedChildren(page, id);
  while (rows.length < count && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); rows = await renderedChildren(page, id); }
  return rows;
}
const lastSibling = (plan: LargePlan) => plan.rootSiblings[plan.rootSiblings.length - 1];

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary 2,000-item Library: bounded window, wheel, Home/End/Arrow, disclosure and "more" return the planned rows (${engine})`, { timeout: 280_000 }, async t => {
  const app = await ordinaryWeb(t, engine);
  let phase = 'seed', page = app.page, plan: LargePlan | undefined;
  try {
    const opened = await seedAndReopen(app, DEFAULT_SPEC);
    page = opened.page; plan = opened.plan;
    const root = plan.rootSiblings, first = root[0], expectedMore = root.length - 100;
    assert.equal(plan.items.length, 2000); assert.equal(plan.folders.length, 100); assert.equal(root.length, 240);

    phase = 'initial-window';
    const initial = await treeMetrics(page);
    assert.ok(initial.rendered > 0 && initial.rendered < WINDOW_LIMIT, `the DOM holds a window, not all rows: ${initial.rendered}`);
    assert.equal(initial.setSize, root.length, 'aria-setsize of the root rows is the planned sibling count');
    assert.equal(initial.first, first.id, 'the first rendered row is the first planned root sibling');
    assert.ok(initial.scrollHeight > initial.clientHeight * 5, `the scrollable height covers many more rows than are rendered (${initial.scrollHeight} vs ${initial.clientHeight})`);
    const initialLabels = (await renderedRows(page)).map(row => row.folderId ?? row.id);
    assert.deepEqual(initialLabels, root.slice(0, initialLabels.length).map(sibling => sibling.id), 'the rendered window is exactly the planned prefix, in order');

    phase = 'wheel-to-the-end-of-the-first-page';
    await page.locator(TREE).hover(); await page.mouse.wheel(0, 100_000);
    await page.waitForFunction(tree => { const rows = document.querySelectorAll(`${tree} [role="treeitem"]`); return rows.length > 0 && rows[rows.length - 1].getAttribute('data-library-more') === 'root'; }, TREE);
    const bottom = await treeMetrics(page);
    assert.ok(bottom.rendered < WINDOW_LIMIT && bottom.scrollTop > 0);
    const moreRow = page.locator('[data-library-more="root"]');
    assert.equal(await moreRow.getAttribute('aria-label'), `さらに${expectedMore}件を表示`, 'the root "more" row counts the rows beyond the first page of 100');
    const renderedBottom = (await renderedRows(page)).map(row => row.folderId ?? row.id).filter(Boolean);
    // The product keeps the roving tab stop (row 0 while nothing is focused) mounted; the rest is the contiguous planned tail ending at the 100th row.
    assert.equal(renderedBottom[0], first.id, 'the single tab stop row stays mounted outside the window');
    const tail = renderedBottom.slice(1);
    assert.deepEqual(tail, root.slice(100 - tail.length, 100).map(sibling => sibling.id), 'the bottom window is the planned tail ending at the 100th row');

    phase = 'home-from-the-more-row';
    await moreRow.focus(); await page.keyboard.press('Home');
    await expectFocus(page, first.id, 'Home from the "more" row focuses the first row and scrolls it into view');
    assert.equal((await treeMetrics(page)).scrollTop, 0);

    phase = 'end-reveals-the-last-logical-row';
    await page.keyboard.press('End');
    const last = lastSibling(plan);
    await expectFocus(page, last.id, 'End focuses the last planned root sibling, beyond the first page');
    const afterEnd = await treeMetrics(page);
    assert.ok(afterEnd.rendered < WINDOW_LIMIT, `the window stays bounded after End (${afterEnd.rendered})`); assert.ok(afterEnd.scrollTop > bottom.scrollTop, 'the tree scrolled past the first page');
    assert.equal(await page.locator('[data-library-more="root"]').count(), 0, 'every root row is now displayed, so no "more" row remains');
    assert.equal(afterEnd.last, last.id);

    phase = 'arrow-navigation-across-window-edges';
    await page.keyboard.press('Home'); await expectFocus(page, first.id, 'Home again');
    for (let step = 1; step <= 40; step++) { await page.keyboard.press('ArrowDown'); await expectFocus(page, root[step].id, `ArrowDown step ${step} focuses planned root sibling ${step}`); }
    for (let step = 39; step >= 30; step--) { await page.keyboard.press('ArrowUp'); await expectFocus(page, root[step].id, `ArrowUp returns to planned root sibling ${step}`); }

    phase = 'expand-folder-and-more-children';
    await page.keyboard.press('Home'); await expectFocus(page, first.id, 'Home before expanding');
    const children = plan.childrenOf.get(first.id)!; assert.equal(children.length, 49);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(({ id, tree }) => document.querySelector(`${tree} [data-folder-id="${id}"]`)?.getAttribute('aria-expanded') === 'true', { id: first.id, tree: TREE });
    const firstPage = await renderedChildrenUntil(page, first.id, 7);
    assert.deepEqual(firstPage.map(row => row.key), [...children.slice(0, 6).map(child => child.id), 'more'], 'six children and a "more" row, in planned order');
    assert.equal(firstPage[6].label, `さらに${children.length - 6}件を表示`);
    assert.ok(firstPage.every(row => row.level === 2));
    await page.locator(TREE).getByRole('button', { name: `さらに${children.length - 6}件を表示`, exact: true }).click();
    await expectFocus(page, children[6].id, 'the first newly revealed child is focused after "more"');
    assert.deepEqual(await rowAttributes(page, children[6].id), { level: 2, posinset: 7, setsize: 49, expanded: children[6].kind === 'folder' ? 'false' : null });
    for (let step = 7; step < children.length; step++) { await page.keyboard.press('ArrowDown'); await expectFocus(page, children[step].id, `ArrowDown walks planned child ${step}`); }
    await page.keyboard.press('ArrowDown'); await expectFocus(page, root[1].id, 'after the last child of the expanded folder comes the next root sibling');
    assert.ok((await treeMetrics(page)).rendered < WINDOW_LIMIT);

    phase = 'collapse-and-nested-expand';
    await page.keyboard.press('Home'); await expectFocus(page, first.id, 'Home before collapsing');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(({ id, tree }) => document.querySelector(`${tree} [data-folder-id="${id}"]`)?.getAttribute('aria-expanded') === 'false', { id: first.id, tree: TREE });
    assert.deepEqual((await renderedRows(page)).slice(0, 3).map(row => row.folderId ?? row.id), root.slice(0, 3).map(sibling => sibling.id), 'collapsing the folder removes its children from the rows');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
    const sub = children[0]; assert.equal(sub.kind, 'folder');
    await expectFocus(page, sub.id, 'ArrowDown from the reopened folder focuses its first (nested) folder');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(({ id, tree }) => document.querySelector(`${tree} [data-folder-id="${id}"]`)?.getAttribute('aria-expanded') === 'true', { id: sub.id, tree: TREE });
    const subItems = plan.childrenOf.get(sub.id)!; assert.equal(subItems.length, 10);
    const nested = await renderedChildrenUntil(page, sub.id, 7);
    assert.deepEqual(nested.map(row => row.key), [...subItems.slice(0, 6).map(item => item.id), 'more']);
    assert.ok(nested.every(row => row.level === 3), 'a nested folder\'s children are at level 3');
    assert.equal(nested[6].label, `さらに${subItems.length - 6}件を表示`);
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
    await expectFocus(page, first.id, 'ArrowLeft on a collapsed nested folder, then on its (collapsed) row, walks to the parent folder');
    const memory = await memoryProbe(page);
    t.diagnostic(`large-tree memory ${engine}: ${JSON.stringify(memory)}`);
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, metrics: await treeMetrics(page).catch(() => null), focus: await focusedRow(page).catch(() => null) }));
    throw error;
  }
});

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary 2,000-item Library: an item found by search and opened is restored after a cold restart and revealed beyond the first page (${engine})`, { timeout: 280_000 }, async t => {
  const app = await ordinaryWeb(t, engine);
  let phase = 'seed', page = app.page;
  try {
    const opened = await seedAndReopen(app, DEFAULT_SPEC), plan = opened.plan;
    page = opened.page;
    const target = plan.items.find(item => item.path.startsWith('Folder 17/') && item.body !== null)!;
    assert.ok(target, 'a planned item inside a nested folder of the 17th top-level folder');
    const token = `bn${String(target.index).padStart(4, '0')}`, top = plan.folders.find(folder => folder.title === 'Folder 17')!, nestedFolder = plan.folders.find(folder => folder.id === target.folderId)!;
    assert.equal(nestedFolder.parentId, top.id);
    assert.ok(plan.rootSiblings.findIndex(sibling => sibling.id === top.id) >= 100, 'the target folder lies beyond the first page of root rows');

    phase = 'search-and-open';
    await page.getByLabel('資料の検索語', { exact: true }).fill(target.title.replace('Item ', ''));
    await page.getByText('1件の資料が一致', { exact: true }).waitFor();
    assert.equal((await renderedRows(page)).length, 1, 'one flat result row');
    await page.locator(TREE).getByRole('button', { name: target.title, exact: true }).click();
    await page.locator(`[data-content-document="${target.id}"]`).waitFor();
    await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).filter({ hasText: token }).waitFor();

    phase = 'cold-restart';
    page = await app.restartLibrary({ showCatalog: true });
    await page.locator(`[data-content-document="${target.id}"]`).waitFor();
    await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).filter({ hasText: token }).waitFor();
    assert.equal(await page.getByLabel('資料の検索語', { exact: true }).inputValue(), target.title.replace('Item ', ''), 'the saved search text is restored');
    await page.getByText('1件の資料が一致', { exact: true }).waitFor();
    assert.equal(await page.locator(TREE).getByRole('button', { name: target.title, exact: true }).getAttribute('aria-current'), 'page', 'the restored document is marked as the open one in the list');

    phase = 'clear-and-reveal';
    await page.getByRole('button', { name: '表示条件を解除', exact: true }).click();
    await page.waitForFunction(tree => document.querySelectorAll(`${tree} [role="treeitem"]`).length > 1, TREE);
    await page.getByRole('button', { name: '表示中の資料を一覧で表示', exact: true }).click();
    await focusUntil(page, row => row.id === target.id && row.visible, 'the open item is revealed and focused in the tree');
    const rows = await renderedRows(page);
    const byKey = (key: string) => rows.find(row => row.folderId === key || row.id === key);
    assert.deepEqual([byKey(top.id)?.level, byKey(top.id)?.expanded], [1, 'true'], 'the top-level folder of the item is expanded');
    assert.deepEqual([byKey(nestedFolder.id)?.level, byKey(nestedFolder.id)?.expanded], [2, 'true'], 'the nested folder of the item is expanded');
    assert.equal(byKey(target.id)?.level, 3);
    assert.ok(rows.length < WINDOW_LIMIT, `the window stays bounded after reveal (${rows.length})`);
    assert.equal(await page.locator(TREE).getByRole('button', { name: target.title, exact: true }).getAttribute('aria-current'), 'page');
    t.diagnostic(`large-restore memory ${engine}: ${JSON.stringify(await memoryProbe(page))}`);
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, metrics: await treeMetrics(page).catch(() => null), focus: await focusedRow(page).catch(() => null) }));
    throw error;
  }
});

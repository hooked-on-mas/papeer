import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import type { DocumentSnapshot, PageAnnotation } from '../../../src/runtime/edits/contracts.ts';
import { applyBatch } from '../../../src/runtime/edits/editModel.ts';
import { documentContent } from '../../../src/runtime/edits/documentPages.ts';
import { committed } from '../reader/p2/ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';

const A4_WIDTH_PT = 595.2755905511812;
const A4_HEIGHT_PT = 841.8897637795276;

type Observation = Awaited<ReturnType<typeof committed>>;
type StickyDom = { id: string; title: string; fill: string };
type StickyAnnotation = Extract<PageAnnotation, { kind: 'sticky' }>;

/** Pure readback of stored batches along a single parent chain. */
function snapshot(value: Observation): DocumentSnapshot {
  let current = value.root;
  const rest = [...value.edits];
  while (rest.length) {
    const index = rest.findIndex(edit => edit.batch.parents.length === 1 && edit.batch.parents[0] === current.version);
    assert.ok(index >= 0, 'expected linear history in ordinary notebook test');
    current = applyBatch(current, rest.splice(index, 1)[0].batch) as DocumentSnapshot;
  }
  return current;
}

async function saved(page: Page, id: string, count: number) {
  const until = Date.now() + 30_000;
  for (;;) {
    const value = await committed(page, id);
    if (value.edits.length === count && !value.pendingIntents && value.edits.every(edit => edit.receipt.durable && edit.history)) {
      await page.getByRole('status').filter({ hasText: /^端末保存済み/ }).first().waitFor();
      return value;
    }
    assert.ok(Date.now() < until, `expected ${count} exact durable operations with history`);
    await delay(50);
  }
}

async function jump(page: Page, number: number) {
  const input = page.getByLabel('ページ番号', { exact: true });
  await input.fill(String(number));
  await input.press('Enter');
  assert.equal(await input.inputValue(), String(number));
}

async function readPageDom(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-paper-page]');
    const pageId = root?.getAttribute('data-paper-page') ?? null;
    const inkIds = [...(root?.querySelectorAll('[data-ink-id]') ?? [])].map(element => element.getAttribute('data-ink-id') ?? '');
    const stickies = [...(root?.querySelectorAll('[data-sticky-id]') ?? [])].map(element => ({
      id: element.getAttribute('data-sticky-id') ?? '',
      title: element.querySelector('title')?.textContent ?? '',
      fill: element.querySelector('circle')?.getAttribute('fill') ?? '',
    }));
    return { pageId, inkIds, stickies };
  });
}

async function expectPageDom(page: Page, expectedPageId: string, expectedInkIds: string[], expectedStickies: StickyDom[]) {
  await page.waitForFunction(({ pageId, inkCount, stickyCount }) => {
    const root = document.querySelector('[data-paper-page]');
    if (!root || root.getAttribute('data-paper-page') !== pageId) return false;
    return root.querySelectorAll('[data-ink-id]').length === inkCount && root.querySelectorAll('[data-sticky-id]').length === stickyCount;
  }, { pageId: expectedPageId, inkCount: expectedInkIds.length, stickyCount: expectedStickies.length });
  const dom = await readPageDom(page);
  assert.deepEqual(dom, { pageId: expectedPageId, inkIds: expectedInkIds, stickies: expectedStickies });
}

async function waitPostRestartReady(page: Page) {
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(
      element => element.textContent === '編集をロック' || element.textContent === '編集ロックを解除',
    );
    return !!button && !(button as HTMLButtonElement).disabled;
  });
}

async function addSticky(page: Page, at: [number, number], memo: string, label: string, color: string) {
  await page.getByRole('button', { name: '付箋を貼る', exact: true }).click();
  await gesture(page, [at]);
  const form = page.getByRole('region', { name: '注釈を編集', exact: true });
  await form.waitFor();
  await form.getByRole('textbox', { name: '付箋のメモ', exact: true }).fill(memo);
  await form.getByLabel('注釈の分類', { exact: true }).fill(label);
  await form.getByLabel('注釈の色', { exact: true }).selectOption(color);
  await form.getByRole('button', { name: '確定', exact: true }).click();
  await form.waitFor({ state: 'hidden' });
}

function stickyDom(annotation: StickyAnnotation): StickyDom {
  return { id: annotation.id, title: annotation.text, fill: annotation.color ?? '#f59e0b' };
}

for (const engine of ['chromium', 'webkit'] as const) {
  test(`ordinary notebook sticky+ink duplicate delete sequential Undo/Redo and cold restart (${engine})`, { timeout: 240_000 }, async t => {
    const app = await ordinaryWeb(t, engine);
    let page = app.page;
    const title = `R13 sticky history ${engine}`;
    let phase = 'create';
    try {
      const id = await createNotebook(page, title);
      const initial = await committed(page, id);
      assert.equal(initial.root.pages.length, 1);
      const firstId = initial.root.pages[0].id;
      assert.ok(Math.abs(initial.root.pages[0].widthPt - A4_WIDTH_PT) < 0.01);
      assert.ok(Math.abs(initial.root.pages[0].heightPt - A4_HEIGHT_PT) < 0.01);

      phase = 'op1-ink-A';
      await page.getByRole('button', { name: 'ペン', exact: true }).click();
      await gesture(page, [[.18, .22], [.44, .28]]);
      const s1 = snapshot(await saved(page, id, 1));
      assert.deepEqual(s1.pages.map(value => value.id), [firstId]);
      assert.deepEqual(s1.pages[0].annotations.map(value => value.kind), ['ink']);
      const inkA = structuredClone(s1.pages[0].annotations[0]);
      await expectPageDom(page, firstId, [inkA.id], []);

      phase = 'op2-sticky-A';
      await addSticky(page, [.68, .34], 'Aの付箋メモ', '確認', '#60a5fa');
      const s2 = snapshot(await saved(page, id, 2));
      assert.deepEqual(s2.pages[0].annotations.map(value => value.kind), ['ink', 'sticky']);
      assert.deepEqual(s2.pages[0].annotations[0], inkA);
      const stickyA = structuredClone(s2.pages[0].annotations[1]);
      assert.equal(stickyA.kind, 'sticky');
      assert.equal(stickyA.text, 'Aの付箋メモ');
      assert.equal(stickyA.metadata.label, '確認');
      assert.equal(stickyA.color, '#60a5fa');
      assert.ok(Math.abs(stickyA.anchor.x - A4_WIDTH_PT * 0.68) < 12, `stickyA x=${stickyA.anchor.x}`);
      assert.ok(Math.abs(stickyA.anchor.y - A4_HEIGHT_PT * 0.34) < 12, `stickyA y=${stickyA.anchor.y}`);
      await expectPageDom(page, firstId, [inkA.id], [stickyDom(stickyA)]);

      phase = 'op3-duplicate-to-B';
      await page.getByRole('button', { name: 'ページ複製', exact: true }).click();
      const s3 = snapshot(await saved(page, id, 3));
      assert.equal(s3.pages.length, 2);
      const copyId = s3.pages[1].id;
      assert.notEqual(copyId, firstId);
      assert.deepEqual(s3.pages.map(value => value.id), [firstId, copyId]);
      assert.deepEqual(s3.pages[0].annotations, [inkA, stickyA]);
      const bInit = structuredClone(s3.pages[1].annotations);
      assert.deepEqual(bInit.map(value => value.kind), ['ink', 'sticky']);
      assert.equal(new Set([inkA.id, stickyA.id, bInit[0].id, bInit[1].id]).size, 4);
      assert.deepEqual({ ...bInit[0], id: '' }, { ...inkA, id: '' });
      assert.deepEqual({ ...bInit[1], id: '' }, { ...stickyA, id: '' });
      assert.equal(bInit[1].kind, 'sticky');
      if (bInit[1].kind !== 'sticky') throw new Error('expected duplicated sticky annotation');
      const stickyACopy = bInit[1];
      assert.equal(stickyACopy.text, 'Aの付箋メモ');
      assert.equal(stickyACopy.metadata.label, '確認');
      assert.equal(stickyACopy.color, '#60a5fa');
      assert.deepEqual(stickyACopy.anchor, stickyA.anchor);
      assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '2');
      await expectPageDom(page, copyId, [bInit[0].id], [stickyDom(stickyACopy)]);

      phase = 'op4-ink-B';
      await page.getByRole('button', { name: 'ペン', exact: true }).click();
      await gesture(page, [[.22, .62], [.52, .68]]);
      const s4 = snapshot(await saved(page, id, 4));
      assert.deepEqual(s4.pages[1].annotations.map(value => value.kind), ['ink', 'sticky', 'ink']);
      assert.deepEqual(s4.pages[1].annotations.slice(0, 2), bInit);
      const inkB = structuredClone(s4.pages[1].annotations[2]);
      assert.equal(new Set([inkA.id, stickyA.id, bInit[0].id, bInit[1].id, inkB.id]).size, 5);
      await expectPageDom(page, copyId, [bInit[0].id, inkB.id], [stickyDom(stickyACopy)]);

      phase = 'op5-sticky-B';
      await addSticky(page, [.72, .76], 'Bの付箋メモ', '追記', '#34d399');
      const s5 = snapshot(await saved(page, id, 5));
      assert.deepEqual(s5.pages[1].annotations.map(value => value.kind), ['ink', 'sticky', 'ink', 'sticky']);
      assert.deepEqual(s5.pages[1].annotations.slice(0, 3), [bInit[0], bInit[1], inkB]);
      const stickyB = structuredClone(s5.pages[1].annotations[3]);
      assert.equal(stickyB.kind, 'sticky');
      assert.equal(stickyB.text, 'Bの付箋メモ');
      assert.equal(stickyB.metadata.label, '追記');
      assert.equal(stickyB.color, '#34d399');
      assert.ok(Math.abs(stickyB.anchor.x - A4_WIDTH_PT * 0.72) < 12, `stickyB x=${stickyB.anchor.x}`);
      assert.ok(Math.abs(stickyB.anchor.y - A4_HEIGHT_PT * 0.76) < 12, `stickyB y=${stickyB.anchor.y}`);
      assert.equal(new Set([inkA.id, stickyA.id, bInit[0].id, bInit[1].id, inkB.id, stickyB.id]).size, 6);
      const bFull = structuredClone(s5.pages[1].annotations);
      await expectPageDom(page, copyId, [bInit[0].id, inkB.id], [stickyDom(stickyACopy), stickyDom(stickyB)]);

      phase = 'op6-add-C';
      await page.getByRole('button', { name: 'ページ追加', exact: true }).click();
      const s6 = snapshot(await saved(page, id, 6));
      assert.equal(s6.pages.length, 3);
      const thirdId = s6.pages[2].id;
      assert.deepEqual(s6.pages.map(value => value.id), [firstId, copyId, thirdId]);
      assert.deepEqual(s6.pages[2].annotations, []);
      assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '3');
      await expectPageDom(page, thirdId, [], []);

      phase = 'op7-delete-B';
      await jump(page, 2);
      await expectPageDom(page, copyId, [bInit[0].id, inkB.id], [stickyDom(stickyACopy), stickyDom(stickyB)]);
      await page.getByRole('button', { name: 'ページ削除', exact: true }).click();
      const s7 = snapshot(await saved(page, id, 7));
      assert.deepEqual(s7.pages.map(value => value.id), [firstId, thirdId]);
      assert.deepEqual(s7.pages[0].annotations, [inkA, stickyA]);
      assert.deepEqual(s7.pages[1].annotations, []);
      assert.deepEqual(s7.deletedPages.find(value => value.id === copyId)?.annotations, bFull);
      await expectPageDom(page, thirdId, [], []);

      phase = 'sequential-undo-7';
      const undoExpectations: {
        pageIds: string[];
        annotationsByIndex: PageAnnotation[][];
        jumpPage?: number;
        domPageId: string;
        domInkIds: string[];
        domStickies: StickyDom[];
      }[] = [
        { pageIds: [firstId, copyId, thirdId], annotationsByIndex: [[inkA, stickyA], bFull, []], jumpPage: 2,
          domPageId: copyId, domInkIds: [bInit[0].id, inkB.id], domStickies: [stickyDom(stickyACopy), stickyDom(stickyB)] },
        { pageIds: [firstId, copyId], annotationsByIndex: [[inkA, stickyA], bFull],
          domPageId: copyId, domInkIds: [bInit[0].id, inkB.id], domStickies: [stickyDom(stickyACopy), stickyDom(stickyB)] },
        { pageIds: [firstId, copyId], annotationsByIndex: [[inkA, stickyA], [bInit[0], bInit[1], inkB]],
          domPageId: copyId, domInkIds: [bInit[0].id, inkB.id], domStickies: [stickyDom(stickyACopy)] },
        { pageIds: [firstId, copyId], annotationsByIndex: [[inkA, stickyA], bInit],
          domPageId: copyId, domInkIds: [bInit[0].id], domStickies: [stickyDom(stickyACopy)] },
        { pageIds: [firstId], annotationsByIndex: [[inkA, stickyA]],
          domPageId: firstId, domInkIds: [inkA.id], domStickies: [stickyDom(stickyA)] },
        { pageIds: [firstId], annotationsByIndex: [[inkA]],
          domPageId: firstId, domInkIds: [inkA.id], domStickies: [] },
        { pageIds: [firstId], annotationsByIndex: [[]],
          domPageId: firstId, domInkIds: [], domStickies: [] },
      ];
      for (const [stepIndex, expected] of undoExpectations.entries()) {
        await page.getByRole('button', { name: '元に戻す', exact: true }).click();
        const current = snapshot(await saved(page, id, 8 + stepIndex));
        assert.deepEqual(current.pages.map(value => value.id), expected.pageIds, `undo step ${stepIndex + 1} pageIds`);
        for (const [pageIndex, annotations] of expected.annotationsByIndex.entries()) {
          assert.deepEqual(current.pages[pageIndex].annotations, annotations, `undo step ${stepIndex + 1} page ${pageIndex} annotations`);
        }
        if (expected.jumpPage !== undefined) await jump(page, expected.jumpPage);
        await expectPageDom(page, expected.domPageId, expected.domInkIds, expected.domStickies);
      }
      assert.equal(await page.getByRole('button', { name: '元に戻す', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'やり直す', exact: true }).isDisabled(), false);

      phase = 'sequential-redo-7';
      const redoExpectations: {
        pageIds: string[];
        annotationsByIndex: PageAnnotation[][];
        jumpPage?: number;
        domPageId: string;
        domInkIds: string[];
        domStickies: StickyDom[];
      }[] = [
        { pageIds: [firstId], annotationsByIndex: [[inkA]],
          domPageId: firstId, domInkIds: [inkA.id], domStickies: [] },
        { pageIds: [firstId], annotationsByIndex: [[inkA, stickyA]],
          domPageId: firstId, domInkIds: [inkA.id], domStickies: [stickyDom(stickyA)] },
        { pageIds: [firstId, copyId], annotationsByIndex: [[inkA, stickyA], bInit], jumpPage: 2,
          domPageId: copyId, domInkIds: [bInit[0].id], domStickies: [stickyDom(stickyACopy)] },
        { pageIds: [firstId, copyId], annotationsByIndex: [[inkA, stickyA], [bInit[0], bInit[1], inkB]],
          domPageId: copyId, domInkIds: [bInit[0].id, inkB.id], domStickies: [stickyDom(stickyACopy)] },
        { pageIds: [firstId, copyId], annotationsByIndex: [[inkA, stickyA], bFull],
          domPageId: copyId, domInkIds: [bInit[0].id, inkB.id], domStickies: [stickyDom(stickyACopy), stickyDom(stickyB)] },
        { pageIds: [firstId, copyId, thirdId], annotationsByIndex: [[inkA, stickyA], bFull, []], jumpPage: 3,
          domPageId: thirdId, domInkIds: [], domStickies: [] },
        { pageIds: [firstId, thirdId], annotationsByIndex: [[inkA, stickyA], []],
          domPageId: thirdId, domInkIds: [], domStickies: [] },
      ];
      for (const [stepIndex, expected] of redoExpectations.entries()) {
        await page.getByRole('button', { name: 'やり直す', exact: true }).click();
        const current = snapshot(await saved(page, id, 15 + stepIndex));
        assert.deepEqual(current.pages.map(value => value.id), expected.pageIds, `redo step ${stepIndex + 1} pageIds`);
        for (const [pageIndex, annotations] of expected.annotationsByIndex.entries()) {
          assert.deepEqual(current.pages[pageIndex].annotations, annotations, `redo step ${stepIndex + 1} page ${pageIndex} annotations`);
        }
        if (expected.jumpPage !== undefined) await jump(page, expected.jumpPage);
        await expectPageDom(page, expected.domPageId, expected.domInkIds, expected.domStickies);
      }
      const afterRedo = await saved(page, id, 21);
      const s21 = snapshot(afterRedo);
      assert.deepEqual(documentContent(s21).pages, documentContent(s7).pages);
      assert.deepEqual(s21.deletedPages.find(value => value.id === copyId)?.annotations, bFull);
      assert.equal(await page.getByRole('button', { name: 'やり直す', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: '元に戻す', exact: true }).isDisabled(), false);

      phase = 'cold-restart-and-undo';
      page = await app.restart(title);
      assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), id);
      await waitPostRestartReady(page);
      const restarted = await saved(page, id, 21);
      assert.deepEqual(restarted.edits, afterRedo.edits);
      assert.deepEqual(snapshot(restarted), s21);
      assert.equal(restarted.pendingIntents, 0);
      assert.equal(await page.getByRole('button', { name: 'やり直す', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: '元に戻す', exact: true }).isDisabled(), false);

      await page.getByRole('button', { name: '元に戻す', exact: true }).click();
      const s22 = snapshot(await saved(page, id, 22));
      assert.deepEqual(s22.pages.map(value => value.id), [firstId, copyId, thirdId]);
      assert.deepEqual(s22.pages[0].annotations, [inkA, stickyA]);
      assert.deepEqual(s22.pages[1].annotations, bFull);
      assert.deepEqual(s22.pages[2].annotations, []);
      await jump(page, 2);
      await expectPageDom(page, copyId, [bInit[0].id, inkB.id], [stickyDom(stickyACopy), stickyDom(stickyB)]);

      t.diagnostic(JSON.stringify({
        engine, id, firstId, copyId, thirdId,
        durableOperations: 22, undoSteps: 7, redoSteps: 7,
        postRestartUndo: true, stickyPreservedAndRestored: true,
      }));
    } catch (error) {
      console.error(JSON.stringify({ phase, error: String(error), body: await page.locator('body').innerText().catch(String) }));
      throw error;
    }
  });
}

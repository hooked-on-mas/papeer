import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { createNotebook, ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { committed, durable, inks } from '../reader/p2/ordinaryStorage.ts';
import { ordinaryMarkdownSaved } from '../../support/ordinaryMarkdown.ts';

const refusal = '操作を完了または取り消してから集中表示を切り替えてください。';
async function catalog(page: Page, expanded: boolean) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  const open = await button.getAttribute('aria-expanded') === 'true';
  if (open === expanded) return;
  if (!expanded) {
    const collapse = page.getByRole('button', { name: '左パネルを閉じる', exact: true });
    if (await collapse.isVisible()) { await collapse.click(); return; }
  }
  await button.click();
}
async function focus(page: Page, next: boolean) {
  await page.getByRole('button', { name: next ? '集中表示' : '集中表示を終了', exact: true }).click();
  await page.waitForFunction(next => document.querySelector('[data-workspace-focus]')?.getAttribute('data-workspace-focus') === String(next), next);
  assert.deepEqual(await page.locator('[data-workspace-chrome]').evaluate(element => ({ hidden: (element as HTMLElement).hidden, inert: (element as HTMLElement).inert })), { hidden: next, inert: next });
  const catalogExpanded = !next && await page.locator('[data-workspace-chrome] button[aria-controls="workspace-catalog-chrome"]').getAttribute('aria-expanded') === 'true';
  assert.deepEqual(await page.locator('#workspace-catalog-chrome').evaluate(element => ({ hidden: (element as HTMLElement).hidden, inert: (element as HTMLElement).inert })), { hidden: next || !catalogExpanded, inert: next || !catalogExpanded });
}

for (const engine of ['chromium', 'webkit'] as const) {
  test(`ordinary focus preserves Markdown, catalog and annotation controls; empty chooser and attachment (${engine})`, { timeout: 180_000 }, async t => {
    const app = await ordinaryWeb(t, engine), { page } = app;
    let phase = 'create';
    try {
      const title = `Focus Markdown ${engine}`, body = 'Focus keeps the existing editor\n本文を保持する';
      await page.getByRole('button', { name: '新規', exact: true }).click();
      const createDialog = page.getByRole('dialog', { name: '新しい資料を作成', exact: true });
      await createDialog.getByLabel('新しい資料の名前', { exact: true }).fill(title);
      await createDialog.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
      await createDialog.getByRole('button', { name: '資料を作成', exact: true }).click();
      await createDialog.waitFor({ state: 'hidden' });
      const editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true }); await editor.waitFor();
      const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
      await editor.fill(body); await editor.blur();
      const saved = await ordinaryMarkdownSaved(page, id, body, 1);
      await page.getByRole('button', { name: '右側で編集', exact: true }).click();
      await page.locator('[data-editor-placement="right"]').waitFor();
      const root = await page.locator('[data-reader-root]').elementHandle(), editorNode = await editor.elementHandle(); assert.ok(root && editorNode);
      phase = 'settings-modal-admission';
      await page.getByRole('button', { name: '表示設定', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'このライブラリの表示設定', exact: true }); await settings.waitFor();
      // Admission seam: a DOM click bypasses the modal's normal input trap, while
      // every modal/owner is the real UI-created one. No authority is fabricated.
      await page.locator('[data-workspace-focus] button[aria-controls~="workspace-chrome"]').evaluate(button => (button as HTMLButtonElement).click());
      assert.equal(await page.locator('[data-workspace-focus]').getAttribute('data-workspace-focus'), 'false');
      assert.equal(await settings.isVisible(), true);
      await settings.getByRole('button', { name: '表示設定を閉じる', exact: true }).click(); await settings.waitFor({ state: 'hidden' });
      phase = 'draft-refusal';
      await catalog(page, true);
      await page.getByRole('button', { name: '新規', exact: true }).click();
      const draftDialog = page.getByRole('dialog', { name: '新しい資料を作成', exact: true });
      const draft = draftDialog.getByLabel('新しい資料の名前', { exact: true }); await draft.fill('keep this creation draft');
      await page.locator('[data-workspace-focus] button[aria-controls~="workspace-chrome"]').evaluate(button => (button as HTMLButtonElement).click());
      await page.waitForFunction(text => [...document.querySelectorAll('[role="alert"]')].some(el => el.textContent?.includes(text)), refusal);
      assert.equal(await page.locator('[data-workspace-focus]').getAttribute('data-workspace-focus'), 'false');
      assert.equal(await draft.inputValue(), 'keep this creation draft');
      await draftDialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
      await draftDialog.waitFor({ state: 'hidden' });
      phase = 'preserve-controls';
      const annotations = page.getByRole('region', { name: '付箋・ハイライト一覧', exact: true });
      await annotations.getByRole('button', { name: /^付箋・ハイライト一覧/ }).click();
      await annotations.getByPlaceholder('複数の語を空白で区切る').fill('retained annotation query');
      await annotations.getByLabel('種類', { exact: true }).selectOption('sticky');
      const query = page.getByLabel('資料の検索語', { exact: true }); await query.fill('Focus');
      const queryNode = await query.elementHandle(); assert.ok(queryNode);
      await focus(page, true);
      assert.equal(await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).count(), 1);
      assert.equal(await root.evaluate(element => element.isConnected && document.querySelector('[data-reader-root]') === element), true);
      assert.equal(await editorNode.evaluate(element => element.isConnected), true);
      assert.equal(await queryNode.evaluate(element => element.isConnected), true, 'hidden catalog remains mounted');
      await editor.click(); await editor.press('End');
      await focus(page, false);
      assert.equal(await query.inputValue(), 'Focus');
      assert.equal(await annotations.getByPlaceholder('複数の語を空白で区切る').inputValue(), 'retained annotation query');
      assert.equal(await annotations.getByLabel('種類', { exact: true }).inputValue(), 'sticky');
      assert.equal(await query.evaluate(element => document.activeElement === element), false, 'explicit editor focus prevents restoring old catalog focus');
      assert.deepEqual(await ordinaryMarkdownSaved(page, id, body, 1), saved);
      await query.fill('');
      phase = 'chooser-hold-and-empty-selection';
      const choosing = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'PDFを取り込む', exact: true }).click();
      const chooser = await choosing;
      await page.getByRole('button', { name: '集中表示', exact: true }).click();
      assert.equal(await page.locator('[data-workspace-focus]').getAttribute('data-workspace-focus'), 'false');
      await chooser.setFiles([]);
      await focus(page, true); await focus(page, false);
      t.diagnostic('Chooser interception with setFiles([]) checks the empty selection route, not an OS dialog cancel event.');
      phase = 'attachment';
      await page.getByLabel(`「${title}」の操作`, { exact: true }).click();
      const attaching = page.waitForEvent('filechooser');
      await page.getByRole('menuitem', { name: 'ファイルを添付', exact: true }).click();
      await (await attaching).setFiles({ name: 'focus-retained.txt', mimeType: 'text/plain', buffer: Buffer.from('Attachment remains the selected resource') });
      // The ordinary import opens its exact created attachment itself.
      await page.getByRole('heading', { name: 'focus-retained.txt', exact: true }).waitFor();
      await page.getByText('Attachment remains the selected resource', { exact: true }).waitFor();
      const resource = await page.locator('[data-attachment-id]').elementHandle(); assert.ok(resource);
      await focus(page, true); await focus(page, false);
      assert.equal(await resource.evaluate(element => element.isConnected), true);
      assert.equal(await page.locator('[data-reader-root]').count(), 0, 'attachment does not claim an editing surface');
      phase = 'cold-restart'; await focus(page, true);
      const restarted = await app.restartLibrary({ showCatalog: false });
      await restarted.getByRole('heading', { name: 'focus-retained.txt', exact: true }).waitFor();
      assert.equal(await restarted.locator('[data-workspace-focus]').getAttribute('data-workspace-focus'), 'false', 'focus presentation is transient within a Library lifetime');
      assert.deepEqual(await ordinaryMarkdownSaved(restarted, id, body, 1), saved);
      t.diagnostic(JSON.stringify({ engine, editorAndChromeIdentityRetained: true, unchangedMarkdownBatches: 1, attachmentReadOnly: true, focusResetAfterColdRestart: true }));
    } catch (error) { t.diagnostic(JSON.stringify({ phase, error: String(error), body: await page.locator('body').innerText().catch(String) })); throw error; }
  });

  test(`ordinary focus keeps notebook and PDF viewport at 125 percent and compact widths (${engine})`, { timeout: 180_000 }, async t => {
    const app = await ordinaryWeb(t, engine), { page } = app;
    let phase = 'notebook';
    try {
      const id = await createNotebook(page, `Focus paper ${engine}`); await catalog(page, false);
      let changes = 0;
      const sticky = async (text: string, x: number, y: number) => {
        await page.getByRole('button', { name: '付箋を貼る', exact: true }).click();
        await page.getByLabel('注釈の配置と選択', { exact: true }).click({ position: { x, y } });
        const annotation = page.getByRole('region', { name: '注釈を編集', exact: true });
        await annotation.getByRole('textbox', { name: '付箋のメモ', exact: true }).fill(text);
        await annotation.getByRole('button', { name: '確定', exact: true }).click(); await annotation.waitFor({ state: 'hidden' });
        await durable(page, id, [], ++changes);
      };
      for (let index = 0; index < 4; index++) await sticky(`Focus annotation row ${index}`, 100 + index % 2 * 120, 140 + Math.floor(index / 2) * 140);
      await catalog(page, true);
      const annotations = page.getByRole('region', { name: '付箋・ハイライト一覧', exact: true });
      await annotations.getByRole('button', { name: /^付箋・ハイライト一覧/ }).click();
      await annotations.getByText('Focus annotation row 3', { exact: true }).waitFor();
      await annotations.getByRole('button', { name: '絞込結果をノートへ追記', exact: true }).click();
      const append = page.getByRole('dialog', { name: '引用をノートへ追加', exact: true }); await append.waitFor();
      await page.locator('[data-workspace-focus] button[aria-controls~="workspace-chrome"]').evaluate(button => (button as HTMLButtonElement).click());
      assert.equal(await page.locator('[data-workspace-focus]').getAttribute('data-workspace-focus'), 'false');
      assert.equal(await append.isVisible(), true);
      await append.getByRole('button', { name: '追加を取り消す', exact: true }).click(); await append.waitFor({ state: 'hidden' });
      const exportButton = annotations.getByRole('button', { name: '絞込結果をノートへ追記', exact: true });
      await exportButton.waitFor();
      await page.waitForFunction(() => {
        const buttons = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="付箋・ハイライト一覧"] button')];
        return buttons.some(button => button.textContent === '絞込結果をノートへ追記' && !button.disabled);
      });
      phase = 'annotation-scroll-hidden-update';
      const results = annotations.getByLabel('注釈の検索結果', { exact: true });
      await annotations.getByLabel('順序', { exact: true }).selectOption('created-descending');
      await page.waitForFunction(() => document.querySelector('[aria-label="注釈の検索結果"] li p.whitespace-pre-wrap')?.textContent === 'Focus annotation row 3');
      await results.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
      const anchorBefore = await results.evaluate(element => {
        const top = element.getBoundingClientRect().top + element.clientTop;
        const rows = [...element.querySelectorAll('li')], index = rows.findIndex(row => row.getBoundingClientRect().bottom > top);
        const row = rows[index], text = row?.querySelector('p.whitespace-pre-wrap')?.textContent;
        if (!row || !text || element.scrollTop <= 0) throw new Error('visible anchor in an actually overflowing list required');
        return { text, index, offset: row.getBoundingClientRect().top - top };
      });
      await focus(page, true);
      await sticky('Focus annotation added while the list is hidden', 280, 400);
      await page.locator('#workspace-catalog-chrome').getByText('Focus annotation added while the list is hidden', { exact: true }).waitFor({ state: 'attached' });
      await focus(page, false);
      const indexAfter = await results.locator('li p.whitespace-pre-wrap').evaluateAll((elements, text) => elements.findIndex(element => element.textContent === text), anchorBefore.text);
      assert.ok(indexAfter > anchorBefore.index, 'the new row must actually be inserted above the retained anchor');
      await page.waitForFunction(expected => {
        const pane = document.querySelector<HTMLElement>('[aria-label="注釈の検索結果"]');
        const row = pane && [...pane.querySelectorAll('li')].find(row => row.querySelector('p.whitespace-pre-wrap')?.textContent === expected.text);
        return !!pane && !!row && Math.abs(row.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientTop - expected.offset) < 8;
      }, anchorBefore);
      await annotations.getByRole('button', { name: /^付箋・ハイライト一覧/ }).click();
      await catalog(page, false);
      t.diagnostic('Settings/append modal refusal uses an explicitly labelled DOM admission seam against real UI owners.');
      await page.getByRole('button', { name: '表示設定', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'このライブラリの表示設定', exact: true });
      await settings.getByLabel('文字の大きさ', { exact: true }).selectOption('1.25');
      await settings.getByRole('button', { name: '表示設定を閉じる', exact: true }).click(); await settings.waitFor({ state: 'hidden' });
      phase = 'active-contact-admission';
      await page.getByRole('button', { name: 'ペン', exact: true }).click();
      const layer = page.getByLabel('ノート書き込みレイヤー', { exact: true }); await layer.scrollIntoViewIfNeeded();
      const box = await layer.boundingBox(); assert.ok(box && box.width > 0 && box.height > 0);
      await page.mouse.move(box.x + box.width * .3, box.y + box.height * .65); await page.mouse.down();
      try {
        await page.mouse.move(box.x + box.width * .45, box.y + box.height * .65, { steps: 5 });
        await page.locator('[data-workspace-focus] button[aria-controls~="workspace-chrome"]').evaluate(button => (button as HTMLButtonElement).click());
        assert.equal(await page.locator('[data-workspace-focus]').getAttribute('data-workspace-focus'), 'false', 'real held mouse contact rejects a layout change');
        const afterRefusal = await layer.boundingBox(); assert.ok(afterRefusal);
        assert.ok(Math.abs(afterRefusal.x - box.x) < 1 && Math.abs(afterRefusal.y - box.y) < 1 && Math.abs(afterRefusal.width - box.width) < 1 && Math.abs(afterRefusal.height - box.height) < 1,
          'the refusal alert must not resize or move the paper during a held contact');
      } finally { await page.mouse.up(); }
      await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 1);
      await durable(page, id, (await inks(page)).map(ink => ink.id), ++changes);
      phase = 'compact-layout';
      const root = await page.locator('[data-reader-root]').elementHandle(); assert.ok(root);
      const before = await committed(page, id);
      for (const width of [1382, 1000, 600]) {
        phase = `compact-layout-${width}`; await page.setViewportSize({ width, height: 910 });
        await focus(page, true);
        const paper = page.locator('.document-paper-pane[aria-label="用紙"] [data-paper-page]'); await paper.waitFor();
        await page.waitForFunction(() => {
          const paper = document.querySelector('[data-paper-page]')?.getBoundingClientRect();
          return paper && paper.height > 0 && paper.bottom <= innerHeight + 1;
        });
        assert.equal(await root.evaluate(element => element.isConnected && document.querySelector('[data-reader-root]') === element), true);
        await focus(page, false);
      }
      assert.deepEqual(await committed(page, id), before, 'layout toggles do not create durable edits');
      phase = 'pdf';
      const rootDir = path.resolve(import.meta.dirname, '../../../..'), pdf = path.join(app.scratch, 'focus.pdf');
      const authored = spawnSync(path.join(rootDir, '.venv/Scripts/python.exe'), [path.join(rootDir, 'frontend/e2e/fixtures/p2PdfNavigation.py'), pdf], { encoding: 'utf8', windowsHide: true });
      assert.equal(authored.status, 0, authored.stderr);
      await catalog(page, true);
      await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(pdf);
      await page.getByRole('heading', { name: 'focus.pdf', exact: true }).waitFor();
      await catalog(page, false);
      await page.locator('[data-reader-surface="original"] [data-rendered="true"] canvas').first().waitFor();
      await page.getByRole('button', { name: 'リーダーのその他', exact: true }).click();
      await page.getByRole('menuitem', { name: '右側で編集', exact: true }).click();
      const pdfRoot = await page.locator('[data-reader-root]').elementHandle(); assert.ok(pdfRoot);
      const pdfId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(pdfId);
      const pdfBefore = await committed(page, pdfId);
      await focus(page, true);
      await page.getByLabel('倍率', { exact: true }).selectOption('0');
      assert.equal(await pdfRoot.evaluate(element => element.isConnected && document.querySelector('[data-reader-root]') === element), true);
      assert.equal(await page.locator('[data-reader-root]').count(), 1);
      await focus(page, false);
      assert.deepEqual(await committed(page, pdfId), pdfBefore);
      t.diagnostic(JSON.stringify({ engine, widths: [1382, 1000, 600], uiScale: 1.25, sameNotebookAndPdfOwner: true, noDurableEditsFromFocus: true }));
    } catch (error) { t.diagnostic(JSON.stringify({ phase, error: String(error), body: await page.locator('body').innerText().catch(String) })); throw error; }
  });
}

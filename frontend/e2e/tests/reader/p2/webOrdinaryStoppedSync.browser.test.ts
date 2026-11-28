import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { ordinaryWeb } from './ordinaryWeb.ts';
import { ordinaryMarkdownSaved } from '../../../support/ordinaryMarkdown.ts';

for (const engine of ['chromium', 'webkit'] as const) {
  test(`ordinary local Library displays stopped sync and saves Markdown (${engine})`, { timeout: 240_000 }, async t => {
    const app = await ordinaryWeb(t, engine), page = app.page;
    await page.getByRole('region', { name: '資料一覧', exact: true }).getByRole('status')
      .filter({ hasText: '同期停止中（未送信の変更は保持されます）' }).waitFor({ timeout: 25_000 });
    await page.getByLabel('新しい資料の名前', { exact: true }).fill('Stopped Markdown');
    await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
    await page.getByRole('button', { name: '資料を作成', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true });
    await editor.waitFor({ timeout: 25_000 });
    const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
    const toolbar = page.getByRole('toolbar', { name: 'Markdownノートの操作', exact: true });
    await toolbar.getByRole('status').filter({ hasText: '端末保存済み・同期停止中' }).waitFor({ timeout: 25_000 });
    assert.equal(await toolbar.getByRole('button', { name: '同期', exact: true }).isDisabled(), true);
    await editor.fill('Durable local text');
    await page.getByRole('heading', { name: 'Stopped Markdown', exact: true }).click();
    await ordinaryMarkdownSaved(page, id, 'Durable local text', 1);
    await toolbar.getByRole('status').filter({ hasText: '端末保存済み・同期停止中' }).waitFor({ timeout: 25_000 });
    assert.equal(await toolbar.getByRole('button', { name: '同期', exact: true }).isDisabled(), true);
  });
  test(`ordinary local PDF does not claim a stopped sender has synced (${engine})`, { timeout: 240_000 }, async t => {
    const { page } = await ordinaryWeb(t, engine);
    await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(path.resolve(import.meta.dirname, '../../../../../tests/fixtures/shared-coordinate-pages.pdf'));
    await page.getByRole('heading', { name: 'shared-coordinate-pages.pdf', exact: true }).waitFor({ timeout: 25_000 });
    await page.getByRole('status').filter({ hasText: '端末保存済み・同期停止中' }).first().waitFor({ timeout: 25_000 });
    assert.equal(await page.getByRole('button', { name: '同期', exact: true }).isDisabled(), true);
  });
}

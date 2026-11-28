import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { resource } from '../reader/p2/ordinaryStorage.ts';
import { ordinaryMarkdown, ordinaryMarkdownSaved, ordinaryMarkdownSnapshot } from '../../support/ordinaryMarkdown.ts';

function makePng() {
  function chunk(type: string, data: Buffer) { const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([size, body, checksum]); }
  const header = Buffer.alloc(13); header.writeUInt32BE(3); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.from([0, 20, 100, 220, 20, 100, 220, 20, 100, 220]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0))]);
}
const png = makePng();
const headings = ['何を解決する論文？', '新しい点', '主な結果', '前提・限界', '自分に使えそうな点', '疑問・次に調べること'];
const builtin = headings.map(value => `## ${value}`).join('\n\n');

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary built-in and resource-bearing templates (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page, firstTitle = `Template image source ${engine}`;
  let phase = 'source-and-builtin';
  try {
  await page.getByLabel('新しい資料の名前', { exact: true }).fill(firstTitle);
  await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
  await page.getByRole('button', { name: '資料を作成', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true }); await editor.waitFor();
  const firstId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(firstId);
  const toggle = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.getByRole('button', { name: 'テンプレートを使う', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'このライブラリのテンプレート', exact: true }); await modal.waitFor();
  await modal.getByRole('button', { name: 'ノートに追加', exact: true }).click(); await modal.waitFor({ state: 'hidden' });
  const firstText = `\n\n${builtin}\n`;
  await ordinaryMarkdownSaved(page, firstId, firstText, 1);
  await page.getByLabel('追加する画像', { exact: true }).setInputFiles({ name: 'template.png', mimeType: 'image/png', buffer: png });
  phase = 'image-and-template';
  const deadline = Date.now() + 30_000;
  let source = await ordinaryMarkdown(page, firstId), body = ordinaryMarkdownSnapshot(source);
  while (body.imageResources.length !== 1 || source.intents.length || source.edits.some(edit => !edit.receipt.durable)) {
    assert.ok(Date.now() < deadline, 'uploaded image did not become durable'); await delay(50);
    source = await ordinaryMarkdown(page, firstId); body = ordinaryMarkdownSnapshot(source);
  }
  const reference = body.imageResources[0]; assert.equal(reference.sha256, createHash('sha256').update(png).digest('hex'));
  const originalResource = await resource(page, source.namespace, reference.resourceId);
  assert.equal(originalResource.actualSha256, reference.sha256);
  await page.getByRole('button', { name: 'テンプレートを使う', exact: true }).click(); await modal.waitFor();
  await modal.getByRole('button', { name: '現在のノートから作成', exact: true }).click();
  await modal.getByLabel('テンプレート名', { exact: true }).fill('読書メモ');
  await modal.getByRole('button', { name: 'テンプレートを保存', exact: true }).click(); await modal.getByRole('alert').waitFor();
  await modal.getByLabel('テンプレート名', { exact: true }).fill('Image template');
  await modal.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
  const select = modal.getByLabel('テンプレート', { exact: true }); await select.waitFor();
  const templateId = await select.inputValue(); assert.ok(templateId);
  assert.equal(await page.getByRole('button', { name: '作成した資料を開く', exact: true, includeHidden: true }).count(), 0);
  const template = await ordinaryMarkdown(page, templateId);
  assert.deepEqual(ordinaryMarkdownSnapshot(template).imageResources, [reference]);
  assert.equal(ordinaryMarkdownSnapshot(template).content, body.content);
  await modal.getByRole('button', { name: 'コピーして作成', exact: true }).click();
  await modal.getByLabel('テンプレート名', { exact: true }).fill('Image template');
  await modal.getByRole('button', { name: 'テンプレートを保存', exact: true }).click(); await modal.getByRole('alert').waitFor();
  await modal.getByRole('button', { name: '編集を取り消す', exact: true }).click();
  await modal.getByRole('button', { name: '閉じる', exact: true }).click();
  phase = 'destination-create';
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.getByLabel('新しい資料の名前', { exact: true }).fill(`Template image destination ${engine}`);
  await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
  await page.getByRole('button', { name: '資料を作成', exact: true }).click();
  await page.getByRole('heading', { name: `Template image destination ${engine}`, exact: true }).waitFor();
  await page.waitForFunction(original => { const id = document.querySelector('[data-content-document]')?.getAttribute('data-content-document'); return !!id && id !== original; }, firstId);
  await editor.waitFor(); const secondId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(secondId && secondId !== firstId);
  phase = 'insert-and-restart';
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.getByRole('button', { name: 'テンプレートを使う', exact: true }).click(); await modal.waitFor();
  await modal.getByLabel('テンプレート', { exact: true }).selectOption(templateId);
  await page.waitForFunction(expected => document.querySelector('[role="dialog"] pre')?.textContent === expected, body.content);
  await modal.getByRole('button', { name: 'ノートに追加', exact: true }).click(); await modal.waitFor({ state: 'hidden' });
  const expected = `\n\n${body.content}\n`;
  const destination = await ordinaryMarkdownSaved(page, secondId, expected, 1);
  assert.deepEqual(ordinaryMarkdownSnapshot(destination).imageResources, [reference]);
  await page.getByRole('button', { name: 'プレビュー', exact: true }).click();
  await page.waitForFunction(() => { const image = document.querySelector<HTMLImageElement>('img[alt="template.png"]'); return image?.complete && image.naturalWidth === 3 && image.naturalHeight === 2; });
  const reopened = await app.restart(`Template image destination ${engine}`);
  const restored = await ordinaryMarkdownSaved(reopened, secondId, expected, 1); assert.deepEqual(restored, destination);
  assert.deepEqual(await resource(reopened, source.namespace, reference.resourceId), originalResource);
  assert.deepEqual(ordinaryMarkdownSnapshot(await ordinaryMarkdown(reopened, templateId)).imageResources, [reference]);
  await reopened.getByRole('button', { name: 'プレビュー', exact: true }).click();
  await reopened.waitForFunction(() => { const image = document.querySelector<HTMLImageElement>('img[alt="template.png"]'); return image?.complete && image.naturalWidth === 3 && image.naturalHeight === 2; });
  assert.equal(await reopened.getByRole('button', { name: '作成した資料を開く', exact: true, includeHidden: true }).count(), 0);
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, error: String(error), alerts: await page.getByRole('alert').allTextContents().catch(() => []),
      dialogs: await page.getByRole('dialog').allTextContents().catch(() => []), body: await page.locator('body').innerText().catch(() => '') }));
    throw error;
  }
});

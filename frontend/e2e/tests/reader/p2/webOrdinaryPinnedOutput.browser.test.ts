import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { committed, durable } from './ordinaryStorage.ts';
import { gesture, ordinaryWeb } from './ordinaryWeb.ts';

async function download(page: Page, action: () => Promise<void>, target: string) {
  const waiting = page.waitForEvent('download', { timeout: 150_000 });
  await action(); const file = await waiting; await file.saveAs(target);
  assert.equal(await file.failure(), null);
}
const inspect = `import sys,json,pymupdf
d=pymupdf.open(sys.argv[1])
def counts(p):
 c=[q.get('color') for q in p.get_drawings() if q.get('color')]
 return {'red':sum(1 for x in c if x[0]>.5 and x[1]<.2 and x[2]<.2),'green':sum(1 for x in c if x[1]>.3 and x[0]<.2 and x[2]<.4)}
p=pymupdf.Pixmap(sys.argv[2]); a=p.samples; n=p.n
pixels=[a[i:i+3] for i in range(0,len(a),n)]
print(json.dumps({'pages':[counts(x) for x in d], 'png':{'width':p.width,'height':p.height,'green':sum(1 for x in pixels if x[1]>65 and x[1]>x[0]*1.6 and x[1]>x[2]*1.3),'red':sum(1 for x in pixels if x[0]>100 and x[0]>x[1]*1.7 and x[0]>x[2]*1.7)}}))`;

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary pinned reference does not duplicate PDF export or replace main-page capture (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  const root = path.resolve(import.meta.dirname, '../../../../..'), python = path.join(root, '.venv/Scripts/python.exe');
  const directory = process.env.PAPEER_E2E_ARTIFACT_DIR ? path.join(path.resolve(process.env.PAPEER_E2E_ARTIFACT_DIR), engine) : app.scratch;
  await mkdir(directory, { recursive: true });
  const source = path.join(app.scratch, 'pinned-output.pdf');
  const authored = spawnSync(python, [path.join(root, 'frontend/e2e/fixtures/p2PdfNavigation.py'), source], { encoding: 'utf8', windowsHide: true });
  assert.equal(authored.status, 0, authored.stderr);
  await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(source);
  await page.getByRole('heading', { name: 'pinned-output.pdf', exact: true }).waitFor();
  const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
  await page.getByRole('button', { name: '資料一覧', exact: true }).click();
  const main = page.locator('[data-reader-surface="original"]'), reference = page.locator('[data-reader-reference]');
  await main.locator('[data-rendered="true"] .react-pdf__Page__canvas').waitFor();
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  await page.getByLabel('書き込みの色', { exact: true }).fill('#cc0000');
  await gesture(page, [[.2, .4], [.55, .5]], 'PDF書き込みレイヤー');
  const red = await main.locator('[data-ink-id]').getAttribute('data-ink-id'); assert.ok(red);
  await durable(page, id, [red], 1);
  await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).click();
  await reference.locator('[data-rendered="true"] .react-pdf__Page__canvas').waitFor();
  const pin = await reference.locator('[data-canonical-page]').getAttribute('data-canonical-page'); assert.ok(pin);
  await page.getByRole('button', { name: '次のページ', exact: true }).click();
  await main.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="2"] .react-pdf__Page__canvas').waitFor();
  await page.getByLabel('書き込みの色', { exact: true }).fill('#008844');
  await gesture(page, [[.2, .6], [.55, .7]], 'PDF書き込みレイヤー');
  const green = await main.locator('[data-ink-id]').getAttribute('data-ink-id'); assert.ok(green && green !== red);
  const before = await durable(page, id, [red, green], 2);
  await reference.locator(`[data-canonical-page="${pin}"] [data-ink-id="${red}"]`).waitFor();
  const pdf = path.join(directory, 'pinned-export.pdf'), png = path.join(directory, 'pinned-main-capture.png');
  await page.getByLabel('出力に注釈を含める', { exact: true }).check();
  await download(page, () => page.getByRole('button', { name: 'PDFを書き出す', exact: true }).click(), pdf);
  await page.getByRole('status').filter({ hasText: /^PDFをダウンロードしました/ }).waitFor();
  await page.getByLabel('切り抜き先', { exact: true }).selectOption('download');
  await download(page, async () => {
    await page.getByRole('button', { name: '範囲を切り抜く', exact: true }).click();
    await gesture(page, [[.05, .05], [.95, .95]], 'PDF書き込みレイヤー');
  }, png);
  const bytes = await readFile(png); assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  const result = spawnSync(python, ['-c', inspect, pdf, png], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as { pages: { red: number; green: number }[]; png: { width: number; height: number; green: number; red: number } };
  assert.equal(output.pages.length, 2, 'the reference is not an extra export page');
  assert.deepEqual(output.pages, [{ red: 1, green: 0 }, { red: 0, green: 1 }], 'each authored pen stroke is exported once on its own page');
  assert.ok(output.png.width > 100 && output.png.height > 100 && output.png.green > 30, 'capture includes the edited main page');
  assert.equal(output.png.red, 0, 'capture does not substitute the pinned first page');
  await reference.locator(`[data-canonical-page="${pin}"]`).waitFor();
  assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '2');
  assert.deepEqual(await committed(page, id), before, 'export and capture do not create editing history');
  t.diagnostic(JSON.stringify({ engine, documentId: id, pinnedPage: pin, exportedPages: 2, output, exactEdits: 2 }));
});

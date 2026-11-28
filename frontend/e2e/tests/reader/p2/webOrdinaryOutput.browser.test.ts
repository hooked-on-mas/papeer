import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { committed, durable, inks } from './ordinaryStorage.ts';
import { gesture, ordinaryWeb } from './ordinaryWeb.ts';

async function download(page: Page, action: () => Promise<void>, destination: string) {
  const waiting = page.waitForEvent('download', { timeout: 150_000 }); await action(); const file = await waiting;
  await file.saveAs(destination); assert.equal(await file.failure(), null); return destination;
}
const inspection = `import sys,json,re,hashlib,pymupdf
out=[]
for name in sys.argv[1:]:
 d=pymupdf.open(name)
 out.append([{'rect':list(p.rect),'crop':list(p.cropbox),'rotation':p.rotation,'userUnit':d.xref_get_key(p.xref,'UserUnit'),'text':p.get_text(),'rasterSha256':hashlib.sha256(p.get_pixmap(matrix=pymupdf.Matrix(.5,.5),alpha=False).samples).hexdigest(),'notes':[{'content':a.info['content'],'rect':[float(n) for n in re.findall(r'-?\\d+(?:\\.\\d+)?',d.xref_get_key(a.xref,'Rect')[1])]} for a in p.annots() or []],'green':sum(1 for q in p.get_drawings() if q.get('color') and q['color'][1]>.4 and q['color'][1]>q['color'][0]*1.5)} for p in d])
 if name.endswith('annotated.pdf'): d[1].get_pixmap(alpha=False).save(name+'.page2.png')
print(json.dumps(out))`;
for (const engine of ['chromium', 'webkit'] as const) test(`ordinary P2 PDF export retains source text and physical metadata; capture downloads real annotated PNG (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  const root = path.resolve(import.meta.dirname, '../../../../..'), python = path.join(root, '.venv/Scripts/python.exe');
  const artifacts = process.env.PAPEER_E2E_ARTIFACT_DIR ? path.join(path.resolve(process.env.PAPEER_E2E_ARTIFACT_DIR), engine) : app.scratch;
  await mkdir(artifacts, { recursive: true });
  const source = path.join(artifacts, 'p2-output.pdf');
  let phase = 'authoring';
  try {
  const author = spawnSync(python, [path.join(root, 'frontend/e2e/fixtures/p2PdfOutput.py'), path.join(root, 'tests/fixtures/sample.pdf'), source], { encoding: 'utf8', windowsHide: true });
  assert.equal(author.status, 0, author.stderr);
  await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(source);
  await page.getByRole('heading', { name: 'p2-output.pdf', exact: true }).waitFor();
  const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
  await page.getByRole('button', { name: '資料一覧', exact: true }).click();
  await page.getByLabel('ページ番号', { exact: true }).fill('2'); await page.getByLabel('ページ番号', { exact: true }).press('Enter');
  await page.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="2"] canvas').waitFor();
  await page.getByLabel('描画の種類', { exact: true }).selectOption('arrow');
  await page.getByLabel('書き込みの色', { exact: true }).fill('#228855');
  await gesture(page, [[.2, .3], [.45, .4]], 'PDF書き込みレイヤー');
  await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 1);
  const arrowIds = (await inks(page)).map(value => value.id); await durable(page, id, arrowIds, 1);
  phase = 'Japanese-ink-text';
  await page.getByRole('button', { name: '文字', exact: true }).click();
  await gesture(page, [[.25, .65]], 'PDF書き込みレイヤー');
  await page.getByRole('textbox', { name: '書き込みテキスト', exact: true }).fill('日本語の書き出し');
  await page.getByRole('button', { name: '確定', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 2);
  const ids = (await inks(page)).map(value => value.id); await durable(page, id, ids, 2);
  phase = 'sticky';
  await page.getByRole('button', { name: '付箋を貼る', exact: true }).click();
  await gesture(page, [[.5, .5]], '注釈の配置と選択');
  const form = page.getByRole('region', { name: '注釈を編集', exact: true });
  await form.getByRole('textbox', { name: '付箋のメモ', exact: true }).fill('付箋の日本語');
  await form.getByRole('button', { name: '確定', exact: true }).click();
  await durable(page, id, ids, 3);
  phase = 'managed-highlight';
  await page.getByRole('button', { name: '読む', exact: true }).click();
  const textLayer = page.locator('.react-pdf__Page[data-page-number="2"] .textLayer[tabindex="0"]');
  await page.waitForFunction(() => {
    const page = document.querySelector('.react-pdf__Page[data-page-number="2"]');
    const canvas = page?.querySelector('canvas')?.getBoundingClientRect(), text = page?.querySelector('.textLayer')?.getBoundingClientRect();
    return canvas && text && Math.abs(canvas.x - text.x) < 1 && Math.abs(canvas.y - text.y) < 1
      && Math.abs(canvas.width - text.width) < 1 && Math.abs(canvas.height - text.height) < 1;
  });
  await textLayer.focus(); await page.keyboard.press('Enter');
  // The authored CropBox deliberately cuts the title's ascent. Select the next
  // fully visible line through trusted caret movement rather than inventing a Range.
  const headingLength = (await textLayer.locator('span[role="presentation"]').first().textContent())!.length;
  for (let i = 0; i <= headingLength; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.getByRole('button', { name: '選択した文章をハイライト', exact: true }).click();
  await Promise.race([form.waitFor({ timeout: 10_000 }), page.getByRole('alert').filter({ hasText: '本文ハイライトを作成できません' }).waitFor({ timeout: 10_000 })]);
  if (!await form.isVisible()) throw new Error('managed-highlight-refused');
  await form.getByRole('textbox', { name: '本文ハイライトのコメント', exact: true }).fill('ハイライトの日本語');
  await form.getByRole('button', { name: '確定', exact: true }).click();
  const saved = await durable(page, id, ids, 4);
  const annotations = saved.edits.flatMap(edit => edit.batch.kind === 'page' ? edit.batch.changes.flatMap(change => change.type === 'create' ? [change.annotation] : []) : []);
  assert.deepEqual(annotations.map(annotation => annotation.kind).sort(), ['highlight', 'ink', 'ink', 'sticky']);
  await page.getByRole('button', { name: '編集をロック', exact: true }).click();
  await gesture(page, [[.2, .8], [.4, .8]], 'PDF書き込みレイヤー');
  assert.equal((await committed(page, id)).edits.length, 4, 'locked reader cannot add edits');
  await page.getByRole('button', { name: '書き込みを非表示', exact: true }).click();
  assert.equal(await page.locator('[data-ink-id]').count(), 0);
  phase = 'plain-PDF-export';
  const plain = path.join(artifacts, 'plain.pdf'), annotated = path.join(artifacts, 'annotated.pdf');
  await page.getByLabel('出力に注釈を含める', { exact: true }).uncheck();
  await download(page, () => page.getByRole('button', { name: 'PDFを書き出す', exact: true }).click(), plain);
  await page.getByRole('status').filter({ hasText: /^PDFをダウンロードしました/ }).waitFor();
  await page.getByLabel('出力に注釈を含める', { exact: true }).check();
  phase = 'annotated-PDF-export';
  await download(page, () => page.getByRole('button', { name: 'PDFを書き出す', exact: true }).click(), annotated);
  const inspected = spawnSync(python, ['-c', inspection, source, plain, annotated], { encoding: 'utf8', windowsHide: true });
  assert.equal(inspected.status, 0, inspected.stderr);
  const [input, bare, inked] = JSON.parse(inspected.stdout) as { rect: number[]; crop: number[]; rotation: number; userUnit: string[]; text: string; green: number; rasterSha256: string; notes: { content: string; rect: number[] }[] }[][];
  for (const output of [bare, inked]) {
    assert.equal(output.length, input.length);
    for (const [index, physical] of output.entries()) {
      assert.deepEqual(physical.rect, input[index].rect); assert.deepEqual(physical.crop, input[index].crop);
      assert.equal(physical.rotation, input[index].rotation); assert.deepEqual(physical.userUnit, input[index].userUnit);
      const expectedText = output === inked && index === 1 ? physical.text.replace('日本語の書き出し\n', '') : physical.text;
      assert.equal(expectedText, input[index].text, 'source text remains searchable and added Japanese text has an exact Unicode mapping');
    }
  }
  assert.equal(bare[1].green, input[1].green); assert.ok(inked[1].green > bare[1].green);
  assert.deepEqual(bare.map(page => page.rasterSha256), input.map(page => page.rasterSha256), 'unannotated PDF renders exactly like the source in an independent renderer');
  assert.equal(inked[0].rasterSha256, input[0].rasterSha256);
  assert.notEqual(inked[1].rasterSha256, input[1].rasterSha256);
  assert.ok(inked[1].text.includes('日本語の書き出し'));
  assert.deepEqual(inked[1].notes.map(note => note.content).sort(), ['ハイライトの日本語', '付箋の日本語']);
  assert.equal(bare[1].notes.length, 0);
  for (const note of annotations.filter(annotation => annotation.kind === 'sticky' || annotation.kind === 'highlight')) {
    const exported = inked[1].notes.find(value => value.content === note.text); assert.ok(exported);
    // Independent oracle for this authored CropBox=[40,40,555,802], Rotate=90,
    // UserUnit=1.25 input, expressed in the raw PDF annotation rectangle.
    const x = 40 + note.anchor.y / 1.25, y = 40 + note.anchor.x / 1.25;
    const expected = [x, y, x + 9.6, y + 9.6];
    exported.rect.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < .01));
  }
  await page.getByRole('button', { name: '編集ロックを解除', exact: true }).click();
  await page.getByRole('button', { name: '書き込みを表示', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 2);
  await page.getByLabel('切り抜き先', { exact: true }).selectOption('download');
  phase = 'annotated-PNG-capture';
  const png = path.join(artifacts, 'capture.png');
  await download(page, async () => {
    await page.getByRole('button', { name: '範囲を切り抜く', exact: true }).click();
    await gesture(page, [[.03, .03], [.97, .97]], 'PDF書き込みレイヤー');
  }, png);
  const bytes = await readFile(png); assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.ok(width > 100 && height > 100);
  assert.ok(Math.abs(width / height - input[1].rect[2] / input[1].rect[3]) < .05);
  await page.getByLabel('出力に注釈を含める', { exact: true }).uncheck();
  phase = 'bare-PNG-capture';
  const plainPng = path.join(artifacts, 'capture-without-annotations.png');
  await download(page, async () => {
    await page.getByRole('button', { name: '範囲を切り抜く', exact: true }).click();
    await gesture(page, [[.03, .03], [.97, .97]], 'PDF書き込みレイヤー');
  }, plainPng);
  await page.getByLabel('出力に注釈を含める', { exact: true }).check();
  const inkText = annotations.find(annotation => annotation.kind === 'ink' && annotation.geometry.kind === 'text');
  const sticky = annotations.find(annotation => annotation.kind === 'sticky');
  const highlight = annotations.find(annotation => annotation.kind === 'highlight');
  assert.ok(inkText?.kind === 'ink' && inkText.geometry.kind === 'text' && sticky?.kind === 'sticky' && highlight?.kind === 'highlight');
  const quads = highlight.quads.flat();
  const rois = {
    text: [inkText.transform.x, inkText.transform.y, inkText.transform.x + inkText.geometry.widthPt, inkText.transform.y + inkText.geometry.heightPt],
    sticky: [sticky.anchor.x - 8, sticky.anchor.y - 8, sticky.anchor.x + 8, sticky.anchor.y + 8],
    highlight: [Math.min(...quads.map(p => p.x)), Math.min(...quads.map(p => p.y)), Math.max(...quads.map(p => p.x)), Math.max(...quads.map(p => p.y))],
  };
  const pixelOracle = `import sys,json,math,pymupdf
pw,ph=float(sys.argv[3]),float(sys.argv[4]);rois=json.loads(sys.argv[5]);out={}
for key,box in rois.items():
 counts=[]
 for name in sys.argv[1:3]:
  pix=pymupdf.Pixmap(name);data=pix.samples;n=pix.n;count=0
  x0=max(0,math.floor((box[0]/pw-.03)/.94*pix.width));x1=min(pix.width,math.ceil((box[2]/pw-.03)/.94*pix.width))
  y0=max(0,math.floor((box[1]/ph-.03)/.94*pix.height));y1=min(pix.height,math.ceil((box[3]/ph-.03)/.94*pix.height))
  for y in range(y0,y1):
   for x in range(x0,x1):
    i=(y*pix.width+x)*n;r,g,b=data[i:i+3]
    count+=int((g>100 and g>r*1.5 and g>b*1.1) if key=='text' else (r>200 and 100<g<200 and b<80) if key=='sticky' else (r>220 and g>180 and b<210))
  counts.append(count)
 out[key]=counts
print(json.dumps(out))`;
  const pixels = spawnSync(python, ['-c', pixelOracle, png, plainPng, String(input[1].rect[2]), String(input[1].rect[3]), JSON.stringify(rois)], { encoding: 'utf8', windowsHide: true });
  assert.equal(pixels.status, 0, pixels.stderr);
  const pixelCounts = JSON.parse(pixels.stdout) as Record<string, [number, number]>;
  for (const [kind, [withAnnotations, withoutAnnotations]] of Object.entries(pixelCounts))
    assert.ok(withAnnotations > withoutAnnotations + 10, `${kind} is visibly painted into actual PNG: ${JSON.stringify(pixelCounts)}`);
  if (engine === 'chromium') {
    phase = 'clipboard-permission-fallback';
    const cdp = await page.context().newCDPSession(page);
    // Browser permission denial is real and confined to this disposable profile.
    await cdp.send('Browser.grantPermissions', { origin: new URL(page.url()).origin, permissions: [] });
    assert.equal(await page.evaluate(async () => (await navigator.permissions.query({ name: 'clipboard-write' as PermissionName })).state), 'denied');
    await page.getByLabel('切り抜き先', { exact: true }).selectOption('clipboard');
    await page.getByRole('button', { name: '範囲を切り抜く', exact: true }).click();
    await gesture(page, [[.03, .03], [.97, .97]], 'PDF書き込みレイヤー');
    await page.getByRole('status').filter({ hasText: '画像をコピーできません。生成した画像をダウンロードできます。' }).waitFor();
    const fallback = path.join(artifacts, 'clipboard-fallback.png');
    await download(page, () => page.getByRole('button', { name: '生成した画像をダウンロード', exact: true }).click(), fallback);
    const retained = await readFile(fallback); assert.equal(retained.subarray(1, 4).toString(), 'PNG');
    assert.ok(Math.abs(retained.readUInt32BE(16) - width) <= 1 && Math.abs(retained.readUInt32BE(20) - height) <= 1);
    await cdp.detach();
  }
  const afterOutput = await committed(page, id);
  assert.deepEqual(afterOutput.edits, saved.edits, 'export and capture preserve the exact edit batches, history and receipts');
  assert.equal(afterOutput.pendingIntents, 0);
  t.diagnostic(JSON.stringify({ engine, documentId: id, physicalMetadata: input.map(p => ({ rect: p.rect, crop: p.crop, rotation: p.rotation, userUnit: p.userUnit })),
    retainedText: true, japaneseInkText: true, lockHiddenExportRetainsAnnotations: true,
    annotatedVectorPaths: inked[1].green - bare[1].green, png: { width, height, pixelCounts }, annotationBatches: 4,
    clipboardFallback: engine === 'chromium' ? 'real permission denial, retained PNG downloaded' : 'not exercised on this engine' }));
  } catch (error) {
    const diagnostic = await page.evaluate(async url => {
      const { readHighlightDiagnostic } = await import(/* @vite-ignore */ url);
      return readHighlightDiagnostic(document.querySelector('[data-reader-root]'), document.querySelector('[data-reader-surface][data-active-surface="true"] [data-pdf-scroller]'));
    }, `/@fs/${path.join(root, 'frontend/src/features/reader/highlightDiagnostics.ts').split('\\').join('/')}`).catch(cause => ({ diagnosticError: String(cause) }));
    const details = await page.evaluate(() => ({ statuses: [...document.querySelectorAll('[role="status"]')].map(node => node.textContent),
      alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent),
      pressed: [...document.querySelectorAll('[aria-pressed="true"]')].map(node => node.textContent),
      selection: { text: getSelection()?.toString(), rects: getSelection()?.rangeCount ? [...getSelection()!.getRangeAt(0).getClientRects()].map(rect => rect.toJSON()) : [] },
      pdfLayout: [...document.querySelectorAll<HTMLElement>('.react-pdf__Page, .react-pdf__Page canvas, .react-pdf__Page .textLayer')].map(element => ({
        className: element.className, box: element.getBoundingClientRect().toJSON(), transform: getComputedStyle(element).transform,
        scaleFactor: getComputedStyle(element).getPropertyValue('--scale-factor'), totalScaleFactor: getComputedStyle(element).getPropertyValue('--total-scale-factor'),
        mainRotation: element.getAttribute('data-main-rotation'), canvasWidth: element instanceof HTMLCanvasElement ? element.width : undefined,
        canvasHeight: element instanceof HTMLCanvasElement ? element.height : undefined })) })).catch(cause => ({ observationError: String(cause) }));
    await writeFile(path.join(artifacts, 'failure.json'), JSON.stringify({ engine, phase, error: String(error), details, diagnostic }, null, 2));
    await page.screenshot({ path: path.join(artifacts, 'failure.png'), timeout: 5_000 }).catch(() => {});
    console.error(JSON.stringify({ event: 'ordinary-output-failure', engine, phase, error: String(error), details, diagnostic }));
    throw error;
  }
});

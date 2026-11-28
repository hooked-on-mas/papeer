import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';

const fixture = `
import React,{useState,useSyncExternalStore}from'react';import{createRoot}from'react-dom/client';
import{LegacyPdfReaderConnection as PdfReader}from'./LegacyPdfReaderConnection';import{PdfWritingTools}from'./PdfWritingTools';import{AnnotationStore}from'./annotations';
import{WritingToolbarSlot}from'../features/reader/WritingToolbar';
import{prepareWebNavigation}from'./textDrafts';import'./style.css';
const paper='a'.repeat(32),sha='b'.repeat(64),anchor={paper_id:paper,side:'original',source_sha256:sha,page:1};
window.eraseUploads=[];
const transport={annotationFiles:async()=>[],annotation:async()=>{},saveAnnotation:async(_library,_folder,_id,op)=>{window.eraseUploads.push(op)}};
const store=new AnnotationStore(transport,'erase-fixture',{version:1,revision:'fixture',items:[],attachments:[],files:{['papers/'+paper+'/original.pdf']:{id:'pdf',sha256:sha,size:1,mime:'application/pdf'}}});
await store.start();
for(const y of [.3,.34])store.add(anchor,{kind:'pen',color:'#000000',width:.003,points:[[.2,y],[.4,y]]});await store.flush();
let fail=true;const set=Storage.prototype.setItem;
Storage.prototype.setItem=function(key,value){if(fail&&(key.startsWith('papeer-ink:')||key.startsWith('papeer-ink-admission:'))&&JSON.parse(value).version===2)throw new Error('QuotaExceeded grouped erase');return set.call(this,key,value)};
function App(){const state=useSyncExternalStore(store.subscribe,store.getSnapshot);const[left,setLeft]=useState(0);
return <main style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
<nav><button onClick={()=>{fail=false}}>保存を許可</button><button onClick={()=>{if(prepareWebNavigation())setLeft(value=>value+1)}}>別のページへ</button><output aria-label="離脱回数">{left}</output></nav>
<div className="web-pdf-pane" style={{flex:1,minHeight:0,overflow:'auto',width:700}}><PdfWritingTools initialActive="original"><WritingToolbarSlot/><PdfReader key={left} url="/eraser-fixture.pdf" target={{paperId:paper,side:'original',sourceSha256:sha}} store={store} zoom={0}/></PdfWritingTools></div></main>}
createRoot(document.getElementById('root')).render(<App/>);`;

for (const engine of ['chromium', 'webkit'] as const) {
test(`Web erase keeps its whole gesture and single Undo through quota failure/retry (${engine})`, { timeout: 90_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ configFile: path.join(frontend, 'vite.web.config.ts'), logLevel: 'error',
    cacheDir: 'node_modules/.vite-eraser-atomic', server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [path.resolve(frontend, '..')] } },
    plugins: [{ name: 'eraser-atomic-fixture', enforce: 'pre', transform(code, id) { return id.replace(/\\/g, '/').endsWith('/src/web/main.tsx') ? fixture : code; } }] });
  await server.listen(); let closeBrowser = async () => {};
  t.after(async () => { await closeBrowser(); if (server.httpServer && 'closeAllConnections' in server.httpServer) server.httpServer.closeAllConnections(); await server.close(); });
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  closeBrowser = () => browser.close(); const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/eraser-fixture.pdf', route => route.fulfill({ body: readFileSync(path.resolve(frontend, '../tests/fixtures/sample.pdf')), contentType: 'application/pdf' }));
  await page.goto(server.resolvedUrls!.local[0], { waitUntil: 'domcontentloaded' });
  const surface = page.getByTestId('web-ink'); await surface.waitFor().catch(async error => { throw new Error(`${error}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`); });
  await page.getByRole('button', { name: '消しゴム', exact: true }).click();
  const rect = (await surface.boundingBox())!;
  await page.mouse.move(rect.x + rect.width * .3, rect.y + rect.height * .25); await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * .3, rect.y + rect.height * .4, { steps: 24 }); await page.mouse.up();
  await page.getByRole('alert').filter({ hasText: '2件の消去' }).waitFor();
  assert.equal(await page.locator('[data-ink-id]').count(), 2);
  assert.equal(await page.getByRole('button', { name: '元に戻す', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '別のページへ', exact: true }).click();
  assert.equal(await page.getByLabel('離脱回数').textContent(), '0');
  await page.getByRole('button', { name: '保存を許可', exact: true }).click();
  await page.getByRole('button', { name: '消去を再保存', exact: true }).click(); assert.equal(await page.locator('[data-ink-id]').count(), 0);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click(); assert.equal(await page.locator('[data-ink-id]').count(), 2);
  await page.getByRole('button', { name: 'やり直す', exact: true }).click(); assert.equal(await page.locator('[data-ink-id]').count(), 0);
  const operations = await page.evaluate(() => (window as any).eraseUploads);
  assert.ok(operations.filter((value: any) => value.version === 2).every((value: any) => value.changes.length === 2));
  await page.getByRole('button', { name: '別のページへ', exact: true }).click(); assert.equal(await page.getByLabel('離脱回数').textContent(), '1');
  await surface.waitFor();
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  const drawnRect = (await surface.boundingBox())!;
  for (const y of [.3, .34]) {
    await page.mouse.move(drawnRect.x + drawnRect.width * .2, drawnRect.y + drawnRect.height * y); await page.mouse.down();
    await page.mouse.move(drawnRect.x + drawnRect.width * .4, drawnRect.y + drawnRect.height * y, { steps: 8 }); await page.mouse.up();
  }
  assert.equal(await page.locator('[data-ink-id]').count(), 2);
  await page.getByRole('button', { name: '消しゴム', exact: true }).click();
  await page.mouse.move(drawnRect.x + drawnRect.width * .3, drawnRect.y + drawnRect.height * .25); await page.mouse.down();
  await page.mouse.move(drawnRect.x + drawnRect.width * .3, drawnRect.y + drawnRect.height * .4, { steps: 24 }); await page.mouse.up();
  assert.equal(await page.locator('[data-ink-id]').count(), 0);
  // Recreate the surface while the document-scoped history stays mounted.
  await page.getByRole('button', { name: '別のページへ', exact: true }).click(); await surface.waitFor();
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const expected of [2, 1, 0]) {
      await page.getByRole('button', { name: '元に戻す', exact: true }).click(); assert.equal(await page.locator('[data-ink-id]').count(), expected);
    }
    for (const expected of [1, 2, 0]) {
      await page.getByRole('button', { name: 'やり直す', exact: true }).click(); assert.equal(await page.locator('[data-ink-id]').count(), expected);
    }
  }
  assert.deepEqual(errors, []);
});
}

test('real Chromium quota rejects a large erase before changing ink and allows smaller groups', { timeout: 90_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ configFile: false, root: frontend, logLevel: 'error',
    optimizeDeps: { noDiscovery: true, entries: [] }, server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(async () => { await browser.close(); if (server.httpServer && 'closeAllConnections' in server.httpServer) server.httpServer.closeAllConnections(); await server.close(); });
  const page = await browser.newPage();
  await page.route('**/quota-probe', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto(server.resolvedUrls!.local[0] + 'quota-probe');
  const result = await page.evaluate(async () => {
    // Import the production store without mounting the application or connecting Drive.
    const modulePath = '/src/web/annotations.ts';
    const { AnnotationStore } = await import(/* @vite-ignore */ modulePath);
    const paper = 'a'.repeat(32), sha = 'b'.repeat(64);
    const anchor = { paper_id: paper, side: 'original', source_sha256: sha, page: 1 };
    const uploads: unknown[] = [];
    const transport = { annotationFiles: async () => [], saveAnnotation: async (_l: string, _f: string, _i: string, op: unknown) => { uploads.push(op); } };
    const store = new AnnotationStore(transport, 'quota-probe', { version: 1, revision: 'r', items: [], attachments: [],
      files: { ['papers/' + paper + '/original.pdf']: { id: 'pdf', sha256: sha, size: 1 } } });
    localStorage.setItem('papeer-ink-admission:quota-probe:interrupted', 'not an operation');
    await store.start();
    const cleaned = localStorage.length === 0;
    const original = [];
    for (let i = 0; i < 10; i++) {
      original.push(store.add(anchor, { kind: 'pen', color: '#000000', width: .003,
        points: Array.from({ length: 20000 }, () => [.12345678901234567, .7654321098765432]) }));
      await store.flush();
    }
    let error = '';
    try { store.edit(anchor, { remove: original.map(stroke => stroke.id) }); } catch (reason) { error = String(reason); }
    const rejected = { count: store.page(anchor).strokes.length, uploads: uploads.length, pending: store.getSnapshot().pending, keys: localStorage.length };
    store.edit(anchor, { remove: original.slice(0, 2).map(stroke => stroke.id) }); await store.flush();
    const afterSmallErase = store.page(anchor).strokes.length;
    store.edit(anchor, { add: original.slice(0, 2) }); await store.flush();
    const restored = store.page(anchor).strokes.length; store.dispose();
    return { cleaned, error, rejected, afterSmallErase, restored, remainingKeys: localStorage.length };
  });
  assert.equal(result.cleaned, true);
  assert.match(result.error, /一度に消去する量を減らして/);
  assert.deepEqual(result.rejected, { count: 10, uploads: 10, pending: 0, keys: 0 });
  assert.equal(result.afterSmallErase, 8); assert.equal(result.restored, 10); assert.equal(result.remainingKeys, 0);
});

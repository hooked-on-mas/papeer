import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright-core';
import { createNotebook } from './reader/p2/ordinaryWeb.ts';

async function documentRows(page: Page, id: string) {
  return page.evaluate(async target => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r=indexedDB.open('papeer-shared-edits'); r.onupgradeneeded=()=>{r.transaction?.abort();reject(new Error('existing DB required'));}; r.onerror=()=>reject(r.error); r.onsuccess=()=>resolve(r.result); });
    try { return await new Promise<{ roots: unknown[]; edits: unknown[]; intents: unknown[] }>((resolve,reject)=>{
      const tx=db.transaction(['roots','edits','intents'],'readonly'), roots=tx.objectStore('roots').getAll(), edits=tx.objectStore('edits').getAll(), intents=tx.objectStore('intents').getAll();
      tx.onabort=()=>reject(tx.error); tx.oncomplete=()=>resolve({roots:roots.result.filter((row:{value:{id:string}})=>row.value.id===target),edits:edits.result.filter((row:{value:{batch:{targetId:string}}})=>row.value.batch.targetId===target),intents:intents.result.filter((row:{key:string})=>JSON.parse(row.key)[1]===target)});
    }); } finally { db.close(); }
  }, id);
}

test('actual Document controller refuses placement after scope leaves during deferred retry', { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '../..');
  const scratch = await mkdtemp(path.join(tmpdir(), 'paper-desk-workspace-seam-'));
  const server = await createServer({ root: path.join(frontend, 'web'), configFile: path.join(frontend, 'vite.web.config.ts'), logLevel: 'error', cacheDir: path.join(scratch, 'cache'),
    server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [frontend] } } });
  const errors: string[] = [];
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  t.after(async () => { await context.close(); await browser.close(); await server.close(); await rm(scratch, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  await server.listen(); const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && m.text() !== 'Manifest: Line: 1, column: 1, Syntax error.') errors.push(m.text()); });
  const fixture = path.join(frontend, 'e2e/fixtures/workspaceControllerSeam.ts').replace(/\\/g, '/');
  await page.route(new RegExp(`^http://127\\.0\\.0\\.1:${address.port}/main\\.tsx(?:\\?.*)?$`), route => route.fulfill({ status: 200, contentType: 'text/javascript', body: `import "/@fs/${fixture}";` }));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).click();
  await page.getByLabel('新しいライブラリの名前').fill('Workspace seam library');
  await page.getByRole('button', { name: '作成', exact: true }).click();
  await page.getByRole('button', { name: '確認しました', exact: true }).click();
  await page.getByRole('button', { name: 'Workspace seam library', exact: true }).click();
  await page.getByText('資料を選択してください。', { exact: true }).waitFor();
  const id = await createNotebook(page, 'Workspace seam notebook');
  await page.getByRole('button', { name: '右側で編集', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '右側で編集', exact: true }).click();
  await page.getByRole('button', { name: '中央で編集', exact: true }).click();
  const beforeRows = await documentRows(page, id); assert.equal(beforeRows.roots.length, 1); assert.equal(beforeRows.intents.length, 0);
  const before = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  await page.evaluate(() => { (window as unknown as { workspaceControllerSeam: { armed: boolean } }).workspaceControllerSeam.armed = true; });
  await page.getByRole('button', { name: '右側で編集', exact: true }).click();
  await page.waitForFunction(() => (window as unknown as { workspaceControllerSeam: { waiting: boolean } }).workspaceControllerSeam.waiting);
  await page.getByRole('button', { name: 'ライブラリを切り替える', exact: true }).click();
  await page.getByRole('button', { name: 'Workspace seam library', exact: true }).waitFor({ state: 'visible' });
  await page.evaluate(() => { const s = (window as unknown as { workspaceControllerSeam: { release?: () => void } }).workspaceControllerSeam; assertRelease(s); function assertRelease(v: typeof s) { if (!v.release) throw new Error('retry not held'); v.release(); } });
  await page.waitForFunction(() => (window as unknown as { workspaceControllerSeam: { released: boolean } }).workspaceControllerSeam.released);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const actual = await page.evaluate(() => { const s = (window as unknown as { workspaceControllerSeam: { refreshAfterHold: number; placementAfterHold: number } }).workspaceControllerSeam; return { refresh: s.refreshAfterHold, placement: s.placementAfterHold, local: Object.fromEntries(Object.entries(localStorage)) }; });
  assert.equal(actual.refresh, 0); assert.equal(actual.placement, 0);
  assert.deepEqual(await documentRows(page, id), beforeRows);
  for (const [key, value] of Object.entries(before)) if (key.includes(id)) assert.equal(actual.local[key], value);
});

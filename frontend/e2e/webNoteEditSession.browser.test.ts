import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const fixture = `
import React,{useState,useSyncExternalStore} from 'react';import{createRoot}from'react-dom/client';
import{WebNoteEditor}from'./WebNotes';import{WebNoteStore}from'./noteStore';
import{newPage}from'../runtime/noteDocuments';import{DEFAULT_PAPER}from'../features/notebooks/paperSpec';
import{prepareWebNavigation}from'./textDrafts';import'./style.css';
const manifest={files:{},items:[],attachments:[]};
const store=new WebNoteStore({noteFiles:async()=>[],saveNote:async()=>{}},'test-library',manifest);
await store.start();
const id='a'.repeat(32);store.edit({id,title:'Test note',kind:'notebook',parent_id:null,collection_name:'',note_position:0,revision:'',
document:{version:1,revision:1,pages:[newPage({...DEFAULT_PAPER,template:'blank'})]},ink:{}});await store.flush();
let fail=true;const setItem=Storage.prototype.setItem;
Storage.prototype.setItem=function(key,value){if(fail&&key.startsWith('papeer-notes:v1:'))throw new Error('QuotaExceeded fixture');return setItem.call(this,key,value)};
function App(){const state=useSyncExternalStore(store.subscribe,store.getSnapshot);const[closed,setClosed]=useState(0);
const note=state.notes.find(n=>n.id===store.editingId(id));return <><button onClick={()=>{fail=false}}>保存を許可</button>
<button onClick={()=>{if(prepareWebNavigation())setClosed(c=>c+1)}}>別の資料へ</button><output aria-label="離脱回数">{closed}</output>
<output aria-label="保存済み筆跡">{Object.values(note.ink).flat().length}</output>
<WebNoteEditor store={store} id={id} manifest={manifest} onClose={()=>setClosed(c=>c+1)}/></>}
createRoot(document.getElementById('root')).render(<App/>);`;

test('Web handwritten edits survive storage failure, Undo and page operations until retry', { timeout: 180_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ configFile: path.join(frontend, 'vite.web.config.ts'), logLevel: 'error',
    cacheDir: 'node_modules/.vite-note-edit-session', server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [{ name: 'note-edit-fixture', enforce: 'pre', transform(code, id) {
      return id.replace(/\\/g, '/').endsWith('/src/web/main.tsx') ? fixture : code;
    } }] });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0], { timeout: 60_000, waitUntil: 'domcontentloaded' });
  const surface = page.getByLabel('手書きノートの用紙');
  await surface.waitFor({ timeout: 30_000 }).catch(async error => { throw new Error(`${error}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`); });
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + 50, box.y + 50); await page.mouse.down();
  await surface.dispatchEvent('pointercancel', { pointerId: 999, pointerType: 'touch' }); // A cancelled palm cannot cancel the active stroke.
  await page.mouse.move(box.x + 100, box.y + 80, { steps: 4 }); await page.mouse.up();
  await page.getByRole('alert').filter({ hasText: 'QuotaExceeded' }).waitFor();
  assert.equal(await page.locator('span[role="status"]').textContent(), '未保存の変更があります');
  assert.equal(await surface.locator(':scope > g').count(), 2, 'failed stroke stays visible');
  assert.equal(await page.getByLabel('保存済み筆跡').textContent(), '0');
  await page.getByRole('button', { name: '別の資料へ', exact: true }).click();
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  assert.equal(await page.getByLabel('離脱回数').textContent(), '0');
  await page.getByRole('button', { name: '＋ ページ', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'ページ', exact: true }).locator('option').count(), 2);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'ページ', exact: true }).locator('option').count(), 1);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  assert.equal(await surface.locator(':scope > g').count(), 1);
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  assert.equal(await surface.locator(':scope > g').count(), 2);
  await page.getByRole('button', { name: '保存を許可', exact: true }).click();
  await page.getByRole('button', { name: '下書きを保存・再試行', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('output[aria-label="保存済み筆跡"]')?.textContent === '1');
  await page.getByRole('button', { name: '別の資料へ', exact: true }).click();
  assert.equal(await page.getByLabel('離脱回数').textContent(), '1');
  assert.deepEqual(errors, []);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { ordinaryMarkdownSaved } from '../../support/ordinaryMarkdown.ts';
import type { Page } from 'playwright-core';
import { EditGraph } from '../../../src/runtime/edits/editGraph.ts';
import type { LibrarySnapshot, Snapshot } from '../../../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../../../src/runtime/edits/repository.ts';

async function catalog(page: Page, namespace: string, libraryId: string) {
  const data = await page.evaluate(async ({ namespace, libraryId }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-shared-edits');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing database required')); };
      request.onblocked = () => reject(new Error('catalog observation blocked'));
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    try { return await new Promise<{ root: Snapshot; edits: StoredEdit[]; intents: number }>((resolve, reject) => {
      const tx = db.transaction(['roots', 'edits', 'intents'], 'readonly');
      const roots = tx.objectStore('roots').getAll(), edits = tx.objectStore('edits').getAll(), intents = tx.objectStore('intents').getAll();
      tx.onabort = () => reject(tx.error ?? new Error('catalog read aborted'));
      tx.oncomplete = () => {
        const root = roots.result.find((row: { scope: string; value: Snapshot }) => row.scope === namespace && row.value.id === libraryId);
        if (!root) { reject(new Error('catalog root missing')); return; }
        resolve({ root: root.value, edits: edits.result.filter((row: { scope: string; value: StoredEdit }) => row.scope === namespace && row.value.batch.targetId === libraryId).map((row: { value: StoredEdit }) => row.value),
          intents: intents.result.filter((row: { scope: string; key: string }) => row.scope === namespace && JSON.parse(row.key)[1] === libraryId).length });
      };
    }); } finally { db.close(); }
  }, { namespace, libraryId });
  const graph = new EditGraph({ version: 1, libraryId, root: data.root, batches: data.edits.map(value => value.batch) });
  const heads = graph.getView().heads; assert.equal(heads.length, 1);
  const snapshot = graph.snapshot(heads[0]); assert.equal(snapshot?.kind, 'library');
  return { ...data, snapshot: snapshot as LibrarySnapshot };
}

async function selectedMarkdownRows(page: Page, id: string, namespace: string) {
  return page.evaluate(async ({ id, namespace }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r=indexedDB.open('papeer-shared-edits'); r.onupgradeneeded=()=>{r.transaction?.abort();reject(new Error('existing database required'));};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error); });
    try { return await new Promise<{ root: Snapshot; edits: StoredEdit[]; intents: unknown[] }>((resolve,reject)=>{
      const tx=db.transaction(['roots','edits','intents'],'readonly'), roots=tx.objectStore('roots').getAll(), edits=tx.objectStore('edits').getAll(), intents=tx.objectStore('intents').getAll();
      tx.onabort=()=>reject(tx.error);tx.oncomplete=()=>{const root=roots.result.find((row:{scope:string;value:Snapshot})=>row.scope===namespace&&row.value.id===id);if(!root){reject(new Error('root absent'));return;}
        resolve({root:root.value,edits:edits.result.filter((row:{scope:string;value:StoredEdit})=>row.scope===namespace&&row.value.batch.targetId===id).map((row:{value:StoredEdit})=>row.value),intents:intents.result.filter((row:{scope:string;key:string})=>row.scope===namespace&&JSON.parse(row.key)[1]===id).map((row:{value:unknown})=>row.value)});};
    }); } finally {db.close();}
  },{id,namespace});
}
for (const engine of ['chromium', 'webkit'] as const) test(`ordinary workspace restores exact folder and document without content writes (${engine})`, {timeout:240_000}, async t=>{
 const app=await ordinaryWeb(t,engine);let page=app.page;
 const folder='Selection folder', title='Selection note', body='Durable selection body';
 await page.getByRole('button',{name:'\u30d5\u30a9\u30eb\u30c0\u30fc\u3092\u4f5c\u6210',exact:true}).click();
 const form=page.getByRole('form',{name:'\u30d5\u30a9\u30eb\u30c0\u30fc\u306e\u64cd\u4f5c',exact:true});
 await form.getByLabel('\u30d5\u30a9\u30eb\u30c0\u30fc\u540d',{exact:true}).fill(folder);
 await form.getByRole('button',{name:'\u30d5\u30a9\u30eb\u30c0\u30fc\u3092\u4fdd\u5b58',exact:true}).click();await form.waitFor({state:'hidden'});
 const tree=page.getByRole('treeitem',{name:`\u30d5\u30a9\u30eb\u30c0\u30fc\u300c${folder}\u300d`,exact:true});await tree.waitFor();const folderId=await tree.getAttribute('data-folder-id');assert.ok(folderId);
 await tree.getByRole('button',{name:`\u300c${folder}\u300d\u3092\u9078\u629e`,exact:true}).click();
 await page.getByLabel('\u65b0\u3057\u3044\u8cc7\u6599\u306e\u540d\u524d',{exact:true}).fill(title);
 await page.getByLabel('\u8cc7\u6599\u306e\u7a2e\u985e',{exact:true}).selectOption('markdown');
 await page.getByRole('button',{name:'\u8cc7\u6599\u3092\u4f5c\u6210',exact:true}).click();
 const editor=page.getByRole('textbox',{name:'Markdown\u30ce\u30fc\u30c8',exact:true});await editor.waitFor();
 const id=await page.locator('[data-content-document]').getAttribute('data-content-document');assert.ok(id);
 await editor.fill(body);const saved=await ordinaryMarkdownSaved(page,id,body,1), namespace=saved.namespace, libraryId=JSON.parse(namespace)[1] as string;
 // A second actual UI-created note supplies the explicit competing selection.
 const toggleBeforeSecond=page.getByRole('button',{name:'\u8cc7\u6599\u4e00\u89a7',exact:true});if(await toggleBeforeSecond.getAttribute('aria-expanded')!=='true')await toggleBeforeSecond.click();
 await page.getByLabel('\u65b0\u3057\u3044\u8cc7\u6599\u306e\u540d\u524d',{exact:true}).fill('Selection competing note');
 await page.getByLabel('\u8cc7\u6599\u306e\u7a2e\u985e',{exact:true}).selectOption('markdown');await page.getByRole('button',{name:'\u8cc7\u6599\u3092\u4f5c\u6210',exact:true}).click();
 await page.getByRole('heading',{name:'Selection competing note',exact:true}).waitFor();const second=await page.locator('[data-content-document]').getAttribute('data-content-document');assert.ok(second&&second!==id);
 const listToggle=page.getByRole('button',{name:'\u8cc7\u6599\u4e00\u89a7',exact:true});if(await listToggle.getAttribute('aria-expanded')!=='true')await listToggle.click();
 await page.getByRole('button',{name:title,exact:true}).click();await page.getByRole('heading',{name:title,exact:true}).waitFor();
 let beforeCatalog=await catalog(page,namespace,libraryId);const settleDeadline=Date.now()+30000;while(beforeCatalog.intents || beforeCatalog.edits.some(edit=>!edit.receipt.durable || !edit.history)){assert.ok(Date.now()<settleDeadline);await delay(50);beforeCatalog=await catalog(page,namespace,libraryId);}
 const key=`paper-desk.selection.v1:${namespace}`;
 await page.waitForFunction(({key,id,folderId})=>{const raw=localStorage.getItem(key);if(!raw)return false;const v=JSON.parse(raw);return v.documentId===id&&v.folderId===folderId;},{key,id,folderId});
 page=await app.restartLibrary({showCatalog:true});try { await page.getByRole('heading',{name:title,exact:true}).waitFor(); } catch(error) { console.log(JSON.stringify({phase:'restore', body:await page.locator('body').innerText(), hint:await page.evaluate(key=>localStorage.getItem(key),key)})); throw error; }
 assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'),id);
 { const restoredEditor=page.getByRole('textbox',{name:'Markdown\u30ce\u30fc\u30c8',exact:true}); await restoredEditor.waitFor({state:'visible'}); const until=Date.now()+30000; while (!await restoredEditor.evaluate((element, expected)=>element instanceof HTMLElement && element.isContentEditable && element.textContent===expected,body)) { assert.ok(Date.now()<until, 'restored Markdown editor did not become editable with the saved body'); await delay(50); } }
 await page.waitForFunction(id=>document.querySelector(`[data-folder-id="${id}"]`)?.getAttribute('aria-selected')==='true',folderId);
 assert.deepEqual(await ordinaryMarkdownSaved(page,id,body,1),saved);assert.deepEqual(await catalog(page,namespace,libraryId),beforeCatalog);
 // Hold completion of one actual readonly IndexedDB target read, not its data or authority.
 await page.evaluate(target=>{
   const marked=new WeakSet<IDBTransaction>(), property=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete');if(!property?.get||!property.set)throw new Error('IDB completion descriptor absent');
   const original=IDBObjectStore.prototype.get, probe={armed:false,waiting:false,completed:false,release:null as null|(()=>void)};
   (globalThis as unknown as {selectionReadProbe:typeof probe}).selectionReadProbe=probe;
   IDBObjectStore.prototype.get=function(key:IDBValidKey|IDBKeyRange){
     if(probe.armed&&this.name==='roots'&&typeof key==='string'){try{const parts=JSON.parse(key) as string[];if(parts[1]===target)marked.add(this.transaction);}catch{/* unrelated key */}}
     return original.call(this,key);
   };
   Object.defineProperty(IDBTransaction.prototype,'oncomplete',{configurable:property.configurable,enumerable:property.enumerable,get:property.get,set:function(this:IDBTransaction,handler:((event:Event)=>unknown)|null){
     const transaction=this;property.set!.call(transaction,handler?function(this:IDBTransaction,event:Event){
       if(probe.armed&&marked.has(transaction)){probe.armed=false;probe.waiting=true;probe.release=()=>{probe.waiting=false;handler.call(transaction,event);probe.completed=true;};return;}
       handler.call(transaction,event);
     }:null);
   }});
 },id);
 await page.getByRole('button',{name:'\u30e9\u30a4\u30d6\u30e9\u30ea\u3092\u5207\u308a\u66ff\u3048\u308b',exact:true}).click();
 const libraryChoice=page.getByRole('button',{name:app.library,exact:true});
 try {
   await libraryChoice.waitFor({state:'visible'});
   await page.getByLabel('\u65b0\u3057\u3044\u30e9\u30a4\u30d6\u30e9\u30ea\u306e\u540d\u524d').waitFor({state:'visible'});
 } catch(error) {
   t.diagnostic(JSON.stringify({phase:'leave-before-arming-restore-probe',body:await page.locator('body').innerText(),probe:await page.evaluate(()=>{const p=(globalThis as unknown as {selectionReadProbe:{armed:boolean;waiting:boolean;completed:boolean}}).selectionReadProbe;return {armed:p.armed,waiting:p.waiting,completed:p.completed};})}));
   throw error;
 }
 await page.evaluate(()=>{const probe=(globalThis as unknown as {selectionReadProbe:{armed:boolean;waiting:boolean;completed:boolean}}).selectionReadProbe;if(probe.waiting||probe.completed)throw new Error('unarmed probe intercepted leave');probe.armed=true;});
 await libraryChoice.click();
 await page.waitForFunction(()=>(globalThis as unknown as {selectionReadProbe:{waiting:boolean}}).selectionReadProbe?.waiting===true);
 const chooseToggle=page.getByRole('button',{name:'\u8cc7\u6599\u4e00\u89a7',exact:true});if(await chooseToggle.getAttribute('aria-expanded')!=='true')await chooseToggle.click();
 const folderRow=page.getByRole('treeitem',{name:`\u30d5\u30a9\u30eb\u30c0\u30fc\u300c${folder}\u300d`,exact:true});if(await folderRow.getAttribute('aria-expanded')!=='true')await folderRow.getByRole('button',{name:`\u300c${folder}\u300d\u3092\u958b\u304f`,exact:true}).click();
 await page.getByRole('button',{name:'Selection competing note',exact:true}).click();await page.getByRole('heading',{name:'Selection competing note',exact:true}).waitFor();
 await page.evaluate(()=>{const probe=(globalThis as unknown as {selectionReadProbe:{release:null|(()=>void)}}).selectionReadProbe;if(!probe.release)throw new Error('actual read not held');probe.release();});
 await page.waitForFunction(()=>(globalThis as unknown as {selectionReadProbe:{completed:boolean}}).selectionReadProbe.completed);
 await page.waitForFunction(({second,key})=>document.querySelector('[data-content-document]')?.getAttribute('data-content-document')===second && JSON.parse(localStorage.getItem(key)!).documentId===second,{second,key});
 const backToggle=page.getByRole('button',{name:'\u8cc7\u6599\u4e00\u89a7',exact:true});if(await backToggle.getAttribute('aria-expanded')!=='true')await backToggle.click();await page.getByRole('button',{name:title,exact:true}).click();await page.getByRole('heading',{name:title,exact:true}).waitFor();
 // Wrong-scope cache cannot change the active scope's exact hint.
 await page.evaluate(({key,namespace})=>{const parts=JSON.parse(namespace);parts[2]+='-other';localStorage.setItem(`paper-desk.selection.v1:${JSON.stringify(parts)}`,JSON.stringify({version:1,documentId:crypto.randomUUID(),folderId:null}));assertLocal();function assertLocal(){if(!localStorage.getItem(key))throw new Error('active hint absent');}},{key,namespace});
 page=await app.restartLibrary({showCatalog:true});await page.getByRole('heading',{name:title,exact:true}).waitFor();assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'),id);
 { const restoredEditor=page.getByRole('textbox',{name:'Markdown\u30ce\u30fc\u30c8',exact:true}); await restoredEditor.waitFor({state:'visible'}); const until=Date.now()+30000; while (!await restoredEditor.evaluate((element, expected)=>element instanceof HTMLElement && element.isContentEditable && element.textContent===expected,body)) { assert.ok(Date.now()<until, 'restored Markdown editor did not become editable with the saved body'); await delay(50); } }
 // Enter a genuinely different library through bootstrap; scope A's saved selection must not appear.
 await page.getByRole('button',{name:'\u30e9\u30a4\u30d6\u30e9\u30ea\u3092\u5207\u308a\u66ff\u3048\u308b',exact:true}).click();
 await page.getByLabel('\u65b0\u3057\u3044\u30e9\u30a4\u30d6\u30e9\u30ea\u306e\u540d\u524d').fill('Selection other scope');
 await page.getByRole('button',{name:'\u4f5c\u6210',exact:true}).click();await page.getByRole('button',{name:'\u78ba\u8a8d\u3057\u307e\u3057\u305f',exact:true}).click();
 await page.getByRole('button',{name:'Selection other scope',exact:true}).click();await page.getByText('\u8cc7\u6599\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002',{exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:title,exact:true}).count(),0);
 await page.getByRole('button',{name:'\u30e9\u30a4\u30d6\u30e9\u30ea\u3092\u5207\u308a\u66ff\u3048\u308b',exact:true}).click();await page.getByRole('button',{name:app.library,exact:true}).click();
 await page.getByRole('heading',{name:title,exact:true}).waitFor();assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'),id);
 // A missing target is never opened or silently overwritten; explicit new selection recovers.
 const missing='00000000-0000-0000-0000-000000000001';
 await page.evaluate(({key,missing,folderId})=>localStorage.setItem(key,JSON.stringify({version:1,documentId:missing,folderId})),{key,missing,folderId});
 page=await app.restartLibrary({showCatalog:true});await page.getByText('\u8cc7\u6599\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002',{exact:true}).waitFor();
 assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).documentId,key),missing);
 const missingFolder=page.getByRole('treeitem',{name:`\u30d5\u30a9\u30eb\u30c0\u30fc\u300c${folder}\u300d`,exact:true});if(await missingFolder.getAttribute('aria-expanded')!=='true')await missingFolder.getByRole('button',{name:`\u300c${folder}\u300d\u3092\u958b\u304f`,exact:true}).click();
 await page.getByRole('button',{name:title,exact:true}).click();await page.getByRole('heading',{name:title,exact:true}).waitFor();
 await page.waitForFunction(({key,id})=>JSON.parse(localStorage.getItem(key)!).documentId===id,{key,id});
 assert.deepEqual(await selectedMarkdownRows(page,id,namespace),{root:saved.root,edits:saved.edits,intents:saved.intents});assert.deepEqual(await catalog(page,namespace,libraryId),beforeCatalog);
 const catalogToggle=page.getByRole('button',{name:'\u8cc7\u6599\u4e00\u89a7',exact:true});if(await catalogToggle.getAttribute('aria-expanded')!=='true')await catalogToggle.click();
 await page.getByLabel(`\u300c${title}\u300d\u3092\u524a\u9664`,{exact:true}).click();await page.getByRole('button',{name:'\u524a\u9664\u3092\u78ba\u5b9a',exact:true}).click();
 const deadline=Date.now()+30000;let deleted=await catalog(page,namespace,libraryId);while(deleted.intents || deleted.edits.some(edit=>!edit.receipt.durable || !edit.history) || !deleted.snapshot.deletions.some(record=>record.active&&record.itemIds.includes(id))){assert.ok(Date.now()<deadline);await delay(50);deleted=await catalog(page,namespace,libraryId);}
 await page.evaluate(({key,id,folderId})=>localStorage.setItem(key,JSON.stringify({version:1,documentId:id,folderId})),{key,id,folderId});
 page=await app.restartLibrary({showCatalog:true});await page.getByText('\u8cc7\u6599\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-content-document]').count(),0);assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)!).documentId,key),id);
 assert.deepEqual(await catalog(page,namespace,libraryId),deleted);assert.deepEqual(await selectedMarkdownRows(page,id,namespace),{root:saved.root,edits:saved.edits,intents:saved.intents});
 t.diagnostic(JSON.stringify({sameScopeColdRestart:true,exactCatalogAndBodyNoWrites:true,otherScopeCacheIgnored:true,delayedRealReadExplicitSelectionWins:true,missingTargetNotOpened:true,deletedTargetNotOpened:true,explicitSelectionRecovers:true}));
});

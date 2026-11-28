import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { EditGraph } from '../../../src/runtime/edits/editGraph.ts';
import type { Snapshot } from '../../../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../../../src/runtime/edits/repository.ts';
import { projectCanonicalAnnotations,filterCanonicalAnnotations,freezeAnnotationExport } from '../../../src/features/library/annotations/canonicalAnnotationBrowser.ts';
/** Read only physical storage; never obtains application bindings or write authority. */
async function stored(page: Page, id: string) {
  const rows = await page.evaluate(async id => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('papeer-shared-edits');
      opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('existing database required')); };
      opening.onerror = () => reject(opening.error); opening.onsuccess = () => resolve(opening.result);
    });
    try {
      return await new Promise<{ root: Snapshot; edits: StoredEdit[]; namespace: string }>((resolve, reject) => {
        const tx = db.transaction(['roots', 'edits'], 'readonly');
        const roots = tx.objectStore('roots').getAll(), edits = tx.objectStore('edits').getAll();
        tx.onabort = () => reject(tx.error);
        tx.oncomplete = () => {
          const root = roots.result.find((row: { value: Snapshot }) => row.value.id === id);
          if (!root) { reject(new Error('UI-created root missing')); return; }
          resolve({ root: root.value, namespace: root.scope, edits: edits.result.filter((row: { scope: string; value: StoredEdit }) =>
            row.scope === root.scope && row.value.batch.targetId === id).map((row: { value: StoredEdit }) => row.value) });
        };
      });
    } finally { db.close(); }
  }, id);
  const graph = new EditGraph({ version: 1, libraryId: JSON.parse(rows.namespace)[1], root: rows.root, batches: rows.edits.map(row => row.batch) });
  const view = graph.getView(); assert.equal(view.heads.length, 1);
  return { ...rows, snapshot: graph.snapshot(view.heads[0])! };
}
async function markdown(page: Page, id: string, count: number) {
  const until = Date.now() + 30_000;
  for (;;) {
    const value = await stored(page, id);
    if (value.snapshot.kind === 'markdown' && value.snapshot.appendIds.length === count && value.edits.every(edit => edit.receipt.durable)) return value;
    assert.ok(Date.now() < until, 'append did not become durable'); await delay(50);
  }
}


// Candidate lives in checkpoint; promote to e2e/tests/reader/p2 before typechecking or running.
const panel = (p: Page) => p.getByRole('region', { name: '\u4ed8\u7b8b\u30fb\u30cf\u30a4\u30e9\u30a4\u30c8\u4e00\u89a7', exact: true });
async function catalog(p: Page, open: boolean) {
  const toggle=p.getByRole('button',{name:'\u8cc7\u6599\u4e00\u89a7',exact:true});
  if ((await toggle.getAttribute('aria-expanded')==='true')!==open) await toggle.click();
}
async function sticky(p: Page, text: string, label: string, y = 140) {
  const documentId = await p.locator('[data-content-document]').getAttribute('data-content-document');
  assert.ok(documentId);
  await p.getByRole('button',{name:'\u4ed8\u7b8b\u3092\u8cbc\u308b',exact:true}).click();
  await p.getByLabel('\u6ce8\u91c8\u306e\u914d\u7f6e\u3068\u9078\u629e',{exact:true}).click({position:{x:100,y}});
  const form=p.getByRole('region',{name:'\u6ce8\u91c8\u3092\u7de8\u96c6',exact:true});
  await form.getByRole('textbox',{name:'\u4ed8\u7b8b\u306e\u30e1\u30e2',exact:true}).fill(text);
  await form.getByLabel('\u6ce8\u91c8\u306e\u5206\u985e',{exact:true}).fill(label);
  await form.getByRole('button',{name:'\u78ba\u5b9a',exact:true}).click();
  await form.waitFor({ state: 'hidden' });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const observed = await stored(p, documentId);
    const saved = observed.snapshot.kind === 'document' && observed.snapshot.pages.some(page =>
      page.annotations.some(annotation => annotation.kind === 'sticky' && annotation.text === text && annotation.metadata.label === label));
    if (saved && observed.edits.every(edit => edit.receipt.durable)) break;
    assert.ok(Date.now() < deadline, 'sticky annotation did not become durable');
    await delay(50);
  }
  await p.getByRole('status').filter({hasText:/^\u7aef\u672b\u4fdd\u5b58\u6e08\u307f/}).first().waitFor();
}
async function expand(p: Page) {
  const toggle=panel(p).getByRole('button',{name:/^\u4ed8\u7b8b\u30fb\u30cf\u30a4\u30e9\u30a4\u30c8\u4e00\u89a7/});
  if (await toggle.getAttribute('aria-expanded')!=='true') await toggle.click();
}
async function mapPdf(page: Page, file: string, destinations: [string, string]) {
  const choosing = page.waitForEvent('filechooser');
  await page.getByLabel('取り込む訳文PDF', { exact: true }).click();
  await (await choosing).setFiles(file);
  for (const [index, value] of destinations.entries())
    await page.getByLabel(`訳文${index + 1}ページに対応する原文ページ`, { exact: true }).selectOption(value);
  const region = page.getByRole('region', { name: '訳文PDFの取込', exact: true });
  await region.getByRole('button', { name: /訳文PDFを(?:登録する|入れ替える)/ }).click();
}

for (const engine of ['chromium','webkit'] as const) test(`ordinary annotation browser two documents and filtered append (${engine})`,{timeout:300_000},async t=>{
  const app=await ordinaryWeb(t,engine);const p=app.page;let phase='note';
  try {
    const note=`Annotation destination ${engine}`;
    await p.getByLabel('\u65b0\u3057\u3044\u8cc7\u6599\u306e\u540d\u524d',{exact:true}).fill(note);
    await p.getByLabel('\u8cc7\u6599\u306e\u7a2e\u985e',{exact:true}).selectOption('markdown');
    await p.getByRole('button',{name:'\u8cc7\u6599\u3092\u4f5c\u6210',exact:true}).click();
    await p.getByRole('textbox',{name:'Markdown\u30ce\u30fc\u30c8',exact:true}).waitFor();
    const noteId=await p.locator('[data-content-document]').getAttribute('data-content-document');assert.ok(noteId);
    const root=path.resolve(import.meta.dirname,'../../../..');
    const pdf=path.join(app.scratch,'annotations.pdf');
    const generated=spawnSync(path.join(root,'.venv/Scripts/python.exe'),[path.join(root,'frontend/e2e/fixtures/p2PdfNavigation.py'),pdf],{encoding:'utf8',windowsHide:true});assert.equal(generated.status,0,generated.stderr);
    phase='first-document'; await catalog(p,true);
    await p.getByLabel('\u53d6\u308a\u8fbc\u3080PDF',{exact:true}).setInputFiles(pdf);
    await p.getByRole('heading',{name:'annotations.pdf',exact:true}).waitFor();
    const first=await p.locator('[data-content-document]').getAttribute('data-content-document');assert.ok(first);
    await catalog(p,false);await p.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="1"] canvas').waitFor();
    await sticky(p,'alpha common first','group-a');
    phase='second-document';await catalog(p,true);
    // Same source bytes through a distinct filename and ordinary import creates a distinct document.
    const secondPdf=path.join(app.scratch,'annotations-second.pdf');
    const generatedSecond=spawnSync(path.join(root,'.venv/Scripts/python.exe'),[path.join(root,'frontend/e2e/fixtures/p2PdfNavigation.py'),secondPdf],{encoding:'utf8',windowsHide:true});assert.equal(generatedSecond.status,0,generatedSecond.stderr);
    await p.getByLabel('\u53d6\u308a\u8fbc\u3080PDF',{exact:true}).setInputFiles(secondPdf);
    await p.getByRole('heading',{name:'annotations-second.pdf',exact:true}).waitFor();
    const second=await p.locator('[data-content-document]').getAttribute('data-content-document');assert.ok(second);assert.notEqual(first,second);
    await catalog(p,false);await p.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="1"] canvas').waitFor();
    await sticky(p,'beta common second','group-b');
    for(let i=0;i<6;i++) await sticky(p,`extra ${i}`,'group-b',180+i*30);
    phase='filters';await expand(p);
    const scrollBox=panel(p).getByLabel('\u6ce8\u91c8\u306e\u691c\u7d22\u7d50\u679c',{exact:true});
    await scrollBox.locator('li').filter({hasText:'extra 5'}).waitFor();
    await scrollBox.evaluate(e=>{e.scrollTop=e.scrollHeight; e.dispatchEvent(new Event('scroll'));});
    const scrollBefore=await scrollBox.evaluate(e=>e.scrollTop);assert.ok(scrollBefore>0);
    const toggle=panel(p).getByRole('button',{name:/^\u4ed8\u7b8b\u30fb\u30cf\u30a4\u30e9\u30a4\u30c8\u4e00\u89a7/});await toggle.click();await toggle.click();
    assert.ok(Math.abs((await scrollBox.evaluate(e=>e.scrollTop))-scrollBefore)<8,'scroll position restored');const list=panel(p).getByLabel('\u6ce8\u91c8\u306e\u691c\u7d22\u7d50\u679c',{exact:true});
    await panel(p).getByLabel('\u5bfe\u8c61',{exact:true}).selectOption('all');
    await list.locator('li').filter({hasText:'alpha common first'}).waitFor();await list.locator('li').filter({hasText:'beta common second'}).waitFor();
    await panel(p).getByLabel('\u5bfe\u8c61',{exact:true}).selectOption('current');
    assert.equal(await list.locator('li').filter({hasText:'alpha common first'}).count(),0);await list.locator('li').filter({hasText:'beta common second'}).waitFor();
    await panel(p).getByLabel('\u5bfe\u8c61',{exact:true}).selectOption('all');
    await panel(p).getByPlaceholder('\u8907\u6570\u306e\u8a9e\u3092\u7a7a\u767d\u3067\u533a\u5207\u308b').fill('alpha common');
    await panel(p).getByPlaceholder('\u5206\u985e\u540d\u3068\u5b8c\u5168\u4e00\u81f4').fill('group-a');
    await panel(p).getByLabel('\u7a2e\u985e',{exact:true}).selectOption('sticky');
    await panel(p).getByLabel('\u539f\u8a33',{exact:true}).selectOption('original');
    await list.locator('li').filter({hasText:'alpha common first'}).waitFor();assert.equal(await list.locator('li').count(),1);
    const firstState=await stored(p,first); assert.equal(firstState.snapshot.kind,'document'); if(firstState.snapshot.kind!=='document') throw new Error('document required');
    const rows=projectCanonicalAnnotations([{libraryId:JSON.parse(firstState.namespace)[1],title:'annotations.pdf',document:firstState.snapshot}]);
    const expected=freezeAnnotationExport(filterCanonicalAnnotations(rows,{query:'alpha common',label:'group-a',kind:'sticky',surface:'original'})); assert.equal(expected.rows.length,1);
    const beforeNote=await markdown(p,noteId,0);
    phase='append';await panel(p).getByRole('button',{name:'\u7d5e\u8fbc\u7d50\u679c\u3092\u30ce\u30fc\u30c8\u3078\u8ffd\u8a18',exact:true}).click();
    const dialog=p.getByRole('dialog',{name:'\u5f15\u7528\u3092\u30ce\u30fc\u30c8\u3078\u8ffd\u52a0',exact:true});
    await dialog.getByLabel('\u8ffd\u52a0\u5148\u306e\u30ce\u30fc\u30c8',{exact:true}).selectOption(noteId);
    await dialog.getByRole('button',{name:'\u30ce\u30fc\u30c8\u3078\u8ffd\u52a0',exact:true}).click();
    await dialog.getByRole('status').filter({hasText:'\u30ce\u30fc\u30c8\u306b\u8ffd\u52a0\u3057\u307e\u3057\u305f'}).waitFor();
    await dialog.getByRole('button',{name:'\u9589\u3058\u308b',exact:true}).click();
    const appended=await markdown(p,noteId,1);assert.equal(appended.snapshot.kind,'markdown');if(appended.snapshot.kind!=='markdown') throw new Error('markdown required');
    assert.equal(appended.edits.length,beforeNote.edits.length+1);const expectedContent=beforeNote.snapshot.kind==='markdown' ? beforeNote.snapshot.content+'\n\n'+expected.markdown : (()=>{throw new Error('markdown required')})();assert.equal(appended.snapshot.content,expectedContent);assert.equal(createHash('sha256').update(appended.snapshot.content).digest('hex'),createHash('sha256').update(expectedContent).digest('hex'));
    const inserted=appended.edits.filter(e=>e.batch.kind==='markdown'&&e.batch.appendId);assert.equal(inserted.length,1);assert.equal(inserted[0].receipt.durable,true);
    phase='location';await expand(p);const target=list.locator('li').filter({hasText:'alpha common first'});
    await target.getByRole('button',{name:'\u5834\u6240\u3078\u79fb\u52d5',exact:true}).click();
    await p.getByRole('heading',{name:'annotations.pdf',exact:true}).waitFor();
    assert.equal(await p.locator('[data-content-document]').getAttribute('data-content-document'),first);
    const row=expected.rows[0]; await p.locator(`[data-reader-surface="original"] [data-canonical-page="${row.pageId}"][data-background-revision="${row.backgroundRevision}"]`).waitFor();
    const landed=p.locator(`[data-reader-surface="original"] [data-annotation-id="${row.annotationId}"]`);await landed.waitFor();const box=await landed.boundingBox();assert.ok(box&&box.y>=0&&box.y<(p.viewportSize()?.height??0),'annotation anchor is visible after landing');
    await catalog(p,true);await p.getByRole('button',{name:note,exact:true}).click();await p.getByRole('textbox',{name:'Markdown\u30ce\u30fc\u30c8',exact:true}).waitFor();
    await p.getByRole('button',{name:'\u5143\u306b\u623b\u3059',exact:true}).click();
    const deadline=Date.now()+30000;for(;;){const v=await stored(p,noteId);if(v.snapshot.kind==='markdown'&&!v.snapshot.content.includes('alpha common first'))break;assert.ok(Date.now()<deadline);await delay(50);}
    const reopened=await app.restart(note);const after=await stored(reopened,noteId);assert.equal(after.snapshot.kind,'markdown');if(after.snapshot.kind!=='markdown')throw new Error('markdown required');assert.ok(!after.snapshot.content.includes('alpha common first'));assert.equal(after.edits.filter(e=>e.batch.kind==='markdown'&&e.batch.appendId).length,1);
  } catch(error){
    t.diagnostic(JSON.stringify({ phase, current: await p.locator('[data-content-document]').getAttribute('data-content-document').catch(() => null),
      alerts: await p.locator('[role="alert"]').allTextContents().catch(() => []),
      statuses: await p.locator('[role="status"]').allTextContents().catch(() => []) }));
    throw new Error(`annotation ordinary phase ${phase}: ${String(error)}`);
  }
});
for (const engine of ['chromium','webkit'] as const) test(`ordinary translated annotation surface and type filters (${engine})`,{timeout:300_000},async t=>{
  const app=await ordinaryWeb(t,engine);const p=app.page;const root=path.resolve(import.meta.dirname,'../../../..');
  const original=path.join(app.scratch,'annotation-original.pdf'),translated=path.join(app.scratch,'annotation-translated.pdf');
  for(const file of [original,translated]) {const g=spawnSync(path.join(root,'.venv/Scripts/python.exe'),[path.join(root,'frontend/e2e/fixtures/p2PdfNavigation.py'),file],{encoding:'utf8',windowsHide:true});assert.equal(g.status,0,g.stderr);}
  await p.getByLabel('\u53d6\u308a\u8fbc\u3080PDF',{exact:true}).setInputFiles(original);await p.getByRole('heading',{name:'annotation-original.pdf',exact:true}).waitFor();
  const id=await p.locator('[data-content-document]').getAttribute('data-content-document');assert.ok(id);
  await catalog(p,false);await p.locator('[data-reader-surface="original"] [data-rendered="true"] canvas').first().waitFor();
  await sticky(p,'original surface','origin');
  const initial=await stored(p,id);assert.equal(initial.snapshot.kind,'document');if(initial.snapshot.kind!=='document')throw new Error('document required');
  await mapPdf(p,translated,[initial.snapshot.pages[0].id,initial.snapshot.pages[1].id]);
  await p.getByRole('button',{name:'\u8aad\u3080',exact:true}).click();
  await p.getByRole('button',{name:'\u8a33\u6587',exact:true}).click();
  const translatedPane=p.locator('[data-reader-surface="translated"]');await translatedPane.locator('[data-rendered="true"] canvas').first().waitFor();
  const layer=translatedPane.locator('.react-pdf__Page[data-page-number="1"] .textLayer[tabindex="0"]');await layer.locator('span[role="presentation"]').first().waitFor();await layer.focus();await p.keyboard.press('Enter');
  const live=p.locator('[data-managed-pdf-selection-overlay] [aria-live="polite"]');await live.filter({hasText:'\u672c\u6587\u306e\u9078\u629e\u64cd\u4f5c\u3092\u958b\u59cb\u3057\u307e\u3057\u305f'}).waitFor({state:'attached'});
  for(let i=0;i<8;i++)await p.keyboard.press('Shift+ArrowRight');await live.filter({hasText:/^8\u6587\u5b57\u3092\u9078\u629e\u3057\u307e\u3057\u305f/}).waitFor({state:'attached'});
  await p.getByRole('button',{name:'\u9078\u629e\u3057\u305f\u6587\u7ae0\u3092\u30cf\u30a4\u30e9\u30a4\u30c8',exact:true}).click();
  const form=p.getByRole('region',{name:'\u6ce8\u91c8\u3092\u7de8\u96c6',exact:true});await form.getByRole('textbox',{name:'\u672c\u6587\u30cf\u30a4\u30e9\u30a4\u30c8\u306e\u30b3\u30e1\u30f3\u30c8',exact:true}).fill('translated highlight');await form.getByLabel('\u6ce8\u91c8\u306e\u5206\u985e',{exact:true}).fill('translated-group');await form.getByRole('button',{name:'\u78ba\u5b9a',exact:true}).click();
  await p.getByRole('status').filter({hasText:/^\u7aef\u672b\u4fdd\u5b58\u6e08\u307f/}).first().waitFor();await expand(p);
  const list=panel(p).getByLabel('\u6ce8\u91c8\u306e\u691c\u7d22\u7d50\u679c',{exact:true});await panel(p).getByLabel('\u539f\u8a33',{exact:true}).selectOption('translated');await panel(p).getByLabel('\u7a2e\u985e',{exact:true}).selectOption('highlight');
  await list.locator('li').filter({hasText:'translated highlight'}).waitFor();assert.equal(await list.locator('li').count(),1);
  await panel(p).getByLabel('\u539f\u8a33',{exact:true}).selectOption('original');await panel(p).getByLabel('\u7a2e\u985e',{exact:true}).selectOption('sticky');
  await list.locator('li').filter({hasText:'original surface'}).waitFor();assert.equal(await list.locator('li').count(),1);
  const persisted=await stored(p,id);assert.equal(persisted.snapshot.kind,'document');if(persisted.snapshot.kind!=='document')throw new Error('document required');
  assert.ok(persisted.snapshot.translation?.pages.some(page=>page.annotations.some(a=>a.kind==='highlight'&&a.text==='translated highlight')));
  assert.ok(persisted.snapshot.pages.some(page=>page.annotations.some(a=>a.kind==='sticky'&&a.text==='original surface')));assert.ok(persisted.edits.every(e=>e.receipt.durable));
});

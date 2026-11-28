import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderOrdinaryFixture } from '../../../fixtures/provider/providerOrdinary.tsx';

import { createCompositionDrive, installBrowserDriveBoundary } from '../../../support/provider/fakeDrive.ts';

const frontend = path.resolve(import.meta.dirname, '../../../..');
for (const engine of ['chromium','webkit'] as const) test(`ordinary provider chooser, retained unknown create, foreign-owner JOIN and two-host Markdown sync (${engine})`, {timeout: 120000}, async t => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'papeer-provider-ordinary-'));
  const server = await createServer({ root: frontend, configFile: path.join(frontend,'vite.config.ts'), cacheDir, logLevel: 'error',
    optimizeDeps: {entries:['e2e/fixtures/provider/providerOrdinary.html']}, server: {host:'127.0.0.1',port:0,strictPort:false,hmr:false} });
  await server.listen();
  t.after(async () => {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
  const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const browser = engine === 'chromium' ? await chromium.launch({channel:'msedge',headless:true}) : await webkit.launch({headless:true});
  t.after(() => browser.close()); const drive = createCompositionDrive({uncertainDescriptor:true}), errors: string[] = [];
  const first = await browser.newContext({viewport:{width:1000,height:680}}), second = await browser.newContext({viewport:{width:1000,height:680}});
  await installBrowserDriveBoundary(first,drive,'first'); await installBrowserDriveBoundary(second,drive,'second');
  const a = await first.newPage(), b = await second.newPage(), local = await first.newPage();
  for (const page of [a,b,local]) { page.on('pageerror',e=>errors.push(String(e))); page.on('console',m=>{if(m.type()==='error')errors.push(m.text());}); }
  const url = `http://127.0.0.1:${address.port}/e2e/fixtures/provider/providerOrdinary.html`;
  const until = async (condition: () => Promise<boolean>) => {
    const deadline = Date.now() + 30000; while (!await condition()) {
      if (Date.now() > deadline) {
        const state = await b.evaluate(()=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.status());
        throw new Error('ordinary-condition-timeout:' + JSON.stringify({state,calls:drive.calls}));
      }
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  };
  const read = (page: typeof a) => page.evaluate(() => (window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.snapshot());
  await local.goto(url,{waitUntil:'domcontentloaded'});
  await local.getByRole('button',{name:'この端末で使い始める',exact:true}).click();
  await local.getByLabel('新しいライブラリの名前',{exact:true}).fill('Unchanged local Library');
  await local.getByRole('button',{name:'作成',exact:true}).click();
  await local.getByRole('button',{name:'確認しました',exact:true}).click();
  await local.getByRole('button',{name:'Unchanged local Library',exact:true}).click();
  await until(async ()=>(await read(local)).phase==='ready');
  const localBefore = (await read(local)).active;
  assert.equal((await read(local)).kind,'local');
  assert.equal(await local.evaluate(async ()=>(await indexedDB.databases()).find(db=>db.name==='papeer-shared-edits')?.version),8);
  assert.equal(await local.evaluate(()=>(window as unknown as {fixtureGesture?:boolean}).fixtureGesture),undefined);
  for (const page of [a,b]) {
    await page.goto(url,{waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:'Google Driveを使う',exact:true}).click();
    const connect = page.getByRole('button',{name:'Googleに接続',exact:true}); await connect.waitFor();
    await page.waitForFunction(() => !(document.querySelector('button')?.disabled) && !!(window as unknown as {providerOrdinary?:unknown}).providerOrdinary);
    await connect.click();
    await page.getByLabel('新しいクラウドライブラリの名前').waitFor();
    assert.equal(await page.evaluate(()=>(window as unknown as {fixtureGesture:boolean}).fixtureGesture),true);
  }
  await a.getByLabel('新しいクラウドライブラリの名前').fill('😀'.repeat(201));
  await a.getByRole('button',{name:'クラウドライブラリを作成',exact:true}).click();
  assert.equal((await read(a)).provider!.request,null); assert.equal((await read(a)).provider!.pendingGuard,false);
  await a.getByLabel('新しいクラウドライブラリの名前').fill('Same human cloud title');
  await a.getByRole('button',{name:'クラウドライブラリを作成',exact:true}).click();
  await until(async ()=>(await read(a)).provider?.request?.status==='unknown');
  const unknown = (await read(a)).provider!.request!;
  assert.equal(drive.files.size,4); assert.equal(unknown.action,'create');
  await a.getByRole('button',{name:'保存状況を再確認',exact:true}).click();
  await until(async ()=>(await read(a)).phase==='ready');
  const accepted = await read(a); assert.equal(accepted.provider!.request!.requestId,unknown.requestId); assert.equal(accepted.kind,'google-drive');
  assert.equal(drive.files.size,4); // No replacement physical Library on the uncertain retry.
  await b.getByRole('button',{name:'Driveの一覧を更新',exact:true}).click();
  await b.getByRole('button',{name:'Same human cloud title',exact:true}).click();
  await until(async ()=>(await read(b)).phase==='ready');
  assert.deepEqual((await read(b)).active!.scope,accepted.active!.scope);
  const secondOwnerNamespace = await b.evaluate(() => new Promise<string>((resolve,reject) => {
    const opening = indexedDB.open('papeer-shared-cloud-v1');
    opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('existing-cloud-owner-required')); };
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => { const db=opening.result, tx=db.transaction('canonicalLocalGrant','readonly'), row=tx.objectStore('canonicalLocalGrant').get('primary-local-context');
      tx.oncomplete=()=>{db.close();resolve(row.result.value.namespaceId);};tx.onabort=()=>{db.close();reject(tx.error);}; };
  }));
  assert.notEqual(secondOwnerNamespace,accepted.active!.scope.accountId);
  assert.equal(await b.evaluate(async ()=>(await indexedDB.databases()).some(db=>db.name==='papeer-shared-edits')),false);
  const note = await a.evaluate(()=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.createMarkdown('Shared note','Saved A'));
  // Wait until any overlapping timer sync finishes on A/B and B observes A's initial upload.
  await until(async () => {
    await a.evaluate(()=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.sync());
    await b.evaluate(()=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.sync());
    return (await b.evaluate(id=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.body(id).then(s=>s?.content),note))==='Saved A';
  });
  assert.equal(await b.evaluate(id=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.body(id).then(s=>s?.content),note),'Saved A');
  await b.evaluate(id=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.editMarkdown(id,'Saved AB'),note);
  const observe = (page: typeof a, receiptId?: string) => page.evaluate(({id,receiptId}) =>
    (window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.observeMarkdown(id,receiptId), {id:note,receiptId});
  const savedB = await observe(b), batchId = savedB.state.accepted!.version;
  assert.equal(savedB.state.accepted!.content,'Saved AB'); assert.equal(savedB.state.durable,true);
  assert.equal(savedB.state.dirty,false); assert.equal(savedB.state.saving,false); assert.equal(savedB.state.error,'');
  assert.equal(savedB.receipt?.id,batchId); assert.equal(savedB.receipt?.targetId,note); assert.equal(savedB.receipt?.durable,true);
  const remoteBatches = () => [...drive.files.values()].flatMap(file => {
    try { const envelope = JSON.parse(file.body) as {kind?:string;record?:{batch?:{id?:string}}};
      return envelope.kind==='edit-record' && envelope.record?.batch?.id===batchId ? [{providerId:file.id,record:envelope.record}] : [];
    } catch { return []; }
  });
  console.log(JSON.stringify({diagnostic:'AB-durable-before-receive',engine,batchId,source:savedB,remote:remoteBatches(),posts:[...drive.posts]}));
  await a.evaluate(()=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.sync());
  console.log(JSON.stringify({diagnostic:'AB-after-one-receive-flush',engine,batchId,destination:await observe(a,batchId),remote:remoteBatches(),posts:[...drive.posts]}));
  // flush joins an already running timer pass. Observe this exact durable batch's
  // upload/import and refreshed projection; a stale pass is not a delivery barrier.
  await until(async () => {
    const source = await observe(b,batchId);
    if (source.receipt?.upload!=='accepted' || source.pending.some(record=>record.batch.id===batchId)) {
      await b.evaluate(()=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.sync()); return false;
    }
    await a.evaluate(()=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.sync());
    const destination = await observe(a,batchId);
    return destination.refreshed && destination.state.accepted?.version===batchId
      && destination.state.accepted.content==='Saved AB' && destination.receipt?.id===batchId && destination.receipt.durable;
  });
  const finalB = await observe(b,batchId), finalA = await observe(a,batchId);
  assert.equal(finalB.receipt!.upload,'accepted'); assert.equal(finalB.pending.some(record=>record.batch.id===batchId),false);
  assert.equal(remoteBatches().length,1);
  const savedBatch = finalB.read.checkpoint.batches.find(batch=>batch.id===batchId)!; assert.ok(savedBatch);
  assert.deepEqual(finalA.read.checkpoint.batches.find(batch=>batch.id===batchId),savedBatch);
  assert.deepEqual(remoteBatches()[0].record.batch,savedBatch);
  assert.deepEqual(finalA.read.heads,[batchId]); assert.equal(finalA.refreshed,true);
  assert.equal(finalA.state.accepted!.version,batchId); assert.equal(finalA.state.accepted!.content,'Saved AB');
  console.log(JSON.stringify({diagnostic:'AB-exact-durable-delivery-observed',engine,batchId,source:finalB,destination:finalA,remote:remoteBatches(),posts:[...drive.posts]}));
  assert.equal(await a.evaluate(id=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.body(id).then(s=>s?.content),note),'Saved AB');
  await a.evaluate(()=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.pauseSync());
  await b.evaluate(()=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.createMarkdown('Queued remote arrival','Remote B'));
  await b.evaluate(()=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.pauseSync());
  await a.evaluate(id=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.editMarkdownNoSync(id,'Retained ABC'),note);
  const beforeCancel = (await read(a)).active!, canceled = drive.holdPull('first');
  const canceledSync = a.evaluate(()=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.resumeSync().then(()=>false,()=>true));
  await canceled.reached; const cancellationPosts = drive.posts.length;
  await Promise.race([a.evaluate(()=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.pauseSync()),
    new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error('owned-sync-cancel-did-not-drain')),5000))]);
  assert.equal(await canceledSync,true); canceled.release();
  assert.equal(drive.posts.length,cancellationPosts);
  assert.deepEqual((await read(a)).active,beforeCancel); // No old-scope import; exact durable outbox remains.
  const held = drive.holdPull('first'), blockedSync = a.evaluate(()=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.resumeSync().then(()=>false,()=>true));
  await held.reached;
  const selectedDescriptor = [...drive.files.values()].find(file=>file.properties?.providerKind==='descriptor')!;
  selectedDescriptor.ownedByMe = false; const postsBeforeDenial = drive.posts.length; held.release();
  assert.equal(await blockedSync,true);
  await until(async ()=>(await read(a)).phase==='recovery-required');
  assert.equal(drive.posts.length,postsBeforeDenial); // No next import receipt or outbound edit after observed denial.
  selectedDescriptor.ownedByMe = true;
  // Same account and exact retained scope restore the same editor/outbox; no replacement Library.
  await a.getByRole('button',{name:'Googleに接続',exact:true}).click();
  await until(async ()=>(await read(a)).phase==='ready');
  await a.evaluate(()=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.sync());
  assert.equal(await a.evaluate(id=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.body(id).then(s=>s?.content),note),'Retained ABC');
  await b.getByRole('button',{name:'ライブラリを切り替える',exact:true}).click();
  await b.getByRole('button',{name:'この端末で使い始める',exact:true}).waitFor();
  assert.equal(await b.evaluate(async ()=>(await indexedDB.databases()).some(db=>db.name==='papeer-shared-edits')),false);
  assert.deepEqual((await read(local)).active,localBefore);
  assert.equal(await local.evaluate(async ()=>(await indexedDB.databases()).find(db=>db.name==='papeer-shared-edits')?.version),8);
  for (const page of [a,b,local]) assert.equal((await page.evaluate(()=>(window as unknown as {providerOrdinary:ProviderOrdinaryFixture}).providerOrdinary.close())).status,'allowed');
  assert.deepEqual(errors,[]);
});

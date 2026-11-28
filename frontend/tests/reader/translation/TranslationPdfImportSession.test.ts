import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { TranslationPdfImportSession } from '../../../src/features/reader/translation/TranslationPdfImportSession.ts';
import { DocumentEditSession } from '../../../src/features/reader/edit/DocumentEditSession.ts';
import { DurableEditRepository } from '../../../src/runtime/edits/repository.ts';
import { resourceHash } from '../../../src/runtime/edits/contentPublication.ts';
import { EditMemoryDatabase } from '../../support/editMemoryDatabase.ts';
import type { DocumentSnapshot } from '../../../src/runtime/edits/contracts.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../../tests/fixtures/shared-edits.json',import.meta.url),'utf8'));
const bytes=Uint8Array.from([37,80,68,70,45,49,46,55]);
async function setup() {
 const root=structuredClone(fixture.document) as DocumentSnapshot;
 const originalBytes=Uint8Array.from([37,80,68,70,45,48]), resourceId=crypto.randomUUID(), hash=await resourceHash(originalBytes);
 root.pages[0].background={kind:'pdf',resourceId,sourceRevision:hash,pdfPage:1};
 const repo=new DurableEditRepository({accountId:'translation-fixture',libraryId:fixture.libraryId,epoch:'one'},new EditMemoryDatabase(),{inspectPdf:async input=>input.length===originalBytes.length?[{widthPt:root.pages[0].widthPt,heightPt:root.pages[0].heightPt}]:[{widthPt:300,heightPt:400},{widthPt:400,heightPt:300}]});
 await repo.storeResource({id:resourceId,sha256:hash,mediaType:'application/pdf',bytes:originalBytes}); await repo.initialize(root);const document=new DocumentEditSession(repo,root.id);assert.equal(await document.refresh(),true);
 let active=true,blocked=false;const session=new TranslationPdfImportSession({repository:repo,document,active:()=>active,inputBlocked:()=>blocked,makeId:()=>crypto.randomUUID()});
 return {root,repo,document,session,setActive:(value:boolean)=>{active=value;},setBlocked:(value:boolean)=>{blocked=value;}};
}
test('requires explicit mappings, imports all pages and replacement can be undone',async()=>{
 const f=await setup();assert.equal(await f.session.stage(async()=>bytes),true);const ready=f.session.getSnapshot();
 assert.deepEqual(ready.originalPages,[{pageId:f.root.pages[0].id,pageNumber:1}]);assert.equal(ready.pages.length,2);assert.equal(f.session.canLeave(),false);
 assert.equal((await f.session.submit()).status,'refused');assert.equal(f.session.setMapping(0,f.root.pages[0].id),true);assert.equal(f.session.setMapping(1,null),true);
 assert.equal((await f.session.submit()).status,'applied');assert.equal(f.session.canLeave(),true);const first=structuredClone(f.document.getSnapshot().document!.translation!);
 assert.equal(first.pages.length,2);assert.equal(first.bindings.length,1);assert.equal(first.bindings[0].candidates[0].pageId,first.pages[0].id);
 const token=Symbol('translated');assert.equal(f.document.claimPage(first.pages[0].id,token),true);
 assert.equal((await f.document.editPage(first.pages[0].id,token,[structuredClone(fixture.batches[0].changes[0])])).status,'applied');
 const annotated=structuredClone(f.document.getSnapshot().document!.translation!);
 assert.equal(await f.session.stage(async()=>bytes),true);assert.equal(f.session.getSnapshot().replacing,true);assert.equal(f.session.setMapping(0,null),true);assert.equal(f.session.setMapping(1,f.root.pages[0].id),true);
 assert.equal((await f.session.submit()).status,'applied');const replaced=f.document.getSnapshot().document!;assert.ok(first.pages.every(page=>replaced.deletedPages.some(dead=>dead.id===page.id)));
 assert.equal((await f.document.undo()).status,'applied');const restored=f.document.getSnapshot().document!.translation!;assert.deepEqual(restored.pages.map(page=>page.id),first.pages.map(page=>page.id));assert.deepEqual(restored.pages[0].annotations,annotated.pages[0].annotations);
});
test('resource failures retry with the same immutable bytes and resource id',async()=>{
 const f=await setup();const real=f.repo.storeResource.bind(f.repo), attempts: string[]=[];let fail=true;
 f.repo.storeResource=async input=>{attempts.push(input.id);if(fail){fail=false;throw new Error('offline');}return real(input);};let reads=0;
 assert.equal(await f.session.stage(async()=>{reads++;return bytes;}),false);assert.equal(f.session.getSnapshot().phase,'error');assert.equal(f.session.canLeave(),false);
 assert.equal(await f.session.retry(),true);assert.equal(reads,1);assert.equal(attempts[0],attempts[1]);
});
test('cancelled delayed read cannot publish or revive the session',async()=>{
 const f=await setup();let release!:(value:Uint8Array)=>void;const slow=new Promise<Uint8Array>(resolve=>{release=resolve;});const pending=f.session.stage(()=>slow);
 assert.equal(f.session.cancel(),true);release(bytes);assert.equal(await pending,false);assert.equal(f.session.getSnapshot().phase,'idle');assert.equal(f.session.canLeave(),true);
});
test('refuses paper mapping, live input and changed document version',async()=>{
 const f=await setup();assert.equal(await f.session.stage(async()=>bytes),true);assert.equal(f.session.setMapping(0,f.root.pages[1].id),false);f.setBlocked(true);
 assert.equal((await f.session.submit()).status,'refused');f.setBlocked(false);assert.equal(f.session.setMapping(0,null),true);assert.equal(f.session.setMapping(1,null),true);
 const current=f.document.getSnapshot().document!;const page=current.pages[1];assert.equal((await f.document.editDocument([{type:'remove',expected:{pageId:page.id,backgroundRevision:page.backgroundRevision,lifecycleVersion:page.lifecycleVersion,annotationVersion:page.annotationVersion}}])).status,'applied');
 assert.equal((await f.session.submit()).status,'refused');assert.equal(f.session.getSnapshot().phase,'ready');
});

test('disposal while storage is in flight never revives a new scope or submits',async()=>{
 const f=await setup();const real=f.repo.storeResource.bind(f.repo);let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;}), started=new Promise<void>(resolve=>{entered=resolve;});
 f.repo.storeResource=async input=>{entered();await waiting;return real(input);};const pending=f.session.stage(async()=>bytes);await started;f.setActive(false);f.session.dispose();release();
 assert.equal(await pending,false);assert.equal(f.document.getSnapshot().document!.translation,undefined);
});

test('reactivation starts a fresh stage while an old read settles harmlessly',async()=>{
 const f=await setup();let release!:(value:Uint8Array)=>void;const slow=new Promise<Uint8Array>(resolve=>{release=resolve;});const old=f.session.stage(()=>slow);
 f.session.dispose();assert.equal(f.session.canLeave(),true);f.session.activate();assert.equal(await f.session.stage(async()=>bytes),true);
 const fixed=f.session.getSnapshot().pages.map(page=>page.pageId);release(bytes);assert.equal(await old,false);assert.deepEqual(f.session.getSnapshot().pages.map(page=>page.pageId),fixed);
});
test('corrupt resource readback fails closed and retries the same staged resource',async()=>{
 const f=await setup(), realRead=f.repo.readResource.bind(f.repo);let corrupt=true;const ids:string[]=[];const realStore=f.repo.storeResource.bind(f.repo);
 f.repo.storeResource=async input=>{ids.push(input.id);return realStore(input);};
 f.repo.readResource=async id=>{const result=await realRead(id);if(!result || !corrupt)return result;corrupt=false;return {...result,bytes:Uint8Array.from(result.bytes,byte=>byte^1)};};
 assert.equal(await f.session.stage(async()=>bytes),false);assert.equal(f.session.getSnapshot().phase,'error');assert.equal(await f.session.retry(),true);assert.equal(ids[0],ids[1]);
});
test('unknown commit hands recovery to the document session instead of retaining an import guard',async()=>{
 const f=await setup();assert.equal(await f.session.stage(async()=>bytes),true);f.session.setMapping(0,null);f.session.setMapping(1,null);
 f.repo.commit=async()=>({status:'unknown',reason:'response-lost'});
 const result=await f.session.submit();assert.equal(result.status,'applied');assert.equal(f.session.canLeave(),true);assert.equal(f.document.getSnapshot().phase,'unknown');assert.equal(f.document.canNavigate(),false);
});
test('one submit owns the guard while the repository head read is pending',async()=>{
 const f=await setup();assert.equal(await f.session.stage(async()=>bytes),true);f.session.setMapping(0,null);f.session.setMapping(1,null);
 const real=f.repo.read.bind(f.repo);let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});let reads=0;
 f.repo.read=async id=>{reads++;entered();await wait;return real(id);};
 const first=f.session.submit();await started;assert.equal(f.session.getSnapshot().phase,'submitting');assert.equal(f.session.canLeave(),false);assert.equal(f.session.cancel(),false);
 const second=await f.session.submit();assert.equal(second.status,'refused');assert.equal(reads,1);assert.equal(f.session.getSnapshot().phase,'submitting');release();assert.equal((await first).status,'applied');
});

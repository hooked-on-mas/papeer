import type { PreparedEditPlan } from '../../src/runtime/edits/repositoryPlan.ts';
// Real same-origin grant and proof; fake owner lease is used only to seed the existing bootstrap fixture.
import golden from '../../../tests/fixtures/shared-edits.json';
import type { DocumentSnapshot } from '../../src/runtime/edits/contracts.ts';
import { LocalHostAuthority, createLocalHostGate } from '../../src/adapters/browser/localHostAuthority.ts';
import { discoverLocalGrant } from '../../src/adapters/browser/ownership/canonicalLocalGrantIndexedDb.ts';
import { createOwnerInitialization } from '../../src/adapters/browser/ownership/browserOwnerInitialization.ts';
import { createBrowserScopePorts } from '../../src/adapters/browser/browserScopePorts.ts';
import { BrowserMarkdownDraftPort } from '../../src/adapters/browser/canonicalMarkdownDrafts.ts';
import { BrowserAnnotationAppendDraftPort } from '../../src/adapters/browser/annotationAppendDrafts.ts';
import { BrowserReaderStatePort } from '../../src/adapters/browser/readerState.ts';
import type { HostLease } from '../../src/features/bootstrap/bootstrapPorts.ts';
import { createPlanEvidence, type PlanEvidence } from '../../src/runtime/edits/repositoryExecution.ts';
import { IndexedDbPlan } from '../../src/adapters/browser/indexedDbPlan.ts';
import { canonicalHostTransaction } from '../../src/adapters/browser/canonicalHostTransaction.ts';
import { LOCAL_GRANT_STORE } from '../../src/adapters/browser/canonicalIndexedDbSchema.ts';
import { createPlannedRepositoryDraft, type RepositoryOperationHost } from '../../src/runtime/edits/repositoryFacadeDraft.ts';
import { resourceHash } from '../../src/runtime/edits/contentPublication.ts';
import { initialRequest } from '../../src/features/bootstrap/initialRequest.ts';
import type { EditMutation, ScopeRead, RepositoryOperation } from '../../src/runtime/edits/repositoryPlan.ts';
const req = <T>(r: IDBRequest<T>) => new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const done = (tx: IDBTransaction) => new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??new Error('aborted'));});
async function cases() {
 const name=`plan-${crypto.randomUUID()}`, controller=new AbortController(), signal=controller.signal, authority=new LocalHostAuthority(indexedDB,name);
 try {
  const absent=await authority.discover(signal);let upgradeSeen=false;
  await new Promise<void>((resolve,reject)=>{const probe=indexedDB.open(name);probe.onupgradeneeded=()=>{upgradeSeen=true;probe.transaction?.abort();};probe.onerror=()=>resolve();probe.onsuccess=()=>{probe.result.close();reject(new Error('readonly discovery created database'));};});
  const readonlyNoDDL=absent.status==='setup-required'&&upgradeSeen;
  const lease=await authority.provision(signal), grant=await discoverLocalGrant(indexedDB,name,signal);if(grant.status!=='ready')throw new Error('grant');
  const storage=createOwnerInitialization(authority,lease),peer=await storage.getOrCreatePeer(signal),request=await initialRequest('plan fixture',peer);
  const prepared=await storage.prepare(request,signal),accepted=await storage.execute(request.control.id,signal);
  await storage.acknowledge(request.control.id,signal);const replay=await storage.query(request.control.id,signal), replayExecute=await storage.execute(request.control.id,signal), replayPrepare=await storage.prepare(request,signal);
  const ownerReplay=prepared.status==='pending'&&accepted.status==='accepted'&&JSON.stringify(accepted)===JSON.stringify(replay)&&JSON.stringify(accepted)===JSON.stringify(replayExecute)&&JSON.stringify(accepted)===JSON.stringify(replayPrepare);
  const otherRequest=structuredClone(request);otherRequest.profile.identity.accountId=crypto.randomUUID();otherRequest.control.identity.accountId=otherRequest.profile.identity.accountId;
  let crossOwner=false;try{await storage.prepare(otherRequest,signal);}catch{crossOwner=true;}
  let forgedOwner=false;try{await createOwnerInitialization(authority,{} as HostLease).list(signal);}catch{forgedOwner=true;}
  const proof=await authority.inspect(lease,request.profile.identity.libraryId,signal), op=authority.capture(lease,proof,signal);
  const evidence=createPlanEvidence('fixture-fixed'), sink=evidence.bind(op); const adapter=new IndexedDbPlan(authority,op,proof.scope,sink);
  const scope=proof.scope, id=crypto.randomUUID(), root={kind:'markdown' as const,id,version:crypto.randomUUID(),content:'one',appendIds:[],imageResources:[]};
  const reads:ScopeRead[]=[{kind:'control',identity:{accountId:scope.accountId,libraryId:scope.libraryId}},{kind:'roots',scope,targetId:id}];
  const originalGet=IDBObjectStore.prototype.get, originalAll=IDBObjectStore.prototype.getAll, originalIndexAll=IDBIndex.prototype.getAll;let unrelatedBlobReads=0;
  IDBObjectStore.prototype.get=function(query){if(this.name==='resourceBytes')unrelatedBlobReads++;return originalGet.call(this,query);};
  IDBObjectStore.prototype.getAll=function(query,count){if(this.name==='resourceBytes')unrelatedBlobReads++;return originalAll.call(this,query,count);};
  IDBIndex.prototype.getAll=function(query,count){if(this.objectStore.name==='resourceBytes')unrelatedBlobReads++;return originalIndexAll.call(this,query,count);};
  let captured;try{captured=await adapter.capture('commit',reads);}finally{IDBObjectStore.prototype.get=originalGet;IDBObjectStore.prototype.getAll=originalAll;IDBIndex.prototype.getAll=originalIndexAll;} const mutation:EditMutation={kind:'put-root',scope,root};
  const db=await req(indexedDB.open(name)),ns=JSON.stringify([scope.accountId,scope.libraryId,scope.epoch]);
  const tx=db.transaction('roots','readwrite');tx.objectStore('roots').put({key:JSON.stringify([ns,id]),scope:ns,value:{...root,content:'competing'}});await done(tx);db.close();
  const changed=await adapter.compareAndApply('commit',{snapshot:captured,mutations:[mutation],result:null});
  const fresh=await adapter.capture('commit',reads); const committed=await adapter.compareAndApply('commit',{snapshot:fresh,mutations:[mutation],result:null});
  let reused=false;try{await adapter.compareAndApply('commit',{snapshot:fresh,mutations:[mutation],result:null});}catch{reused=true;}
  const final=await adapter.capture('read',reads), value=final.values.find(v=>v.read.kind==='roots')?.value as {content:string}[];
  const denied:RepositoryOperation[]=['install-checkpoint','initialize','install-dataset','replace-dataset-control','receive-records','acknowledge-upload','acknowledge-import'];
  let forbidden=true;for(const operation of denied){try{await adapter.capture(operation,reads);forbidden=false;}catch{/* denied before transaction contents */}}
  const permitted:RepositoryOperation[]=['read','read-intent','pending-intents','replace-intent','checkpoint','dataset-control','datasets','store-resource','read-resource','resource-metadata','commit','publish','receipt','pending','pending-records','pending-publications'];
  let operationPermissions=true;for(const operation of permitted){try{await adapter.capture(operation,reads);}catch{operationPermissions=false;}}
  const allRoots:ScopeRead[]=[{kind:'control',identity:{accountId:scope.accountId,libraryId:scope.libraryId}},{kind:'roots',scope}];
  const beforePhantom=await adapter.capture('commit',allRoots), outsider=crypto.randomUUID(), phantom={...root,id:outsider,version:crypto.randomUUID()};
  const db2=await req(indexedDB.open(name)),tx2=db2.transaction('roots','readwrite');tx2.objectStore('roots').put({key:JSON.stringify([ns,outsider]),scope:ns,value:phantom});await done(tx2);db2.close();
  const phantomResult=await adapter.compareAndApply('commit',{snapshot:beforePhantom,mutations:[mutation],result:null});
  const hash='a'.repeat(64),resourceId=crypto.randomUUID(),metadata={id:resourceId,sha256:hash,mediaType:'application/octet-stream',byteLength:2};
  const resourceReads:ScopeRead[]=[{kind:'control',identity:{accountId:scope.accountId,libraryId:scope.libraryId}},{kind:'resource',scope,resourceId},{kind:'resource-bytes',scope,sha256:hash}];
  const beforeBytes=await adapter.capture('store-resource',resourceReads), db3=await req(indexedDB.open(name)),tx3=db3.transaction('resourceBytes','readwrite');
  tx3.objectStore('resourceBytes').put({key:JSON.stringify([ns,hash]),scope:ns,value:new Uint8Array([1,2])});await done(tx3);db3.close();
  const bytesResult=await adapter.compareAndApply('store-resource',{snapshot:beforeBytes,mutations:[{kind:'put-resource',scope,resource:{metadata,bytes:new Uint8Array([1,2])}}],result:null});
  const isolated=await adapter.capture('store-resource',resourceReads), capturedBytes=isolated.values.find(v=>v.read.kind==='resource-bytes')?.value as Uint8Array; capturedBytes[0]=99;
  const byteCommitted=await adapter.compareAndApply('store-resource',{snapshot:isolated,mutations:[{kind:'put-resource',scope,resource:{metadata,bytes:new Uint8Array([1,2])}}],result:null});
  // Test-only corrupt page collision, followed by successful projection and prune.
  const doc=structuredClone(golden.translation.root) as DocumentSnapshot;doc.id=crypto.randomUUID();doc.version=crypto.randomUUID();delete doc.translation;
  const page=doc.pages[0], pageId=[doc.id,page.id,page.backgroundRevision,page.lifecycleVersion,page.annotationVersion].join(':');
  const docReads:ScopeRead[]=[{kind:'control',identity:{accountId:scope.accountId,libraryId:scope.libraryId}},{kind:'roots',scope,targetId:doc.id}];
  const corruptDb=await req(indexedDB.open(name)),corrupt=corruptDb.transaction('pages','readwrite');
  corrupt.objectStore('pages').put({key:JSON.stringify([ns,pageId]),scope:ns,value:{...page,widthPt:page.widthPt+1}});await done(corrupt);corruptDb.close();
  const collisionSnapshot=await adapter.capture('publish',docReads);let collision=false;
  try{await adapter.compareAndApply('publish',{snapshot:collisionSnapshot,mutations:[{kind:'put-root',scope,root:doc},{kind:'put-projection',scope,snapshot:doc}],result:null});}catch{collision=true;}
  const verifyDb=await req(indexedDB.open(name)),verify=verifyDb.transaction(['roots','pages'],'readwrite');
  const noRoot=await req(verify.objectStore('roots').get(JSON.stringify([ns,doc.id])));verify.objectStore('pages').delete(JSON.stringify([ns,pageId]));await done(verify);verifyDb.close();
  const firstDoc=await adapter.capture('publish',docReads);await adapter.compareAndApply('publish',{snapshot:firstDoc,mutations:[{kind:'put-root',scope,root:doc},{kind:'put-projection',scope,snapshot:doc}],result:null});
  const next=structuredClone(doc);next.version=crypto.randomUUID();next.pages[0].annotationVersion=crypto.randomUUID();
  const secondDoc=await adapter.capture('commit',docReads);await adapter.compareAndApply('commit',{snapshot:secondDoc,mutations:[{kind:'put-projection',scope,snapshot:next},{kind:'prune-projections',scope,targetId:doc.id,versions:[next.version]}],result:null});
  const inspectDb=await req(indexedDB.open(name)),inspect=inspectDb.transaction(['pages','projections'],'readonly');
  const oldPage=await req(inspect.objectStore('pages').get(JSON.stringify([ns,pageId]))), oldProjection=await req(inspect.objectStore('projections').get(JSON.stringify([ns,`${doc.id}:${doc.version}`])));
  const newId=[doc.id,next.pages[0].id,next.pages[0].backgroundRevision,next.pages[0].lifecycleVersion,next.pages[0].annotationVersion].join(':');
  const newPage=await req(inspect.objectStore('pages').get(JSON.stringify([ns,newId])));await done(inspect);inspectDb.close();
  const physical=collision&&!noRoot&&!oldPage&&!oldProjection&&!!newPage;
  // The normal planned facade uses two simultaneous host-bound native connections.
  const ports=createBrowserScopePorts(authority,lease,proof,new BrowserMarkdownDraftPort(scope),new BrowserAnnotationAppendDraftPort(scope),new BrowserReaderStatePort(scope));
  const factoryRead=await ports.repository.read(scope.libraryId);let forbiddenFactory=false;try{await ports.repository.installCheckpoint({} as never);}catch{forbiddenFactory=true;}
  const factoryGate=!!factoryRead && forbiddenFactory && Array.isArray(ports.markdown.targets());
  await ports.gate.close();
  const gate=createLocalHostGate(authority,lease,proof);
  const evidenceLog:PlanEvidence[]=[];
  const makeHost=(ownerGate:ReturnType<typeof createLocalHostGate>):RepositoryOperationHost=>({createEvidence:(_operation,input)=>{const value=createPlanEvidence(JSON.stringify(input));evidenceLog.push(value);return value;},
   run:(_operation,evidence,action)=>ownerGate.run(signal,op=>action(new IndexedDbPlan(authority,op,scope,evidence.bind(op))))});
  const host=makeHost(gate);
  const repo1=createPlannedRepositoryDraft(scope,host),repo2=createPlannedRepositoryDraft(scope,host);
  const initial=await repo1.read(scope.libraryId), initialHead=initial.heads[0];
  const bytes=new TextEncoder().encode('outside transaction'), sha=await resourceHash(bytes), oldDigest=SubtleCrypto.prototype.digest;
  let releaseHash!:()=>void, enterHash!:()=>void;const hashGate=new Promise<void>(resolve=>{releaseHash=resolve;}),hashEntered=new Promise<void>(resolve=>{enterHash=resolve;});let delay=true;
  SubtleCrypto.prototype.digest=function(algorithm,data){if(delay){delay=false;enterHash();return hashGate.then(()=>oldDigest.call(this,algorithm,data));}return oldDigest.call(this,algorithm,data);};
  const resourcePromise=repo1.storeResource({id:crypto.randomUUID(),sha256:sha,mediaType:'application/octet-stream',bytes});
  await hashEntered;
  const firstBatch={kind:'library' as const,id:crypto.randomUUID(),libraryId:scope.libraryId,targetId:scope.libraryId,parents:[initialHead],changes:[{type:'put-folder' as const,folder:{id:crypto.randomUUID(),title:'concurrent',parentId:null,position:0}}]};
  let concurrentResult;try{concurrentResult=await repo2.commit(firstBatch);}finally{releaseHash();SubtleCrypto.prototype.digest=oldDigest;}
  const resource=await resourcePromise;
  // Valid payloads deliberately stored under other physical IDs must never be relabelled.
  const badResourceId=crypto.randomUUID(), badEditId=crypto.randomUUID(), badManifestId=crypto.randomUUID();
  const corruptIdentityDb=await req(indexedDB.open(name)),identityTx=corruptIdentityDb.transaction(['resources','edits','datasets'],'readwrite');
  const editRow=await req(identityTx.objectStore('edits').get(JSON.stringify([ns,firstBatch.id])));
  const manifest=request.control.active!;
  identityTx.objectStore('resources').put({key:JSON.stringify([ns,badResourceId]),scope:ns,value:{id:resource.id,sha256:sha,mediaType:'application/octet-stream',byteLength:bytes.length}});
  identityTx.objectStore('edits').put({key:JSON.stringify([ns,badEditId]),scope:ns,value:editRow.value});
  identityTx.objectStore('datasets').put({key:JSON.stringify([ns,badManifestId]),scope:ns,value:manifest});await done(identityTx);corruptIdentityDb.close();
  let identityBlobReads=0;IDBObjectStore.prototype.get=function(query){if(this.name==='resourceBytes')identityBlobReads++;return originalGet.call(this,query);};
  let badResource=false,badEdit=false,badManifest=false;
  try { for(const [read,mark] of [[{kind:'resource',scope,resourceId:badResourceId},()=>{badResource=true;}],[{kind:'edits',scope},()=>{badEdit=true;}],[{kind:'datasets',scope,manifestId:badManifestId},()=>{badManifest=true;}]] as [ScopeRead,()=>void][]) { try{await adapter.capture('read',[read]);}catch{mark();} } }
  finally {IDBObjectStore.prototype.get=originalGet;}
  const identityCheckDb=await req(indexedDB.open(name)),identityCheck=identityCheckDb.transaction(['resources','edits','datasets'],'readwrite');
  const preservedResource=await req(identityCheck.objectStore('resources').get(JSON.stringify([ns,badResourceId]))),preservedEdit=await req(identityCheck.objectStore('edits').get(JSON.stringify([ns,badEditId]))),preservedManifest=await req(identityCheck.objectStore('datasets').get(JSON.stringify([ns,badManifestId])));
  identityCheck.objectStore('resources').delete(JSON.stringify([ns,badResourceId]));identityCheck.objectStore('edits').delete(JSON.stringify([ns,badEditId]));identityCheck.objectStore('datasets').delete(JSON.stringify([ns,badManifestId]));await done(identityCheck);identityCheckDb.close();
  const physicalIdentity=badResource&&badEdit&&badManifest&&identityBlobReads===0&&preservedResource?.value.id===resource.id&&preservedEdit?.value.batch.id===firstBatch.id&&preservedManifest?.value.id===manifest.id;

  const corruptBytesDb=await req(indexedDB.open(name)),corruptBytesTx=corruptBytesDb.transaction('resourceBytes','readwrite');
  corruptBytesTx.objectStore('resourceBytes').put({key:JSON.stringify([ns,sha]),scope:ns,value:new Uint8Array([9,9])});await done(corruptBytesTx);corruptBytesDb.close();
  let bytesCollision=false;try{await repo2.storeResource({id:crypto.randomUUID(),sha256:sha,mediaType:'application/octet-stream',bytes});}catch{bytesCollision=true;}
  const restoreBytesDb=await req(indexedDB.open(name)),restoreBytesTx=restoreBytesDb.transaction('resourceBytes','readwrite');
  const corrupted=await req(restoreBytesTx.objectStore('resourceBytes').get(JSON.stringify([ns,sha])));bytesCollision=bytesCollision && corrupted.value[0]===9;
  restoreBytesTx.objectStore('resourceBytes').put({key:JSON.stringify([ns,sha]),scope:ns,value:bytes});await done(restoreBytesTx);restoreBytesDb.close();
  const afterFirst=await repo1.read(scope.libraryId), beforeConcurrent=afterFirst.heads[0];
  const sameBatch={kind:'library' as const,id:crypto.randomUUID(),libraryId:scope.libraryId,targetId:scope.libraryId,parents:[beforeConcurrent],changes:[{type:'put-folder' as const,folder:{id:crypto.randomUUID(),title:'same id',parentId:null,position:1}}]};
  const both=await Promise.all([repo1.commit(sameBatch),repo2.commit(sameBatch)]), normal=await repo1.read(scope.libraryId), pending=await repo1.pending();
  const normalFacade=concurrentResult.status==='durable' && resource.id.length>0 && both.every(value=>value.status==='durable')
    && normal.heads.length===1 && normal.heads[0]===sameBatch.id && normal.history.length===0 && pending.filter(value=>value.id===sameBatch.id).length===1;
  const beforeQuota=await repo1.read(scope.libraryId), quotaBatch={kind:'library' as const,id:crypto.randomUUID(),libraryId:scope.libraryId,targetId:scope.libraryId,parents:[beforeQuota.heads[0]],changes:[{type:'put-folder' as const,folder:{id:crypto.randomUUID(),title:'quota',parentId:null,position:2}}]};
  const nativePut=IDBObjectStore.prototype.put;let quotaInjected=false;
  IDBObjectStore.prototype.put=function(value,id){if(this.name==='projections'&&!quotaInjected){quotaInjected=true;this.transaction.abort();throw new DOMException('fixture quota','QuotaExceededError');}return id===undefined?nativePut.call(this,value):nativePut.call(this,value,id);};
  let quotaResult;try{quotaResult=await repo1.commit(quotaBatch);}finally{IDBObjectStore.prototype.put=nativePut;}
  const afterQuota=await repo1.read(scope.libraryId),quotaNoWrite=quotaInjected&&quotaResult.status==='unknown'&&JSON.stringify(afterQuota)===JSON.stringify(beforeQuota);
  const quotaRetry=await repo1.commit(quotaBatch),retryStable=quotaRetry.status==='durable' && (await repo1.read(scope.libraryId)).heads[0]===quotaBatch.id;
  const beforeRevoke=await repo1.read(scope.libraryId), revokeBatch={kind:'library' as const,id:crypto.randomUUID(),libraryId:scope.libraryId,targetId:scope.libraryId,parents:[beforeRevoke.heads[0]],changes:[{type:'put-folder' as const,folder:{id:crypto.randomUUID(),title:'revoked',parentId:null,position:3}}]};
  let revokeInjected=false;IDBObjectStore.prototype.put=function(value,id){const result=id===undefined?nativePut.call(this,value):nativePut.call(this,value,id);if(this.name==='projections'&&!revokeInjected){revokeInjected=true;authority.invalidate();}return result;};
  let revokeResult;try{revokeResult=await repo1.commit(revokeBatch);}finally{IDBObjectStore.prototype.put=nativePut;}
  const renewed=await authority.discover(signal);if(renewed.status!=='ready')throw new Error('reauthorization missing');const proof2=await authority.inspect(renewed.lease,scope.libraryId,signal);
  const gate2=createLocalHostGate(authority,renewed.lease,proof2),repo3=createPlannedRepositoryDraft(scope,makeHost(gate2)),afterRevoke=await repo3.read(scope.libraryId);
  const revokeNoWrite=revokeInjected&&revokeResult.status==='unknown'&&JSON.stringify(afterRevoke)===JSON.stringify(beforeRevoke);
  await gate.close();
  // A normal commit completes natively, then loses authority before facade delivery.
  const lateBatch={kind:'library' as const,id:crypto.randomUUID(),libraryId:scope.libraryId,targetId:scope.libraryId,parents:[afterRevoke.heads[0]],changes:[{type:'put-folder' as const,folder:{id:crypto.randomUUID(),title:'late',parentId:null,position:4}}]};
  const originalTransaction=IDBDatabase.prototype.transaction;let armed=true;
  IDBDatabase.prototype.transaction=function(stores,mode,options){const tx=originalTransaction.call(this,stores,mode,options);if(armed&&mode==='readwrite'){armed=false;tx.addEventListener('complete',()=>authority.invalidate(),{once:true});}return tx;};
  let lateResult;try{lateResult=await repo3.commit(lateBatch);}finally{IDBDatabase.prototype.transaction=originalTransaction;}
  const lateEvidence=evidenceLog[evidenceLog.length-1];
  const raw=await req(indexedDB.open(name)),check=raw.transaction('edits','readonly'),stored=await req(check.objectStore('edits').get(JSON.stringify([ns,lateBatch.id])));await done(check);raw.close();
  const oldResultHidden=lateResult.status==='unknown';
  const durableAfterLoss=stored?.value?.batch?.id===lateBatch.id && lateEvidence.view.attempts[lateEvidence.view.attempts.length-1]==='committed';
  await gate2.close();
  return {operationPermissions,readonlyNoDDL,ownerReplay,crossOwner,forgedOwner,factoryGate,physicalIdentity,changed:changed.status,committed:committed.status,content:value[0]?.content,reused,forbidden,unrelatedBlobReads,phantom:phantomResult.status,bytesChanged:bytesResult.status,privateBytes:byteCommitted.status,oldResultHidden,durableAfterLoss,physical,normalFacade,bytesCollision,quotaNoWrite,retryStable,revokeNoWrite,casNoWrite:evidence.view.attempts.includes('cas-no-write'),completed:evidence.view.attempts.includes('committed')};
 } finally {authority.close();await req(indexedDB.deleteDatabase(name));}
}
Object.assign(window,{indexedDbPlanCases:cases});

// Actual local issuer, fixed storage instance and opaque operation; raw writes below
// are isolated IDB faults only, never an authority-minting or no-op authorization seam.
async function readonlyHostVerification() {
 const name = `readonly-host-${crypto.randomUUID()}`, signal = new AbortController().signal;
 const authority = new LocalHostAuthority(indexedDB, name); let raw: IDBDatabase | undefined;
 try {
  const lease = await authority.provision(signal), storage = createOwnerInitialization(authority, lease);
  const peer = await storage.getOrCreatePeer(signal), request = await initialRequest('readonly host verification', peer);
  await storage.prepare(request, signal);
  const accepted = await storage.execute(request.control.id, signal); if (accepted.status !== 'accepted') throw new Error('real initialization required');
  await storage.acknowledge(request.control.id, signal);
  const scope = request.control.active!.scope, identity = JSON.stringify([scope.accountId, scope.libraryId]);
  const namespace = JSON.stringify([scope.accountId, scope.libraryId, scope.epoch]);
  const rootKey = JSON.stringify([namespace, scope.libraryId]);
  const fresh = async () => {
   const context = await authority.discover(signal); if (context.status !== 'ready') throw new Error('real lease reacquisition required');
   const proof = await authority.inspect(context.lease, scope.libraryId, signal);
   return authority.capture(context.lease, proof, signal);
  };
  let operation = await fresh();
  raw = await req(indexedDB.open(name));
  type Row = { key: string; scope: string; value: Record<string, unknown> };
  const protectedKeys = new Map<string, string>([
   [LOCAL_GRANT_STORE, 'primary-local-context'], ['canonicalProfiles', identity], ['datasetControls', identity],
   ['canonicalPeers', scope.accountId], ['datasets', JSON.stringify([namespace, request.control.active!.id])],
  ]);
  const originals = new Map<string, Row>();
  const originalTx = raw.transaction([...protectedKeys.keys()], 'readonly'), originalDone = done(originalTx);
  await Promise.all([...protectedKeys].map(async ([store, key]) => { const row = await req(originalTx.objectStore(store).get(key)); if (!row) throw new Error('actual protected row absent'); originals.set(store, row as Row); }));
  await originalDone;
  const read = () => canonicalHostTransaction(authority, operation, ['roots'], 'readonly', (tx, _tuple, finish) => {
   const request = tx.objectStore('roots').get(rootKey); request.onsuccess = () => finish(request.result);
  });
  // Count the actual one transaction by native tx identity, including requests
  // issued before enqueue. Schema validation transactions make no protected gets.
  const nativeGet = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, 'get')!;
  const calls: { tx: IDBTransaction; store: string; key: unknown }[] = []; let measured: IDBTransaction | undefined;
  Object.defineProperty(IDBObjectStore.prototype, 'get', { ...nativeGet, value: function(this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
   calls.push({ tx: this.transaction, store: this.name, key }); return Reflect.apply(nativeGet.value, this, [key]);
  } });
  let readonlyValue: unknown;
  try { readonlyValue = await canonicalHostTransaction(authority, operation, ['roots'], 'readonly', (tx, _tuple, finish) => {
   measured = tx; const request = tx.objectStore('roots').get(rootKey); request.onsuccess = () => finish(request.result);
  }); } finally { Object.defineProperty(IDBObjectStore.prototype, 'get', nativeGet); }
  const readonlyCounts = Object.fromEntries([...protectedKeys].map(([store, key]) => [store, calls.filter(call => call.tx === measured && call.store === store && call.key === key).length]));
  const readonlyRoot = (readonlyValue as { value?: { id?: string } } | undefined)?.value?.id;
  const concurrent: { store: string; unchanged: boolean; writerBlocked: boolean; nextRejected: boolean; restoredUsable: boolean }[] = [];
  for (const store of [LOCAL_GRANT_STORE, 'canonicalProfiles']) {
   const original = originals.get(store)!, changed = structuredClone(original);
   if (store === LOCAL_GRANT_STORE) changed.value.revision = crypto.randomUUID(); else changed.value.title = 'concurrent profile drift';
   let writerStarted = false, writerFinished: Promise<void> | undefined, unchanged = false, writerBlocked = false;
   try {
    await canonicalHostTransaction(authority, operation, ['roots'], 'readonly', (tx, _tuple, finish) => {
     const request = tx.objectStore('roots').get(rootKey);
     request.onsuccess = () => {
      // This overlapping writer is genuinely scheduled on a separate connection.
      // It cannot run until this live readonly transaction has finished.
      const writer = raw!.transaction(store, 'readwrite'); writerFinished = done(writer);
      const put = writer.objectStore(store).put(changed); put.onsuccess = () => { writerStarted = true; };
      const again = tx.objectStore(store).get(protectedKeys.get(store)!);
      again.onsuccess = () => { unchanged = JSON.stringify(again.result) === JSON.stringify(original); writerBlocked = !writerStarted; finish(request.result); };
     };
    });
    if (!writerFinished) throw new Error('writer was not scheduled'); await writerFinished;
    let nextRejected = false; try { await read(); } catch { nextRejected = true; }
    const restore = raw.transaction(store, 'readwrite'), restored = done(restore); restore.objectStore(store).put(original); await restored;
    const restoredUsable = (await read() as { value?: { id?: string } } | undefined)?.value?.id === scope.libraryId;
    concurrent.push({ store, unchanged, writerBlocked, nextRejected, restoredUsable });
   } finally {
    // Own fault rows are always restored before continuing or closing this fixture.
    if (writerFinished) await writerFinished;
    const restore = raw.transaction(store, 'readwrite'), restored = done(restore); restore.objectStore(store).put(original); await restored;
   }
  }
  let finishInvalidationExercised = false, finishInvalidationRejected = false;
  try { await canonicalHostTransaction(authority, operation, ['roots'], 'readonly', (tx, _tuple, finish) => {
   const request = tx.objectStore('roots').get(rootKey); request.onsuccess = () => { finishInvalidationExercised = true; authority.invalidate(); finish(request.result); };
  }); } catch { finishInvalidationRejected = true; }
  operation = await fresh();
  const restoredAfterInvalidation = (await read() as { value?: { id?: string } } | undefined)?.value?.id === scope.libraryId;
  // Preserve the final oncomplete fence: invalidate before the helper's completion
  // listener runs, using the existing test's native transaction observer seam.
  const nativeTransaction = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, 'transaction')!; let completionArmed = true, completionInvalidationRejected = false;
  Object.defineProperty(IDBDatabase.prototype, 'transaction', { ...nativeTransaction, value: function(this: IDBDatabase, ...args: unknown[]) {
   const tx = Reflect.apply(nativeTransaction.value, this, args) as IDBTransaction;
   if (completionArmed && tx.mode === 'readonly' && tx.objectStoreNames.length === 6 && tx.objectStoreNames.contains('roots') && tx.objectStoreNames.contains(LOCAL_GRANT_STORE)) {
    completionArmed = false; tx.addEventListener('complete', () => authority.invalidate(), { once: true });
   }
   return tx;
  } });
  try { await read(); } catch { completionInvalidationRejected = true; }
  finally { Object.defineProperty(IDBDatabase.prototype, 'transaction', nativeTransaction); }
  operation = await fresh();
  const restoredAfterCompletion = (await read() as { value?: { id?: string } } | undefined)?.value?.id === scope.libraryId;
  const readwrite: { store: string; mutationEnqueued: boolean; rejected: boolean; rowPreserved: boolean; markerAbsent: boolean; restoredUsable: boolean }[] = [];
  for (const [store, key] of protectedKeys) {
   const original = originals.get(store)!, changed = structuredClone(original); changed.value.unexpectedFixtureField = true;
   const markerId = crypto.randomUUID(), markerKey = JSON.stringify([namespace, markerId]); let mutationEnqueued = false, rejected = false;
   try { await canonicalHostTransaction(authority, operation, ['roots'], 'readwrite', (tx, _tuple, finish) => {
    tx.objectStore('roots').put({ key: markerKey, scope: namespace, value: { kind: 'markdown', id: markerId, version: crypto.randomUUID(), content: 'must roll back', appendIds: [], imageResources: [] } });
    tx.objectStore(store).put(changed); mutationEnqueued = true; finish(null);
   }); } catch { rejected = true; }
   const check = raw.transaction([store, 'roots'], 'readonly'), checked = done(check);
   const [protectedRow, marker] = await Promise.all([req(check.objectStore(store).get(key)), req(check.objectStore('roots').get(markerKey))]); await checked;
   const restoredUsable = (await read() as { value?: { id?: string } } | undefined)?.value?.id === scope.libraryId;
   readwrite.push({ store, mutationEnqueued, rejected, rowPreserved: JSON.stringify(protectedRow) === JSON.stringify(original), markerAbsent: marker === undefined, restoredUsable });
  }
  return { libraryId: scope.libraryId, readonlyRoot, readonlyCounts, concurrent, finishInvalidationExercised, finishInvalidationRejected, restoredAfterInvalidation,
   completionFenceWasExercised: !completionArmed, completionInvalidationRejected, restoredAfterCompletion, readwrite };
 } finally { raw?.close(); authority.close(); await req(indexedDB.deleteDatabase(name)); }
}
Object.assign(window, { indexedDbReadonlyHostVerification: readonlyHostVerification });


// Root read reuse is tested against a real isolated canonical database and the
// production issuer. Raw rows below are controlled storage faults, not authority.
async function rootReadReuseVerification() {
 const name=`root-reuse-${crypto.randomUUID()}`, signal=new AbortController().signal;
 const authority=new LocalHostAuthority(indexedDB,name);let raw:IDBDatabase|undefined,ports:ReturnType<typeof createBrowserScopePorts>|undefined;
 try {
  const lease=await authority.provision(signal),storage=createOwnerInitialization(authority,lease),peer=await storage.getOrCreatePeer(signal);
  const request=await initialRequest('root read reuse',peer);await storage.prepare(request,signal);
  if((await storage.execute(request.control.id,signal)).status!=='accepted')throw new Error('actual initialization required');
  await storage.acknowledge(request.control.id,signal);
  const proof=await authority.inspect(lease,request.profile.identity.libraryId,signal),scope=proof.scope;
  ports=createBrowserScopePorts(authority,lease,proof,new BrowserMarkdownDraftPort(scope),new BrowserAnnotationAppendDraftPort(scope),new BrowserReaderStatePort(scope));
  const factoryBefore=(await ports.repository.read(scope.libraryId)).checkpoint.root.id===scope.libraryId;
  raw=await req(indexedDB.open(name));const ns=JSON.stringify([scope.accountId,scope.libraryId,scope.epoch]),key=(id:string)=>JSON.stringify([ns,id]);
  const presentId=crypto.randomUUID(),missingId=crypto.randomUUID(),badId=crypto.randomUUID();
  const root={kind:'markdown' as const,id:presentId,version:crypto.randomUUID(),content:'same logical value',appendIds:[],imageResources:[]};
  const seed=raw.transaction('roots','readwrite'),seedDone=done(seed);seed.objectStore('roots').put({key:key(presentId),scope:ns,value:root});await seedDone;
  const full:ScopeRead={kind:'roots',scope},point:ScopeRead={kind:'roots',scope,targetId:presentId},missing:ScopeRead={kind:'roots',scope,targetId:missingId};
  const adapter=()=>{const operation=authority.capture(lease,proof,signal);return new IndexedDbPlan(authority,operation,scope,createPlanEvidence('root-reuse').bind(operation));};
  const measured=async(reads:ScopeRead[])=>{
   const get=Object.getOwnPropertyDescriptor(IDBObjectStore.prototype,'get')!,all=Object.getOwnPropertyDescriptor(IDBIndex.prototype,'getAll')!;
   const calls:string[]=[];let fullScans=0;
   Object.defineProperty(IDBObjectStore.prototype,'get',{...get,value:function(this:IDBObjectStore,...args:unknown[]){
    if(this.transaction.db.name===name&&this.name==='roots')calls.push(String(args[0]));return Reflect.apply(get.value,this,args);
   }});
   Object.defineProperty(IDBIndex.prototype,'getAll',{...all,value:function(this:IDBIndex,...args:unknown[]){
    if(this.objectStore.transaction.db.name===name&&this.objectStore.name==='roots'&&args[0]===ns)fullScans++;return Reflect.apply(all.value,this,args);
   }});
   try {const actual=adapter(),snapshot=await actual.capture('commit',reads);return {actual,snapshot,calls,fullScans};}
   finally{Object.defineProperty(IDBObjectStore.prototype,'get',get);Object.defineProperty(IDBIndex.prototype,'getAll',all);}
  };
  const orders=[];
  for(const reads of [[full,point,missing],[point,missing,full]]){
   const result=await measured(reads),present=result.snapshot.values.find(entry=>entry.read.kind==='roots'&&entry.read.targetId===presentId)?.value as {id:string}[];
   const absent=result.snapshot.values.find(entry=>entry.read.kind==='roots'&&entry.read.targetId===missingId)?.value as unknown[];
   orders.push({presentGets:result.calls.filter(value=>value===key(presentId)).length,missingGets:result.calls.filter(value=>value===key(missingId)).length,
    fullScans:result.fullScans,presentSame:present.length===1&&present[0].id===presentId,missingEmpty:absent.length===0});
  }
  // Same logical snapshot with a changed physical Row wrapper must still fail CAS.
  const before=await measured([point,full]),changed={key:key(presentId),scope:ns,value:root,physicalWitness:'changed'};
  const change=raw.transaction('roots','readwrite'),changedDone=done(change);change.objectStore('roots').put(changed);await changedDone;
  const marker={...root,id:crypto.randomUUID(),version:crypto.randomUUID()},cas=await before.actual.compareAndApply('commit',{
   snapshot:before.snapshot,mutations:[{kind:'put-root',scope,root:marker}],result:null});
  const check=raw.transaction('roots','readonly'),checked=done(check);
  const [afterPhysical,markerRow]=await Promise.all([req(check.objectStore('roots').get(key(presentId))),req(check.objectStore('roots').get(key(marker.id)))]);await checked;
  const witness={status:cas.status,sameLogical:JSON.stringify(afterPhysical.value)===JSON.stringify(root),markerAbsent:markerRow===undefined};
  const wrongScope=JSON.stringify([scope.accountId,scope.libraryId,crypto.randomUUID()]);
  const corrupt=raw.transaction('roots','readwrite'),corrupted=done(corrupt);corrupt.objectStore('roots').put({key:key(badId),scope:wrongScope,value:{...root,id:badId}});await corrupted;
  const nativeGet=Object.getOwnPropertyDescriptor(IDBObjectStore.prototype,'get')!;let badGets=0,badRejected=false;
  Object.defineProperty(IDBObjectStore.prototype,'get',{...nativeGet,value:function(this:IDBObjectStore,...args:unknown[]){
   if(this.transaction.db.name===name&&this.name==='roots'&&args[0]===key(badId))badGets++;return Reflect.apply(nativeGet.value,this,args);
  }});
  try{await adapter().capture('commit',[full,{kind:'roots',scope,targetId:badId}]);}
  catch(error){badRejected=error instanceof DOMException&&error.name==='AbortError';}
  finally{Object.defineProperty(IDBObjectStore.prototype,'get',nativeGet);const restore=raw.transaction('roots','readwrite'),restored=done(restore);restore.objectStore('roots').delete(key(badId));await restored;}
  const positive=await measured([full,point]);
  const recovered=(positive.snapshot.values.find(entry=>entry.read.kind==='roots'&&entry.read.targetId===presentId)?.value as {id:string}[])[0]?.id===presentId;
  const crossScope=[];
  for(const field of ['accountId','libraryId','epoch'] as const){let denied=false;try{await adapter().capture('read',[full,{kind:'roots',scope:{...scope,[field]:crypto.randomUUID()},targetId:presentId}]);}
   catch(error){denied=error instanceof Error&&error.message==='host-scope-mismatch';}crossScope.push({field,denied});}
  const factoryAfter=(await ports.repository.read(scope.libraryId)).checkpoint.root.id===scope.libraryId;
  return {factoryBefore,factoryAfter,orders,witness,badGets,badRejected,recovered,crossScope};
 } finally {raw?.close();await ports?.gate.close();authority.close();await req(indexedDB.deleteDatabase(name));}
}
Object.assign(window,{indexedDbRootReadReuseVerification:rootReadReuseVerification});

// Three-conflict differential case. Real factory, real IDB and opaque local authority.
async function optimisticDifferentialCases() {
 const name=`optimistic-differential-${crypto.randomUUID()}`, signal=new AbortController().signal, authority=new LocalHostAuthority(indexedDB,name);
 const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
 try {
  const lease=await authority.provision(signal),storage=createOwnerInitialization(authority,lease),peer=await storage.getOrCreatePeer(signal);
  const request=await initialRequest('differential',peer);await storage.prepare(request,signal);await storage.execute(request.control.id,signal);await storage.acknowledge(request.control.id,signal);
  const proof=await authority.inspect(lease,request.profile.identity.libraryId,signal),scope=proof.scope;
  const ports=createBrowserScopePorts(authority,lease,proof,new BrowserMarkdownDraftPort(scope),new BrowserAnnotationAppendDraftPort(scope),new BrowserReaderStatePort(scope));
  const documentId=crypto.randomUUID(), rootVersion=crypto.randomUUID();
  // Seed a valid second target through the actual admitted adapter and CAS.
  const seedHost=authority.capture(lease,proof,signal), seed=new IndexedDbPlan(authority,seedHost,scope,createPlanEvidence('differential-seed').bind(seedHost));
  const reads:ScopeRead[]=[{kind:'control',identity:{accountId:scope.accountId,libraryId:scope.libraryId}},{kind:'roots',scope,targetId:documentId}];
  const snapshot=await seed.capture('commit',reads);
  const root={kind:'markdown' as const,id:documentId,version:rootVersion,content:'before',appendIds:[],imageResources:[]};
  if((await seed.compareAndApply('commit',{snapshot,mutations:[{kind:'put-root',scope,root}],result:null})).status!=='committed')throw new Error('seed failed');
  const initialLibrary=await ports.repository.read(scope.libraryId);let libraryParent=initialLibrary.heads[0];
  const userId=crypto.randomUUID();
  const userBatch={kind:'markdown' as const,id:userId,libraryId:scope.libraryId,targetId:documentId,parents:[rootVersion],content:'saved',imageResources:[]};
  const namespace=JSON.stringify([scope.accountId,scope.libraryId,scope.epoch]);
  const originalCompare=IndexedDbPlan.prototype.compareAndApply, originalCapture=IndexedDbPlan.prototype.capture;
  let reached=deferred(), activeB='', conflicts=0, entered=0;
  const pendingB:Promise<unknown>[]=[];
  const identify=(plan:PreparedEditPlan<unknown>)=>plan.mutations.find(m=>m.kind==='put-edit')?.edit.batch.id;
  const interfere=async()=>{
   entered++;const bId=crypto.randomUUID();activeB=bId;reached=deferred();
   const bBatch={kind:'library' as const,id:bId,libraryId:scope.libraryId,targetId:scope.libraryId,parents:[libraryParent],changes:[{type:'put-folder' as const,folder:{id:crypto.randomUUID(),title:`other-${entered}`,parentId:null,position:entered}}]};
   const b=ports.repository.commit(bBatch);pendingB.push(b);await reached.promise;
   // In the old implementation B has already queued its open; in the new
   // fallback it is waiting for A's lease. The same-store sentinel observes
   // B's durable edit if its write transaction entered ahead of this read.
   for(let i=0;i<20;i++)await Promise.resolve();
   const raw=await req(indexedDB.open(name)),tx=raw.transaction('edits','readonly'),finished=done(tx);
   const row=await req(tx.objectStore('edits').get(JSON.stringify([namespace,bId])));await finished;raw.close();
   if(row){const result=await b;if(result.status!=='durable')throw new Error('competing writer not durable');conflicts++;libraryParent=bId;}
  };
  IndexedDbPlan.prototype.capture=async function(operation,reads){
   const captured=await originalCapture.call(this,operation,reads);
   // This fixture has one markdown root without resources or catalog items,
   // so each attempt's selected capture is already closed over dependencies.
   if(operation==='commit' && reads.some(read=>read.kind==='roots'&&read.targetId===documentId))await interfere();
   return captured;
  };
  IndexedDbPlan.prototype.compareAndApply=async function(operation,plan){
   const flight=originalCompare.call(this,operation,plan);
   if(identify(plan)===activeB)reached.resolve();
   return flight;
  };
  let result, bResults;
  try {result=await ports.repository.commit(userBatch);bResults=await Promise.all(pendingB);}
  finally {IndexedDbPlan.prototype.compareAndApply=originalCompare;IndexedDbPlan.prototype.capture=originalCapture;}
  const userReceipt=await ports.repository.receipt(userId);await ports.gate.close();
  return {status:result.status,reason:result.status==='unknown'?result.reason:'',conflicts,entered,durable:userReceipt?.durable===true,competitorsDurable:bResults.every(value=>(value as {status:string}).status==='durable')};
 } finally {authority.close();await req(indexedDB.deleteDatabase(name));}
}
Object.assign(window,{indexedDbOptimisticDifferentialCases:optimisticDifferentialCases});


// Differential oracle uses only the ordinary product factory, with no scope API probe.
async function operationDatabaseOpenCountCases() {
 const name=`operation-db-count-${crypto.randomUUID()}`, signal=new AbortController().signal, authority=new LocalHostAuthority(indexedDB,name);
 let originalOpen: typeof indexedDB.open | undefined;
 let ports: ReturnType<typeof createBrowserScopePorts> | undefined;
 try {
  const lease=await authority.provision(signal),storage=createOwnerInitialization(authority,lease),peer=await storage.getOrCreatePeer(signal);
  const request=await initialRequest('open count',peer);await storage.prepare(request,signal);await storage.execute(request.control.id,signal);await storage.acknowledge(request.control.id,signal);
  const proof=await authority.inspect(lease,request.profile.identity.libraryId,signal),scope=proof.scope;
  ports=createBrowserScopePorts(authority,lease,proof,new BrowserMarkdownDraftPort(scope),new BrowserAnnotationAppendDraftPort(scope),new BrowserReaderStatePort(scope));
  const before=await ports.repository.read(scope.libraryId);
  const batch={kind:'library' as const,id:crypto.randomUUID(),libraryId:scope.libraryId,targetId:scope.libraryId,parents:[before.heads[0]],changes:[{type:'put-folder' as const,folder:{id:crypto.randomUUID(),title:'open count',parentId:null,position:0}}]};
  let opens=0;originalOpen=indexedDB.open;
  indexedDB.open=function(dbName,version){if(dbName===name)opens++;return originalOpen!.call(this,dbName,version);};
  const result=await ports.repository.commit(batch),writeOpens=opens;
  indexedDB.open=originalOpen;originalOpen=undefined;
  const receipt=await ports.repository.receipt(batch.id);
  return {status:result.status,writeOpens,durable:receipt?.durable===true};
 } finally {if(originalOpen)indexedDB.open=originalOpen;try{await ports?.gate.close();}finally{authority.close();await req(indexedDB.deleteDatabase(name));}}
}
Object.assign(window,{indexedDbOperationDatabaseOpenCountCases:operationDatabaseOpenCountCases});

// Real factory, authority and IDB; only counts same-origin opens and injects reversible isolated faults.
async function operationDatabaseScopeCases() {
 const name=`operation-db-${crypto.randomUUID()}`, signal=new AbortController().signal, authority=new LocalHostAuthority(indexedDB,name);
 const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
 let originalOpen: typeof indexedDB.open | undefined;
 let ports: ReturnType<typeof createBrowserScopePorts> | undefined;
 try {
  const lease=await authority.provision(signal),storage=createOwnerInitialization(authority,lease),peer=await storage.getOrCreatePeer(signal);
  const request=await initialRequest('operation scoped db',peer);await storage.prepare(request,signal);await storage.execute(request.control.id,signal);await storage.acknowledge(request.control.id,signal);
  const proof=await authority.inspect(lease,request.profile.identity.libraryId,signal),scope=proof.scope;
  ports=createBrowserScopePorts(authority,lease,proof,new BrowserMarkdownDraftPort(scope),new BrowserAnnotationAppendDraftPort(scope),new BrowserReaderStatePort(scope));
  const before=await ports.repository.read(scope.libraryId);
  const batch={kind:'library' as const,id:crypto.randomUUID(),libraryId:scope.libraryId,targetId:scope.libraryId,parents:[before.heads[0]],changes:[{type:'put-folder' as const,folder:{id:crypto.randomUUID(),title:'connection scope',parentId:null,position:0}}]};
  let opens=0;originalOpen=indexedDB.open;
  indexedDB.open=function(dbName,version){if(dbName===name)opens++;return originalOpen!.call(this,dbName,version);};
  const result=await ports.repository.commit(batch),writeOpens=opens;
  const state=await ports.repository.read(scope.libraryId),readOpens=opens-writeOpens;
  indexedDB.open=originalOpen;originalOpen=undefined;
  const plannedOperation=result.status==='durable'&&state.heads[0]===batch.id&&writeOpens===1&&readOpens===1;

  const scopedRead=(operation:ReturnType<typeof authority.capture>)=>canonicalHostTransaction(authority,operation,['roots'],'readonly',(_tx,tuple,finish)=>{if(!tuple)throw new Error('missing proof');finish(true);});
  const cancelController=new AbortController(),cancelOperation=authority.capture(lease,proof,cancelController.signal);
  let cancelledAfterFirst=false,cancelScopeRejected=false;
  try { await authority.withOperationDatabase(cancelOperation,async()=>{
   await scopedRead(cancelOperation);cancelController.abort();
   try{await scopedRead(cancelOperation);}catch{cancelledAfterFirst=true;}
  }); } catch { cancelScopeRejected=true; }
  cancelledAfterFirst=cancelledAfterFirst&&cancelScopeRejected;
  const freshAfterCancel=authority.capture(lease,proof,signal),freshRead=await scopedRead(freshAfterCancel);

  const tamperOperation=authority.capture(lease,proof,signal),raw=await req(indexedDB.open(name));
  const profileKey=JSON.stringify([scope.accountId,scope.libraryId]);
  let profile: {key:string;scope:string;value:Record<string,unknown>}|undefined, tampered=false, persistedRechecked=false;
  try {
   const readTx=raw.transaction('canonicalProfiles','readonly'),readDone=done(readTx);profile=await req(readTx.objectStore('canonicalProfiles').get(profileKey));await readDone;
   if(!profile)throw new Error('fixture profile missing');const storedProfile=profile;
   await authority.withOperationDatabase(tamperOperation,async()=>{
    await scopedRead(tamperOperation);
    const tx=raw.transaction('canonicalProfiles','readwrite'),complete=done(tx);
    tx.objectStore('canonicalProfiles').put({...storedProfile,value:{...storedProfile.value,unexpectedFixtureField:true}});await complete;tampered=true;
    try{await scopedRead(tamperOperation);}catch{persistedRechecked=true;}
   });
  } finally {try {if(tampered&&profile){const tx=raw.transaction('canonicalProfiles','readwrite'),complete=done(tx);tx.objectStore('canonicalProfiles').put(profile);await complete;}} finally {raw.close();}}

  const oldOperation=authority.capture(lease,proof,signal),entered=deferred(),release=deferred();let oldRejected=false;
  const active=authority.withOperationDatabase(oldOperation,async()=>{await scopedRead(oldOperation);entered.resolve();await release.promise;try{await scopedRead(oldOperation);}catch{oldRejected=true;}});
  try {
   await Promise.race([entered.promise,active.then(()=>{throw new Error('scope ended before upgrade');},()=>{throw new Error('scope failed before upgrade');})]);
   // Actual upgrade invalidates the old authority while the scoped connection is idle.
   const upgraded=await authority.upgradeProviderStorage(lease,signal);
   release.resolve();const activeRejected=await active.then(()=>false,()=>true);oldRejected=oldRejected&&activeRejected;
   const nextProof=await authority.inspect(upgraded,scope.libraryId,signal),nextOperation=authority.capture(upgraded,nextProof,signal);
   const afterUpgrade=await scopedRead(nextOperation);
   return {plannedOperation,writeOpens,readOpens,cancelledAfterFirst,freshAfterCancel:freshRead===true,persistedRechecked,oldRejected,afterUpgrade:afterUpgrade===true};
  } finally {release.resolve();await active.catch(()=>undefined);}
 } finally {if(originalOpen)indexedDB.open=originalOpen;try{await ports?.gate.close();}finally{authority.close();await req(indexedDB.deleteDatabase(name));}}
}
Object.assign(window,{indexedDbOperationDatabaseScopeCases:operationDatabaseScopeCases});

// After-only fault/race probes use real IDB requests and a real authority; event delay is test-only.
async function operationDatabaseRaceCases() {
 const name=`operation-db-races-${crypto.randomUUID()}`, signal=new AbortController().signal, setup=new LocalHostAuthority(indexedDB,name);
 const releases=new Set<()=>void>(),authorities=new Set<LocalHostAuthority>([setup]),flights=new Set<Promise<unknown>>(),databases=new Set<IDBDatabase>();
 const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});releases.add(resolve);return {promise,resolve};};
 const track=<T,>(flight:Promise<T>):Promise<T>=>{flights.add(flight);void flight.then(()=>flights.delete(flight),()=>flights.delete(flight));return flight;};
 const read=(auth:LocalHostAuthority,operation:ReturnType<LocalHostAuthority['capture']>)=>canonicalHostTransaction(auth,operation,['roots'],'readonly',(_tx,tuple,finish)=>{if(!tuple)throw new Error('missing proof');finish(true);});
 let originalOpen: typeof indexedDB.open|undefined;
 const originalTx=IDBDatabase.prototype.transaction,originalClose=IDBDatabase.prototype.close;
 try {
  const lease=await setup.provision(signal),storage=createOwnerInitialization(setup,lease),peer=await storage.getOrCreatePeer(signal);
  const request=await initialRequest('operation races',peer);await storage.prepare(request,signal);await storage.execute(request.control.id,signal);await storage.acknowledge(request.control.id,signal);
  const libraryId=request.profile.identity.libraryId;setup.close();
  const openLateCases:{mode:string;rejected:boolean;closed:boolean;nativeTransactions:number}[]=[];
  for(const mode of ['abort','invalidate','close'] as const){
   const auth=new LocalHostAuthority(indexedDB,name);authorities.add(auth);const context=await auth.discover(signal);if(context.status!=='ready')throw new Error('reauthorization failed');
   const proof=await auth.inspect(context.lease,libraryId,signal),controller=new AbortController(),operation=auth.capture(context.lease,proof,controller.signal);
   const entered=deferred(),release=deferred();let held:IDBDatabase|undefined,closed=false,nativeTransactions=0;
   originalOpen=indexedDB.open;let armed=true;
   indexedDB.open=function(dbName,version){
    const native=originalOpen!.call(this,dbName,version);if(!armed||dbName!==name)return native;armed=false;
    let success:((this:IDBOpenDBRequest,event:Event)=>unknown)|null=null;
    const proxy=new Proxy(native,{
     get(target,key){const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;},
     set(target,key,value){if(key==='onsuccess'){success=value as typeof success;return true;}return Reflect.set(target,key,value,target);},
    });
    native.addEventListener('success',event=>{held=native.result;entered.resolve();void release.promise.then(()=>success?.call(native,event));},{once:true});
    return proxy;
   };
   IDBDatabase.prototype.close=function(){if(this===held)closed=true;return originalClose.call(this);};
   IDBDatabase.prototype.transaction=function(stores,mode,options){if(this===held)nativeTransactions++;return originalTx.call(this,stores,mode,options);};
   const flight=track(auth.withOperationDatabase(operation,()=>read(auth,operation)).then(()=>false,()=>true));
   try {
    await Promise.race([entered.promise,flight.then(()=>{throw new Error('open did not enter');})]);
    if(mode==='abort')controller.abort();else if(mode==='invalidate')auth.invalidate();else auth.close();
    release.resolve();const rejected=await flight;
    openLateCases.push({mode,rejected,closed,nativeTransactions});
   } finally {release.resolve();await flight;indexedDB.open=originalOpen;originalOpen=undefined;IDBDatabase.prototype.close=originalClose;IDBDatabase.prototype.transaction=originalTx;auth.close();}
  }
  const auth=new LocalHostAuthority(indexedDB,name);authorities.add(auth);const context=await auth.discover(signal);if(context.status!=='ready')throw new Error('reauthorization failed');
  const proof=await auth.inspect(context.lease,libraryId,signal),oldOp=auth.capture(context.lease,proof,signal);let oldDb!:IDBDatabase,oldHandler!:NonNullable<IDBDatabase['onversionchange']>;
  await auth.withOperationDatabase(oldOp,async()=>{await read(auth,oldOp);oldDb=await auth.openOperation(oldOp);oldHandler=oldDb.onversionchange!;});
  let spentOpenRejected=false,spentReentryRejected=false;
  try{await auth.openOperation(oldOp);}catch{spentOpenRejected=true;}
  try{await auth.withOperationDatabase(oldOp,async()=>true);}catch{spentReentryRejected=true;}
  auth.invalidate();const again=await auth.discover(signal);if(again.status!=='ready')throw new Error('reacquisition failed');
  const proof2=await auth.inspect(again.lease,libraryId,signal),newOp=auth.capture(again.lease,proof2,signal);
  // Explicitly deliver an already-queued old event after new authority acquisition.
  oldHandler.call(oldDb,new IDBVersionChangeEvent('versionchange'));
  const lateOldVersionChangeSafe=await read(auth,newOp);
  const failedOp=auth.capture(again.lease,proof2,signal);let firstDb!:IDBDatabase,abnormalSameOperationRejected=false;
  let abnormalScopeRejected=false;
  try {await auth.withOperationDatabase(failedOp,async()=>{
   await read(auth,failedOp);firstDb=await auth.openOperation(failedOp);
   // Synthetic abnormal-close event on a real connection; IDB close() itself is not an abnormal event.
   firstDb.close();firstDb.dispatchEvent(new Event('close'));
   try{await read(auth,failedOp);}catch{abnormalSameOperationRejected=true;}
  });}catch{abnormalScopeRejected=true;}
  abnormalSameOperationRejected=abnormalSameOperationRejected&&abnormalScopeRejected;
  const recoveryOp=auth.capture(again.lease,proof2,signal);let distinctConnection=false;
  await auth.withOperationDatabase(recoveryOp,async()=>{const next=await auth.openOperation(recoveryOp);distinctConnection=next!==firstDb;await read(auth,recoveryOp);});
  // An async Core callback completing after ownership loss cannot return a stale value.
  const asyncOp=auth.capture(again.lease,proof2,signal),asyncEntered=deferred(),asyncRelease=deferred();
  const stale=track(auth.withOperationDatabase(asyncOp,async()=>{asyncEntered.resolve();await asyncRelease.promise;return 'stale';}).then(()=>false,()=>true));
  await Promise.race([asyncEntered.promise,stale.then(()=>{throw new Error('async scope did not enter');})]);auth.invalidate();asyncRelease.resolve();const finalOwnerFence=await stale;
  const latest=await auth.discover(signal);if(latest.status!=='ready')throw new Error('post-invalidation reacquisition failed');
  const proof3=await auth.inspect(latest.lease,libraryId,signal),writeOp=auth.capture(latest.lease,proof3,signal);
  const siblingOp=auth.capture(latest.lease,proof3,signal),siblingReady=deferred(),siblingRelease=deferred();
  const sibling=track(auth.withOperationDatabase(siblingOp,async()=>{await read(auth,siblingOp);siblingReady.resolve();await siblingRelease.promise;return read(auth,siblingOp);}).then(value=>value===true,()=>false));
  await Promise.race([siblingReady.promise,sibling.then(()=>{throw new Error('sibling scope did not enter');})]);
  const sent=deferred(),markerId=crypto.randomUUID(),ns=JSON.stringify([proof3.scope.accountId,proof3.scope.libraryId,proof3.scope.epoch]);
  const markerKey=JSON.stringify([ns,markerId]);let sentObserved=false,abortObserved=false,writeResult!:Promise<boolean>;
  IDBDatabase.prototype.transaction=function(stores,mode,options){const tx=originalTx.call(this,stores,mode,options);if(mode==='readwrite'&&Array.from(typeof stores==='string'?[stores]:stores).includes('roots'))sent.resolve();return tx;};
  let outstandingRejected=false;
  try {
   await auth.withOperationDatabase(writeOp,async()=>{
    writeResult=track(canonicalHostTransaction(auth,writeOp,['roots'],'readwrite',(tx,_tuple,finish)=>{
     tx.objectStore('roots').put({key:markerKey,scope:ns,value:{kind:'markdown',id:markerId,version:crypto.randomUUID(),content:'must abort',appendIds:[],imageResources:[]}});finish(true);
    },{sent:()=>{sentObserved=true;},aborted:()=>{abortObserved=true;},completed:()=>{}}).then(()=>false,()=>true));
    await Promise.race([sent.promise,writeResult.then(()=>{throw new Error('write did not dispatch');})]);return 'must not succeed';
   });
  }catch{outstandingRejected=true;}
  finally{IDBDatabase.prototype.transaction=originalTx;}
  const writeRejected=await writeResult;
  const verify=await req(indexedDB.open(name));databases.add(verify);
  const tx=verify.transaction('roots','readonly'),completed=done(tx),marker=await req(tx.objectStore('roots').get(markerKey));await completed;verify.close();databases.delete(verify);
  const unawaitedWriteAborted=outstandingRejected&&writeRejected&&sentObserved&&abortObserved&&!marker;
  siblingRelease.resolve();const siblingUnaffected=await sibling;
  auth.close();
  return {openLateCases,spentOpenRejected,spentReentryRejected,lateOldVersionChangeSafe:lateOldVersionChangeSafe===true,abnormalSameOperationRejected,distinctConnection,finalOwnerFence,unawaitedWriteAborted,siblingUnaffected};
 } finally {
  for(const release of releases)release();
  for(const authority of authorities)authority.close();
  for(const database of databases)database.close();
  await Promise.allSettled([...flights]);
  if(originalOpen)indexedDB.open=originalOpen;
  IDBDatabase.prototype.close=originalClose;IDBDatabase.prototype.transaction=originalTx;
  await req(indexedDB.deleteDatabase(name));
 }
}
Object.assign(window,{indexedDbOperationDatabaseRaceCases:operationDatabaseRaceCases});

// Append to frontend/e2e/fixtures/indexedDbPlan.ts after the operation scope source candidate.
// Uses existing fixture imports and helpers. Each case owns an isolated canonical database.
async function independentScopeVersionChangeCase() {
 const name=`independent-vchange-${crypto.randomUUID()}`, signal=new AbortController().signal;
 const owner=new LocalHostAuthority(indexedDB,name), upgrader=new LocalHostAuthority(indexedDB,name);
 const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
 const release=deferred();let active:Promise<unknown>|undefined;
 try {
  const lease=await owner.provision(signal), storage=createOwnerInitialization(owner,lease), peer=await storage.getOrCreatePeer(signal);
  const request=await initialRequest('external versionchange',peer);await storage.prepare(request,signal);await storage.execute(request.control.id,signal);await storage.acknowledge(request.control.id,signal);
  const libraryId=request.profile.identity.libraryId, proof=await owner.inspect(lease,libraryId,signal);
  const external=await upgrader.discover(signal);if(external.status!=='ready')throw new Error('external owner missing');
  // The normally earlier watcher also invalidates the scope. Close that test-only watcher to isolate
  // actual UA delivery to the scoped connection and exercise its own onversionchange handler.
  const watcher=(owner as unknown as {watcher:IDBDatabase|null}).watcher;if(!watcher)throw new Error('watcher missing');watcher.close();
  const operation=owner.capture(lease,proof,signal),entered=deferred();let uaVersionChange=false,oldReadRejected=false;
  const read=(op:typeof operation)=>canonicalHostTransaction(owner,op,['roots'],'readonly',(_tx,tuple,finish)=>{if(!tuple)throw new Error('proof missing');finish(true);});
  active=owner.withOperationDatabase(operation,async()=>{
   await read(operation);const db=await owner.openOperation(operation);
   db.addEventListener('versionchange',event=>{uaVersionChange=event instanceof IDBVersionChangeEvent&&event.oldVersion===8&&event.newVersion===9;},{once:true});
   entered.resolve();await release.promise;
   try{await read(operation);}catch{oldReadRejected=true;}
  });
  // Surface an early flight failure instead of waiting forever on readiness.
  await Promise.race([entered.promise,active.then(()=>{throw new Error('scope ended before ready');},error=>{throw error;})]);
  // A separate authority runs the real grant-checked provider schema upgrade.
  await upgrader.upgradeProviderStorage(external.lease,signal);
  release.resolve();const oldScopeRejected=await active.then(()=>false,()=>true);
  const fresh=await owner.discover(signal);if(fresh.status!=='ready')throw new Error('owner reacquisition missing');
  const nextProof=await owner.inspect(fresh.lease,libraryId,signal), next=owner.capture(fresh.lease,nextProof,signal);
  const freshValidated=await owner.withOperationDatabase(next,()=>canonicalHostTransaction(owner,next,['roots'],'readonly',(_tx,tuple,finish)=>{if(!tuple)throw new Error('proof missing');finish(true);}));
  return {uaVersionChange,oldReadRejected,oldScopeRejected,freshValidated};
 } finally {
  release.resolve();
  // Close both authorities even if the flight or a cleanup action fails.
  try {try {owner.close();} finally {upgrader.close();}}
  finally {try {await active?.catch(()=>undefined);} finally {await req(indexedDB.deleteDatabase(name));}}
 }
}

async function independentScopedDeliveryCase() {
 const name=`independent-delivery-${crypto.randomUUID()}`,signal=new AbortController().signal,authority=new LocalHostAuthority(indexedDB,name);
 const nativeTransaction=IDBDatabase.prototype.transaction;let ports:ReturnType<typeof createBrowserScopePorts>|undefined;
 try {
  const lease=await authority.provision(signal),storage=createOwnerInitialization(authority,lease),peer=await storage.getOrCreatePeer(signal);
  const request=await initialRequest('scoped delivery',peer);await storage.prepare(request,signal);await storage.execute(request.control.id,signal);await storage.acknowledge(request.control.id,signal);
  const proof=await authority.inspect(lease,request.profile.identity.libraryId,signal),scope=proof.scope;
  ports=createBrowserScopePorts(authority,lease,proof,new BrowserMarkdownDraftPort(scope),new BrowserAnnotationAppendDraftPort(scope),new BrowserReaderStatePort(scope));
  const before=await ports.repository.read(scope.libraryId);
  const batch={kind:'library' as const,id:crypto.randomUUID(),libraryId:scope.libraryId,targetId:scope.libraryId,parents:[before.heads[0]],changes:[{type:'put-folder' as const,folder:{id:crypto.randomUUID(),title:'durable before delivery loss',parentId:null,position:0}}]};
  let invalidated=false,armed=true;
  IDBDatabase.prototype.transaction=function(stores,mode,options){const tx=nativeTransaction.call(this,stores,mode,options);if(armed&&mode==='readwrite'){armed=false;tx.addEventListener('complete',()=>{invalidated=true;authority.invalidate();},{once:true});}return tx;};
  let result;try{result=await ports.repository.commit(batch);}finally{IDBDatabase.prototype.transaction=nativeTransaction;}
  const raw=await req(indexedDB.open(name));
  try {
   const tx=raw.transaction('edits','readonly'), completed=done(tx);
   const ns=JSON.stringify([scope.accountId,scope.libraryId,scope.epoch]);
   const [stored]=await Promise.all([req(tx.objectStore('edits').get(JSON.stringify([ns,batch.id]))),completed]);
   return {invalidated,unknown:result.status==='unknown',durableWitness:stored?.value?.batch?.id===batch.id};
  } finally {raw.close();}
 } finally {
  IDBDatabase.prototype.transaction=nativeTransaction;
  try {await ports?.gate.close();} finally {try {authority.close();} finally {await req(indexedDB.deleteDatabase(name));}}
 }
}
Object.assign(window,{independentScopeVersionChangeCase,independentScopedDeliveryCase});



﻿// CP-only append to frontend/e2e/fixtures/indexedDbPlan.ts; uses existing imports/helpers.
// A genuinely awaited host transaction, aborted in the microtask after native dispatch.
async function awaitedScopedQueuedAbortRegression() {
 const name=`awaited-scoped-abort-${crypto.randomUUID()}`, signal=new AbortController().signal;
 const authority=new LocalHostAuthority(indexedDB,name), originalTransaction=IDBDatabase.prototype.transaction;
 let controller:AbortController|undefined;
 try {
  const lease=await authority.provision(signal),storage=createOwnerInitialization(authority,lease),peer=await storage.getOrCreatePeer(signal);
  const request=await initialRequest('awaited scoped queued abort',peer);await storage.prepare(request,signal);await storage.execute(request.control.id,signal);await storage.acknowledge(request.control.id,signal);
  const proof=await authority.inspect(lease,request.profile.identity.libraryId,signal);controller=new AbortController();
  const operation=authority.capture(lease,proof,controller.signal),cancel=controller;
  let armed=true, nativeCreated=false,nativeAborted=false,nativeCompleted=false,signalIssued=false;
  let evidenceSent=false,evidenceAborted=false,evidenceCompleted=false,enqueued=false;
  IDBDatabase.prototype.transaction=function(stores,mode,options){
   const tx=originalTransaction.call(this,stores,mode,options);
   if(armed&&mode==='readwrite'&&Array.from(typeof stores==='string'?[stores]:stores).includes('roots')){
    armed=false;nativeCreated=true;
    tx.addEventListener('abort',()=>{nativeAborted=true;});tx.addEventListener('complete',()=>{nativeCompleted=true;});
    queueMicrotask(()=>{signalIssued=true;cancel.abort();});
   }
   return tx;
  };
  let rejected=false;
  try {
   await authority.withOperationDatabase(operation,()=>canonicalHostTransaction(authority,operation,['roots'],'readwrite',(_tx,_tuple,finish)=>{enqueued=true;finish(true);},
    {sent:()=>{evidenceSent=true;},aborted:()=>{evidenceAborted=true;},completed:()=>{evidenceCompleted=true;}}));
  } catch {rejected=true;}
  return {nativeCreated,signalIssued,nativeAborted,nativeCompleted,evidenceSent,evidenceAborted,evidenceCompleted,enqueued,rejected};
 } finally {
  IDBDatabase.prototype.transaction=originalTransaction;controller?.abort();authority.close();await req(indexedDB.deleteDatabase(name));
 }
}
Object.assign(window,{awaitedScopedQueuedAbortRegression});

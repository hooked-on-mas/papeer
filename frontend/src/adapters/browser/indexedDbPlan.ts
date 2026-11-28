import { assertEditRecord } from '../../runtime/edits/editRecord.ts';
import { enqueueEditMutations, sameStoredValue as same } from './repository/indexedDbMutationWriter.ts';
import type { EditScope } from '../../runtime/edits/ports.ts';
import type { Snapshot } from '../../runtime/edits/contracts.ts';
import type { StoredEdit } from '../../runtime/edits/repository.ts';
import { selectorKey, type ApplyResult, type CapturedEditSnapshot, type EditMutation, type PlanDatabase, type PreparedEditPlan, type RepositoryOperation, type ScopeRead } from '../../runtime/edits/repositoryPlan.ts';
import { canonicalHostTransaction } from './canonicalHostTransaction.ts';
import type { BoundPlanEvidence } from '../../runtime/edits/repositoryExecution.ts';
import type { HostOperation, LocalHostAuthority, PersistentTuple } from './localHostAuthority.ts';

type Row = { key: string; scope: string; value: unknown };
type Token = { operation: RepositoryOperation; reads: ScopeRead[]; values: unknown[]; witnesses: unknown[]; used: boolean };
const key = (...parts: string[]) => JSON.stringify(parts);
const namespace = (scope: EditScope) => key(scope.accountId, scope.libraryId, scope.epoch);
// A queue is local to one authority and exact scope. CAS remains the authority
// across tabs, authority instances and all other writers.
const writeQueues = new WeakMap<LocalHostAuthority, Map<string, Promise<void>>>();
async function waitTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
 if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
 let cancel!: () => void;
 const aborted = new Promise<never>((_resolve, reject) => {
  cancel = () => reject(new DOMException('Cancelled', 'AbortError'));
  signal.addEventListener('abort', cancel, { once: true });
 });
 try { await Promise.race([previous, aborted]); }
 finally { signal.removeEventListener('abort', cancel); }
}
const sorted = <T>(items: T[], id: (value: T) => string) => items.sort((a,b) => id(a).localeCompare(id(b)));
const allowed = new Set<RepositoryOperation>(['read','read-intent','pending-intents','replace-intent','checkpoint','dataset-control','datasets','store-resource','read-resource','resource-metadata','commit','publish','receipt','pending','pending-records','pending-publications']);
function assertScope(scope: EditScope, read: ScopeRead): void {
 const other = read.kind === 'control' ? read.identity : read.scope;
 if (other.accountId !== scope.accountId || other.libraryId !== scope.libraryId || ('epoch' in other && other.epoch !== scope.epoch)) throw new Error('host-scope-mismatch');
}
function assertAdmission(tuple: PersistentTuple | null, scope: EditScope): void {
 if (!tuple || !same(tuple.scope,scope)) throw new Error('host-admission-invalid');
}
function collect(tx: IDBTransaction, reads: readonly ScopeRead[], finish: (result: { values: unknown[]; witnesses: unknown[] }) => void): void {
 const values: unknown[] = new Array(reads.length), witnesses: unknown[] = new Array(reads.length); let left=reads.length;
 const fullRootScopes = new Set(reads.flatMap(read=>read.kind==='roots'&&read.targetId===undefined?[namespace(read.scope)]:[]));
 const fullRoots = new Map<string, ReadonlyMap<string, Row>>(), rootWaiters = new Map<string, ((rows: ReadonlyMap<string, Row>) => void)[]>();
 const safe = (action: () => void) => () => { try { action(); } catch { try { tx.abort(); } catch { /* finished */ } } };
 if (!left) { finish({values,witnesses}); return; }
 const set = (i: number, value: unknown, physical: unknown) => { values[i]=value; witnesses[i]=physical; if (!--left) finish({values,witnesses}); };
 const validate = (row: Row, scope: string, id: string) => { if(row.scope!==scope || row.key!==key(scope,id)) throw new Error('storage-corruption'); };
 reads.forEach((read,i) => {
  if (read.kind === 'control') {
   const id=key(read.identity.accountId,read.identity.libraryId), a=tx.objectStore('datasetControls').get(id), b=tx.objectStore('datasetAccess').get(id); let n=2;
   const done=()=> { if (--n) return; const ar=a.result as Row|undefined, br=b.result as Row|undefined; if ((ar&&(ar.scope!==id||ar.key!==id||!same((ar.value as {identity?:unknown})?.identity,read.identity)))||(br&&(br.scope!==id||br.key!==id))) throw new Error('storage-corruption'); set(i,{control:ar?.value,access:br?.value},[ar,br]); }; a.onsuccess=safe(done);b.onsuccess=safe(done); return;
  }
  const ns=namespace(read.scope);
  if (read.kind === 'edit-by-id') {
   const request=tx.objectStore('edits').get(key(ns,read.batchId));
   request.onsuccess=safe(()=>{ const row=request.result as Row|undefined;
    if(row){validate(row,ns,read.batchId);const value=row.value as StoredEdit;
     if(!value || !value.batch || value.batch.id!==read.batchId || value.batch.libraryId!==read.scope.libraryId || !value.batch.targetId)throw new Error('storage-corruption');
     const {receipt,...record}=value;assertEditRecord(record);
     if(!receipt || Object.keys(receipt).sort().join(',')!=='durable,id,importedBy,targetId,upload' || receipt.id!==read.batchId || receipt.targetId!==value.batch.targetId || receipt.durable!==true || !['pending','accepted'].includes(receipt.upload) || !Array.isArray(receipt.importedBy) || receipt.importedBy.some(peer=>typeof peer!=='string'))throw new Error('storage-corruption');
    } set(i,row?.value,row); });return;
  }
  if (read.kind === 'roots' || read.kind === 'edits' || read.kind === 'intents') {
   const issue = () => { const request = read.targetId && read.kind !== 'edits' ? tx.objectStore(read.kind).get(key(ns,read.targetId)) : tx.objectStore(read.kind).index('scope').getAll(ns);
   request.onsuccess=safe(()=> { const raw = Array.isArray(request.result) ? request.result as Row[] : request.result ? [request.result as Row] : [];
    for(const row of raw){ const parts=JSON.parse(row.key) as unknown; if(!Array.isArray(parts)||parts.length!==2||typeof parts[1]!=='string')throw new Error('storage-corruption'); const id=parts[1]; validate(row,ns,id); const value=row.value as {id?:string;batch?:{id?:string;targetId?:string;libraryId?:string};intent?:{request?:{batch?:{targetId?:string;libraryId?:string};publication?:{libraryBatch?:{targetId?:string;libraryId?:string}}}}}; if(read.kind==='roots'&&value?.id!==id || read.kind==='edits'&&(value?.batch?.id!==id||value?.batch?.libraryId!==read.scope.libraryId) || read.kind==='intents'&&((value?.intent?.request?.batch?.targetId??value?.intent?.request?.publication?.libraryBatch?.targetId)!==id||(value?.intent?.request?.batch?.libraryId??value?.intent?.request?.publication?.libraryBatch?.libraryId)!==read.scope.libraryId))throw new Error('storage-corruption'); if(read.targetId&&read.kind!=='edits'&&id!==read.targetId)throw new Error('storage-corruption'); }
    const rows=raw.filter(row => (read.targetId === undefined || read.kind !== 'edits' || (row.value as StoredEdit).batch.targetId===read.targetId));
    if (read.kind==='roots') set(i,sorted(rows.map(row=>row.value as Snapshot),v=>v.id),raw);
    else if (read.kind==='edits') set(i,sorted(rows.map(row=>row.value as StoredEdit),v=>v.batch.id),raw);
    else set(i,sorted(rows.map(row=>({targetId:(JSON.parse(row.key) as string[])[1],record:row.value})),v=>v.targetId),raw);
    if (read.kind === 'roots' && read.targetId === undefined) {
     const byKey=new Map(raw.map(row=>[row.key,row]));
     fullRoots.set(ns,byKey); const waiting=rootWaiters.get(ns); rootWaiters.delete(ns); waiting?.forEach(ready=>ready(byKey));
    }
   }); };
   if (read.kind === 'roots' && read.targetId && fullRootScopes.has(ns)) {
    // Reuse only a verified present primary key from this same transaction.
    // An index miss must still perform the original point read: a corrupt row
    // may physically exist at that key while being hidden in another scope.
    const targetId=read.targetId, ready=(rows:ReadonlyMap<string,Row>)=>{
     const row=rows.get(key(ns,targetId));
     if(row)set(i,[row.value],[row]);else issue();
    };
    const rows=fullRoots.get(ns);
    if(rows)ready(rows);else{const waiting=rootWaiters.get(ns)??[];waiting.push(ready);rootWaiters.set(ns,waiting);}
   } else issue();
   return;
  }
  if (read.kind==='datasets') { const request=read.manifestId ? tx.objectStore('datasets').get(key(ns,read.manifestId)) : tx.objectStore('datasets').index('scope').getAll(ns);
   request.onsuccess=safe(()=>{ const rows=Array.isArray(request.result)?request.result as Row[]:request.result?[request.result as Row]:[]; for(const row of rows){const value=row.value as {id:string;scope:EditScope};validate(row,ns,value?.id);if(!same(value?.scope,read.scope)||(read.manifestId&&value.id!==read.manifestId))throw new Error('storage-corruption');} set(i,sorted(rows.map(row=>row.value as {id:string}),v=>v.id),rows); });return; }
  const store=read.kind==='resource'?'resources':read.kind==='resource-bytes'?'resourceBytes':'checkpoints';
  if(read.kind!=='resource' && !('sha256' in read))throw new Error('invalid-selector');
  const id=read.kind==='resource'?read.resourceId:read.sha256, request=tx.objectStore(store).get(key(ns,id));
  request.onsuccess=safe(()=>{ const row=request.result as Row|undefined; if(row){validate(row,ns,id); if(read.kind==='resource'&&((row.value as {id?:string;sha256?:string})?.id!==id||!/^[0-9a-f]{64}$/.test((row.value as {sha256?:string})?.sha256??'')) || read.kind==='resource-bytes'&&!(row.value instanceof Uint8Array) || read.kind==='checkpoint-marker'&&row.value!==true)throw new Error('storage-corruption');} set(i,read.kind==='checkpoint-marker' ? !!row : row?.value,row); });
 });
}
function covered(reads: readonly ScopeRead[], mutation: EditMutation): boolean {
 const match=(kind:ScopeRead['kind'],scope?:EditScope,target?:string)=>reads.some(read=>{
  if(read.kind!==kind)return false; if(read.kind==='control')return mutation.kind==='put-control' && read.identity.accountId===mutation.record.identity.accountId && read.identity.libraryId===mutation.record.identity.libraryId;
  if(!scope || namespace(read.scope)!==namespace(scope))return false;
  if(read.kind==='roots'||read.kind==='edits'||read.kind==='intents')return read.targetId===undefined||read.targetId===target;
  if(read.kind==='datasets')return read.manifestId===undefined||read.manifestId===target;
  if(read.kind==='resource')return read.resourceId===target; return 'sha256' in read && read.sha256===target;
 });
 switch(mutation.kind){
  case 'put-control':return match('control'); case 'put-root':return match('roots',mutation.scope,mutation.root.id);
  case 'put-edit':return match('edits',mutation.scope,mutation.edit.batch.targetId); case 'put-intent':return match('intents',mutation.scope,mutation.targetId);
  case 'put-dataset':return match('datasets',mutation.scope,mutation.manifest.id); case 'put-resource':return match('resource',mutation.scope,mutation.resource.metadata.id)&&match('resource-bytes',mutation.scope,mutation.resource.metadata.sha256);
  case 'remember-checkpoint':return match('checkpoint-marker',mutation.scope,mutation.sha256);
  case 'put-projection':return match('roots',mutation.scope,mutation.snapshot.id)||match('edits',mutation.scope,mutation.snapshot.id);
  case 'prune-projections':return match('roots',mutation.scope,mutation.targetId)||match('edits',mutation.scope,mutation.targetId);
 }
}
/** One instance is bound to one captured host operation and private evidence. */
export class IndexedDbPlan implements PlanDatabase {
 private readonly authority: LocalHostAuthority; private readonly host: HostOperation; private readonly scope: EditScope; private readonly evidence: BoundPlanEvidence;
 private readonly tokens = new WeakMap<object,Token>();
 constructor(authority: LocalHostAuthority, host: HostOperation, scope: EditScope, evidence: BoundPlanEvidence) { this.authority=authority;this.host=host;this.scope=Object.freeze(structuredClone(scope));this.evidence=evidence; }
 private async withWriteLease<T>(action: () => Promise<T>): Promise<T> {
  let queues = writeQueues.get(this.authority);
  if (!queues) { queues = new Map(); writeQueues.set(this.authority, queues); }
  const scopeKey = namespace(this.scope), previous = queues.get(scopeKey) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => turn);
  queues.set(scopeKey, tail);
  const map = queues;
  void tail.then(() => { if (map.get(scopeKey) === tail) map.delete(scopeKey); });
  try {
   await waitTurn(previous, this.host.signal);
   this.authority.captureRecord(this.host);
   const result = await action();
   this.authority.captureRecord(this.host);
   return result;
  } finally { release(); }
 }
 async withRetryLease<T>(action: (database: PlanDatabase) => Promise<T>): Promise<T> {
  return this.withWriteLease(async () => {
   let active = true;
   const flights = new Set<Promise<unknown>>();
   const track = <V>(promise: Promise<V>): Promise<V> => {
    flights.add(promise);
    void promise.then(() => flights.delete(promise), () => flights.delete(promise));
    return promise;
   };
   const assertActive = () => { if (!active) throw new Error('repository-retry-lease-expired'); };
   const bound: PlanDatabase = {
    capture: (operation, reads) => { assertActive(); return track(this.capture(operation, reads)); },
    compareAndApply: (operation, plan) => { assertActive(); return track(this.compareUnderLease(operation, plan)); },
   };
   try { return await action(bound); }
   finally { active = false; await Promise.allSettled([...flights]); }
  });
 }
 private permitted(operation: RepositoryOperation): boolean {
  if (allowed.has(operation)) return true;
  return this.authority.captureRecord(this.host).providerReplication === true
   && ['receive-records','acknowledge-upload','acknowledge-import'].includes(operation);
 }
 async capture(operation: RepositoryOperation, reads: readonly ScopeRead[]): Promise<CapturedEditSnapshot> {
  if (!this.permitted(operation)) throw new Error('host-operation-forbidden'); const stable=structuredClone([...reads]); stable.forEach(read=>{ assertScope(this.scope,read); if(read.kind==='edit-by-id' && operation!=='receipt')throw new Error('host-operation-forbidden'); });
  if(new Set(stable.map(selectorKey)).size!==stable.length)throw new Error('duplicate-selector');
  const values=await canonicalHostTransaction<{values:unknown[];witnesses:unknown[]}>(this.authority,this.host,['roots','edits','intents','datasets','resources','resourceBytes','checkpoints','datasetControls','datasetAccess'],'readonly', (tx,tuple,finish)=>{ assertAdmission(tuple,this.scope);collect(tx,stable,finish); });
  const token=Object.freeze({}); this.tokens.set(token,{operation,reads:structuredClone(stable),values:structuredClone(values.values),witnesses:structuredClone(values.witnesses),used:false});
  return {values:stable.map((read,i)=>({read:structuredClone(read),value:structuredClone(values.values[i])})),comparison:token};
 }
 async compareAndApply(operation: RepositoryOperation, plan: PreparedEditPlan<unknown>): Promise<ApplyResult> {
  return this.withWriteLease(() => this.compareUnderLease(operation, plan));
 }
 private async compareUnderLease(operation: RepositoryOperation, plan: PreparedEditPlan<unknown>): Promise<ApplyResult> {
  if(!this.permitted(operation))throw new Error('host-operation-forbidden'); const token=this.tokens.get(plan.snapshot.comparison);
  if(!token||token.used||token.operation!==operation)throw new Error('invalid-snapshot-token');token.used=true;
  const mutations=structuredClone([...plan.mutations]); if(!token.reads.length||mutations.some(m=>!covered(token.reads,m)))throw new Error('mutation-prestate-not-captured');
  for(const m of mutations){if(m.kind==='put-control')throw new Error('host-operation-forbidden'); assertScope(this.scope,{kind:'roots',scope:m.scope});}
  const attempt=this.evidence.startAttempt(); let sent=false, terminal=false;
  const observer={ sent:()=>{sent=true;attempt.sent();}, aborted:()=>{terminal=true;attempt.aborted();},
    completed:(value:unknown)=>{terminal=true;if(value && typeof value==='object' && 'status' in value && value.status==='changed')attempt.casNoWrite();else attempt.committed();} };
  let result: ApplyResult; try { result=await canonicalHostTransaction<ApplyResult>(this.authority,this.host,['roots','edits','intents','datasets','resources','resourceBytes','checkpoints','projections','pages','datasetControls','datasetAccess'],'readwrite',(tx,tuple,finish)=>{
   assertAdmission(tuple,this.scope);collect(tx,token.reads,result=>{if(!same(result.values,token.values)||!same(result.witnesses,token.witnesses)){finish({status:'changed'});return;} this.apply(tx,mutations,()=>finish({status:'committed'}));});
  },observer); } catch (error) { if(sent&&!terminal)attempt.unknown(); throw error; }
  return result;
 }
 private apply(tx: IDBTransaction, mutations: readonly EditMutation[], finish: () => void): void {
  enqueueEditMutations(tx, this.scope, mutations, finish);
 }
}

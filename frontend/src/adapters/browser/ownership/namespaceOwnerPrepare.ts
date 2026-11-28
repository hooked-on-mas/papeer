import type { InitializationOutcome } from '../../../runtime/edits/canonicalInitializationStorage.ts';
import type { CanonicalInitializeRequest, CanonicalLibraryInitializationIntent, CanonicalLibraryProfile } from '../../../runtime/edits/contracts.ts';
import { makeInitializationIntent } from '../../../runtime/edits/canonicalInitializationIntent.ts';
import { initializationReceipt, validateInitializationRead, type CanonicalStoredRow, type InitializationReadSnapshot } from '../../../runtime/edits/canonicalInitializationReadProof.ts';
import { canonicalJson, EditRejected } from '../../../runtime/edits/editModel.ts';
import { CANONICAL_STORES } from '.././canonicalIndexedDbSchema.ts';
import type { LocalHostAuthority, HostOperation } from '.././localHostAuthority.ts';
import { namespaceOwnerAccount, namespaceOwnerTransaction } from './namespaceOwnerTransaction.ts';

const stores = ['canonicalPeers', 'canonicalProfiles', 'canonicalInitialIntents', 'canonicalInitialArtifacts', ...CANONICAL_STORES] as const;
type StoreName = typeof stores[number];
export type Rows = Record<StoreName, CanonicalStoredRow[]>;
const key = (...parts: string[]) => JSON.stringify(parts);
export function scopeParts(scope: string): unknown[] { try { const value: unknown = JSON.parse(scope); return Array.isArray(value) ? value : []; } catch { return []; } }
export function readProofRows(rows: Rows, account: string): InitializationReadSnapshot {
 const own = (r: CanonicalStoredRow[]) => r.filter(v => v.scope === account);
 const scoped = (r: CanonicalStoredRow[]) => r.filter(v => scopeParts(v.scope)[0] === account);
 return { profiles: own(rows.canonicalProfiles), intents: own(rows.canonicalInitialIntents), artifacts: own(rows.canonicalInitialArtifacts), controls: scoped(rows.datasetControls), roots: scoped(rows.roots), datasets: scoped(rows.datasets), checkpoints: scoped(rows.checkpoints) };
}
/** Only this request, target identity and account-wide request/library collisions enter CAS. */
export function relevant(rows: Rows, account: string, library: string, requestId: string): unknown {
 const ownProfiles = rows.canonicalProfiles.filter(row => row.scope === account);
 const ownIntents = rows.canonicalInitialIntents.filter(row => row.scope === account);
 const matchedProfiles = ownProfiles.filter(row => { const p = row.value as CanonicalLibraryProfile; return row.key === key(account, library) || p.initialization?.requestId === requestId; });
 const relevantLibraries = new Set([library, ...matchedProfiles.map(row => (row.value as CanonicalLibraryProfile).identity.libraryId)]);
 const matchesLibrary = (scope: string) => { const parts = scopeParts(scope); return parts[0] === account && typeof parts[1] === 'string' && relevantLibraries.has(parts[1]); };
 const selectedIntents = ownIntents.filter(row => { const i = row.value as CanonicalLibraryInitializationIntent; const id = 'retired' in i ? i.identity : i.request.profile.identity; return i.requestId === requestId || id.libraryId === library; });
 const canonical = Object.fromEntries(CANONICAL_STORES.map(name => [name, rows[name].filter(row => matchesLibrary(row.scope))]));
 return { peer: rows.canonicalPeers.filter(row => row.key === account), profiles: matchedProfiles, intents: selectedIntents,
   artifacts: rows.canonicalInitialArtifacts.filter(row => row.scope === account && relevantLibraries.has(String(scopeParts(row.key)[1]))), canonical };
}
/** Collect only target/collision metadata, then indexed target-library occupancy. Resource bodies are never read. */
export function collectOwnerRows(tx: IDBTransaction, account: string, library: string, requestId: string, callback: (rows: Rows) => void): void {
 const rows = Object.fromEntries(stores.map(name => [name, []])) as unknown as Rows;
 let pending = 4;
 const metadataDone = () => {
  if (--pending) return;
  rows.canonicalProfiles = rows.canonicalProfiles.filter(row => { const p = row.value as CanonicalLibraryProfile; return row.key === key(account, library) || p.initialization?.requestId === requestId; });
  rows.canonicalInitialIntents = rows.canonicalInitialIntents.filter(row => { const i = row.value as CanonicalLibraryInitializationIntent; const identity = 'retired' in i ? i.identity : i.request.profile.identity; return i.requestId === requestId || identity.libraryId === library; });
  const libraries = new Set([library, ...rows.canonicalProfiles.map(row => (row.value as CanonicalLibraryProfile).identity.libraryId)]);
  rows.canonicalInitialArtifacts = rows.canonicalInitialArtifacts.filter(row => libraries.has(String(scopeParts(row.key)[1])));
  let cursors = 0;
  const finished = () => { if (--cursors === 0) callback(rows); };
  for (const lib of libraries) for (const name of CANONICAL_STORES) {
   const identity = key(account, lib), prefix = identity.slice(0, -1) + ',';
   const range = name === 'datasetControls' || name === 'datasetAccess' ? IDBKeyRange.only(identity) : IDBKeyRange.bound(prefix, prefix + '\uffff');
   const store = tx.objectStore(name), index = store.index('scope'); cursors++;
   const valuesNeeded = name === 'roots' || name === 'datasets' || name === 'checkpoints' || name === 'datasetControls';
   const cursor = valuesNeeded ? index.openCursor(range) : index.openKeyCursor(range);
   cursor.onsuccess = () => {
    const item = cursor.result; if (!item) { finished(); return; }
    if (valuesNeeded) rows[name].push((item as IDBCursorWithValue).value as CanonicalStoredRow);
    else rows[name].push({ key: String(item.primaryKey), scope: String(item.key), value: null });
    item.continue();
   };
  }
  if (!cursors) callback(rows);
 };
 const peer = tx.objectStore('canonicalPeers').get(account); peer.onsuccess = () => { if (peer.result) rows.canonicalPeers.push(peer.result as CanonicalStoredRow); metadataDone(); };
 for (const name of ['canonicalProfiles', 'canonicalInitialIntents', 'canonicalInitialArtifacts'] as const) {
  const request = tx.objectStore(name).index('scope').getAll(account);
  request.onsuccess = () => { rows[name] = request.result as CanonicalStoredRow[]; metadataDone(); };
 }
}
export function ownerRows<T>(authority: LocalHostAuthority, operation: HostOperation, mode: IDBTransactionMode, library: string, requestId: string, action: (rows: Rows, tx: IDBTransaction) => T): Promise<T> {
 return namespaceOwnerTransaction<T>(authority,operation,stores,mode,(tx,account,finish)=>collectOwnerRows(tx,account,library,requestId,rows=>{try{finish(action(rows,tx));}catch{try{tx.abort();}catch{/* closed */}}}));
}
export async function prepareOwner(authority: LocalHostAuthority, operation: HostOperation, request: CanonicalInitializeRequest): Promise<InitializationOutcome> {
 const account=namespaceOwnerAccount(authority,operation), fixed=await makeInitializationIntent(request,account);namespaceOwnerAccount(authority,operation);
 if('retired' in fixed)throw new Error('invalid-initialization-intent');
 const library=fixed.request.profile.identity.libraryId, requestId=fixed.requestId;
 const captured=await ownerRows(authority,operation,'readonly',library,requestId,rows=>structuredClone(rows));
 const valid=await validateInitializationRead(readProofRows(captured,account),account); namespaceOwnerAccount(authority,operation);
 const intent=valid.intents.find(value=>value.requestId===requestId),profile=valid.profiles.find(value=>value.initialization?.requestId===requestId);
 if(intent||profile){const digest=intent?intent.requestSha256:profile!.initialization!.requestSha256;
  const identity=intent?('retired' in intent?intent.identity:intent.request.profile.identity):profile!.identity;
  if(digest!==fixed.requestSha256||canonicalJson(identity)!==canonicalJson(fixed.request.profile.identity))throw new EditRejected('dataset-request-reused');
 }else if(valid.intents.some(value=>!('retired' in value)&&value.request.profile.identity.libraryId===library))throw new EditRejected('dataset-library-request-pending');
 const result:InitializationOutcome=profile?{status:'accepted',receipt:initializationReceipt(profile)}:intent?intent.result??{status:'pending'}:{status:'pending'};
 const expected=canonicalJson(relevant(captured,account,library,requestId));
 return ownerRows(authority,operation,'readwrite',library,requestId,(rows,tx)=>{
  if(canonicalJson(relevant(rows,account,library,requestId))!==expected)throw new Error('retry-snapshot');
  if(!intent&&!profile)tx.objectStore('canonicalInitialIntents').add({key:key(account,requestId),scope:account,value:fixed});return result;
 });
}

export function loadOwnerIntent(authority:LocalHostAuthority,operation:HostOperation,requestId:string):Promise<CanonicalLibraryInitializationIntent|null>{
 return namespaceOwnerTransaction<CanonicalLibraryInitializationIntent|null>(authority,operation,['canonicalInitialIntents'],'readonly',(tx,account,finish)=>{
  const req=tx.objectStore('canonicalInitialIntents').get(key(account,requestId));req.onsuccess=()=>{const row=req.result as CanonicalStoredRow|undefined;
   if(row&&(row.key!==key(account,requestId)||row.scope!==account)){tx.abort();return;}finish((row?.value as CanonicalLibraryInitializationIntent|undefined)??null);};
 });
}

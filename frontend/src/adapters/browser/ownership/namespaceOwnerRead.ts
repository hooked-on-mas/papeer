import type { InitializationOutcome } from '../../../runtime/edits/canonicalInitializationStorage.ts';
import type { CanonicalLibraryProfile, CanonicalLibraryInitializationIntent } from '../../../runtime/edits/contracts.ts';
import { initializationReceipt, validateInitializationRead, type CanonicalStoredRow, type InitializationReadSnapshot } from '../../../runtime/edits/canonicalInitializationReadProof.ts';
import type { LocalHostAuthority, HostOperation } from '.././localHostAuthority.ts';
import { namespaceOwnerAccount, namespaceOwnerTransaction } from './namespaceOwnerTransaction.ts';

export async function ownerSnapshot(authority:LocalHostAuthority, operation:HostOperation):Promise<InitializationReadSnapshot> {
 const names=['canonicalProfiles','canonicalInitialIntents','canonicalInitialArtifacts','datasetControls','roots','datasets','checkpoints'];
 return namespaceOwnerTransaction<InitializationReadSnapshot>(authority,operation,names,'readonly',(tx,account,finish)=>{
  const rows:CanonicalStoredRow[][]=names.map(()=>[]);let metadata=3;
  const after=()=>{if(--metadata)return;try{
   const libraries=new Set(rows[0].map(row=>(row.value as CanonicalLibraryProfile).identity.libraryId));let pending=libraries.size*4;
   const done=()=>{if(--pending===0)finish(structuredClone({profiles:rows[0],intents:rows[1],artifacts:rows[2],controls:rows[3],roots:rows[4],datasets:rows[5],checkpoints:rows[6]}));};
   if(!pending){finish(structuredClone({profiles:rows[0],intents:rows[1],artifacts:rows[2],controls:rows[3],roots:rows[4],datasets:rows[5],checkpoints:rows[6]}));return;}
   for(const library of libraries){const identity=JSON.stringify([account,library]),prefix=identity.slice(0,-1)+',';
    for(let i=3;i<names.length;i++){const range=i===3?IDBKeyRange.only(identity):IDBKeyRange.bound(prefix,prefix+'\uffff');const cursor=tx.objectStore(names[i]).index('scope').openCursor(range);
     cursor.onsuccess=()=>{const item=cursor.result;if(item){rows[i].push(item.value as CanonicalStoredRow);item.continue();}else done();};}}
  }catch{try{tx.abort();}catch{/* closed */}}};
  for(let i=0;i<3;i++){const req=tx.objectStore(names[i]).index('scope').getAll(account);req.onsuccess=()=>{rows[i]=req.result as CanonicalStoredRow[];after();};}
 });
}
export async function listOwner(authority:LocalHostAuthority,operation:HostOperation):Promise<{profiles:CanonicalLibraryProfile[];intents:CanonicalLibraryInitializationIntent[]}>{
 const account=namespaceOwnerAccount(authority,operation), snapshot=await ownerSnapshot(authority,operation);
 const result=await validateInitializationRead(snapshot,account);namespaceOwnerAccount(authority,operation);
 return {profiles:result.profiles,intents:result.intents.filter(intent=>!('retired' in intent))};
}
export async function queryOwner(authority:LocalHostAuthority,operation:HostOperation,requestId:string):Promise<InitializationOutcome>{
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId))throw new Error('invalid-id');
 const account=namespaceOwnerAccount(authority,operation),snapshot=await ownerSnapshot(authority,operation),result=await validateInitializationRead(snapshot,account);namespaceOwnerAccount(authority,operation);
 const profile=result.profiles.find(value=>value.initialization?.requestId===requestId),intent=result.intents.find(value=>value.requestId===requestId);
 if(profile)return {status:'accepted',receipt:initializationReceipt(profile)};return intent?.result??(intent?{status:'pending'}:{status:'not-found'});
}

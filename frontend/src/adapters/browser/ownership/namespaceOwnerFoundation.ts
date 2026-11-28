import { validateCanonicalDevicePeer, type CanonicalDevicePeer } from '../../../runtime/edits/contracts.ts';
import type { LocalHostAuthority, HostOperation } from '.././localHostAuthority.ts';
import { namespaceOwnerAccount, namespaceOwnerTransaction } from './namespaceOwnerTransaction.ts';

/** Existing database only; explicit host provisioning creates its schema before this operation. */
export async function getOrCreateOwnerPeer(authority: LocalHostAuthority, operation: HostOperation, candidatePeerId: string): Promise<CanonicalDevicePeer> {
 const account = namespaceOwnerAccount(authority,operation), candidate: CanonicalDevicePeer = {version:1,accountId:account,peerId:candidatePeerId};
 validateCanonicalDevicePeer(candidate);
 return namespaceOwnerTransaction<CanonicalDevicePeer>(authority, operation, ['canonicalPeers'], 'readwrite', (tx, actual, finish) => {
  if(actual!==account)throw new Error('namespace-owner-invalid');
  const store=tx.objectStore('canonicalPeers'), request=store.get(account);
  request.onsuccess=()=>{try{
   const row=request.result as {key:string;scope:string;value:CanonicalDevicePeer}|undefined;
   if(row){validateCanonicalDevicePeer(row.value);if(row.key!==account||row.scope!==account||row.value.accountId!==account)throw new Error('recovery-required');finish(structuredClone(row.value));}
   else {store.add({key:account,scope:account,value:candidate});finish(candidate);}
  }catch{try{tx.abort();}catch{/* transaction already completed */}}};
 });
}

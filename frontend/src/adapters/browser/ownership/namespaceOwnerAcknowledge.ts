import type { CanonicalLibraryInitializationIntent } from '../../../runtime/edits/contracts.ts';
import { validateInitializationRead } from '../../../runtime/edits/canonicalInitializationReadProof.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import { loadOwnerIntent, readProofRows, relevant, ownerRows } from './namespaceOwnerPrepare.ts';
import { queryOwner } from './namespaceOwnerRead.ts';
import { namespaceOwnerAccount } from './namespaceOwnerTransaction.ts';
import type { LocalHostAuthority, HostOperation } from '.././localHostAuthority.ts';
const key=(...parts:string[])=>JSON.stringify(parts);
export async function acknowledgeOwner(authority:LocalHostAuthority,operation:HostOperation,requestId:string):Promise<void>{
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId))throw new Error('invalid-id');
 const account=namespaceOwnerAccount(authority,operation);
   const first = await loadOwnerIntent(authority,operation,requestId); namespaceOwnerAccount(authority,operation);
   if (!first || 'retired' in first) { await queryOwner(authority,operation,requestId); return; }
   const libraryId = first.request.profile.identity.libraryId;
   const captured = await ownerRows(authority,operation,'readonly', libraryId, requestId, rows => structuredClone(rows));
   const valid = await validateInitializationRead(readProofRows(captured, account), account); namespaceOwnerAccount(authority,operation);
   const intent = valid.intents.find(value => value.requestId === requestId);
   if (!intent || 'retired' in intent) return;
   if (!intent.result) throw new Error('initialization-pending');
   const finalResult = intent.result;
   const library = intent.request.profile.identity.libraryId, expected = canonicalJson(relevant(captured, account, library, requestId));
   await ownerRows(authority,operation,'readwrite', library, requestId, (rows, tx) => {
    if (canonicalJson(relevant(rows, account, library, requestId)) !== expected) throw new Error('retry-snapshot');
    if (finalResult.status === 'accepted') {
     // validateInitializationRead already verified the exact profile, immutable rows and current control.
     tx.objectStore('canonicalInitialIntents').delete(key(account, requestId));
    } else {
     const retired: CanonicalLibraryInitializationIntent = { version: 1, accountId: intent.accountId, requestId: intent.requestId,
       requestSha256: intent.requestSha256, identity: intent.request.profile.identity, result: finalResult, retired: true };
     tx.objectStore('canonicalInitialIntents').put({ key: key(account, requestId), scope: account, value: retired });
    }
   });
   namespaceOwnerAccount(authority,operation);
}

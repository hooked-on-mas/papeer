import type { HostLease, OwnerInitializationFacade } from '../../../features/bootstrap/bootstrapPorts.ts';
import type { LocalHostAuthority } from '.././localHostAuthority.ts';
import { namespaceOwnerAccount } from './namespaceOwnerTransaction.ts';
import { getOrCreateOwnerPeer } from './namespaceOwnerFoundation.ts';
import { listOwner, queryOwner } from './namespaceOwnerRead.ts';
import { prepareOwner } from './namespaceOwnerPrepare.ts';
import { executeOwner } from './namespaceOwnerExecute.ts';
import { acknowledgeOwner } from './namespaceOwnerAcknowledge.ts';
/** Lease is opaque and issuer-verified afresh at each operation; no caller-selected account or DB. */
export function createOwnerInitialization(authority:LocalHostAuthority,lease:HostLease):OwnerInitializationFacade & {list(signal:AbortSignal):ReturnType<typeof listOwner>} {
 const run=<T>(signal:AbortSignal,action:(operation:ReturnType<LocalHostAuthority['captureNamespaceOwner']>)=>Promise<T>):Promise<T>=>{
  const operation=authority.captureNamespaceOwner(lease,signal);
  return Promise.resolve().then(()=>{namespaceOwnerAccount(authority,operation);return action(operation);}).then(value=>{namespaceOwnerAccount(authority,operation);return value;});
 };
 const facade:OwnerInitializationFacade & {list(signal:AbortSignal):ReturnType<typeof listOwner>} = {list:signal=>run(signal,op=>listOwner(authority,op)),getOrCreatePeer:signal=>run(signal,op=>getOrCreateOwnerPeer(authority,op,crypto.randomUUID())),
  prepare:(request,signal)=>{const fixed=structuredClone(request);return run(signal,op=>prepareOwner(authority,op,fixed));},query:(id,signal)=>run(signal,op=>queryOwner(authority,op,id)),
  execute:(id,signal)=>run(signal,op=>executeOwner(authority,op,id)),acknowledge:(id,signal)=>run(signal,op=>acknowledgeOwner(authority,op,id))};
 return Object.freeze(facade);
}

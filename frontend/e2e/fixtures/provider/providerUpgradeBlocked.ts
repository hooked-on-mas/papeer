import { LocalHostAuthority } from '../../../src/adapters/browser/localHostAuthority.ts';
import { createOwnerInitialization } from '../../../src/adapters/browser/ownership/browserOwnerInitialization.ts';
import { initialRequest } from '../../../src/features/bootstrap/initialRequest.ts';
import { canonicalJson } from '../../../src/runtime/edits/editModel.ts';
import { openCanonicalDatabase } from '../../../src/adapters/browser/canonicalIndexedDbSchema.ts';
const ensure = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function open(name: string) {
 return new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name);
  request.onupgradeneeded = () => { request.transaction?.abort();reject(new Error('existing database required')); };
  request.onerror = () => reject(request.error);request.onsuccess = () => resolve(request.result); });
}
async function inventory(db: IDBDatabase) {
 const stores = Array.from(db.objectStoreNames);
 return new Promise<{ version: number; rows: Record<string, unknown[]> }>((resolve, reject) => {
  const tx = db.transaction(stores, 'readonly'), requests = stores.map(name => tx.objectStore(name).getAll());
  tx.onabort = () => reject(tx.error);tx.oncomplete = () => resolve({ version: db.version, rows: Object.fromEntries(stores.map((name, index) => [name, requests[index].result])) });
 });
}
/** Contract-only foreign IDB connection deliberately holds version8. No dirty-editor or natural UI claim. */
export async function exerciseBlockedUpgrade() {
 const name = `provider-blocked-upgrade-${crypto.randomUUID()}`, authority = new LocalHostAuthority(indexedDB, name), signal = new AbortController().signal;
 let blocker: IDBDatabase | undefined;
 try {
  const lease = await authority.provision(signal), owner = createOwnerInitialization(authority, lease), request = await initialRequest('Blocked upgrade retained Library', await owner.getOrCreatePeer(signal));
  ensure((await owner.prepare(request, signal)).status === 'pending', 'real local prepare failed');
  ensure((await owner.execute(request.control.id, signal)).status === 'accepted', 'real local initialization failed');await owner.acknowledge(request.control.id, signal);
  blocker = await open(name);let versionChangeSeen = 0;blocker.onversionchange = () => { versionChangeSeen++; };
  const before = await inventory(blocker);ensure(before.version === 8, 'populated baseline must be schema8');
  let rejected: string | null = null;try { await authority.upgradeProviderStorage(lease, signal); } catch (error) { rejected = String(error); }
  ensure(rejected === 'Error: provider-upgrade-blocked' && versionChangeSeen > 0, 'actual blocked rejection/versionchange missing');
  // Releasing the blocker permits the ALREADY REJECTED open request to fire a late upgradeneeded.
  blocker.close();blocker = undefined;
  const afterConnection = await open(name);let after;
  try { after = await inventory(afterConnection); } finally { afterConnection.close(); }
  ensure(canonicalJson(after) === canonicalJson(before), 'rejected upgrade committed late schema/row changes');
  const rediscovered = await authority.discover(signal);ensure(rediscovered.status === 'ready', 'unchanged local context no longer discoverable');
  return { rejected, versionChangeSeen, before, after, rediscoveredStatus: rediscovered.status };
 } finally {
  blocker?.close();authority.close();await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name);
   request.onsuccess = () => resolve();request.onerror = () => reject(request.error);request.onblocked = () => reject(new Error('fixture cleanup blocked')); });
 }
}

/** Schema-only legacy fixture: sentinel data is not a canonical grant, repository or admission. */
export async function exerciseBaseBlockedUpgrade() {
 const name = `canonical-blocked-upgrade-${crypto.randomUUID()}`;
 let blocker: IDBDatabase | undefined;
 try {
  blocker = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name, 1);
   request.onupgradeneeded = () => { const store = request.result.createObjectStore('legacy-retained', { keyPath: 'key' });store.createIndex('scope', 'scope', { unique: false }); };
   request.onerror = () => reject(request.error);request.onsuccess = () => resolve(request.result); });
  await new Promise<void>((resolve, reject) => { const tx = blocker!.transaction('legacy-retained', 'readwrite');
   tx.objectStore('legacy-retained').add({ key: 'sentinel', scope: 'legacy', value: 'Existing legacy bytes must survive a rejected upgrade' });
   tx.oncomplete = () => resolve();tx.onabort = () => reject(tx.error); });
  let versionChangeSeen = 0;blocker.onversionchange = () => { versionChangeSeen++; };
  const before = await inventory(blocker);let rejected: string | null = null;
  try { const unexpected = await openCanonicalDatabase(indexedDB, name);unexpected.close(); } catch (error) { rejected = String(error); }
  ensure(rejected === 'Error: canonical-database-blocked' && versionChangeSeen > 0, 'base blocked rejection/versionchange missing');
  blocker.close();blocker = undefined;
  const afterConnection = await open(name);let after;
  try { after = await inventory(afterConnection); } finally { afterConnection.close(); }
  ensure(canonicalJson(after) === canonicalJson(before), 'rejected base upgrade committed late schema/row changes');
  return { rejected, versionChangeSeen, before, after };
 } finally {
  blocker?.close();await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name);
   request.onsuccess = () => resolve();request.onerror = () => reject(request.error);request.onblocked = () => reject(new Error('fixture cleanup blocked')); });
 }
}

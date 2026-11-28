import fixture from '../../../tests/fixtures/canonical-local-owner-grant.json';
import { assertLocalOwnerGrant } from '../../src/runtime/edits/canonicalLocalGrant.ts';
import { validateCanonicalLocalOwnerGrant } from '../../src/runtime/edits/contracts.ts';
import { discoverLocalGrant, provisionLocalGrant } from '../../src/adapters/browser/ownership/canonicalLocalGrantIndexedDb.ts';

const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
async function oldDatabase(name: string, occupied: boolean) {
  const opening = indexedDB.open(name, 7);
  opening.onupgradeneeded = () => { const store = opening.result.createObjectStore('roots', { keyPath:'key' }); if (occupied) store.add({ key:'existing', value:'preserved' }); };
  (await request(opening)).close();
}
async function remove(name: string) { await request(indexedDB.deleteDatabase(name)); }
async function cases() {
  const name = `grant-${crypto.randomUUID()}`, legacy = `grant-old-${crypto.randomUUID()}`;
  try {
    assertLocalOwnerGrant(fixture.valid);
    validateCanonicalLocalOwnerGrant(fixture.valid);
    let invalid = 0; for (const value of fixture.invalid) { let model = false, wire = false; try { assertLocalOwnerGrant(value); } catch { model = true; } try { validateCanonicalLocalOwnerGrant(value); } catch { wire = true; } if (model && wire) invalid++; }
    const absent = (await discoverLocalGrant(indexedDB, name)).status === 'setup-required';
    const probe = indexedDB.open(name); let created = false;
    probe.onupgradeneeded = () => { created = true; probe.transaction?.abort(); };
    try { await request(probe); } catch { /* expected aborted creation */ }
    await oldDatabase(name, false);
    const before = await discoverLocalGrant(indexedDB, name);
    const readonlyOld = before.status === 'setup-required' && before.reason === 'schema-upgrade';
    const oldDb = await request(indexedDB.open(name)); const oldVersion = oldDb.version === 7; oldDb.close();
    const [first, second] = await Promise.all([provisionLocalGrant(indexedDB, name), provisionLocalGrant(indexedDB, name)]);
    const winner = JSON.stringify(first) === JSON.stringify(second);
    const ready = await discoverLocalGrant(indexedDB, name);
    const same = ready.status === 'ready' && JSON.stringify(ready.grant) === JSON.stringify(first);
    const db = await request(indexedDB.open(name)); const tx = db.transaction('canonicalLocalGrant','readwrite');
    tx.objectStore('canonicalLocalGrant').put({ key:'primary-local-context', scope:'primary-local-context', value:{} }); await done(tx); db.close();
    const corrupt = (await discoverLocalGrant(indexedDB, name)).status === 'recovery-required';
    let refused = false; try { await provisionLocalGrant(indexedDB, name); } catch { refused = true; }
    const stillCorrupt = (await discoverLocalGrant(indexedDB, name)).status === 'recovery-required';
    await oldDatabase(legacy, true);
    const ungranted = await discoverLocalGrant(indexedDB, legacy);
    let noAdoption = false; try { await provisionLocalGrant(indexedDB, legacy); } catch { noAdoption = true; }
    const legacyDb = await request(indexedDB.open(legacy)); const read = legacyDb.transaction(['roots','canonicalLocalGrant'],'readonly');
    const root = read.objectStore('roots').get('existing'), count = read.objectStore('canonicalLocalGrant').count(); await done(read); legacyDb.close();
    return { fixture: invalid === fixture.invalid.length, absent, noCreate: created, readonlyOld, oldVersion, winner, same, corrupt, refused, stillCorrupt,
      ungranted: ungranted.status === 'recovery-required', noAdoption, preserved: root.result?.value === 'preserved' && count.result === 0 };
  } finally { await remove(name); await remove(legacy); }
}
Object.assign(window, { canonicalLocalGrantCases: cases });

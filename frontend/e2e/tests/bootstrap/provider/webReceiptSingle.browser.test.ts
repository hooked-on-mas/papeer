import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openComposition } from '../../../support/documentComposition.ts';

for (const engine of ['chromium', 'webkit'] as const) test(`receipt uses one IndexedDB edit key (${engine})`, { timeout: 120_000 }, async t => {
 const setup = await openComposition(t, engine);
 const page = setup.web, batchId = setup.publication.libraryBatch.id, scope = setup.repository.scope;
 const observed = await page.evaluate(async ({ batchId, scope }) => {
  const namespace = JSON.stringify([scope.accountId, scope.libraryId, scope.epoch]), wanted = JSON.stringify([namespace, batchId]);
  const prototype = IDBObjectStore.prototype, oldGet = Object.getOwnPropertyDescriptor(prototype, 'get')!, oldGetAll = Object.getOwnPropertyDescriptor(prototype, 'getAll')!;
  const indexPrototype = IDBIndex.prototype, oldIndexGetAll = Object.getOwnPropertyDescriptor(indexPrototype, 'getAll')!;
  const transactions = new WeakMap<IDBTransaction, number>(); let next = 0;
  const id = (tx: IDBTransaction) => { let n=transactions.get(tx); if(!n){n=++next;transactions.set(tx,n);} return n; };
  const calls: { tx:number; method:string; key?:unknown }[] = [];
  Object.defineProperty(prototype, 'get', { ...oldGet, value: function(this: IDBObjectStore, ...args: unknown[]) {
   if(this.name==='edits') calls.push({tx:id(this.transaction),method:'get',key:args[0]});
   return Reflect.apply(oldGet.value,this,args);
  }});
  Object.defineProperty(prototype, 'getAll', { ...oldGetAll, value: function(this: IDBObjectStore, ...args: unknown[]) {
   if(this.name==='edits') calls.push({tx:id(this.transaction),method:'getAll'});
   return Reflect.apply(oldGetAll.value,this,args);
  }});
  Object.defineProperty(indexPrototype, 'getAll', { ...oldIndexGetAll, value: function(this: IDBIndex, ...args: unknown[]) {
   if(this.objectStore.name==='edits') calls.push({tx:id(this.objectStore.transaction),method:'index.getAll'});
   return Reflect.apply(oldIndexGetAll.value,this,args);
  }});
  try {
   const receipt = await (window as unknown as { compositionRepository(method:string,args:unknown[]):Promise<{id:string}|undefined> }).compositionRepository('receipt',[batchId]);
   const matching = calls.filter(call => call.method==='get' && call.key===wanted);
   const txs = [...new Set(matching.map(call => call.tx))];
   return {receipt, matching, sameTransactions:calls.filter(call => txs.includes(call.tx))};
  } finally { Object.defineProperty(prototype,'get',oldGet); Object.defineProperty(prototype,'getAll',oldGetAll); Object.defineProperty(indexPrototype,'getAll',oldIndexGetAll); }
 }, {batchId,scope});
 assert.equal(observed.receipt?.id,batchId); assert.ok(observed.matching.length > 0);
 assert.equal(observed.sameTransactions.filter(call => call.method==='getAll' || call.method==='index.getAll').length,0);
 for (const tx of new Set(observed.matching.map(call => call.tx))) assert.equal(observed.sameTransactions.filter(call => call.tx===tx && call.method==='get').length,1);
 await setup.finish();
});

// Fault injection changes only edits rows in the disposable, genuinely admitted Web profile.
// No grant/profile/control/binding row is created or modified by this test.
for (const engine of ['chromium', 'webkit'] as const) test(`receipt validates the selected IDB row and isolates unrelated corruption (${engine})`, { timeout: 120_000 }, async t => {
 const setup = await openComposition(t, engine), page = setup.web;
 const batchId = setup.publication.libraryBatch.id, scope = setup.repository.scope;
 const observed = await page.evaluate(async ({ batchId, scope }) => {
  type Row = { key: string; scope: string; value: { batch: Record<string, unknown>; receipt: Record<string, unknown>; history?: unknown; publication?: unknown } };
  const namespace = JSON.stringify([scope.accountId, scope.libraryId, scope.epoch]), wanted = JSON.stringify([namespace, batchId]);
  const call = (method: string, args: unknown[]) => (window as unknown as { compositionRepository(method: string, args: unknown[]): Promise<unknown> })
   .compositionRepository(method, args);
  const opening = indexedDB.open('papeer-shared-cloud-v1');
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
   opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('existing-cloud-database-required')); };
   opening.onerror = () => reject(opening.error); opening.onblocked = () => reject(new Error('cloud-database-blocked'));
   opening.onsuccess = () => resolve(opening.result);
  });
  if (database.version !== 9) { database.close(); throw new Error('existing-provider-schema-required'); }
  const transact = <T,>(mode: IDBTransactionMode, enqueue: (store: IDBObjectStore, finish: (value: T) => void) => void) => new Promise<T>((resolve, reject) => {
   const tx = database.transaction('edits', mode); let value: T;
   tx.oncomplete = () => resolve(value); tx.onabort = () => reject(tx.error ?? new Error('fault-transaction-aborted'));
   try { enqueue(tx.objectStore('edits'), result => { value = result; }); } catch (error) { tx.abort(); reject(error); }
  });
  const get = (key: string) => transact<Row | undefined>('readonly', (store, finish) => {
   const request = store.get(key); request.onsuccess = () => finish(request.result as Row | undefined);
  });
  const restore = (original: Row, remove?: string) => transact<void>('readwrite', (store, finish) => {
   if (remove !== undefined) store.delete(remove); store.put(original); finish(undefined);
  });
  const rejected = async (method: string, args: unknown[]) => {
   try { await call(method, args); return { rejected: false, name: null }; }
   catch (error) { return { rejected: true, name: error instanceof Error ? error.name : null }; }
  };
  const healthy = async (expected: Row) => {
   const receipt = await call('receipt', [batchId]);
   if (JSON.stringify(receipt) !== JSON.stringify(expected.value.receipt)) throw new Error('restored-authorized-receipt-mismatch');
   return true;
  };
  const baseline = await call('receipt', [batchId]) as { id: string } | undefined;
  if (baseline?.id !== batchId) { database.close(); throw new Error('genuine-durable-receipt-required'); }
  const cases: [string, (row: Row) => void][] = [
   ['scope', row => { row.scope = JSON.stringify(['foreign', scope.libraryId, scope.epoch]); }],
   ['batch-id', row => { row.value.batch.id = crypto.randomUUID(); }],
   ['batch-library', row => { row.value.batch.libraryId = crypto.randomUUID(); }],
   ['batch-target', row => { row.value.batch.targetId = crypto.randomUUID(); }],
   ['batch-schema', row => { row.value.batch.unexpectedField = true; }],
   ['receipt-id', row => { row.value.receipt.id = crypto.randomUUID(); }],
   ['receipt-target', row => { row.value.receipt.targetId = crypto.randomUUID(); }],
   ['receipt-durable', row => { row.value.receipt.durable = false; }],
   ['receipt-upload', row => { row.value.receipt.upload = 'not-a-status'; }],
   ['receipt-peers', row => { row.value.receipt.importedBy = [1]; }],
   ['receipt-keys', row => { row.value.receipt.extra = true; }],
   ['history-schema', row => { row.value.history = { operationId: 'invalid' }; }],
   ['publication-schema', row => { row.value.publication = {}; }],
  ];
  const selected: { name: string; rejected: boolean; errorName: string | null; originalRestored: boolean; authorizedReceiptRestored: boolean }[] = [];
  try {
   for (const [name, change] of cases) {
    const original = await get(wanted); if (!original) throw new Error('selected-row-missing-before-fault');
    const corrupt = structuredClone(original); change(corrupt);
    await restore(corrupt);
    let refusal: { rejected: boolean; name: string | null } = { rejected: false, name: null };
    try { refusal = await rejected('receipt', [batchId]); }
    finally { await restore(original); }
    // A broken/retired owner is not evidence that the intentionally corrupt row was rejected.
    const authorizedReceiptRestored = await healthy(original);
    selected.push({ name, rejected: refusal.rejected, errorName: refusal.name, authorizedReceiptRestored,
      originalRestored: JSON.stringify(await get(wanted)) === JSON.stringify(original) });
   }
   const original = await get(wanted); if (!original) throw new Error('selected-row-missing-after-faults');
   const otherId = crypto.randomUUID(), otherKey = JSON.stringify([namespace, otherId]);
   if (await get(otherKey)) throw new Error('fault-key-already-present');
   // Real keyPath='key' cannot store a different .key under wanted. Relocate the
   // actual row instead: point lookup must disclose no receipt, full query rejects
   // the relocated key/payload mismatch. Do not fabricate IDB request.result.
   const relocated = { ...structuredClone(original), key: otherKey };
   await transact<void>('readwrite', (store, finish) => { store.delete(wanted); store.put(relocated); finish(undefined); });
   let relocatedAbsent = false, relocatedFull = { rejected: false, name: null as string | null };
   try { relocatedAbsent = await call('receipt', [batchId]) === undefined; relocatedFull = await rejected('pendingRecords', []); }
   finally { await restore(original, otherKey); }
   const relocatedAuthorityRestored = await healthy(original);
   const unrelated = structuredClone(original); unrelated.key = otherKey; unrelated.value.batch.id = otherId;
   unrelated.value.batch.libraryId = crypto.randomUUID(); unrelated.value.receipt.id = otherId;
   await restore(unrelated);
   let unrelatedSelectedId: string | undefined, unrelatedFull = { rejected: false, name: null as string | null };
   try {
    unrelatedSelectedId = (await call('receipt', [batchId]) as { id?: string } | undefined)?.id;
    unrelatedFull = await rejected('pendingRecords', []);
   } finally { await transact<void>('readwrite', (store, finish) => { store.delete(otherKey); finish(undefined); }); }
   const unrelatedAuthorityRestored = await healthy(original);
   return { baselineId: baseline.id, selected, relocatedAbsent, relocatedFull, relocatedAuthorityRestored, unrelatedSelectedId, unrelatedFull, unrelatedAuthorityRestored,
    selectedRestored: JSON.stringify(await get(wanted)) === JSON.stringify(original), extraRemoved: await get(otherKey) === undefined };
  } finally { database.close(); }
 }, { batchId, scope });
 assert.equal(observed.baselineId, batchId);
 assert.equal(observed.selected.length, 13);
 for (const value of observed.selected) {
  assert.equal(value.rejected, true, `selected ${value.name} corruption must reject`);
  assert.equal(value.errorName, 'AbortError', `selected ${value.name} rejects through the actual IDB transaction abort path`);
  assert.equal(value.originalRestored, true, `selected ${value.name} fault must restore exact original row`);
  assert.equal(value.authorizedReceiptRestored, true, `selected ${value.name} must retain an actually usable opaque owner after restore`);
 }
 assert.equal(observed.relocatedAbsent, true);
 assert.equal(observed.relocatedFull.rejected, true); assert.equal(observed.relocatedFull.name, 'AbortError');
 assert.equal(observed.relocatedAuthorityRestored, true);
 assert.equal(observed.unrelatedSelectedId, batchId);
 assert.equal(observed.unrelatedFull.rejected, true); assert.equal(observed.unrelatedFull.name, 'AbortError');
 assert.equal(observed.unrelatedAuthorityRestored, true);
 assert.equal(observed.selectedRestored, true); assert.equal(observed.extraRemoved, true);
 t.diagnostic(JSON.stringify({ engine, selectedFaults: observed.selected.map(value => value.name), realPointKey: true,
  unrelatedFaultDetection: 'point lookup isolates it; existing full-scope pendingRecords rejects it', faultsRestored: true,
  authority: 'unchanged actual composition bootstrap and opaque host transaction; raw edits fault injection only' }));
 await setup.finish();
});

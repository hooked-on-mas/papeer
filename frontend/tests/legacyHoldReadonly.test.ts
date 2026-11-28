import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readLegacyHoldRecordReadonly, readLegacyHoldReadonly } from '../src/adapters/browser/legacyHoldReadonly.ts';
import { validateLegacyMigrationHold } from '../src/runtime/edits/contracts.ts';

/** Controlled IDB delivery: open and transaction events can arrive after cancellation or blocking. */
function storage({ hold, version = 3, stores = ['holds'] }: { hold?: unknown; version?: number; stores?: string[] } = {}) {
  const state = { opens: [] as unknown[][], upgradeAborts: 0, readAborts: 0, closes: 0, modes: [] as string[] };
  const get = { result: hold };
  const tx = {
    oncomplete: null as (() => void) | null, onabort: null as (() => void) | null, error: null,
    objectStore(name: string) { assert.equal(name, 'holds'); return { get(key: string) { assert.equal(key, 'origin'); return get; } }; },
    abort() { state.readAborts++; queueMicrotask(() => tx.onabort?.()); },
  };
  const db = {
    version, objectStoreNames: { contains: (name: string) => stores.includes(name) },
    close() { state.closes++; },
    transaction(name: string, mode: string) { assert.equal(name, 'holds'); state.modes.push(mode); return tx; },
  };
  const request = {
    result: db, error: null as DOMException | null,
    onupgradeneeded: null as (() => void) | null, onerror: null as (() => void) | null,
    onsuccess: null as (() => void) | null, onblocked: null as (() => void) | null,
    transaction: null as { abort(): void } | null,
  };
  const factory = { open(...args: unknown[]) { state.opens.push(args); return request; } } as unknown as IDBFactory;
  return { state, factory, request, success: () => request.onsuccess?.(), complete: () => tx.oncomplete?.(),
    missing: () => {
      request.transaction = { abort() { state.upgradeAborts++; request.error = new DOMException('Aborted', 'AbortError'); queueMicrotask(() => request.onerror?.()); } };
      request.onupgradeneeded?.();
    }, blocked: () => request.onblocked?.() };
}

const signal = () => new AbortController().signal;
const hold = { version: 1 as const, runId: '00000000-0000-4000-8000-000000000001' };

test('absent hold database rolls back creation and supplies null to the outer startup gate', async () => {
  const s = storage(), pending = readLegacyHoldRecordReadonly(signal(), s.factory, 'isolated-hold');
  s.missing();
  assert.equal(await pending, null);
  assert.deepEqual(s.state.opens, [['isolated-hold']], 'never request a schema version');
  assert.equal(s.state.upgradeAborts, 1, 'creation transaction must abort');
  assert.deepEqual(s.state.modes, []);
});

test('outer startup receives the validated hold record; driver retains clear/held admission', async () => {
  const s = storage({ hold }), pending = readLegacyHoldRecordReadonly(signal(), s.factory);
  s.success(); s.complete();
  const record = await pending;
  assert.deepEqual(record, hold); assert.doesNotThrow(() => validateLegacyMigrationHold(record));
  assert.deepEqual(s.state.modes, ['readonly']); assert.equal(s.state.closes, 1);
  for (const [value, expected] of [[undefined, 'clear'], [hold, 'held']] as const) {
    const source = storage({ hold: value }), admission = readLegacyHoldReadonly(signal(), source.factory);
    source.success(); source.complete(); assert.equal(await admission, expected);
  }
});

test('unverifiable schema and malformed hold reject without treating the storage as clear', async () => {
  for (const options of [{ version: 2 }, { stores: ['plans'] }, { hold: { version: 2 } }, { hold: null }]) {
    const s = storage(options), pending = readLegacyHoldRecordReadonly(signal(), s.factory);
    s.success(); s.complete(); await assert.rejects(pending); assert.equal(s.state.closes, 1);
    if (!('hold' in options)) assert.deepEqual(s.state.modes, []);
  }
});

test('already cancelled inquiry never opens the database', async () => {
  const controller = new AbortController(), s = storage(); controller.abort();
  await assert.rejects(readLegacyHoldRecordReadonly(controller.signal, s.factory), { name: 'AbortError' });
  assert.equal(s.state.opens.length, 0);
});

test('cancellation while opening settles immediately and closes a late successful connection', async () => {
  const controller = new AbortController(), s = storage(), pending = readLegacyHoldRecordReadonly(controller.signal, s.factory);
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  s.success(); assert.equal(s.state.closes, 1); assert.deepEqual(s.state.modes, []);
  const missingController = new AbortController(), absent = storage();
  const cancelled = readLegacyHoldRecordReadonly(missingController.signal, absent.factory);
  missingController.abort(); await assert.rejects(cancelled, { name: 'AbortError' });
  absent.missing(); await Promise.resolve(); assert.equal(absent.state.upgradeAborts, 1);
});

test('blocked inquiry fails closed and a late upgrade is aborted or late connection closed', async () => {
  const missing = storage(), missingResult = readLegacyHoldRecordReadonly(signal(), missing.factory);
  missing.blocked(); await assert.rejects(missingResult, /legacy-hold-blocked/);
  missing.missing(); await Promise.resolve(); assert.equal(missing.state.upgradeAborts, 1);
  const existing = storage(), existingResult = readLegacyHoldRecordReadonly(signal(), existing.factory);
  existing.blocked(); await assert.rejects(existingResult, /legacy-hold-blocked/);
  existing.success(); assert.equal(existing.state.closes, 1); assert.deepEqual(existing.state.modes, []);
});

test('cancellation during the readonly transaction aborts it and closes its connection', async () => {
  const controller = new AbortController(), s = storage({ hold }), pending = readLegacyHoldRecordReadonly(controller.signal, s.factory);
  s.success(); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  await Promise.resolve(); assert.equal(s.state.readAborts, 1); assert.equal(s.state.closes, 1);
});

test('open errors stay errors and successful completion detaches the cancellation listener', async () => {
  const s = storage(), pending = readLegacyHoldRecordReadonly(signal(), s.factory);
  s.request.error = new DOMException('Unavailable', 'UnknownError'); s.request.onerror?.();
  await assert.rejects(pending, { name: 'UnknownError' });
  const throwing = { open() { throw new Error('storage-disabled'); } } as unknown as IDBFactory;
  await assert.rejects(readLegacyHoldRecordReadonly(signal(), throwing), /storage-disabled/);
  const controller = new AbortController(), finished = storage(), complete = readLegacyHoldRecordReadonly(controller.signal, finished.factory);
  finished.success(); finished.complete(); assert.equal(await complete, null); controller.abort();
  assert.equal(finished.state.readAborts, 0); assert.equal(finished.state.upgradeAborts, 0);
});

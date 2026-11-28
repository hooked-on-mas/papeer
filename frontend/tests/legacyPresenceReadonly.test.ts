import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readLegacyWebPresenceReadonly } from '../src/adapters/browser/legacyPresenceReadonly.ts';
import { discoverLegacyIndexedDbNames, isLegacyLocalStorageKey } from '../src/adapters/browser/legacySourceNames.ts';

function local(values = new Map<string, string>()) {
  return { values, storage: { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null } };
}
type Database = { version?: number; stores?: Record<string, number>; failure?: 'blocked' | 'missing' | 'read' | 'open' };
function databases(entries: Record<string, Database> = {}) {
  const state = { enumerations: 0, opens: [] as unknown[][], closes: 0, upgradesAborted: 0, modes: [] as string[] };
  const factory = {
    async databases() { state.enumerations++; return Object.keys(entries).map(name => ({ name, version: entries[name].version ?? 1 })); },
    open(...args: unknown[]) {
      state.opens.push(args);
      const source = entries[String(args[0])], stores = source?.stores ?? { libraries: 0, files: 0, annotations: 0 };
      const tx = { error: null, oncomplete: null as (() => void) | null, onabort: null as (() => void) | null,
        abort() { queueMicrotask(() => tx.onabort?.()); }, objectStore(name: string) { return { count: () => ({ result: stores[name] }) }; } };
      const db = { version: source?.version ?? 1, objectStoreNames: Object.keys(stores), onversionchange: null,
        close() { state.closes++; }, transaction(_stores: string[], mode: string) {
          state.modes.push(mode); queueMicrotask(() => source.failure === 'read' ? tx.onabort?.() : tx.oncomplete?.()); return tx;
        } };
      const request = { result: db, error: new DOMException('Open failed', 'UnknownError'),
        transaction: { abort() { state.upgradesAborted++; } },
        onupgradeneeded: null as (() => void) | null, onerror: null as (() => void) | null,
        onsuccess: null as (() => void) | null, onblocked: null as (() => void) | null };
      queueMicrotask(() => {
        if (source?.failure === 'blocked') request.onblocked?.();
        else if (!source || source.failure === 'missing') request.onupgradeneeded?.();
        else if (source.failure === 'open') request.onerror?.();
        else request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
  return { state, factory };
}
const signal = () => new AbortController().signal;

test('clean, unrelated and canonical storage never become legacy sources or get opened', async () => {
  const source = local(new Map([['paper-desk.reader.v1:scope', '{}'], ['paper-desk.markdown-draft.v1:scope', 'draft'],
    ['papeer-google-session:v1', 'credential'], ['paperdesk-google-session:v1', 'credential'], ['other-app', 'value']]));
  const db = databases({ 'papeer-shared-edits': {}, 'papeer-migration-backups': {}, 'unrelated': {} });
  assert.equal(await readLegacyWebPresenceReadonly(signal(), db.factory, source.storage), 'clear');
  assert.deepEqual(db.state.opens, []); assert.equal(db.state.enumerations, 2);
  assert.equal(isLegacyLocalStorageKey('papeer-ink:library:unsent'), true);
  assert.equal(isLegacyLocalStorageKey('paperdesk-draft'), true);
});

test('legacy raw data including malformed drafts blocks without interpreting or changing bytes', async () => {
  for (const key of ['paper-desk-storage', 'papeer-ink:library:pending', 'papeer-notes:v1:library:pending', 'papeer:unknown', 'paperdesk-draft']) {
    const source = local(new Map([[key, '{damaged raw draft \ud800']])), original = [...source.values];
    assert.equal(await readLegacyWebPresenceReadonly(signal(), databases().factory, source.storage), 'legacy-present');
    assert.deepEqual([...source.values], original);
  }
});

test('an empty known legacy DB is clear; records in any old store require migration, using readonly count only', async () => {
  const name = 'papeer-documents:/old/path/';
  for (const store of ['none', 'libraries', 'files', 'annotations']) {
    const counts = { libraries: 0, files: 0, annotations: 0 };
    if (store !== 'none') counts[store as keyof typeof counts] = 1;
    const db = databases({ [name]: { stores: counts } });
    assert.equal(await readLegacyWebPresenceReadonly(signal(), db.factory, local().storage), store === 'none' ? 'clear' : 'legacy-present');
    assert.deepEqual(db.state.opens, [[name]]); assert.deepEqual(db.state.modes, ['readonly']); assert.equal(db.state.closes, 1);
    assert.deepEqual(counts, { libraries: store === 'libraries' ? 1 : 0, files: store === 'files' ? 1 : 0, annotations: store === 'annotations' ? 1 : 0 });
  }
});

test('unavailable enumeration, unreadable localStorage and malformed discovery fail closed', async () => {
  await assert.rejects(readLegacyWebPresenceReadonly(signal(), {} as IDBFactory, local().storage), /discovery-unavailable/);
  const invalid = { databases: async () => [{}] } as unknown as IDBFactory;
  await assert.rejects(discoverLegacyIndexedDbNames(invalid), /discovery-invalid/);
  const denied = { get length(): number { throw new Error('storage-denied'); }, key: () => null, getItem: () => null };
  await assert.rejects(readLegacyWebPresenceReadonly(signal(), databases().factory, denied), /storage-denied/);
  const changed = { length: 1, key: () => 'papeer-ink:a', getItem: () => null };
  await assert.rejects(readLegacyWebPresenceReadonly(signal(), databases().factory, changed), /source-changed/);
});

test('unknown schema, blocked/failed reads and a deleted enumerated DB never get treated as empty', async () => {
  for (const source of [{ version: 2 }, { stores: { libraries: 0 } }, { failure: 'blocked' }, { failure: 'read' }, { failure: 'missing' }, { failure: 'open' }] as Database[]) {
    const db = databases({ 'papeer-documents:/': source });
    await assert.rejects(readLegacyWebPresenceReadonly(signal(), db.factory, local().storage));
    assert.ok(db.state.modes.every(mode => mode === 'readonly'));
    assert.equal(db.state.upgradesAborted, source.failure === 'missing' ? 1 : 0);
  }
});

test('changing local bytes or the enumerated source set invalidates the inquiry', async () => {
  const source = local(new Map([['paperdesk-draft', 'before']])), db = databases();
  db.factory.databases = async () => { source.values.set('paperdesk-draft', 'after'); return []; };
  await assert.rejects(readLegacyWebPresenceReadonly(signal(), db.factory, source.storage), /source-changed/);
  let calls = 0;
  db.factory.databases = async () => ++calls === 1 ? [] : [{ name: 'papeer-documents:/late/' }];
  await assert.rejects(readLegacyWebPresenceReadonly(signal(), db.factory, local().storage), /source-changed/);
});

test('cancellation before inquiry or during database enumeration cannot publish clear', async () => {
  const controller = new AbortController(), db = databases(); controller.abort();
  await assert.rejects(readLegacyWebPresenceReadonly(controller.signal, db.factory, local().storage), { name: 'AbortError' });
  assert.equal(db.state.enumerations, 0);
  const pendingController = new AbortController();
  db.factory.databases = () => new Promise(() => {});
  const pending = readLegacyWebPresenceReadonly(pendingController.signal, db.factory, local().storage);
  pendingController.abort(); await assert.rejects(pending, { name: 'AbortError' });
});

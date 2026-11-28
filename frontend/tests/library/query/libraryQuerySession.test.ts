import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeLibraryQuery, LibraryQuerySession, type LibraryCorpusEntry, type LibraryQuery } from '../../../src/features/library/query/LibraryQuerySession.ts';
import type { LibraryItem } from '../../../src/runtime/edits/contracts.ts';

const item = (id: string, title: string, fields: Partial<LibraryItem> = {}): LibraryItem => ({ id, title, kind: 'markdown',
  ownerId: null, folderId: null, tags: [], read: false, metadata: {}, position: 0, ...fields });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('saved query decodes strictly and invalid persisted input never broadens results', async () => {
  const scope = { accountId: 'a', libraryId: crypto.randomUUID(), epoch: 'e' };
  let raw: unknown = { text: 'x', scope: 'bad', tag: '', read: 'all', sort: 'position', descending: false }, writes = 0;
  const port = { scope, read: () => raw, write: (value: LibraryQuery) => { writes++; raw = structuredClone(value); } };
  const query = new LibraryQuerySession(undefined, () => true, port, scope);
  await query.setCatalog([item('a', 'visible')]);
  assert.equal(query.getSnapshot().preferenceBlocked, true); assert.equal(query.getSnapshot().flat, true); assert.deepEqual(query.getSnapshot().ids, []); assert.equal(writes, 0);
  assert.throws(() => decodeLibraryQuery({ ...raw as object, extra: true }), /library-query-invalid/);
  for (const invalid of [{ scope: ['content'] }, { read: ['all'] }, { sort: ['title'] }, { scope: { value: 'content' } }])
    assert.throws(() => decodeLibraryQuery({ text: '', scope: 'metadata', tag: '', read: 'all', sort: 'position', descending: false, ...invalid }), /library-query-invalid/);
  const base = { text: '', scope: 'metadata', tag: '😀'.repeat(200), read: 'all', sort: 'position', descending: false };
  assert.equal(decodeLibraryQuery(base).tag, base.tag);
  assert.throws(() => decodeLibraryQuery({ ...base, tag: '😀'.repeat(201) }), /library-query-invalid/);
  await query.clear(); assert.equal(query.getSnapshot().preferenceBlocked, false); assert.equal(writes, 1); assert.deepEqual(query.getSnapshot().ids, ['a']);
});

test('query preference write failure retains the exact query for retry and rejects stale scope callbacks', async () => {
  const scope = { accountId: 'a', libraryId: crypto.randomUUID(), epoch: 'e' }; let active = true, fail = true;
  let raw: unknown = null; const port = { scope, read: () => raw, write: (value: LibraryQuery) => { if (fail) throw new Error('quota'); raw = structuredClone(value); } };
  const query = new LibraryQuerySession(undefined, () => active, port, scope); await query.setCatalog([item('a', 'Alpha')]);
  await query.setQuery({ text: 'Alpha', sort: 'title', descending: true });
  assert.equal(query.getSnapshot().preferencePending, true); assert.match(query.getSnapshot().preferenceError, /quota/); assert.deepEqual(query.getSnapshot().ids, ['a']);
  const expected = structuredClone(query.getSnapshot().query); active = false; fail = false;
  await query.setQuery({ text: 'stale' }); await query.retryPreference(); assert.equal(raw, null); assert.deepEqual(query.getSnapshot().query, expected);
  active = true; await query.retryPreference(); assert.deepEqual(raw, expected); assert.equal(query.getSnapshot().preferencePending, false);
  const restored = new LibraryQuerySession(undefined, () => true, port, scope); await restored.setCatalog([item('a', 'Alpha')]); assert.deepEqual(restored.getSnapshot().query, expected);
});

test('library query combines normalized AND metadata, exact tag/read filters and deterministic ordering without catalog mutation', async () => {
  const values = [item('b', 'Ａlpha', { tags: ['Tag'], metadata: { author: 'SMITH', year: '2023' }, read: true }),
    item('a', 'alpha', { tags: ['Tag'], metadata: { author: 'Smith', year: '2024' }, read: true }), item('c', 'other')];
  const original = structuredClone(values), query = new LibraryQuerySession(); await query.setCatalog(values);
  await query.setQuery({ text: 'ａｌｐｈａ SMITH', tag: 'Tag', read: 'read', sort: 'title' });
  assert.deepEqual(query.getSnapshot().ids, ['a', 'b']);
  await query.setQuery({ sort: 'year', descending: true }); assert.deepEqual(query.getSnapshot().ids, ['a', 'b']);
  await query.setQuery({ tag: 'tag' }); assert.deepEqual(query.getSnapshot().ids, []);
  await query.clear(); assert.equal(query.getSnapshot().flat, false); assert.deepEqual(query.getSnapshot().ids, ['a', 'b', 'c']);
  assert.deepEqual(values, original);
});

test('new query, clear and catalog replacement invalidate late corpus replies even when acquisition ignores abort', async () => {
  const calls: { signal: AbortSignal; reply: ReturnType<typeof deferred<readonly LibraryCorpusEntry[]>> }[] = [];
  const query = new LibraryQuerySession({ read: async (_, signal) => { const reply = deferred<readonly LibraryCorpusEntry[]>(); calls.push({ signal, reply }); return reply.promise; } });
  await query.setCatalog([item('a', 'first'), item('b', 'second')]);
  const old = query.setQuery({ scope: 'content', text: 'old' }), latest = query.setQuery({ text: 'new' });
  assert.equal(calls[0].signal.aborted, true); assert.equal(query.getSnapshot().loading, true); assert.deepEqual(query.getSnapshot().ids, []);
  calls[1].reply.resolve([{ itemId: 'b', status: 'complete', text: 'new' }]); await latest;
  calls[0].reply.resolve([{ itemId: 'a', status: 'complete', text: 'old' }]); await old;
  assert.deepEqual(query.getSnapshot().ids, ['b']);
  const late = query.setQuery({ text: 'again' }); await query.clear();
  calls[2].reply.resolve([{ itemId: 'b', status: 'complete', text: 'again' }]); await late;
  assert.equal(query.getSnapshot().flat, false); assert.deepEqual(query.getSnapshot().ids, ['a', 'b']);
  const removed = query.setQuery({ scope: 'content', text: 'removed' }), replacement = query.setCatalog([item('a', 'first')]);
  calls[4].reply.resolve([{ itemId: 'a', status: 'complete', text: 'removed' }]); await replacement;
  calls[3].reply.resolve([{ itemId: 'b', status: 'complete', text: 'removed' }]); await removed;
  assert.deepEqual(query.getSnapshot().ids, ['a']);
});

test('coverage and failed acquisition stay explicit, metadata hits survive missing bodies and a retry replaces the error', async () => {
  let fail = true;
  const query = new LibraryQuerySession({ read: async () => {
    if (fail) throw new Error('offline');
    return [{ itemId: 'a', status: 'complete', text: 'body' }, { itemId: 'b', status: 'partial', text: '' }, { itemId: 'c', status: 'unsupported', text: '' }];
  } });
  const items = [item('a', 'wanted'), item('b', 'other'), item('c', 'wanted')]; await query.setCatalog(items);
  await query.setQuery({ scope: 'all', text: 'wanted' });
  assert.deepEqual(query.getSnapshot().ids, ['a', 'c']); assert.deepEqual(query.getSnapshot().missingIds, ['a', 'b', 'c']); assert.match(query.getSnapshot().error, /offline/);
  fail = false; await query.setCatalog(items);
  assert.equal(query.getSnapshot().error, ''); assert.deepEqual(query.getSnapshot().partialIds, ['b']); assert.deepEqual(query.getSnapshot().unsupportedIds, ['c']);
  await query.reveal('a'); assert.equal(query.getSnapshot().query.text, ''); assert.equal(query.getSnapshot().flat, false);
});

test('suspending the scope cancels a body request and never applies its late result after reactivation', async () => {
  const reply = deferred<readonly LibraryCorpusEntry[]>(); let active = true;
  const query = new LibraryQuerySession({ read: async () => reply.promise }, () => active);
  await query.setCatalog([item('a', 'note')]); const pending = query.setQuery({ scope: 'content', text: 'late' });
  active = false; query.cancel(); active = true;
  reply.resolve([{ itemId: 'a', status: 'complete', text: 'late' }]); await pending;
  assert.equal(query.getSnapshot().loading, false); assert.deepEqual(query.getSnapshot().ids, []);
});

test('unchanged poll preserves a slow search and its results while new content heads invalidate the old acquisition', async () => {
  let revision = 'head-one';
  const requests: { signal: AbortSignal; reply: ReturnType<typeof deferred<readonly LibraryCorpusEntry[]>> }[] = [];
  const query = new LibraryQuerySession({ revision: async () => revision, read: async (_, signal) => {
    const reply = deferred<readonly LibraryCorpusEntry[]>(); requests.push({ signal, reply }); return reply.promise;
  } });
  const values = [item('a', 'one')]; await query.setCatalog(values);
  const first = query.setQuery({ scope: 'content', text: 'body' });
  await new Promise(resolve => setImmediate(resolve));
  for (let poll = 0; poll < 5; poll++) await query.setCatalog(structuredClone(values));
  assert.equal(requests.length, 1); assert.equal(requests[0].signal.aborted, false);
  requests[0].reply.resolve([{ itemId: 'a', text: 'body', status: 'complete' }]); await first;
  const settled = query.getSnapshot(); await query.setCatalog(values);
  assert.equal(query.getSnapshot(), settled); assert.equal(requests.length, 1);
  revision = 'head-two'; const changed = query.setCatalog(values);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(requests.length, 2);
  revision = 'head-three'; const newest = query.setCatalog(values);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(requests[1].signal.aborted, true);
  requests[2].reply.resolve([{ itemId: 'a', text: 'different', status: 'complete' }]); await newest;
  requests[1].reply.resolve([{ itemId: 'a', text: 'body', status: 'complete' }]); await changed;
  assert.deepEqual(query.getSnapshot().ids, []);
});

test('same catalog restarts after suspension or failed initial revision instead of retaining an aborted or uninitialized scan', async () => {
  let failRevision = true, active = true, reads = 0;
  const query = new LibraryQuerySession({ revision: async (_, signal) => {
    signal.throwIfAborted(); if (failRevision) throw new Error('temporary revision failure'); return 'head';
  }, read: async () => { reads++; return [{ itemId: 'a', status: 'complete', text: 'body' }]; } }, () => active);
  const values = [item('a', 'one')]; await query.setCatalog(values);
  await query.setQuery({ scope: 'content', text: 'body' }); assert.match(query.getSnapshot().error, /revision failure/);
  failRevision = false; await query.setCatalog(values);
  assert.equal(reads, 1); assert.deepEqual(query.getSnapshot().ids, ['a']); assert.equal(query.getSnapshot().error, '');
  active = false; query.cancel(); active = true; await query.setCatalog(values);
  assert.equal(reads, 2); assert.deepEqual(query.getSnapshot().ids, ['a']);
});

test('explicit retry recovers a transient body extraction failure even when the content revision is unchanged', async () => {
  let available = false, reads = 0;
  const query = new LibraryQuerySession({ revision: async () => 'unchanged-head-and-resource', read: async () => {
    reads++; return [{ itemId: 'a', status: available ? 'complete' : 'partial', text: available ? 'body' : '' }];
  } });
  const values = [item('a', 'one')]; await query.setCatalog(values); await query.setQuery({ scope: 'content', text: 'body' });
  assert.deepEqual(query.getSnapshot().partialIds, ['a']); available = true;
  await query.setCatalog(values); assert.equal(reads, 1);
  await query.retry(); assert.equal(reads, 2); assert.deepEqual(query.getSnapshot().ids, ['a']); assert.deepEqual(query.getSnapshot().partialIds, []);
});

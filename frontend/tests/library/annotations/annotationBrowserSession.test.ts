import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { DocumentSnapshot, LibrarySnapshot, StickyNote } from '../../../src/runtime/edits/contracts.ts';
import { DurableEditRepository } from '../../../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from '../../support/editMemoryDatabase.ts';
import { AnnotationBrowserSession } from '../../../src/features/library/annotations/AnnotationBrowserSession.ts';
import { createCanonicalAnnotationCorpus, type AnnotationCorpusEntry } from '../../../src/features/library/annotations/canonicalAnnotationCorpus.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const id = (n: number) => `20000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const scope = { accountId: 'annotation-test', libraryId: fixture.libraryId as string, epoch: 'one' };
function data() {
  const document: DocumentSnapshot = structuredClone(fixture.translation.root); delete document.translation; document.deletedPages = [];
  for (const page of document.pages) { page.annotations = []; page.background = { kind: 'paper', spec: { template: 'blank', color: 'white' } }; }
  const note: StickyNote = { kind: 'sticky', id: id(1), text: 'initial ＡＢＣ', anchor: { x: 20, y: 30 }, color: null,
    metadata: { label: 'label', createdAt: null } };
  document.pages[0].annotations = [note];
  const catalog: LibrarySnapshot = { kind: 'library', id: scope.libraryId, version: id(2), folders: [], links: [], deletions: [],
    items: [{ id: document.id, kind: 'notebook', title: 'Paper', ownerId: null, folderId: null, position: 0, tags: [], read: false, metadata: {} }] };
  return { document, catalog };
}
const entry = (document: DocumentSnapshot): AnnotationCorpusEntry => ({ documentId: document.id, heads: [document.version],
  sources: [{ libraryId: scope.libraryId, title: 'Paper', document }], status: 'complete', conflicted: false, error: '' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('corpus reads durable document heads, never attachment roots or uncommitted retained previews', async () => {
  const { document, catalog } = data(), repository = new DurableEditRepository(scope, new EditMemoryDatabase());
  await repository.initialize(document);
  const preview = structuredClone(document); (preview.pages[0].annotations[0] as StickyNote).text = 'uncommitted';
  const calls: string[] = [];
  const corpus = createCanonicalAnnotationCorpus({ scope, read: async target => { calls.push(target); return repository.read(target); } }, () => preview);
  const entries = await corpus.read([...catalog.items, { ...catalog.items[0], id: id(10), kind: 'attachment', ownerId: document.id, resourceId: id(11) }], new AbortController().signal);
  assert.deepEqual(calls, [document.id]); assert.equal(entries.length, 1);
  assert.equal((entries[0].sources[0].document.pages[0].annotations[0] as StickyNote).text, 'initial ＡＢＣ');
  const partial = createCanonicalAnnotationCorpus({ scope, read: async target => ({ ...await repository.read(target), waiting: [id(99)] }) });
  assert.equal((await partial.read(catalog.items, new AbortController().signal))[0].status, 'partial');
  const session = new AnnotationBrowserSession({ repository, isActive: () => true });
  await session.setCatalog(catalog, document.id);
  const row = session.getSnapshot().rows[0]; session.select(row.key); session.rememberScroll(row.key, 12.25);
  assert.equal((await session.validateLocation(row.key)).status, 'valid');
  session.setQuery({ query: 'abc', scope: 'all' }); assert.equal(session.getSnapshot().rows.length, 1);
  session.setQuery({ query: 'absent' }); assert.equal(session.getSnapshot().rows.length, 0);
  session.clear(); assert.equal(session.getSnapshot().selectedKey, row.key);
  assert.deepEqual(session.getSnapshot().scroll, { rowKey: row.key, offset: 12.25 });
});

test('unchanged polls share a slow scan and preserve result identity; a forced retry rejects its late predecessor', async () => {
  const { document, catalog } = data(), gate = deferred<readonly AnnotationCorpusEntry[]>(); let calls = 0;
  const repository = { scope, read: async () => { throw new Error('unexpected direct read'); } };
  const session = new AnnotationBrowserSession({ repository, isActive: () => true, corpus: { read: async () => {
    calls++; return calls === 1 ? gate.promise : [entry(document)];
  } } });
  const first = session.setCatalog(catalog, document.id);
  await Promise.resolve();
  const polls = Array.from({ length: 5 }, () => session.setCatalog(structuredClone(catalog), document.id));
  assert.equal(calls, 1);
  gate.resolve([entry(document)]); await Promise.all([first, ...polls]);
  const rows = session.getSnapshot().rows;
  await session.refresh(); assert.equal(session.getSnapshot().rows, rows);
  const stale = deferred<readonly AnnotationCorpusEntry[]>(), fresh = structuredClone(document);
  (fresh.pages[0].annotations[0] as StickyNote).text = 'fresh'; fresh.version = id(20);
  let reads = 0;
  const other = new AnnotationBrowserSession({ repository, isActive: () => true, corpus: { read: async () => ++reads === 1 ? stale.promise : [entry(fresh)] } });
  const old = other.setCatalog(catalog, document.id); await Promise.resolve(); await other.retry();
  stale.resolve([entry(document)]); await old;
  assert.equal(other.getSnapshot().rows[0].annotation.text, 'fresh');
});

test('failed reads retain explicitly stale rows and reject export/navigation; retry replaces them without accumulation', async () => {
  const { document, catalog } = data(); let mode: 'ok' | 'fail' | 'new' = 'ok';
  const repository = { scope, read: async () => { throw new Error('not used'); } };
  const session = new AnnotationBrowserSession({ repository, isActive: () => true, corpus: { read: async () => {
    if (mode === 'fail') return [{ ...entry(document), sources: [], heads: [], status: 'missing', error: 'offline' }];
    const source = structuredClone(document);
    if (mode === 'new') { source.version = id(30); (source.pages[0].annotations[0] as StickyNote).text = 'replacement'; }
    return [entry(source)];
  } } });
  await session.setCatalog(catalog, document.id); const key = session.getSnapshot().rows[0].key;
  mode = 'fail'; await session.refresh();
  assert.equal(session.getSnapshot().rows.length, 1); assert.deepEqual(session.getSnapshot().staleIds, [document.id]);
  assert.equal(session.captureExport(), null); assert.equal(session.getSnapshot().exportError, 'annotation-export-stale');
  assert.deepEqual(await session.validateLocation(key), { status: 'refused', reason: 'annotation-source-stale' });
  mode = 'new'; await session.retry();
  assert.equal(session.getSnapshot().rows.length, 1); assert.equal(session.getSnapshot().rows[0].annotation.text, 'replacement');
  assert.deepEqual(session.getSnapshot().staleIds, []); assert.ok(session.captureExport());
});

test('navigation requires an explicit current head for conflicts and refuses changed payload or an expired head', async () => {
  const { document, catalog } = data(), branch = structuredClone(document); branch.version = id(40);
  let response: AnnotationCorpusEntry = { ...entry(document), heads: [document.version, branch.version], conflicted: true,
    sources: [...entry(document).sources, ...entry(branch).sources] };
  const session = new AnnotationBrowserSession({ repository: { scope, read: async () => { throw new Error('not used'); } },
    isActive: () => true, corpus: { read: async () => [response] } });
  await session.setCatalog(catalog, document.id); const key = session.getSnapshot().rows[0].key;
  assert.deepEqual(session.getSnapshot().conflictedIds, [document.id]);
  assert.deepEqual(await session.validateLocation(key), { status: 'refused', reason: 'annotation-head-selection-required' });
  const valid = await session.validateLocation(key, branch.version);
  assert.equal(valid.status, 'valid'); if (valid.status === 'valid') assert.equal(valid.version, branch.version);
  response = entry(branch);
  assert.deepEqual(await session.validateLocation(key, document.version), { status: 'refused', reason: 'annotation-head-changed' });
  const changed = structuredClone(branch); (changed.pages[0].annotations[0] as StickyNote).anchor.y = 35;
  response = entry(changed);
  assert.deepEqual(await session.validateLocation(key, branch.version), { status: 'refused', reason: 'annotation-changed' });
});

test('catalog deletion and scope cancellation invalidate late rows without creating another authority', async () => {
  const { document, catalog } = data(), gate = deferred<readonly AnnotationCorpusEntry[]>(); let active = true, reads = 0;
  const session = new AnnotationBrowserSession({ repository: { scope, read: async () => { throw new Error('not used'); } },
    isActive: () => active, corpus: { read: async items => { reads++; return items.length ? gate.promise : []; } } });
  const loading = session.setCatalog(catalog, document.id); await Promise.resolve();
  const deleted = structuredClone(catalog); deleted.version = id(50);
  deleted.deletions = [{ id: id(51), itemIds: [document.id], active: true, observed: [] }];
  await session.setCatalog(deleted, document.id); gate.resolve([entry(document)]); await loading;
  assert.equal(session.getSnapshot().rows.length, 0);
  active = false; session.setAvailable(false); await session.refresh(); assert.equal(reads, 2);
  assert.equal(session.captureExport(), null);
  assert.equal(session.getSnapshot().exportError, 'annotation-browser-inactive');
});

test('an awaited location check cannot outlive a newer scan or selection conditions', async () => {
  const { document, catalog } = data(), gate = deferred<readonly AnnotationCorpusEntry[]>(); let reads = 0;
  const session = new AnnotationBrowserSession({ repository: { scope, read: async () => { throw new Error('not used'); } },
    isActive: () => true, corpus: { read: async () => ++reads === 2 ? gate.promise : [entry(document)] } });
  await session.setCatalog(catalog, document.id);
  const validation = session.validateLocation(session.getSnapshot().rows[0].key);
  await session.retry(); gate.resolve([entry(document)]);
  assert.deepEqual(await validation, { status: 'refused', reason: 'annotation-request-stale' });
});

test('metadata-only catalog changes retain known rows through a failed read while deletion and kind changes remove them', async () => {
  const { document, catalog } = data(); let fail = false;
  const gate = deferred<readonly AnnotationCorpusEntry[]>();
  const session = new AnnotationBrowserSession({ repository: { scope, read: async () => { throw new Error('not used'); } },
    isActive: () => true, corpus: { read: async () => fail ? gate.promise : [entry(document)] } });
  await session.setCatalog(catalog, document.id); const initialKey = session.getSnapshot().rows[0].key;
  session.select(initialKey); session.rememberScroll(initialKey, -3.5);
  const renamed = structuredClone(catalog); renamed.version = id(70); renamed.items[0].title = 'Renamed'; renamed.items[0].tags = ['new'];
  fail = true;
  const work = session.setCatalog(renamed, document.id);
  assert.equal(session.getSnapshot().loading, true);
  assert.equal(session.getSnapshot().rows[0].key, initialKey);
  assert.equal(session.getSnapshot().rows[0].title, 'Renamed');
  gate.resolve([{ ...entry(document), sources: [], heads: [], status: 'missing', error: 'offline' }]); await work;
  assert.equal(session.getSnapshot().rows[0].key, initialKey);
  assert.equal(session.getSnapshot().rows[0].title, 'Renamed');
  assert.deepEqual(session.getSnapshot().staleIds, [document.id]);
  assert.equal(session.getSnapshot().selectedKey, initialKey);
  assert.deepEqual(session.getSnapshot().scroll, { rowKey: initialKey, offset: -3.5 });
  assert.equal(session.captureExport(), null);
  const removed = structuredClone(renamed); removed.version = id(71); removed.items = [];
  await session.setCatalog(removed, document.id); assert.deepEqual(session.getSnapshot().rows, []);
  const retyped = structuredClone(renamed); retyped.version = id(72); retyped.items[0].kind = 'markdown';
  await session.setCatalog(retyped, document.id); assert.deepEqual(session.getSnapshot().rows, []);
});

test('a valid off-page annotation stays visible but an unrepresentable citation fails export without throwing or clamping', async () => {
  const { document, catalog } = data(); (document.pages[0].annotations[0] as StickyNote).anchor.x = -2;
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase()); await repository.initialize(document);
  const session = new AnnotationBrowserSession({ repository, isActive: () => true });
  await session.setCatalog(catalog, document.id); const before = session.getSnapshot().rows;
  assert.doesNotThrow(() => { assert.equal(session.captureExport(), null); });
  assert.equal(session.getSnapshot().exportError, 'annotation-export-location-invalid');
  assert.equal(session.getSnapshot().rows, before); assert.equal(before[0].target.anchor!.xPt, -2);
});

test('location validation survives unchanged polls and rejects changes or explicit invalidation', async () => {
  for (const action of ['poll', 'retry', 'payload', 'head', 'status', 'failure', 'catalog', 'query', 'current', 'scope'] as const) {
    const { document, catalog } = data();
    const validationRead = deferred<readonly AnnotationCorpusEntry[]>();
    const pollRead = deferred<readonly AnnotationCorpusEntry[]>();
    let calls = 0, validationSignal: AbortSignal | undefined;
    const session = new AnnotationBrowserSession({ repository: { scope, read: async () => { throw new Error('not used'); } },
      isActive: () => true, corpus: { read: async (_items, signal) => {
        calls++;
        if (calls === 2) { validationSignal = signal; return validationRead.promise; }
        if (calls === 3) {
          if (action === 'failure') throw new Error('offline');
          return pollRead.promise;
        }
        return [entry(document)];
      } } });
    await session.setCatalog(catalog, document.id);
    const key = session.getSnapshot().rows[0].key;
    const validation = session.validateLocation(key, document.version);
    let poll: Promise<void> | undefined;
    if (action === 'query') session.setQuery({ query: 'initial' });
    else if (action === 'scope') session.setAvailable(false);
    else if (action === 'catalog') poll = session.setCatalog({ ...catalog, version: id(90) }, document.id);
    else if (action === 'current') poll = session.setCatalog(catalog, null);
    else if (action === 'retry') poll = session.retry();
    else poll = session.setCatalog(structuredClone(catalog), document.id);
    if (action === 'poll') assert.equal(validationSignal?.aborted, false, 'poll start preserves validation');
    const changed = structuredClone(document);
    if (action === 'payload') (changed.pages[0].annotations[0] as StickyNote).text = 'changed';
    if (action === 'head') changed.version = id(91);
    pollRead.resolve([{ ...entry(changed), ...(action === 'status' ? { status: 'partial' as const } : {}) }]);
    await poll;
    assert.equal(validationSignal?.aborted, action !== 'poll', action);
    validationRead.resolve([entry(document)]);
    const result = await validation;
    if (action === 'poll') {
      assert.equal(result.status, 'valid');
      if (result.status === 'valid') assert.equal(result.version, document.version);
    } else assert.deepEqual(result, { status: 'refused', reason: 'annotation-request-stale' }, action);
  }
});

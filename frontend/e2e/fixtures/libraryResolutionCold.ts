// Real production owner factory and IndexedDB. Fixture-only orchestration, no raw seed/grant input.
import { createBrowserBootstrapHostDriver } from '../../src/adapters/browser/bootstrapHostDriver.ts';
import { initialRequest } from '../../src/features/bootstrap/initialRequest.ts';
import type { BootstrapHostDriver, HostLease, ScopeResources } from '../../src/features/bootstrap/bootstrapPorts.ts';
import { DocumentEditSessions } from '../../src/features/reader/DocumentEditSessions.ts';
import type { ContentRepository, EditScope } from '../../src/runtime/edits/ports.ts';
import type { EditBatch, EditIntentRecord, LibraryEditBatch, LibrarySnapshot, Snapshot } from '../../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../../src/runtime/edits/repository.ts';
import { canonicalJson } from '../../src/runtime/edits/editModel.ts';

type Options = { databaseName: string; title: string };
type Held = { driver: BootstrapHostDriver; resources: ScopeResources };
type Row<T> = { key: string; scope: string; value: T };
type Observed = { root: LibrarySnapshot; edits: StoredEdit[]; intents: EditIntentRecord[]; projections: LibrarySnapshot[] };
const generation = crypto.randomUUID();
let held: Held | undefined;
const check = (ok: unknown, message: string): void => { if (!ok) throw new Error(message); };
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

async function admit(options: Options, create: boolean): Promise<Held> {
  check(!held, 'fixture already owns a host');
  const signal = new AbortController().signal;
  const driver = createBrowserBootstrapHostDriver({ databaseName: options.databaseName,
    legacyBackupDatabaseName: options.databaseName + '-legacy-hold' });
  const context = await driver.readLocalContext(signal);
  let lease: HostLease;
  if (context.status === 'ready') lease = context.lease;
  else {
    check(create && context.status === 'setup-required', 'cold local grant not discoverable');
    lease = await driver.provisionLocalContext(signal);
  }
  if (create) {
    const owner = driver.initialization(lease);
    const request = await initialRequest(options.title, await owner.getOrCreatePeer(signal));
    check((await owner.prepare(request, signal)).status === 'pending', 'normal owner prepare failed');
    check((await owner.execute(request.control.id, signal)).status === 'accepted', 'normal owner execute failed');
    await owner.acknowledge(request.control.id, signal);
  }
  const listing = await driver.discover(lease, signal);
  const libraries = listing.libraries.filter(item => item.title === options.title && item.status === 'available');
  check(libraries.length === 1, 'normal owner library discovery ambiguous');
  const proof = await driver.inspect(lease, libraries[0].handle, signal);
  const resources = await driver.openScope(proof, signal);
  held = { driver, resources }; return held;
}

/** Independent raw observation only: no write transaction, grant, session or repository in this oracle. */
async function observe(databaseName: string, scope: EditScope): Promise<Observed> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing canonical storage required')); };
    request.onblocked = () => reject(new Error('read-only observation blocked'));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    return await new Promise<Observed>((resolve, reject) => {
      const tx = db.transaction(['roots', 'edits', 'intents', 'projections'], 'readonly');
      const roots = tx.objectStore('roots').getAll() as IDBRequest<Row<Snapshot>[]>;
      const edits = tx.objectStore('edits').getAll() as IDBRequest<Row<StoredEdit>[]>;
      const intents = tx.objectStore('intents').getAll() as IDBRequest<Row<EditIntentRecord>[]>;
      const projections = tx.objectStore('projections').getAll() as IDBRequest<Row<Snapshot>[]>;
      tx.onabort = () => reject(tx.error ?? new Error('read-only observation aborted'));
      tx.oncomplete = () => {
        try {
          const namespace = JSON.stringify([scope.accountId, scope.libraryId, scope.epoch]);
          const root = roots.result.filter(row => row.scope === namespace && row.value.id === scope.libraryId);
          check(root.length === 1 && root[0].value.kind === 'library', 'physical library root missing');
          resolve({ root: root[0].value as LibrarySnapshot,
            edits: edits.result.filter(row => row.scope === namespace).map(row => row.value),
            intents: intents.result.filter(row => row.scope === namespace && (JSON.parse(row.key) as string[])[1] === scope.libraryId).map(row => row.value),
            projections: projections.result.filter(row => row.scope === namespace && row.value.kind === 'library' && row.value.id === scope.libraryId).map(row => row.value as LibrarySnapshot) });
        } catch (error) { reject(error); }
      };
    });
  } finally { db.close(); }
}

function registry(repository: ContentRepository, resources: ScopeResources) {
  return new DocumentEditSessions(repository, resources.markdownDrafts, resources.markdownImages, resources.appendDrafts, resources.queryPreferences);
}

export async function prepare(options: Options) {
  const { resources } = await admit(options, true), repository = resources.repository;
  const initial = registry(repository, resources); await initial.initialize();
  const library = initial.getLibrary(); check(await library.refresh(), 'normal library did not load');
  check(await library.createTemplate('Reserved template', 'Template body'), 'normal template publication failed');
  const publishedTemplates = library.getSnapshot().templates.filter(item => item.title === 'Reserved template');
  check(publishedTemplates.length === 1 && publishedTemplates[0].kind === 'markdown'
    && same(publishedTemplates[0].metadata, { 'papeer.note-template': 'v1' }), 'unique reserved template missing from public catalog');
  const templateId = publishedTemplates[0].id;
  check(same(library.getSelectedSnapshot()?.items.find(item => item.id === templateId), publishedTemplates[0]),
    'public template catalog and full selected snapshot differ');
  check(await library.create({ kind: 'markdown', title: 'Deleted memo' }), 'normal memo publication failed');
  const deletedId = library.getSnapshot().createdId; check(deletedId, 'memo ID missing');
  check(await library.deleteItems([deletedId!]), 'normal logical deletion failed');
  const base = library.getSelectedSnapshot(); check(base, 'base selected snapshot missing');
  const template = base!.items.find(item => item.id === templateId);
  const deletion = base!.deletions.find(item => item.itemIds.includes(deletedId!));
  check(template && same(template, publishedTemplates[0]) && deletion?.active, 'normal template/deletion state missing');
  const branch = (title: string): LibraryEditBatch => ({ kind: 'library', id: crypto.randomUUID(), libraryId: repository.scope.libraryId,
    targetId: repository.scope.libraryId, parents: [base!.version], changes: [{ type: 'put-folder', folder: { id: crypto.randomUUID(), title, parentId: null, position: 0 } }] });
  const a = branch('Selected local branch'), b = branch('Other local branch');
  b.changes.push({ type: 'put-item', item: { ...template!, title: 'Other template', metadata: { ...template!.metadata, source: 'other' } } });
  b.changes.push({ type: 'put-deletion', deletion: { ...deletion!, active: false } });
  // Authorized ordinary commit with known parents creates local contract branches; no receive/initialize or raw IDB write.
  check((await repository.commit(a)).status === 'durable' && (await repository.commit(b)).status === 'durable', 'normal authorized local branch commits failed');
  const attempts: EditBatch[] = []; let injected = false;
  const wrapped: ContentRepository = { ...repository, commit: async (batch, history) => {
    if (batch.kind === 'resolution') attempts.push(structuredClone(batch));
    const result = await repository.commit(batch, history);
    if (batch.kind === 'resolution' && !injected) {
      check(result.status === 'durable', 'cannot inject unknown before real durable commit');
      const receipt = await repository.receipt(batch.id), intent = await repository.readIntent(repository.scope.libraryId);
      check(receipt?.durable === true && intent?.intent.dispatched === true && 'batch' in intent.intent.request
        && same(intent.intent.request.batch, batch), 'physical receipt/dispatched journal must exist before reply loss');
      injected = true; return { status: 'unknown', reason: 'fixture reply lost after real durable receipt' };
    }
    return result;
  } };
  const resolving = registry(wrapped, resources); await resolving.initialize(); const authority = resolving.getLibrary();
  check(await authority.refresh(a.id), 'selected local branch unavailable');
  const versions = authority.conflictVersions(), selected = versions.find(item => item.version === a.id), other = versions.find(item => item.version === b.id);
  check(selected && other && !same(selected.items, other.items) && !same(selected.deletions, other.deletions), 'full branch metadata/deletion divergence absent');
  check(!await authority.resolveConflict(a.id, authority.getSnapshot().heads) && injected, 'resolution did not retain injected unknown');
  check(!authority.canLeave() && (await resolving.prepareLeave()).status === 'refused', 'unknown resolution must refuse guarded leave');
  const raw = await observe(options.databaseName, repository.scope), pending = raw.intents[0];
  check(raw.intents.length === 1 && pending.intent.dispatched && 'batch' in pending.intent.request, 'physical unknown intent absent');
  const batch = 'batch' in pending.intent.request ? pending.intent.request.batch : null; check(batch?.kind === 'resolution', 'physical request is not resolution');
  const committed = raw.edits.filter(edit => edit.batch.id === batch!.id); check(committed.length === 1 && committed[0].receipt.durable, 'physical single durable resolution missing');
  check(raw.projections.some(value => same(value, { ...selected!, version: batch!.id })), 'physical complete selected snapshot projection differs');
  return { generation, scope: repository.scope, selected: selected!, templateId: templateId!, deletedId: deletedId!, request: batch!, intent: pending,
    committed: committed[0], attempts, guardedLeaveRefused: true, storage: raw };
}

export async function recover(options: Options) {
  const { resources } = await admit(options, false), repository = resources.repository, attempts: EditBatch[] = [];
  const wrapped: ContentRepository = { ...repository, commit: async (batch, history) => {
    if (batch.kind === 'resolution') attempts.push(structuredClone(batch));
    return repository.commit(batch, history);
  } };
  const rawBefore = await observe(options.databaseName, repository.scope);
  const restored = registry(wrapped, resources); await restored.initialize(); const library = restored.getLibrary();
  check(restored.getSnapshot().ready && restored.getSnapshot().unhandledTargets.length === 0 && !library.canLeave()
    && (await restored.prepareLeave()).status === 'refused', 'cold registry did not restore the pending guard');
  const intent = await repository.readIntent(repository.scope.libraryId);
  check(intent && rawBefore.intents.length === 1 && same(intent, rawBefore.intents[0]), 'cold registry did not read the exact physical intent');
  check(await library.retry(), 'same-ID recovery retry failed');
  const selected = library.getSelectedSnapshot(), rawAfter = await observe(options.databaseName, repository.scope);
  check(selected && library.canLeave() && (await restored.prepareLeave()).status === 'allowed' && !library.getSnapshot().canUndo, 'resolved scope/history state differs');
  check(rawAfter.intents.length === 0, 'confirmed resolution intent did not durably clear');
  return { generation, scope: repository.scope, intent: intent!, attempts, selected: selected!, heads: library.getSnapshot().heads, rawBefore, rawAfter };
}

export async function confirm(options: Options) {
  const { resources } = await admit(options, false), restored = registry(resources.repository, resources);
  await restored.initialize(); const library = restored.getLibrary(); check(await library.refresh(), 'second cold library refresh failed');
  const raw = await observe(options.databaseName, resources.repository.scope);
  check(library.canLeave() && !library.getSnapshot().canUndo && raw.intents.length === 0, 'second cold state/journal differs');
  return { generation, scope: resources.repository.scope, selected: library.getSelectedSnapshot(), heads: library.getSnapshot().heads, raw };
}

/** Explicit fixture owner shutdown; this bypasses a refused view leave only as simulated unexpected owner loss. */
export async function closeOwner() {
  const current = held; held = undefined;
  if (current) try { await current.resources.close(); } finally { await current.driver.close(); }
}

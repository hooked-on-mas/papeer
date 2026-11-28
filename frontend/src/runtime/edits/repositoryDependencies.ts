import type { ContentRepository, EditScope } from './ports.ts';
import { selectorKey, type EditPlanView, type ScopeRead } from './repositoryPlan.ts';

export type RepositoryMethod = Exclude<keyof ContentRepository, 'scope'>;

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value) ? value as ObjectValue : undefined;
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const scopeValue = (value: unknown): EditScope | undefined => {
  const item = object(value);
  return item && typeof item.accountId === 'string' && typeof item.libraryId === 'string' && typeof item.epoch === 'string'
    ? { accountId: item.accountId, libraryId: item.libraryId, epoch: item.epoch } : undefined;
};
const unique = (reads: ScopeRead[]): ScopeRead[] => [...new Map(reads.map(read => [selectorKey(read), read])).values()];

/** All selectors whose keys are known from the fixed request, including absent rows. */
export function seedRepositoryReads(scope: EditScope, method: RepositoryMethod, args: readonly unknown[]): ScopeRead[] {
  const reads: ScopeRead[] = [{ kind: 'control', identity: { accountId: scope.accountId, libraryId: scope.libraryId } }];
  const target = string(args[0]);
  const input = object(args[0]);
  const addTarget = (kind: 'roots' | 'edits' | 'intents', id: string | undefined) => {
    if (id !== undefined) reads.push({ kind, scope, targetId: id });
  };
  switch (method) {
    case 'readIntent': case 'replaceIntent': addTarget('intents', target); break;
    case 'pendingIntents': reads.push({ kind: 'intents', scope }); break;
    case 'installedDatasets': reads.push({ kind: 'datasets', scope }); break;
    case 'installDataset':
      reads.push({ kind: 'datasets', scope }, { kind: 'roots', scope }, { kind: 'edits', scope });
      if (string(input?.checkpointSha256) !== undefined) reads.push({ kind: 'checkpoint-marker', scope, sha256: input!.checkpointSha256 as string });
      break;
    case 'replaceDatasetControl': {
      const transition = object(input?.transition), publication = object(transition?.publication);
      const manifest = object(publication?.manifest), source = object(transition?.source);
      for (const selected of [scopeValue(manifest?.scope), scopeValue(source?.scope)]) if (selected)
        reads.push({ kind: 'roots', scope: selected }, { kind: 'edits', scope: selected }, { kind: 'intents', scope: selected }, { kind: 'datasets', scope: selected });
      break;
    }
    case 'read': addTarget('roots', target); addTarget('edits', target); break;
    case 'initialize': addTarget('roots', string(input?.id)); addTarget('edits', string(input?.id)); break;
    case 'checkpoint': case 'installCheckpoint': case 'receive': case 'receiveRecords': case 'receivePublications':
      reads.push({ kind: 'roots', scope }, { kind: 'edits', scope }); break;
    case 'commit': case 'publish': {
      reads.push({ kind: 'edits', scope });
      const batch = method === 'publish' ? object(input?.libraryBatch) : input;
      addTarget('roots', string(batch?.targetId));
      if (method === 'publish' && Array.isArray(batch?.changes)) for (const change of batch.changes) {
        const entry = object(change), item = object(entry?.item);
        if (entry?.type === 'put-item') addTarget('roots', string(item?.id));
      }
      if (method === 'publish') addTarget('roots', string(object(input?.content)?.id));
      break;
    }
    case 'receipt': if (target !== undefined) reads.push({ kind: 'edit-by-id', scope, batchId: target }); break;
    case 'pending': case 'pendingRecords': case 'pendingPublications': case 'acknowledgeUpload': case 'acknowledgeImport':
      reads.push({ kind: 'edits', scope }); break;
    case 'readResource': case 'resourceMetadata':
      if (target !== undefined) reads.push({ kind: 'resource', scope, resourceId: target }); break;
    case 'storeResource': {
      const id = string(input?.id), sha = string(input?.sha256);
      if (id !== undefined) reads.push({ kind: 'resource', scope, resourceId: id });
      if (sha !== undefined) reads.push({ kind: 'resource-bytes', scope, sha256: sha });
      break;
    }
  }
  return unique(reads);
}

/**
 * Enumerate dependency keys from the complete captured collections and fixed input.
 * Roots and changes together contain every resource and catalog item that a graph
 * projection can retain or introduce, including deleted pages and waiting parents.
 * This pass only collects keys; semantic validation remains in the repository.
 */
export function repositoryDependencies(view: EditPlanView, method: RepositoryMethod, args: readonly unknown[]): ScopeRead[] {
  const reads: ScopeRead[] = [];
  const add = (read: ScopeRead) => reads.push(read);
  if (method === 'readResource') {
    const id = string(args[0]);
    for (const entry of view.snapshot.values) if (entry.read.kind === 'resource' && entry.read.resourceId === id) {
      const sha = string(object(entry.value)?.sha256);
      if (sha !== undefined) add({ kind: 'resource-bytes', scope: entry.read.scope, sha256: sha });
    }
    return unique(reads);
  }
  if (method === 'installDataset' || method === 'replaceDatasetControl') {
    const first = object(args[0]);
    const transition = object(first?.transition);
    const manifest = method === 'installDataset' ? first : object(object(transition?.publication)?.manifest);
    if (method === 'replaceDatasetControl' && (transition?.phase === 'prepared' || transition?.phase === 'rolled-back')) return [];
    const selected = scopeValue(manifest?.scope);
    if (selected && Array.isArray(manifest?.resources)) for (const resource of manifest.resources) {
      const value = object(resource), id = string(value?.id), sha = string(value?.sha256);
      if (id !== undefined) add({ kind: 'resource', scope: selected, resourceId: id });
      if (sha !== undefined) add({ kind: 'resource-bytes', scope: selected, sha256: sha });
    }
    if (method === 'replaceDatasetControl') return unique(reads);
  }
  if (!['initialize', 'commit', 'publish', 'receive', 'receiveRecords', 'receivePublications', 'installCheckpoint', 'installDataset'].includes(method)) return unique(reads);

  const visit = (value: unknown, selected: EditScope): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item, selected); return; }
    const entry = object(value);
    if (!entry) return;
    const resourceId = string(entry.resourceId);
    if (resourceId !== undefined) add({ kind: 'resource', scope: selected, resourceId });
    if (entry.kind === 'library' && Array.isArray(entry.items)) for (const itemValue of entry.items) {
      const item = object(itemValue), id = string(item?.id);
      if (id !== undefined && item?.kind !== 'attachment') add({ kind: 'roots', scope: selected, targetId: id });
    }
    if (entry.type === 'put-item') {
      const item = object(entry.item), id = string(item?.id);
      if (id !== undefined && item?.kind !== 'attachment') add({ kind: 'roots', scope: selected, targetId: id });
    }
    for (const child of Object.values(entry)) visit(child, selected);
  };
  // Inputs are always bound to the captured operation scope. A nested object
  // cannot select a different epoch; only the explicit manifest proof above can.
  visit(args, view.scope);
  for (const entry of view.snapshot.values) if (entry.read.kind === 'roots' || entry.read.kind === 'edits')
    visit(entry.value, entry.read.scope);
  return unique(reads);
}

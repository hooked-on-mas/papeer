// LEGACY-COPY B13-d U2: verbatim copy of the pre-U2 product file (only the import specifiers are rewritten for tests/support).
// LEGACY-COPY Do not edit: tests/libraryHistoryEquivalence.test.ts maps the specifiers back and checks the sha256 of the original.
import type { DeletionRecord, EditBatch, Folder, HistoryRecord, ItemLink, LibraryEditBatch, LibraryItem, LibrarySnapshot } from '../../src/runtime/edits/contracts.ts';
import type { PublicationOrigin } from '../../src/runtime/edits/ports.ts';
import { applyBatch, canonicalJson, deletedItemIds, EditRejected } from '../../src/runtime/edits/editModel.ts';
import { BIBLIOGRAPHY_FIELDS, normalizeBibliographyField, type LibraryBibliographyField } from '../../src/features/library/canonicalLibraryOperations.ts';
import { isNoteTemplate } from '../../src/runtime/markdown/noteTemplates.ts';

export type LibraryHistoryEntry = { operationId: string; executionId: string };
export interface LibraryVersions {
  batch(id: string): EditBatch | undefined;
  snapshot(id: string): LibrarySnapshot | undefined;
  /** Durable publication records, not inferred from a put-item batch or history entry. */
  publicationOrigin?(id: string): PublicationOrigin | undefined;
  /** Proves a head belongs to this content and descends from its publication root. */
  contentVersion?(itemId: string, head: string): boolean;
}
const editableFields = ['title', 'tags', 'read'] as const;
function metadataEdit(versions: LibraryVersions, executionId: string) {
  const batch = versions.batch(executionId);
  if (!batch || batch.kind !== 'library' || batch.parents.length !== 1 || !batch.changes.length
    || batch.changes.some(change => change.type !== 'put-item')) throw new EditRejected('library-history-unsupported');
  const before = versions.snapshot(batch.parents[0]), after = versions.snapshot(executionId);
  if (!before || !after || before.id !== batch.targetId || after.id !== batch.targetId
    || before.version !== batch.parents[0] || after.version !== executionId || batch.id !== executionId)
    throw new EditRejected('library-history-version-missing');
  if (canonicalJson(applyBatch(before, batch)) !== canonicalJson(after)) throw new EditRejected('library-history-unsupported');
  const seen = new Set<string>();
  const altered = batch.changes.map(change => {
    if (change.type !== 'put-item' || seen.has(change.item.id)) throw new EditRejected('library-history-unsupported');
    const itemId = change.item.id; seen.add(itemId);
    const previous = before.items.find(item => item.id === itemId), next = after.items.find(item => item.id === itemId);
    if (!previous || !next) throw new EditRejected('library-history-unsupported');
    if ([before, after].some(snapshot => snapshot.deletions.some(value => value.active && value.itemIds.includes(itemId))))
      throw new EditRejected('library-history-deleted');
    const protectedFields = (item: typeof previous) => ({ ...item, title: '', tags: [], read: false });
    const fields = editableFields.filter(field => canonicalJson(previous[field]) !== canonicalJson(next[field]));
    if (!fields.length || canonicalJson(protectedFields(previous)) !== canonicalJson(protectedFields(next))) throw new EditRejected('library-history-unsupported');
    return { previous, next, fields };
  });
  return { batch, altered };
}

type ItemPatch = { previous: LibraryItem; next: LibraryItem; fields: (keyof LibraryItem)[]; metadataFields?: LibraryBibliographyField[]; allowDeleted?: boolean };
type FolderPatch = { previous?: Folder; next?: Folder; fields: (keyof Folder)[] };
type LinkPatch = { added: ItemLink[]; removed: ItemLink[] };
type DeletionPatch = { previous?: DeletionRecord; next: DeletionRecord };
type ParsedLibraryEdit = {
  batch: LibraryEditBatch; altered: ItemPatch[]; folders: FolderPatch[];
  links?: LinkPatch; deletion?: DeletionPatch;
  creation?: LibraryItem;
};
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function verifiedLibraryBatch(versions: LibraryVersions, executionId: string) {
  const batch = versions.batch(executionId);
  if (!batch || batch.kind !== 'library' || batch.parents.length !== 1 || !batch.changes.length) throw new EditRejected('library-history-unsupported');
  const before = versions.snapshot(batch.parents[0]), after = versions.snapshot(executionId);
  if (!before || !after || before.id !== batch.targetId || after.id !== batch.targetId || before.version !== batch.parents[0]
    || after.version !== batch.id || batch.id !== executionId || !equal(applyBatch(before, batch), after)) throw new EditRejected('library-history-version-missing');
  return { batch, before, after };
}
function bibliographyEdit(versions: LibraryVersions, executionId: string, allowRestore: boolean): ParsedLibraryEdit {
  const { batch, before, after } = verifiedLibraryBatch(versions, executionId);
  if (batch.changes.length !== 1 || batch.changes[0].type !== 'put-item') throw new EditRejected('library-history-unsupported');
  const itemId = batch.changes[0].item.id;
  const previous = before.items.find(item => item.id === itemId), next = after.items.find(item => item.id === itemId);
  if (!previous || !next || previous.kind !== 'pdf' || next.kind !== 'pdf' || previous.ownerId !== null || next.ownerId !== null)
    throw new EditRejected('library-history-unsupported');
  if (deletedItemIds(before).has(itemId) || deletedItemIds(after).has(itemId)) throw new EditRejected('library-history-deleted');
  if (!equal({ ...previous, metadata: {} }, { ...next, metadata: {} })) throw new EditRejected('library-history-unsupported');
  const allKeys = new Set([...Object.keys(previous.metadata), ...Object.keys(next.metadata)]);
  const metadataFields: LibraryBibliographyField[] = [];
  for (const key of allKeys) {
    const samePresence = (key in previous.metadata) === (key in next.metadata);
    if (samePresence && equal(previous.metadata[key], next.metadata[key])) continue;
    if (!BIBLIOGRAPHY_FIELDS.includes(key as LibraryBibliographyField)) throw new EditRejected('library-history-unsupported');
    const field = key as LibraryBibliographyField;
    if (field in next.metadata) {
      const value = next.metadata[field];
      if (typeof value !== 'string') throw new EditRejected('library-history-unsupported');
      if (!allowRestore && (!value || normalizeBibliographyField(field, value) !== value))
        throw new EditRejected('library-history-unsupported');
    }
    metadataFields.push(field);
  }
  if (!metadataFields.length) throw new EditRejected('library-history-unsupported');
  return { batch, altered: [{ previous, next, fields: ['metadata'], metadataFields }], folders: [] };
}
function folderEdit(versions: LibraryVersions, executionId: string, allowRestore: boolean): ParsedLibraryEdit {
  const { batch, before, after } = verifiedLibraryBatch(versions, executionId);
  const items: ItemPatch[] = [], folders: FolderPatch[] = [], seen = new Set<string>();
  for (const change of batch.changes) {
    if (!['put-item', 'put-folder', 'remove-folder'].includes(change.type)) throw new EditRejected('library-history-unsupported');
    if (change.type === 'put-item') {
      const previous = before.items.find(item => item.id === change.item.id), next = after.items.find(item => item.id === change.item.id);
      if (!previous || !next || previous.ownerId !== null || next.ownerId !== null || seen.has('i:' + next.id)
        || previous.folderId === next.folderId || !equal({ ...previous, folderId: null, position: 0 }, { ...next, folderId: null, position: 0 })) throw new EditRejected('library-history-unsupported');
      seen.add('i:' + next.id); items.push({ previous, next, fields: (['folderId', 'position'] as const).filter(key => !equal(previous[key], next[key])) });
    } else if (change.type === 'put-folder' || change.type === 'remove-folder') {
      const id = change.type === 'put-folder' ? change.folder.id : change.id;
      if (seen.has('f:' + id)) throw new EditRejected('library-history-unsupported'); seen.add('f:' + id);
      const previous = before.folders.find(value => value.id === id), next = after.folders.find(value => value.id === id);
      if (!previous && !next) throw new EditRejected('library-history-unsupported');
      const fields: (keyof Folder)[] = previous && next ? (['title', 'parentId', 'position'] as const).filter(key => !equal(previous[key], next[key])) : [];
      if (previous && next && (!fields.length || fields.includes('title') && fields.length !== 1 || fields.includes('position') && !fields.includes('parentId')))
        throw new EditRejected('library-history-unsupported');
      folders.push({ previous, next, fields });
    }
  }
  const inserted = folders.filter(value => !value.previous), removed = folders.filter(value => !value.next);
  if (inserted.length > 1 || removed.length > 1 || inserted.length && removed.length) throw new EditRejected('library-history-unsupported');
  const changedFolders = folders.filter(value => value.previous && value.next);
  if (inserted.length || removed.length) {
    const creation = !!inserted.length, center = (creation ? inserted[0].next : removed[0].previous)!;
    if (creation && !allowRestore && (items.length || changedFolders.length)) throw new EditRejected('library-history-unsupported');
    const from = creation ? center.parentId : center.id, to = creation ? center.id : center.parentId;
    if (items.some(value => value.previous.folderId !== from || value.next.folderId !== to)
      || changedFolders.some(value => value.previous!.parentId !== from || value.next!.parentId !== to || value.fields.includes('title')))
      throw new EditRejected('library-history-unsupported');
    if (!creation && (before.items.filter(value => value.folderId === center.id).length !== items.length
      || before.folders.filter(value => value.parentId === center.id).length !== changedFolders.length)) throw new EditRejected('library-history-unsupported');
    for (const item of items) item.allowDeleted = true;
  } else if (folders.length) {
    if (folders.length !== 1 || items.length) throw new EditRejected('library-history-unsupported');
  } else {
    if (!items.length || !allowRestore && new Set(items.map(value => value.next.folderId)).size !== 1) throw new EditRejected('library-history-unsupported');
    if (items.some(value => before.deletions.some(deletion => deletion.active && deletion.itemIds.includes(value.previous.id)))) throw new EditRejected('library-history-deleted');
  }
  return { batch, altered: items, folders };
}
/** Reordering changes only placement, for one mixed sibling group and at most one incoming/outgoing entry. */
function reorderEdit(versions: LibraryVersions, executionId: string): ParsedLibraryEdit {
  const { batch, before, after } = verifiedLibraryBatch(versions, executionId);
  const items: ItemPatch[] = [], folders: FolderPatch[] = [], seen = new Set<string>();
  const stableParents = new Set<string | null>(), moves: { from: string | null; to: string | null }[] = [];
  for (const change of batch.changes) {
    if (change.type === 'put-item') {
      const previous = before.items.find(value => value.id === change.item.id), next = after.items.find(value => value.id === change.item.id);
      if (!previous || !next || previous.ownerId !== null || next.ownerId !== null || isNoteTemplate(previous) || isNoteTemplate(next) || seen.has(`item:${next.id}`)
        || !equal({ ...previous, folderId: null, position: 0 }, { ...next, folderId: null, position: 0 })
        || before.deletions.some(value => value.active && value.itemIds.includes(next.id))) throw new EditRejected('library-history-unsupported');
      seen.add(`item:${next.id}`);
      const fields = (['folderId', 'position'] as const).filter(key => !equal(previous[key], next[key]));
      if (!fields.length) throw new EditRejected('library-history-unsupported');
      items.push({ previous, next, fields });
      if (previous.folderId === next.folderId) stableParents.add(next.folderId); else moves.push({ from: previous.folderId, to: next.folderId });
    } else if (change.type === 'put-folder') {
      const previous = before.folders.find(value => value.id === change.folder.id), next = after.folders.find(value => value.id === change.folder.id);
      if (!previous || !next || seen.has(`folder:${next.id}`) || !equal({ ...previous, parentId: null, position: 0 }, { ...next, parentId: null, position: 0 }))
        throw new EditRejected('library-history-unsupported');
      seen.add(`folder:${next.id}`);
      const fields = (['parentId', 'position'] as const).filter(key => !equal(previous[key], next[key]));
      if (!fields.length) throw new EditRejected('library-history-unsupported');
      folders.push({ previous, next, fields });
      if (previous.parentId === next.parentId) stableParents.add(next.parentId); else moves.push({ from: previous.parentId, to: next.parentId });
    } else throw new EditRejected('library-history-unsupported');
  }
  if (!seen.size || moves.length > 1 || stableParents.size > 1) throw new EditRejected('library-history-unsupported');
  if (moves.length && stableParents.size && !stableParents.has(moves[0].from) && !stableParents.has(moves[0].to))
    throw new EditRejected('library-history-unsupported');
  return { batch, altered: items, folders };
}
function linkEdit(versions: LibraryVersions, executionId: string): ParsedLibraryEdit {
  const { batch } = verifiedLibraryBatch(versions, executionId);
  const allAdd = batch.changes.every(change => change.type === 'add-link');
  const allRemove = batch.changes.every(change => change.type === 'remove-link');
  if (!allAdd && !allRemove) throw new EditRejected('library-history-unsupported');
  const added = batch.changes.filter(change => change.type === 'add-link').map(change => structuredClone(change.link));
  const removed = batch.changes.filter(change => change.type === 'remove-link').map(change => structuredClone(change.link));
  return { batch, altered: [], folders: [], links: { added, removed } };
}
function ownerChangePatch(before: LibrarySnapshot, after: LibrarySnapshot, itemId: string, detaching: boolean,
  deletedBefore: ReadonlySet<string>, deletedAfter: ReadonlySet<string>): ItemPatch {
  const previous = before.items.find(item => item.id === itemId), next = after.items.find(item => item.id === itemId);
  if (!previous || !next || deletedBefore.has(itemId) || deletedAfter.has(itemId) || !['markdown', 'notebook'].includes(previous.kind))
    throw new EditRejected('library-history-unsupported');
  if (!equal({ ...previous, ownerId: null, folderId: null, position: 0 }, { ...next, ownerId: null, folderId: null, position: 0 }))
    throw new EditRejected('library-history-unsupported');
  if (detaching) {
    if (!previous.ownerId || previous.folderId !== null || next.ownerId !== null) throw new EditRejected('library-history-unsupported');
    const owner = before.items.find(item => item.id === previous.ownerId);
    if (!owner || deletedBefore.has(owner.id) || owner.ownerId !== null || next.folderId !== owner.folderId) throw new EditRejected('library-history-unsupported');
  } else {
    if (previous.ownerId !== null || !next.ownerId || next.folderId !== null) throw new EditRejected('library-history-unsupported');
    const owner = after.items.find(item => item.id === next.ownerId);
    if (!owner || deletedAfter.has(owner.id) || owner.ownerId !== null || previous.folderId !== owner.folderId) throw new EditRejected('library-history-unsupported');
  }
  return { previous, next, fields: ['ownerId', 'folderId', 'position'] };
}
function detachEdit(versions: LibraryVersions, executionId: string, allowRestore: boolean): ParsedLibraryEdit {
  const { batch, before, after } = verifiedLibraryBatch(versions, executionId);
  if (batch.changes.some(change => change.type !== 'put-item')) throw new EditRejected('library-history-unsupported');
  const deletedBefore = deletedItemIds(before), deletedAfter = deletedItemIds(after);
  const first = batch.changes[0];
  if (first.type !== 'put-item') throw new EditRejected('library-history-unsupported');
  const firstBefore = before.items.find(item => item.id === first.item.id);
  const detaching = !!firstBefore?.ownerId;
  if (!detaching && !allowRestore) throw new EditRejected('library-history-unsupported');
  const seen = new Set<string>();
  const altered = batch.changes.map(change => {
    if (change.type !== 'put-item' || seen.has(change.item.id)) throw new EditRejected('library-history-unsupported');
    seen.add(change.item.id);
    return ownerChangePatch(before, after, change.item.id, detaching, deletedBefore, deletedAfter);
  });
  return { batch, altered, folders: [] };
}
function deletionEdit(versions: LibraryVersions, executionId: string, allowRestore: boolean): ParsedLibraryEdit {
  const { batch, before, after } = verifiedLibraryBatch(versions, executionId);
  const deletions = batch.changes.filter(change => change.type === 'put-deletion');
  if (deletions.length !== 1 || !deletions[0].deletion.itemIds.length) throw new EditRejected('library-history-unsupported');
  const nextDeletion = deletions[0].deletion, prevDeletion = before.deletions.find(record => record.id === nextDeletion.id);
  const deletedBefore = deletedItemIds(before), deletedAfter = deletedItemIds(after);
  const targetSet = new Set(nextDeletion.itemIds);
  const altered: ItemPatch[] = [], added: ItemLink[] = [], removed: ItemLink[] = [], seenItems = new Set<string>();
  if (nextDeletion.active) {
    if (!allowRestore && prevDeletion) throw new EditRejected('library-history-unsupported');
    if (prevDeletion && (prevDeletion.active || !equal({ ...nextDeletion, active: false }, prevDeletion))) throw new EditRejected('library-history-unsupported');
    if (nextDeletion.itemIds.some(id => deletedBefore.has(id))) throw new EditRejected('library-history-deleted');
    for (const change of batch.changes) {
      if (change.type === 'put-deletion') continue;
      if (change.type === 'put-item') {
        if (seenItems.has(change.item.id) || targetSet.has(change.item.id)) throw new EditRejected('library-history-unsupported');
        seenItems.add(change.item.id);
        const patch = ownerChangePatch(before, after, change.item.id, true, deletedBefore, deletedAfter);
        if (!patch.previous.ownerId || !targetSet.has(patch.previous.ownerId)) throw new EditRejected('library-history-unsupported');
        altered.push(patch);
      } else if (change.type === 'remove-link') {
        if (!targetSet.has(change.link.pdfId) && !targetSet.has(change.link.noteId)) throw new EditRejected('library-history-unsupported');
        removed.push(structuredClone(change.link));
      } else throw new EditRejected('library-history-unsupported');
    }
    const survivingChildren = before.items.filter(item => !deletedBefore.has(item.id) && !targetSet.has(item.id) && item.ownerId && targetSet.has(item.ownerId));
    if (survivingChildren.length !== altered.length) throw new EditRejected('library-history-unsupported');
  } else {
    if ((!allowRestore && batch.changes.length !== 1) || !prevDeletion || !prevDeletion.active || !equal({ ...nextDeletion, active: true }, prevDeletion))
      throw new EditRejected('library-history-unsupported');
    if (nextDeletion.itemIds.some(id => deletedAfter.has(id))) throw new EditRejected('library-history-deleted');
    for (const id of nextDeletion.itemIds) {
      const item = after.items.find(value => value.id === id);
      if (!item || (item.folderId !== null && !after.folders.some(folder => folder.id === item.folderId)))
        throw new EditRejected('library-history-unsupported');
      if (item.ownerId !== null) {
        const owner = after.items.find(value => value.id === item.ownerId);
        if (!owner || owner.ownerId !== null || deletedAfter.has(owner.id)) throw new EditRejected('library-history-unsupported');
      }
    }
    for (const change of batch.changes) {
      if (change.type === 'put-deletion') continue;
      if (change.type === 'put-item') {
        if (seenItems.has(change.item.id) || targetSet.has(change.item.id)) throw new EditRejected('library-history-unsupported');
        seenItems.add(change.item.id);
        const patch = ownerChangePatch(before, after, change.item.id, false, deletedBefore, deletedAfter);
        if (!patch.next.ownerId || !targetSet.has(patch.next.ownerId)) throw new EditRejected('library-history-unsupported');
        altered.push(patch);
      } else if (change.type === 'add-link') {
        if (!targetSet.has(change.link.pdfId) && !targetSet.has(change.link.noteId)) throw new EditRejected('library-history-unsupported');
        added.push(structuredClone(change.link));
      } else throw new EditRejected('library-history-unsupported');
    }
  }
  return { batch, altered, folders: [], links: { added, removed }, deletion: { previous: prevDeletion, next: nextDeletion } };
}
function publicationCreation(versions: LibraryVersions, executionId: string): ParsedLibraryEdit {
  const { batch, before, after } = verifiedLibraryBatch(versions, executionId);
  const origin = versions.publicationOrigin?.(executionId);
  if (!origin || origin.batchId !== batch.id) throw new EditRejected('library-history-publication-missing');
  const puts = batch.changes.filter(change => change.type === 'put-item');
  if (puts.length !== 1) throw new EditRejected('library-history-unsupported');
  const item = puts[0].item;
  if (!['markdown', 'notebook', 'attachment', 'pdf'].includes(item.kind) || origin.itemId !== item.id || origin.kind !== item.kind
    || (item.kind === 'attachment' ? origin.contentVersion !== null || !item.ownerId || !item.resourceId
      : !origin.contentVersion)
    || item.kind === 'pdf' && (item.ownerId !== null || !item.resourceId)
    || before.items.some(previous => previous.id === item.id) || !equal(after.items.find(next => next.id === item.id), item))
    throw new EditRejected('library-history-unsupported');
  const added: ItemLink[] = [];
  for (const change of batch.changes) {
    if (change.type === 'put-item') continue;
    if (change.type !== 'add-link' || change.link.noteId !== item.id || item.kind === 'attachment')
      throw new EditRejected('library-history-unsupported');
    added.push(structuredClone(change.link));
  }
  return { batch, altered: [], folders: [], creation: structuredClone(item), links: { added, removed: [] } };
}
function libraryEdit(versions: LibraryVersions, id: string, allowRestore: boolean): ParsedLibraryEdit {
  const parsers: (() => ParsedLibraryEdit)[] = [
    () => ({ ...metadataEdit(versions, id), folders: [] }),
    () => bibliographyEdit(versions, id, allowRestore),
    () => folderEdit(versions, id, allowRestore),
    () => reorderEdit(versions, id),
    () => linkEdit(versions, id),
    () => detachEdit(versions, id, allowRestore),
    () => deletionEdit(versions, id, allowRestore),
    () => publicationCreation(versions, id),
  ];
  let lastError: unknown;
  for (const parse of parsers) {
    try { return parse(); }
    catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new EditRejected('library-history-unsupported');
}
/** Pending normal commands cannot masquerade as a folder-restoring inverse. Action callers also prove stack identity. */
export function assertLibraryEdit(versions: LibraryVersions, executionId: string, allowRestore = false): void {
  libraryEdit(versions, executionId, allowRestore);
}
/** Metadata-only compatibility boundary. */
export function assertLibraryMetadataEdit(versions: LibraryVersions, executionId: string): void { metadataEdit(versions, executionId); }

export function inverseLibraryEdit(versions: LibraryVersions, executionId: string, current: LibrarySnapshot, newId: string,
  options?: { observed: DeletionRecord['observed'] }): LibraryEditBatch {
  const { batch, altered, folders, links, deletion, creation } = libraryEdit(versions, executionId, true);
  if (current.id !== batch.targetId) throw new EditRejected('library-history-target');
  const currentDeleted = deletedItemIds(current);
  const changes: LibraryEditBatch['changes'] = [], removals: LibraryEditBatch['changes'] = [];
  if (creation) {
    const item = current.items.find(value => value.id === creation.id);
    if (!item || item.kind !== creation.kind || item.resourceId !== creation.resourceId || item.ownerId !== creation.ownerId
      || currentDeleted.has(item.id) || current.deletions.some(value => value.id === newId)
      || current.items.some(value => value.ownerId === item.id && !currentDeleted.has(value.id))
      || current.links.some(value => (value.pdfId === item.id || value.noteId === item.id)
        && !links?.added.some(link => equal(link, value))))
      throw new EditRejected('library-history-diverged');
    const observed = options?.observed ?? [];
    if (item.kind === 'attachment' ? observed.length !== 0 : observed.length !== 1 || observed[0].targetId !== item.id
      || !observed[0].heads.length || new Set(observed[0].heads).size !== observed[0].heads.length
      || observed[0].heads.some(head => !versions.contentVersion?.(item.id, head)))
      throw new EditRejected('library-history-content-version-missing');
    changes.push({ type: 'put-deletion', deletion: { id: newId, itemIds: [item.id], observed: structuredClone(observed), active: true } });
  }
  if (deletion) {
    const actual = current.deletions.find(value => value.id === deletion.next.id);
    if (!actual || !equal(actual, deletion.next)) throw new EditRejected('library-history-diverged');
    const targetSet = new Set(actual.itemIds);
    if (actual.active) {
      const otherDeleted = new Set(current.deletions.filter(record => record.active && record.id !== actual.id).flatMap(record => record.itemIds));
      if (actual.itemIds.some(id => otherDeleted.has(id))) throw new EditRejected('library-history-diverged');
      for (const id of actual.itemIds) {
        const item = current.items.find(value => value.id === id);
        if (!item || (item.folderId !== null && !current.folders.some(folder => folder.id === item.folderId)))
          throw new EditRejected('library-history-diverged');
        if (item.ownerId !== null) {
          const owner = current.items.find(value => value.id === item.ownerId);
          if (!owner || owner.ownerId !== null || otherDeleted.has(owner.id) || (currentDeleted.has(owner.id) && !targetSet.has(owner.id)))
            throw new EditRejected('library-history-diverged');
        }
      }
    } else {
      if (actual.itemIds.some(id => currentDeleted.has(id))) throw new EditRejected('library-history-diverged');
      const detachingIds = new Set(altered.map(patch => patch.next.id));
      if (current.items.some(item => !currentDeleted.has(item.id) && !targetSet.has(item.id) && item.ownerId && targetSet.has(item.ownerId) && !detachingIds.has(item.id)))
        throw new EditRejected('library-history-diverged');
      const removingLinks = new Set((links?.added ?? []).map(link => `${link.pdfId}:${link.noteId}`));
      if (current.links.some(link => (targetSet.has(link.pdfId) || targetSet.has(link.noteId)) && !removingLinks.has(`${link.pdfId}:${link.noteId}`)))
        throw new EditRejected('library-history-diverged');
    }
  }
  for (const { previous, next, fields } of folders) {
    const id = (previous ?? next)!.id, actual = current.folders.find(value => value.id === id);
    if (!previous) {
      if (!actual || !equal(actual, next)
        || current.items.some(item => item.folderId === id && !altered.some(value => value.next.id === item.id && value.previous.folderId !== id))
        || current.folders.some(value => value.parentId === id && !folders.some(patch => patch.next?.id === value.id && patch.previous?.parentId !== id)))
        throw new EditRejected('library-history-diverged');
      removals.push({ type: 'remove-folder', id });
    } else if (!next) {
      if (actual || previous.parentId !== null && !current.folders.some(value => value.id === previous.parentId)) throw new EditRejected('library-history-diverged');
      changes.unshift({ type: 'put-folder', folder: structuredClone(previous) });
    } else {
      if (!actual || fields.some(field => !equal(actual[field], next[field]))) throw new EditRejected('library-history-diverged');
      changes.push({ type: 'put-folder', folder: { ...actual, ...Object.fromEntries(fields.map(field => [field, previous[field]])) } });
    }
  }
  for (const { previous, next, fields, metadataFields, allowDeleted } of altered) {
    const item = current.items.find(value => value.id === next.id);
    if (!item || fields.some(field => field !== 'metadata' && !equal(item[field], next[field])) || fields.includes('folderId') && !fields.includes('ownerId') && item.ownerId !== null)
      throw new EditRejected('library-history-diverged');
    if (metadataFields?.length) {
      if (item.kind !== 'pdf' || item.ownerId !== null) throw new EditRejected('library-history-diverged');
      for (const field of metadataFields) {
        if ((field in item.metadata) !== (field in next.metadata) || ((field in next.metadata) && !equal(item.metadata[field], next.metadata[field])))
          throw new EditRejected('library-history-diverged');
      }
    } else if (fields.includes('metadata') && !equal(item.metadata, next.metadata)) {
      throw new EditRejected('library-history-diverged');
    }
    if (!allowDeleted && currentDeleted.has(item.id)) throw new EditRejected('library-history-deleted');
    if (fields.includes('ownerId') && previous.ownerId !== null) {
      if (current.links.some(link => link.pdfId === item.id || link.noteId === item.id)) throw new EditRejected('library-history-diverged');
      const owner = current.items.find(value => value.id === previous.ownerId);
      const restoringOwner = !!deletion && deletion.next.active && deletion.next.itemIds.includes(previous.ownerId);
      if (!owner || (!restoringOwner && currentDeleted.has(owner.id)) || owner.ownerId !== null || owner.folderId !== item.folderId)
        throw new EditRejected('library-history-diverged');
    }
    if (fields.includes('ownerId') && previous.ownerId === null) {
      if (previous.folderId !== null && !current.folders.some(folder => folder.id === previous.folderId))
        throw new EditRejected('library-history-diverged');
      const owner = current.items.find(value => value.id === next.ownerId);
      if (!owner || currentDeleted.has(owner.id) || owner.ownerId !== null || owner.folderId !== previous.folderId)
        throw new EditRejected('library-history-diverged');
    }
    if (metadataFields?.length) {
      const metadata = structuredClone(item.metadata);
      for (const field of metadataFields) {
        if (field in previous.metadata) metadata[field] = structuredClone(previous.metadata[field]);
        else delete metadata[field];
      }
      changes.push({ type: 'put-item', item: { ...structuredClone(item), metadata } });
    } else {
      changes.push({ type: 'put-item', item: { ...structuredClone(item), ...Object.fromEntries(fields.map(field => [field, structuredClone(previous[field])])) } });
    }
  }
  changes.push(...removals);
  if (links) {
    for (const added of links.added) {
      if (!current.links.some(link => link.pdfId === added.pdfId && link.noteId === added.noteId)) throw new EditRejected('library-history-diverged');
      changes.push({ type: 'remove-link', link: structuredClone(added) });
    }
    for (const removed of links.removed) {
      if (current.links.some(link => link.pdfId === removed.pdfId && link.noteId === removed.noteId)) throw new EditRejected('library-history-diverged');
      changes.push({ type: 'add-link', link: structuredClone(removed) });
    }
  }
  if (deletion) changes.push({ type: 'put-deletion', deletion: { ...structuredClone(deletion.next), active: !deletion.next.active } });
  const inverse: LibraryEditBatch = { kind: 'library', id: newId, libraryId: batch.libraryId, targetId: current.id, parents: [current.version], changes };
  applyBatch(current, inverse); return inverse;
}
/** Reconstruct only this selected ancestry. Callers must require an explicitly selected catalog head. */
export function restoreLibraryHistory(versions: LibraryVersions, currentVersion: string, records: HistoryRecord[]): {
  undo: LibraryHistoryEntry[]; redo: LibraryHistoryEntry[];
} {
  let undo: LibraryHistoryEntry[] = [], redo: LibraryHistoryEntry[] = [];
  const path: EditBatch[] = [], seen = new Set<string>(), byId = new Map<string, HistoryRecord>();
  for (const record of records) {
    const existing = byId.get(record.operationId);
    if (existing && canonicalJson(existing) !== canonicalJson(record)) throw new EditRejected('library-history-record-conflict');
    byId.set(record.operationId, record);
  }
  let id = currentVersion;
  while (!seen.has(id)) {
    seen.add(id); const batch = versions.batch(id);
    if (!batch || batch.kind === 'resolution' || batch.parents.length !== 1) break;
    path.push(batch); id = batch.parents[0];
  }
  if (versions.batch(id) && seen.has(id) && path.some(batch => batch.id === id)) throw new EditRejected('library-history-cycle');
  for (const batch of path.reverse()) {
    const record = byId.get(batch.id);
    let supported = false;
    try { libraryEdit(versions, batch.id, !!record?.action); supported = true; } catch { /* Unsupported/bare operations are a boundary. */ }
    if (!record || !supported) { undo = []; redo = []; continue; }
    if (record.operationId !== batch.id || record.afterVersion !== batch.id || record.beforeVersion !== batch.parents[0]) throw new EditRejected('history-mismatch');
    if (!record.action) { undo.push({ operationId: batch.id, executionId: batch.id }); redo = []; }
    else {
      const source = record.action.kind === 'undo' ? undo : redo, destination = record.action.kind === 'undo' ? redo : undo;
      const entry = source[source.length - 1];
      if (!entry || entry.operationId !== record.action.operationId) { undo = []; redo = []; continue; }
      const parent = versions.snapshot(batch.parents[0]);
      const observed = batch.kind === 'library' ? batch.changes.find(change => change.type === 'put-deletion')?.deletion.observed : undefined;
      let inverse: LibraryEditBatch | undefined;
      try { if (parent) inverse = inverseLibraryEdit(versions, entry.executionId, parent, batch.id, observed ? { observed } : undefined); }
      catch (error) {
        // Durable catalog records may arrive before their observed content heads.
        // Hide unproven history until the content arrives; pending commands still use the strict inverse above.
        if (error instanceof EditRejected && error.message === 'library-history-content-version-missing') {
          undo = []; redo = []; continue;
        }
        throw error;
      }
      if (!inverse || canonicalJson(inverse) !== canonicalJson(batch))
        throw new EditRejected('library-history-action-mismatch');
      source.pop(); destination.push({ operationId: entry.operationId, executionId: batch.id });
    }
    if (undo.length > 50) undo.shift();
  }
  return { undo, redo };
}

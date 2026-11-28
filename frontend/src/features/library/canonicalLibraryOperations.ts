import type { ItemLink, LibraryItem, LibrarySnapshot, LibraryChange } from '../../runtime/edits/contracts.ts';
import { canonicalJson, deletedItemIds, EditRejected } from '../../runtime/edits/editModel.ts';
import { PY_SPACE, pyStrip } from '../../lib/pyWhitespace.ts';
import { validateId } from '../../runtime/edits/contracts.ts';

export const BIBLIOGRAPHY_FIELDS = ['author', 'year', 'venue', 'doi', 'arxiv_id'] as const;
export type LibraryBibliographyField = (typeof BIBLIOGRAPHY_FIELDS)[number];
export type LibraryBibliographyValues = Partial<Record<LibraryBibliographyField, string>>;

export type LibraryTagsUpdate = { mode: 'add' | 'remove'; tags: readonly string[] }
  | { mode: 'replace'; tags: readonly string[]; expectedTags: Readonly<Record<string, readonly string[]>> };
export type LibraryDeleteMode = 'detach' | 'delete';
export type LibraryDeleteInput = {
  id: string; itemIds: readonly string[]; childNotes?: LibraryDeleteMode;
  observed: Readonly<Record<string, readonly string[]>>;
};

function liveItems(snapshot: LibrarySnapshot, ids: readonly string[]) {
  return [...new Set(ids)].map(id => {
    const item = snapshot.items.find(value => value.id === id);
    if (!item || snapshot.deletions.some(value => value.active && value.itemIds.includes(id))) throw new EditRejected('library-item-unavailable');
    return item;
  });
}

export function updateLibraryTags(snapshot: LibrarySnapshot, ids: readonly string[], input: LibraryTagsUpdate): LibraryChange[] {
  const items = liveItems(snapshot, ids);
  if (!['add', 'remove', 'replace'].includes(input.mode) || !Array.isArray(input.tags)) throw new EditRejected('library-tags-invalid');
  if (input.mode === 'replace') {
    for (const item of items) {
      const expected = input.expectedTags?.[item.id];
      if (!Array.isArray(expected) || JSON.stringify(expected) !== JSON.stringify(item.tags)) throw new EditRejected('library-tags-changed');
    }
    // Unedited persisted strings need no normalization, but still require the expected-value check.
    if (items.every(item => JSON.stringify(input.tags) === JSON.stringify(item.tags))) return [];
  }
  const tags = [...new Set(input.tags.map(tag => {
    if (typeof tag !== 'string') throw new EditRejected('library-tags-invalid');
    const value = input.mode === 'remove' ? tag : pyStrip(tag);
    if (Array.from(value).length < 1 || Array.from(value).length > 200) throw new EditRejected('library-tags-invalid');
    return value;
  }))];
  return items.flatMap(item => {
    const next = input.mode === 'replace' ? tags : input.mode === 'remove' ? item.tags.filter(tag => !tags.includes(tag))
      : [...item.tags, ...tags.filter(tag => !item.tags.includes(tag))];
    return JSON.stringify(next) === JSON.stringify(item.tags) ? []
      : [{ type: 'put-item' as const, item: { ...structuredClone(item), tags: [...next] } }];
  });
}

export function setLibraryItemsRead(snapshot: LibrarySnapshot, ids: readonly string[], value: boolean): LibraryChange[] {
  const items = liveItems(snapshot, ids);
  if (typeof value !== 'boolean') throw new EditRejected('library-read-invalid');
  return items.filter(item => item.read !== value).map(item => ({ type: 'put-item', item: { ...structuredClone(item), read: value } }));
}

/** Rename the live item without replacing metadata owned by other operations. */
export function renameLibraryItem(snapshot: LibrarySnapshot, itemId: string, title: string, expectedTitle?: string): LibraryChange[] {
  const item = snapshot.items.find(value => value.id === itemId);
  if (!item || snapshot.deletions.some(value => value.active && value.itemIds.includes(itemId))) throw new EditRejected('library-item-unavailable');
  if (expectedTitle !== undefined && item.title !== expectedTitle) throw new EditRejected('library-title-changed');
  if (typeof title !== 'string' || !title.trim()) throw new EditRejected('library-title-empty');
  const next = title.trim();
  return item.title === next ? [] : [{ type: 'put-item', item: { ...structuredClone(item), title: next } }];
}

function folder(snapshot: LibrarySnapshot, id: string) {
  const found = snapshot.folders.find(value => value.id === id);
  if (!found) throw new EditRejected('library-folder-missing');
  return found;
}
function parent(snapshot: LibrarySnapshot, id: string | null) { if (id !== null) folder(snapshot, id); }
function endPosition(positions: number[]) {
  if (!positions.length) return 0;
  const max = Math.max(...positions), next = max + 1;
  if (!Number.isFinite(next) || next <= max) throw new EditRejected('library-position-overflow');
  return next;
}
/** The tree interleaves independent items and folders; owned items belong to their owner, not this sibling list. */
export function libraryAppendPosition(snapshot: LibrarySnapshot, parentId: string | null): number {
  parent(snapshot, parentId);
  return endPosition([...snapshot.folders.filter(value => value.parentId === parentId).map(value => value.position),
    ...snapshot.items.filter(value => value.ownerId === null && value.folderId === parentId).map(value => value.position)]);
}
export function libraryOwnedAppendPosition(snapshot: LibrarySnapshot, ownerId: string): number {
  const owner = liveItems(snapshot, [ownerId])[0];
  if (owner.ownerId !== null) throw new EditRejected('library-owner-invalid');
  return endPosition(snapshot.items.filter(value => value.ownerId === ownerId).map(value => value.position));
}
function folderTitle(title: string) {
  if (typeof title !== 'string' || !pyStrip(title) || Array.from(pyStrip(title)).length > 200) throw new EditRejected('library-folder-title');
  return pyStrip(title);
}
export function createLibraryFolder(snapshot: LibrarySnapshot, id: string, title: string, parentId: string | null): LibraryChange[] {
  validateId(id); parent(snapshot, parentId);
  if (snapshot.folders.some(value => value.id === id)) throw new EditRejected('library-folder-exists');
  return [{ type: 'put-folder', folder: { id, title: folderTitle(title), parentId,
    position: libraryAppendPosition(snapshot, parentId) } }];
}
export function renameLibraryFolder(snapshot: LibrarySnapshot, id: string, title: string, expectedTitle?: string): LibraryChange[] {
  const current = folder(snapshot, id), next = folderTitle(title);
  if (expectedTitle !== undefined && current.title !== expectedTitle) throw new EditRejected('library-folder-title-changed');
  return next === current.title ? [] : [{ type: 'put-folder', folder: { ...current, title: next } }];
}
export function moveLibraryItems(snapshot: LibrarySnapshot, ids: readonly string[], destinationId: string | null): LibraryChange[] {
  const items = liveItems(snapshot, ids); parent(snapshot, destinationId);
  if (items.some(item => item.ownerId !== null)) throw new EditRejected('library-owned-item-move');
  const moving = items.filter(item => item.folderId !== destinationId);
  if (!moving.length) return [];
  let position = libraryAppendPosition(snapshot, destinationId);
  return moving.map((item, index) => {
    if (index > 0) position = endPosition([position]);
    return { type: 'put-item', item: { ...structuredClone(item), folderId: destinationId, position } };
  });
}
export function moveLibraryFolder(snapshot: LibrarySnapshot, id: string, parentId: string | null): LibraryChange[] {
  const current = folder(snapshot, id); parent(snapshot, parentId);
  let at = parentId; const seen = new Set<string>();
  while (at !== null) {
    if (at === id || seen.has(at)) throw new EditRejected('library-folder-cycle');
    seen.add(at); at = folder(snapshot, at).parentId;
  }
  return current.parentId === parentId ? [] : [{ type: 'put-folder', folder: { ...current, parentId,
    position: libraryAppendPosition(snapshot, parentId) } }];
}
/** Promote direct references (including logically deleted items); descendants stay in their own folders. */
export function removeLibraryFolder(snapshot: LibrarySnapshot, id: string): LibraryChange[] {
  const current = folder(snapshot, id); parent(snapshot, current.parentId);
  const children = snapshot.folders.filter(value => value.parentId === id);
  const items = snapshot.items.filter(value => value.folderId === id);
  if (items.some(item => item.ownerId !== null)) throw new EditRejected('library-owned-item-folder');
  const positions = [...snapshot.folders.filter(value => value.parentId === current.parentId && value.id !== id).map(value => value.position),
    ...snapshot.items.filter(value => value.ownerId === null && value.folderId === current.parentId).map(value => value.position)];
  // Match the mixed sibling display order, including references hidden by logical deletion.
  const entries = [...children.map(value => ({ kind: 'folder' as const, value })), ...items.map(value => ({ kind: 'item' as const, value }))]
    .sort((a, b) => a.value.position - b.value.position || (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1)
      || (a.value.id < b.value.id ? -1 : a.value.id > b.value.id ? 1 : 0));
  return [...entries.map(entry => {
    const position = endPosition(positions); positions.push(position);
    return entry.kind === 'folder' ? { type: 'put-folder' as const, folder: { ...entry.value, parentId: current.parentId, position } }
      : { type: 'put-item' as const, item: { ...structuredClone(entry.value), folderId: current.parentId, position } };
  }), { type: 'remove-folder', id }];
}

export function canLinkLibraryItems(first: LibraryItem | undefined, second: LibraryItem | undefined,
  deletedIds: ReadonlySet<string> = new Set()): ItemLink | null {
  if (!first || !second || first.id === second.id || first.ownerId !== null || second.ownerId !== null
    || deletedIds.has(first.id) || deletedIds.has(second.id)) return null;
  if (first.kind === 'pdf' && (second.kind === 'markdown' || second.kind === 'notebook')) return { pdfId: first.id, noteId: second.id };
  if (second.kind === 'pdf' && (first.kind === 'markdown' || first.kind === 'notebook')) return { pdfId: second.id, noteId: first.id };
  return null;
}
export function canDropLibraryLinks(sourceIds: readonly string[], targetId: string,
  snapshot: { items: readonly LibraryItem[]; deletions: readonly LibrarySnapshot['deletions'][number][] }): ItemLink[] | null {
  if (!Array.isArray(sourceIds)) return null;
  const ids = [...new Set(sourceIds)];
  if (!ids.length || ids.includes(targetId)) return null;
  const deleted = deletedItemIds(snapshot as LibrarySnapshot);
  const byId = new Map(snapshot.items.map(item => [item.id, item])), target = byId.get(targetId);
  if (!target || deleted.has(target.id) || target.ownerId !== null) return null;
  if (target.kind === 'markdown' || target.kind === 'notebook') {
    const links = ids.map(id => {
      const source = byId.get(id);
      return source?.kind === 'pdf' ? canLinkLibraryItems(source, target, deleted) : null;
    });
    return links.every(link => link !== null) ? links as ItemLink[] : null;
  }
  if (target.kind === 'pdf' && ids.length === 1) {
    const link = canLinkLibraryItems(byId.get(ids[0]), target, deleted);
    return link ? [link] : null;
  }
  return null;
}
export function addLibraryLinks(snapshot: LibrarySnapshot, links: readonly ItemLink[]): LibraryChange[] {
  if (!Array.isArray(links) || !links.length) throw new EditRejected('library-link-invalid');
  const seen = new Set<string>(), uniqueLinks: ItemLink[] = [];
  for (const link of links) {
    if (!link || typeof link.pdfId !== 'string' || typeof link.noteId !== 'string') throw new EditRejected('library-link-invalid');
    if (link.pdfId === link.noteId) throw new EditRejected('library-link-self');
    const [pdf, note] = liveItems(snapshot, [link.pdfId, link.noteId]);
    if (pdf.kind !== 'pdf' || !['markdown', 'notebook'].includes(note.kind)) throw new EditRejected('library-link-kind');
    if (pdf.ownerId !== null || note.ownerId !== null) throw new EditRejected('library-link-owned');
    const key = `${link.pdfId}:${link.noteId}`;
    if (!seen.has(key)) { seen.add(key); uniqueLinks.push({ pdfId: link.pdfId, noteId: link.noteId }); }
  }
  const existing = new Set(snapshot.links.map(link => `${link.pdfId}:${link.noteId}`));
  return uniqueLinks.filter(link => !existing.has(`${link.pdfId}:${link.noteId}`)).map(link => ({ type: 'add-link', link }));
}
export function removeLibraryLinks(snapshot: LibrarySnapshot, links: readonly ItemLink[]): LibraryChange[] {
  if (!Array.isArray(links) || !links.length) throw new EditRejected('library-link-invalid');
  const existing = new Set(snapshot.links.map(link => `${link.pdfId}:${link.noteId}`));
  const seen = new Set<string>(), uniqueLinks: ItemLink[] = [];
  for (const link of links) {
    if (!link || typeof link.pdfId !== 'string' || typeof link.noteId !== 'string') throw new EditRejected('library-link-invalid');
    const key = `${link.pdfId}:${link.noteId}`;
    if (!existing.has(key)) throw new EditRejected('library-link-missing');
    if (!seen.has(key)) { seen.add(key); uniqueLinks.push({ pdfId: link.pdfId, noteId: link.noteId }); }
  }
  return uniqueLinks.map(link => ({ type: 'remove-link', link }));
}

function detachChanges(snapshot: LibrarySnapshot, notes: readonly LibraryItem[], byId: ReadonlyMap<string, LibraryItem>): LibraryChange[] {
  const ordered = [...notes].sort((a, b) => {
    const ownerA = byId.get(a.ownerId!)!, ownerB = byId.get(b.ownerId!)!;
    return ownerA.position - ownerB.position || (ownerA.id < ownerB.id ? -1 : ownerA.id > ownerB.id ? 1 : 0)
      || a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const nextPositionByFolder = new Map<string | null, number>();
  return ordered.map(note => {
    const owner = byId.get(note.ownerId!)!;
    const folderId = owner.folderId;
    const prev = nextPositionByFolder.get(folderId);
    const position = prev === undefined ? libraryAppendPosition(snapshot, folderId) : endPosition([prev]);
    nextPositionByFolder.set(folderId, position);
    return { type: 'put-item' as const, item: { ...structuredClone(note), ownerId: null, folderId, position } };
  });
}
export function detachLibraryNotes(snapshot: LibrarySnapshot, ids: readonly string[]): LibraryChange[] {
  if (!Array.isArray(ids) || !ids.length) throw new EditRejected('library-detach-invalid');
  const items = liveItems(snapshot, ids);
  const byId = new Map(snapshot.items.map(item => [item.id, item]));
  for (const item of items) {
    if (!item.ownerId || !['markdown', 'notebook'].includes(item.kind)) throw new EditRejected('library-detach-invalid');
    const owner = liveItems(snapshot, [item.ownerId])[0];
    if (owner.ownerId !== null) throw new EditRejected('library-owner-invalid');
  }
  return detachChanges(snapshot, items, byId);
}

export function resolveLibraryDeleteTargets(snapshot: LibrarySnapshot, itemIds: readonly string[],
  childNotes: LibraryDeleteMode = 'detach'): { deleteIds: string[]; detachingNotes: LibraryItem[] } {
  if (!Array.isArray(itemIds) || !itemIds.length) throw new EditRejected('library-item-unavailable');
  if (childNotes !== 'detach' && childNotes !== 'delete') throw new EditRejected('library-deletion-invalid');
  const explicit = liveItems(snapshot, itemIds);
  const deletedAlready = deletedItemIds(snapshot);
  const deleteSet = new Set(explicit.map(item => item.id));
  const detachingNotes: LibraryItem[] = [];
  for (const item of snapshot.items) {
    if (deletedAlready.has(item.id) || deleteSet.has(item.id) || !item.ownerId || !deleteSet.has(item.ownerId)) continue;
    if (item.kind === 'attachment' || childNotes === 'delete') deleteSet.add(item.id);
    else detachingNotes.push(item);
  }
  return { deleteIds: [...deleteSet], detachingNotes };
}
export function deleteLibraryItems(snapshot: LibrarySnapshot, input: LibraryDeleteInput): LibraryChange[] {
  validateId(input.id);
  if (snapshot.deletions.some(record => record.id === input.id)) throw new EditRejected('library-deletion-exists');
  const { deleteIds, detachingNotes } = resolveLibraryDeleteTargets(snapshot, input.itemIds, input.childNotes ?? 'detach');
  const byId = new Map(snapshot.items.map(item => [item.id, item]));
  const deleteSet = new Set(deleteIds);
  const observed = deleteIds.filter(id => byId.get(id)!.kind !== 'attachment').map(targetId => {
    const heads = input.observed?.[targetId];
    if (!Array.isArray(heads) || !heads.length) throw new EditRejected('library-deletion-observation-missing');
    for (const head of heads) validateId(head);
    if (new Set(heads).size !== heads.length) throw new EditRejected('library-deletion-observation-invalid');
    return { targetId, heads: [...heads] };
  });
  if (Object.keys(input.observed ?? {}).some(targetId => !deleteSet.has(targetId) || byId.get(targetId)?.kind === 'attachment'))
    throw new EditRejected('library-deletion-observation-invalid');
  const itemChanges = detachChanges(snapshot, detachingNotes, byId);
  const linkChanges: LibraryChange[] = snapshot.links
    .filter(link => deleteSet.has(link.pdfId) || deleteSet.has(link.noteId))
    .map(link => ({ type: 'remove-link', link: { pdfId: link.pdfId, noteId: link.noteId } }));
  return [...itemChanges, ...linkChanges, { type: 'put-deletion', deletion: { id: input.id, itemIds: deleteIds, observed, active: true } }];
}

export function restoreDeletedLibraryItems(snapshot: LibrarySnapshot, deletionId: string): LibraryChange[] {
  validateId(deletionId);
  const record = snapshot.deletions.find(value => value.id === deletionId);
  if (!record || !record.active) throw new EditRejected('library-deletion-missing');
  const otherDeleted = new Set(snapshot.deletions.filter(value => value.active && value.id !== record.id).flatMap(value => value.itemIds));
  if (record.itemIds.some(id => otherDeleted.has(id))) throw new EditRejected('library-deletion-conflict');
  const targetSet = new Set(record.itemIds);
  const currentDeleted = deletedItemIds(snapshot);
  for (const id of record.itemIds) {
    const item = snapshot.items.find(value => value.id === id);
    if (!item) throw new EditRejected('library-item-unavailable');
    if (item.folderId !== null && !snapshot.folders.some(folder => folder.id === item.folderId))
      throw new EditRejected('library-folder-missing');
    if (item.ownerId !== null) {
      const owner = snapshot.items.find(value => value.id === item.ownerId);
      if (!owner || owner.ownerId !== null || otherDeleted.has(owner.id) || (currentDeleted.has(owner.id) && !targetSet.has(owner.id)))
        throw new EditRejected('library-owner-unavailable');
    }
  }
  return [{ type: 'put-deletion', deletion: { ...structuredClone(record), active: false } }];
}

const PY_WHITESPACE_RUN = new RegExp(`${PY_SPACE}+`);
const DOI_PREFIX = new RegExp(`^(?:doi${PY_SPACE}*[:：]${PY_SPACE}*|https?://(?:dx\\.)?doi\\.org/)`, 'i');
const DOI_MATCH = new RegExp(`^(10\\.\\d{4,9}/[^${PY_SPACE.slice(1, -1)}"<>{}]+)`);
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;
const ARXIV_ID_RE = new RegExp(
  `^(?:arxiv${PY_SPACE}*:${PY_SPACE}*|https?://(?:www\\.)?arxiv\\.org/(?:abs|pdf)/)?(\\d{4}\\.\\d{4,5}|[a-z][a-z.-]*(?:\\.[A-Z]{2})?\\/\\d{7})(?:v\\d+)?(?:\\.pdf)?$`,
  'i',
);

export function cleanDoi(value: string): string {
  const trimmed = pyStrip(value).replace(DOI_PREFIX, '');
  const match = DOI_MATCH.exec(trimmed);
  if (!match) return '';
  let doi = match[1];
  while (doi) {
    const last = doi[doi.length - 1];
    const count = (ch: string) => Array.from(doi).filter(c => c === ch).length;
    if ('. ,;:\''.replace(' ', '').includes(last) || ((last === ')' || last === ']') && count(last) > count(last === ')' ? '(' : '['))) {
      doi = doi.slice(0, -1);
    } else break;
  }
  return DOI_MATCH.exec(doi)?.[1] === doi ? doi : '';
}

export function typedDoi(value: string): string {
  const bare = pyStrip(value).replace(DOI_PREFIX, '');
  if (!bare) return '';
  const doi = cleanDoi(bare);
  if (!doi) throw new EditRejected('library-bibliography-doi');
  const tail = bare.slice(doi.length).replace(/^[.,;:)'"]+|[.,;:)'"]+$/g, '');
  if (!bare.startsWith(doi) || tail || Array.from(doi).length > 500) throw new EditRejected('library-bibliography-doi');
  return doi;
}

export function cleanArxivId(value: string): string {
  let candidate = pyStrip(value);
  if (!candidate) return '';
  const doiMatch = ARXIV_DOI.exec(cleanDoi(candidate));
  if (doiMatch) candidate = doiMatch[1];
  const match = ARXIV_ID_RE.exec(candidate);
  if (!match || Array.from(match[1]).length > 200) throw new EditRejected('library-bibliography-arxiv');
  return match[1];
}

export function normalizeBibliographyField(field: LibraryBibliographyField, value: unknown): string {
  if (typeof value !== 'string') throw new EditRejected('library-bibliography-invalid');
  if (field === 'author') {
    const normalized = pyStrip(value);
    if (Array.from(normalized).length > 200) throw new EditRejected('library-bibliography-author');
    return normalized;
  }
  if (field === 'year') {
    const normalized = pyStrip(value);
    if (normalized && !/^[0-9]{4}$/.test(normalized)) throw new EditRejected('library-bibliography-year');
    return normalized;
  }
  if (field === 'venue') {
    const normalized = value.split(PY_WHITESPACE_RUN).filter(Boolean).join(' ');
    if (Array.from(normalized).length > 300) throw new EditRejected('library-bibliography-venue');
    return normalized;
  }
  if (field === 'doi') return typedDoi(value);
  if (field === 'arxiv_id') return cleanArxivId(value);
  throw new EditRejected('library-bibliography-unsupported');
}

export function updateLibraryBibliography(snapshot: LibrarySnapshot, itemId: string, values: LibraryBibliographyValues,
  expectedMetadata?: Readonly<Partial<Record<LibraryBibliographyField, string>>>): LibraryChange[] {
  const item = liveItems(snapshot, [itemId])[0];
  if (item.kind !== 'pdf' || item.ownerId !== null) throw new EditRejected('library-bibliography-unsupported');
  if (!values || typeof values !== 'object') throw new EditRejected('library-bibliography-invalid');
  const keys = Object.keys(values);
  if (!keys.length || keys.some(key => !BIBLIOGRAPHY_FIELDS.includes(key as LibraryBibliographyField)))
    throw new EditRejected('library-bibliography-unsupported');
  if (expectedMetadata) {
    for (const key of Object.keys(expectedMetadata)) {
      if (!BIBLIOGRAPHY_FIELDS.includes(key as LibraryBibliographyField)) throw new EditRejected('library-bibliography-unsupported');
      const field = key as LibraryBibliographyField;
      const actual = typeof item.metadata[field] === 'string' ? item.metadata[field] : '';
      if ((expectedMetadata[field] ?? '') !== actual) throw new EditRejected('library-metadata-changed');
    }
  }
  const nextMetadata: Record<string, string> = structuredClone(item.metadata);
  for (const key of keys as LibraryBibliographyField[]) {
    const normalized = normalizeBibliographyField(key, values[key]);
    if (normalized) nextMetadata[key] = normalized;
    else delete nextMetadata[key];
  }
  if (canonicalJson(nextMetadata) === canonicalJson(item.metadata)) return [];
  return [{ type: 'put-item', item: { ...structuredClone(item), metadata: nextMetadata } }];
}

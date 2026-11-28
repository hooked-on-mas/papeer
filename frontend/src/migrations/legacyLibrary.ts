import { editSchema, type Folder, type ItemLink, type LibraryItem, type LibrarySnapshot } from '../runtime/edits/contracts.ts';
import { assertSnapshot } from '../runtime/edits/editModel.ts';
import { editContentHash } from '../runtime/edits/editContentHash.ts';
import { validateStructure } from '../runtime/edits/schemaValidator.ts';
import { pyStrip } from '../lib/pyWhitespace.ts';
import { migrationStableId } from './stableId.ts';
import { stagingFail, type FolderRow, type IdEntry, type NotConverted, type PaperRow, type ProvenanceRow, type StagingRows } from './legacyStagingInput.ts';

// The Library structure (item, folder, link, tag) of the staging conversion (work B7-e, DESIGN-r161-b7-staging.md 7.3 item 3, decision J3 (a)).
//
// Evidence and rules (IMPL-r161-b7e.md section 1.3-1.5):
//  - An item exists only if its content root was converted: the canonical store refuses a library item without a content root of the SAME id
//    (papeer/core/edit_repository.py `_assert_bindings`, :408-416). So the item id IS the content id (the document / markdown id).
//  - title: used exactly as stored, or the item is not converted (`title-unrepresentable`). The canonical title is 1-200 characters and not blank
//    (contracts schema LibraryItem; editModel.ts assertLibrary 'empty-title'). Nothing is truncated or defaulted.
//  - tags: the legacy column is the JSON text of a list of strings (library_papers.py:181-186 writes json.dumps of a stripped, de-duplicated list;
//    library_base.py:64 reads json.loads). The canonical tag is a stripped, non-empty string of at most 200 characters, unique per item, order kept
//    (canonicalLibraryOperations.ts:37-47). A column that is not exactly such a list gives `tags-unrepresentable`: not converted, never repaired.
//  - folder: the normalized path of `collection_name` (collection_paths.py), one canonical folder per path and ancestor, titled by its part.
//  - ownership (`parent_id`): the owner must be a converted, un-owned item, and the owned item a notebook or markdown note (assertLibrary
//    'invalid-owner' / 'invalid-owned-kind'). Canonical owned items have no folder; the legacy app stores '' for an owned notebook (notebook.py:150)
//    and the owner's folder for an owned note (notes.py:113-123), so an owned item is accepted only with '' or its owner's folder.
//  - read = false and metadata = {} (J3 (a)): the legacy read_status, bibliography and status are NOT converted (residual `library-metadata-not-converted`).
//  - position: NOT a legacy value. Items stand in the order they were added (created_at, id; library_papers.py `_oldest_first` uses created_at then
//    rowid, which the rows do not carry, so id is the tie-break); an owner's notes follow `note_position` first (notes.py:78,184). Folders are
//    ordered by name (code points). These are ordinals made here (reported as derived in the Library's provenance), not the legacy screen order.
//  - link: only a resolved {pdfId, noteId} whose two ends were converted; the rest stay as `item-link-not-converted`.
export const LIBRARY_RESIDUALS = ['library-item-not-converted', 'folder-not-converted', 'item-link-not-converted'] as const;
export type ContentRef = { kind: 'pdf' | 'markdown' | 'notebook'; contentId: string; resourceId?: string };
export type LibraryBuild = {
  snapshot: LibrarySnapshot; /** paper id -> library item id, for the items that were put into the Library */ kept: Map<string, string>;
  dropped: Map<string, string>; ids: IdEntry[]; provenance: ProvenanceRow[]; notConverted: NotConverted[];
  counts: { items: number; folders: number; links: number; tags: number };
};

const compare = (a: string, b: string) => { const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) { const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!; if (d) return d; }
  return x.length - y.length; };
const scalarText = (value: string) => { for (const char of value) { const cp = char.codePointAt(0)!; if (cp >= 0xd800 && cp <= 0xdfff) return false; } return true; };
const validText = (value: unknown): value is string => typeof value === 'string' && scalarText(value) && Array.from(value).length <= 200 && pyStrip(value) !== '';

/** The tags of a legacy row, exactly, or null when the column is not a list of canonical tags. */
export function legacyTags(column: unknown): string[] | null {
  if (typeof column !== 'string') return null;
  let parsed: unknown; try { parsed = JSON.parse(column); } catch { return null; }
  if (!Array.isArray(parsed) || Object.keys(parsed).length !== parsed.length) return null;
  if (parsed.some(tag => typeof tag !== 'string' || !validText(tag) || pyStrip(tag) !== tag) || new Set(parsed).size !== parsed.length) return null;
  return parsed as string[];
}

export async function buildLegacyLibrary(input: { libraryId: string; rows: StagingRows; contents: ReadonlyMap<string, ContentRef> }): Promise<LibraryBuild> {
  const { libraryId, rows, contents } = input;
  const ids: IdEntry[] = [], provenance: ProvenanceRow[] = [], notConverted: NotConverted[] = [], dropped = new Map<string, string>();
  const drop = (item: PaperRow, reason: string) => { dropped.set(item.id, reason);
    notConverted.push({ sourceKey: ['papers', item.id], kind: 'item', reason, residual: 'library-item-not-converted', count: 1 }); };

  // ---- folders (a folder whose own title cannot be represented, or one below such a folder, is not converted) ----------------------------
  const folderById = new Map<string, FolderRow>(rows.folders.map(folder => [folder.path, folder]));
  const folderOk = new Map<string, boolean>();
  const usable = (path: string): boolean => {
    let result = folderOk.get(path);
    if (result === undefined) { const folder = folderById.get(path);
      if (!folder) return stagingFail('staging-conversion-input-mismatch');
      result = validText(folder.parts[folder.parts.length - 1]) && (folder.parent === null || usable(folder.parent)); folderOk.set(path, result); }
    return result;
  };
  for (const folder of rows.folders) { if (folder.parent !== null && !folderById.has(folder.parent)) stagingFail('staging-conversion-input-mismatch'); }
  const folderIds = new Map<string, string>();
  for (const folder of [...rows.folders].sort((a, b) => compare(a.path, b.path))) {
    if (!usable(folder.path)) { notConverted.push({ sourceKey: ['folder', folder.path], kind: 'folder', reason: 'title-unrepresentable', residual: 'folder-not-converted', count: 1 }); continue; }
    const source = [folder.path], targetId = await migrationStableId(libraryId, 'library-folder', source);
    ids.push({ kind: 'library-folder', source, targetId }); folderIds.set(folder.path, targetId);
  }

  // ---- items -------------------------------------------------------------------------------------------------------------------------
  const byId = new Map(rows.items.map(item => [item.id, item]));
  const eligible = new Map<string, { item: PaperRow; content: ContentRef; tags: string[] }>();
  const sortedItems = [...rows.items].sort((a, b) => compare(a.id, b.id));
  for (const item of sortedItems) {
    if (item.kind !== 'pdf' && item.kind !== 'markdown' && item.kind !== 'notebook') { drop(item, 'item-kind-unsupported'); continue; }
    const content = contents.get(item.id);
    if (!content) { dropped.set(item.id, 'content-not-converted'); continue; }            // already reported by the content converter
    if (content.kind !== item.kind) stagingFail('staging-conversion-input-mismatch');
    if (!validText(item.columns.title)) { drop(item, 'title-unrepresentable'); continue; }
    const tags = legacyTags(item.columns.tags);
    if (tags === null) { drop(item, 'tags-unrepresentable'); continue; }
    eligible.set(item.id, { item, content, tags });
  }
  const parentOf = (item: PaperRow) => item.columns.parent_id;
  const kept = new Map<string, string>();
  for (const [paperId, entry] of eligible) {                                              // un-owned items first (an owner is never owned)
    const parent = parentOf(entry.item);
    if (parent === null) {
      const path = entry.item.collectionPath;
      if (path && !folderById.has(path)) stagingFail('staging-conversion-input-mismatch');
      if (path && !folderIds.has(path)) { drop(entry.item, 'folder-unrepresentable'); eligible.delete(paperId); continue; }
    }
  }
  for (const [paperId, entry] of eligible) {
    const parent = parentOf(entry.item);
    if (parent === null) { kept.set(paperId, entry.content.contentId); continue; }
    const owner = typeof parent === 'string' ? byId.get(parent) : undefined;
    if (!owner || !eligible.has(owner.id) || parentOf(owner) !== null) { drop(entry.item, 'owner-not-converted'); continue; }
    if (entry.item.kind !== 'notebook' && entry.item.kind !== 'markdown') { drop(entry.item, 'owned-kind-unsupported'); continue; }
    const path = entry.item.collectionPath;
    if (path && path !== owner.collectionPath) { drop(entry.item, 'owned-item-folder-conflict'); continue; }
    if (!Number.isSafeInteger(entry.item.columns.note_position) || (entry.item.columns.note_position as number) < 0) { drop(entry.item, 'position-unrepresentable'); continue; }
    kept.set(paperId, entry.content.contentId);
  }
  for (const [paperId] of eligible) if (!kept.has(paperId)) eligible.delete(paperId);

  // ---- positions (ordinals made here) --------------------------------------------------------------------------------------------
  const keyOf = (entry: { item: PaperRow }, owned: boolean): [number, string, string] =>
    [owned ? entry.item.columns.note_position as number : 0, String(entry.item.columns.created_at), entry.item.id];
  const order = (list: { item: PaperRow }[], owned: boolean) => [...list].sort((a, b) => { const x = keyOf(a, owned), y = keyOf(b, owned);
    return x[0] - y[0] || compare(x[1], y[1]) || compare(x[2], y[2]); });
  const groups = new Map<string, { item: PaperRow; content: ContentRef; tags: string[] }[]>();
  for (const entry of eligible.values()) {
    const parent = parentOf(entry.item);
    const group = parent !== null ? `owner:${parent}` : `folder:${entry.item.collectionPath || ''}`;
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }
  const position = new Map<string, number>();
  for (const [group, list] of groups) order(list, group.startsWith('owner:')).forEach((entry, index) => position.set(entry.item.id, index));

  const items: LibraryItem[] = [];
  for (const [paperId, entry] of eligible) {
    const parent = parentOf(entry.item), path = entry.item.collectionPath;
    const item: LibraryItem = { id: entry.content.contentId, kind: entry.item.kind as LibraryItem['kind'], title: entry.item.columns.title as string,
      ownerId: parent === null ? null : kept.get(parent as string)!, folderId: parent === null && path ? folderIds.get(path)! : null,
      position: position.get(paperId)!, tags: entry.tags, read: false, ...(entry.content.resourceId ? { resourceId: entry.content.resourceId } : {}), metadata: {} };
    items.push(item);
    provenance.push({ targetKind: 'library-item', targetId: item.id, sourceKind: 'row', sourceKey: ['papers', paperId], sourceSha256: entry.item.sourceSha256 });
  }
  items.sort((a, b) => compare(a.id, b.id));

  const siblings = new Map<string, FolderRow[]>();
  for (const folder of rows.folders) if (folderIds.has(folder.path)) siblings.set(folder.parent ?? '', [...(siblings.get(folder.parent ?? '') ?? []), folder]);
  const folders: Folder[] = [];
  for (const list of siblings.values()) [...list].sort((a, b) => compare(a.parts[a.parts.length - 1], b.parts[b.parts.length - 1])).forEach((folder, index) => {
    folders.push({ id: folderIds.get(folder.path)!, title: folder.parts[folder.parts.length - 1], parentId: folder.parent === null ? null : folderIds.get(folder.parent)!, position: index });
    provenance.push({ targetKind: 'folder', targetId: folderIds.get(folder.path)!, sourceKind: 'rows', sourceKey: ['folder', folder.path], sourceSha256: folder.sourceSha256 });
  });
  folders.sort((a, b) => compare(a.id, b.id));

  // ---- links ------------------------------------------------------------------------------------------------------------------------
  const links: ItemLink[] = [];
  for (const link of [...rows.links].sort((a, b) => compare(a.a, b.a) || compare(a.b, b.b))) {
    const key = ['item_links', link.a, link.b];
    if (link.status !== 'resolved') { notConverted.push({ sourceKey: key, kind: 'link', reason: link.reason!, residual: 'item-link-not-converted', count: 1 }); continue; }
    const pdf = kept.get(link.pdfId!), note = kept.get(link.noteId!);
    const pdfItem = byId.get(link.pdfId!), noteItem = byId.get(link.noteId!);
    if (!pdf || !note || !pdfItem || !noteItem || parentOf(pdfItem) !== null || parentOf(noteItem) !== null || pdfItem.kind !== 'pdf'
      || (noteItem.kind !== 'notebook' && noteItem.kind !== 'markdown') || link.noteKind !== noteItem.kind) {
      notConverted.push({ sourceKey: key, kind: 'link', reason: 'link-endpoint-not-converted', residual: 'item-link-not-converted', count: 1 }); continue; }
    links.push({ pdfId: pdf, noteId: note });
    provenance.push({ targetKind: 'link', targetId: JSON.stringify([pdf, note]), sourceKind: 'row', sourceKey: key, sourceSha256: link.sourceSha256 });
  }
  links.sort((a, b) => compare(a.pdfId, b.pdfId) || compare(a.noteId, b.noteId));

  // ---- the Library root ------------------------------------------------------------------------------------------------------------
  const contentSha256 = await editContentHash({ items, folders, links });
  const versionSource = [contentSha256], version = await migrationStableId(libraryId, 'library-revision', versionSource);
  ids.push({ kind: 'library-revision', source: versionSource, targetId: version });
  const snapshot: LibrarySnapshot = { kind: 'library', id: libraryId, version, items, folders, links, deletions: [] };
  try { validateStructure(editSchema, 'LibrarySnapshot', snapshot); assertSnapshot(snapshot); } catch { stagingFail('staging-conversion-invalid-result'); }
  const derived = [...provenance].map(row => `${row.targetKind}|${row.targetId}|${row.sourceSha256}`).sort();
  provenance.push({ targetKind: 'library', targetId: libraryId, sourceKind: 'derived', sourceKey: ['library'], sourceSha256: await editContentHash(derived) });
  const tags = items.reduce((sum, item) => sum + item.tags.length, 0);
  return { snapshot, kept, dropped, ids, provenance, notConverted, counts: { items: items.length, folders: folders.length, links: links.length, tags } };
}

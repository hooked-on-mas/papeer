import { EDIT_LIMITS, editSchema, validateEditBatch, validateSnapshot, type DocumentSnapshot, type EditBatch, type LibrarySnapshot,
  type Page, type PageAnnotation, type PageExpectation, type SetTranslation, type Snapshot } from './contracts.ts';
import { pyStrip } from '../../lib/pyWhitespace.ts';
import { activeDocumentPages, allDocumentPages } from './documentPages.ts';
import { annotationPoints } from './annotationGeometry.ts';
import { validAnnotationTimestamp } from './annotationTime.ts';
import { validateStructure } from './schemaValidator.ts';
import { isNoteTemplate, NOTE_TEMPLATE_METADATA_KEY, NOTE_TEMPLATE_METADATA_VALUE, NOTE_TEMPLATE_NAME_LIMIT, NOTE_TEMPLATE_BUILTIN_NAME } from '../markdown/noteTemplates.ts';

export { EDIT_LIMITS } from './contracts.ts';
export { CONFLICT_SUFFIX, conflictTitle } from './textPolicy.ts';
export class EditRejected extends Error {}
const reject = (reason: string): never => { throw new EditRejected(reason); };
const unique = (values: string[], reason: string) => { if (new Set(values).size !== values.length) reject(reason); };
const finite = (values: number[]) => { if (values.some(value => !Number.isFinite(value))) reject('non-finite-geometry'); };

/** Stable serialization compares payloads, not property insertion order. This is not a content hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  const json = JSON.stringify(value);
  if (json === undefined) reject('not-json');
  return json!;
}

function annotationValid(annotation: PageAnnotation, page: Pick<Page, 'backgroundRevision'>): void {
  if (annotation.kind !== 'ink' && annotation.metadata.createdAt !== null && !validAnnotationTimestamp(annotation.metadata.createdAt)) reject('annotation-time');
  if (annotation.kind === 'highlight') {
    if ((annotation.range.kind === 'indexed' && annotation.range.end <= annotation.range.start)
      || annotation.backgroundRevision !== page.backgroundRevision) reject('highlight-range-or-background');
    for (const quad of annotation.quads) {
      const area = quad.reduce((sum, p, i) => sum + p.x * quad[(i + 1) % 4].y - p.y * quad[(i + 1) % 4].x, 0);
      if (!Number.isFinite(area) || Math.abs(area) < 1e-9) reject('degenerate-quad');
    }
  } else if (annotation.kind === 'ink') {
    const g = annotation.geometry, t = annotation.transform;
    if ((g.kind === 'line' || g.kind === 'arrow') && g.start.x === g.end.x && g.start.y === g.end.y) reject('degenerate-line');
    if (g.kind === 'arrow' && g.preferredHeadLengthPt !== undefined && g.preferredHeadLengthPt < g.headLengthPt) reject('arrow-head-preference');
    for (const p of annotationPoints(annotation)) finite([p.x, p.y]);
    const width = annotation.style.widthPt * Math.max(t.scaleX, t.scaleY);
    if (!(width > 0)) reject('degenerate-transform');
    finite([width]);
    if ('widthPt' in g && (!(g.widthPt * t.scaleX > 0) || !(g.heightPt * t.scaleY > 0))) reject('degenerate-transform');
  }
}
/** Admit a retained annotation without inventing a page's dimensions, lifecycle or background. */
export function assertAnnotation(annotation: PageAnnotation, backgroundRevision: string): void {
  validateStructure(editSchema, 'PageAnnotation', annotation);
  annotationValid(annotation, { backgroundRevision });
}
export function assertPage(page: Page): void {
  unique(page.annotations.map(annotation => annotation.id), 'duplicate-annotation');
  let count = 0;
  for (const annotation of page.annotations) {
    annotationValid(annotation, page);
    if (annotation.kind === 'ink' && annotation.geometry.kind === 'path') count += annotation.geometry.points.length;
  }
  if (count > EDIT_LIMITS.pagePoints) reject('page-point-limit');
}

export function deletedItemIds(snapshot: LibrarySnapshot): Set<string> {
  return new Set(snapshot.deletions.filter(record => record.active).flatMap(record => record.itemIds));
}
function assertLibrary(snapshot: LibrarySnapshot): void {
  unique(snapshot.items.map(item => item.id), 'duplicate-item');
  unique(snapshot.folders.map(folder => folder.id), 'duplicate-folder');
  unique([...snapshot.items.map(item => item.id), ...snapshot.folders.map(folder => folder.id)], 'shared-catalog-id');
  unique(snapshot.deletions.map(deletion => deletion.id), 'duplicate-deletion');
  const items = new Map(snapshot.items.map(item => [item.id, item]));
  const folders = new Map(snapshot.folders.map(folder => [folder.id, folder]));
  const deleted = deletedItemIds(snapshot);
  const templateNames = new Set<string>();
  for (const item of snapshot.items) {
    if (!pyStrip(item.title)) reject('empty-title');
    unique(item.tags, 'duplicate-tag');
    if (item.folderId && !folders.has(item.folderId)) reject('missing-folder');
    if (item.ownerId) {
      if (item.folderId !== null) reject('owned-item-folder');
      const owner = items.get(item.ownerId);
      if (!owner || owner.id === item.id || owner.ownerId || isNoteTemplate(owner) || (!deleted.has(item.id) && deleted.has(owner.id))) reject('invalid-owner');
      if (!['notebook', 'markdown', 'attachment'].includes(item.kind)) reject('invalid-owned-kind');
    }
    if (item.kind === 'attachment' && (!item.ownerId || !item.resourceId)) reject('invalid-attachment');
    if (item.metadata[NOTE_TEMPLATE_METADATA_KEY] !== undefined) {
      if (item.metadata[NOTE_TEMPLATE_METADATA_KEY] !== NOTE_TEMPLATE_METADATA_VALUE) reject('note-template-version');
      if (item.kind !== 'markdown' || item.ownerId !== null || item.folderId !== null || item.resourceId != null) reject('note-template-kind');
      const name = pyStrip(item.title);
      if (!name || name !== item.title || Array.from(name).length > NOTE_TEMPLATE_NAME_LIMIT || name === NOTE_TEMPLATE_BUILTIN_NAME) reject('note-template-name');
      if (!deleted.has(item.id)) {
        if (templateNames.has(name)) reject('duplicate-note-template-name');
        templateNames.add(name);
      }
    }
  }
  for (const folder of snapshot.folders) {
    if (!pyStrip(folder.title)) reject('empty-title');
    const seen = new Set([folder.id]);
    let parent = folder.parentId;
    while (parent) {
      if (seen.has(parent)) reject('folder-cycle');
      seen.add(parent);
      const value = folders.get(parent);
      if (!value) reject('missing-parent-folder');
      parent = value!.parentId;
    }
  }
  unique(snapshot.links.map(link => `${link.pdfId}:${link.noteId}`), 'duplicate-link');
  for (const link of snapshot.links) {
    const pdf = items.get(link.pdfId), note = items.get(link.noteId);
    if (pdf?.kind !== 'pdf' || !note || !['notebook', 'markdown'].includes(note.kind) || isNoteTemplate(note) || pdf.ownerId || note.ownerId
      || deleted.has(pdf.id) || deleted.has(note.id)) reject('invalid-link');
  }
  for (const record of snapshot.deletions) {
    unique(record.itemIds, 'duplicate-deleted-item');
    unique(record.observed.map(value => value.targetId), 'duplicate-observation');
    if (record.itemIds.some(id => !items.has(id))) reject('missing-deleted-item');
    const observed = new Map(record.observed.map(value => [value.targetId, value.heads]));
    for (const id of record.itemIds) if (items.get(id)!.kind !== 'attachment' && !observed.has(id)) reject('missing-deletion-observation');
    for (const observation of record.observed) {
      if (!record.itemIds.includes(observation.targetId)) reject('unrelated-deletion-observation');
      unique(observation.heads, 'duplicate-observed-head');
    }
  }
}
export function assertSnapshot(value: unknown): asserts value is Snapshot {
  validateSnapshot(value);
  if (value.kind === 'document') {
    const pages = allDocumentPages(value);
    unique(pages.map(page => page.id), 'duplicate-page');
    for (const page of pages) assertPage(page);
    if (value.translation) {
      const originals = new Map([...value.pages, ...value.deletedPages].map(page => [page.id, page]));
      const translated = new Map([...value.translation.pages, ...value.deletedPages].map(page => [page.id, page]));
      if (value.translation.pages.some(page => page.background.kind !== 'pdf')) reject('translation-pdf-required');
      unique(value.translation.bindings.map(binding => binding.original.pageId), 'duplicate-translation-original');
      for (const binding of value.translation.bindings) {
        if (originals.get(binding.original.pageId)?.background.kind !== 'pdf') reject('translation-original-missing');
        unique(binding.candidates.map(candidate => candidate.pageId), 'duplicate-translation-candidate');
        if (binding.candidates.some(candidate => translated.get(candidate.pageId)?.background.kind !== 'pdf')) reject('translation-page-missing');
      }
    }
  } else if (value.kind === 'library') assertLibrary(value);
  else {
    unique(value.appendIds, 'duplicate-append');
    unique(value.imageResources.map(image => image.resourceId), 'duplicate-markdown-image');
  }
}
export function assertBatch(value: unknown): asserts value is EditBatch {
  validateEditBatch(value);
  unique(value.parents, 'duplicate-parent');
  if (value.parents.includes(value.id)) reject('self-parent');
  if (value.kind === 'library' && value.targetId !== value.libraryId) reject('library-target');
  if (value.kind === 'markdown') unique(value.imageResources.map(image => image.resourceId), 'duplicate-markdown-image');
}
function expectedPage(snapshot: DocumentSnapshot, expected: PageExpectation): Page {
  const page = activeDocumentPages(snapshot).find(page => page.id === expected.pageId);
  if (!page || page.annotationVersion !== expected.annotationVersion || page.backgroundRevision !== expected.backgroundRevision
    || page.lifecycleVersion !== expected.lifecycleVersion) reject('stale-page');
  return page!;
}

function applyTranslation(parent: DocumentSnapshot, change: SetTranslation, version: string): DocumentSnapshot {
  if (change.expectedRevision !== (parent.translation?.revision ?? null)) reject('stale-translation');
  const deletedPages = [...parent.deletedPages], previous = parent.translation?.pages ?? [];
  const pages: Page[] = [];
  const content = (page: Page) => canonicalJson({ ...page, lifecycleVersion: '', annotationVersion: '' });
  for (const page of change.translation?.pages ?? []) {
    if (parent.pages.some(original => original.id === page.id)) reject('translation-page-reused');
    const old = previous.find(value => value.id === page.id), tombstone = deletedPages.find(value => value.id === page.id);
    if (old && canonicalJson(old) !== canonicalJson(page)) reject('translation-page-reused');
    if (tombstone && content(tombstone) !== content(page)) reject('translation-page-reused');
    pages.push(old ?? { ...page, lifecycleVersion: version, annotationVersion: version });
    if (tombstone) deletedPages.splice(deletedPages.indexOf(tombstone), 1);
  }
  for (const old of previous) if (!pages.some(page => page.id === old.id)) deletedPages.push({ ...old, lifecycleVersion: version });
  const { translation: _previousTranslation, ...rest } = parent;
  return { ...rest, version, deletedPages,
    ...(change.translation ? { translation: { revision: version, pages, bindings: change.translation.bindings } } : {}) };
}

/** Apply only to the named immutable parent. Receiving another branch never changes that parent. */
export function applyBatch(parent: Snapshot, batch: EditBatch): Snapshot {
  assertBatch(batch);
  return applyBatchResult(parent, batch, false);
}

/** Graph-internal application: the graph owns both inputs, has validated the
 * batch and parent, and never exposes their references. Unchanged annotations
 * therefore need no repeated schema/geometry traversal for a page delta. */
export function applyValidatedBatch(parent: Snapshot, batch: EditBatch): Snapshot {
  return applyBatchResult(parent, batch, true);
}

function applyBatchResult(parent: Snapshot, batch: EditBatch, validatedParent: boolean): Snapshot {
  if (batch.targetId !== parent.id || !batch.parents.includes(parent.version)) reject('wrong-parent');
  let next: Snapshot;
  switch (batch.kind) {
    case 'resolution':
      if (batch.snapshot.id !== parent.id || batch.snapshot.kind !== parent.kind || batch.snapshot.version !== batch.id) reject('resolution-target');
      next = batch.snapshot.kind === 'document' ? { ...batch.snapshot,
        pages: batch.snapshot.pages.map(page => ({ ...page, annotationVersion: batch.id })),
        ...(batch.snapshot.translation ? { translation: { ...batch.snapshot.translation,
          pages: batch.snapshot.translation.pages.map(page => ({ ...page, annotationVersion: batch.id })) } } : {}),
        deletedPages: batch.snapshot.deletedPages.map(page => ({ ...page, annotationVersion: batch.id })) } : batch.snapshot; break;
    case 'page': {
      if (parent.kind !== 'document') return reject('target-kind');
      const page = expectedPage(parent, batch.expected);
      const annotations = new Map(page.annotations.map(annotation => [annotation.id, annotation]));
      unique(batch.changes.map(change => change.type === 'order' ? '$order' : change.type === 'delete' ? change.id : change.annotation.id), 'duplicate-change-target');
      let order: string[] | undefined;
      for (const change of batch.changes) {
        if (change.type === 'order') { order = change.ids; continue; }
        const id = change.type === 'delete' ? change.id : change.annotation.id;
        if ((change.type === 'create') === annotations.has(id)) reject('annotation-existence');
        if (change.type === 'delete') annotations.delete(id);
        else {
          if (validatedParent) annotationValid(change.annotation, page);
          annotations.set(id, change.annotation);
        }
      }
      if (order && (new Set(order).size !== annotations.size || order.length !== annotations.size || order.some(id => !annotations.has(id)))) reject('annotation-order');
      const updated = { ...page, annotationVersion: batch.id, annotations: order ? order.map(id => annotations.get(id)!) : [...annotations.values()] };
      if (validatedParent) {
        if (annotations.size > EDIT_LIMITS.objects) reject('annotation-limit');
        const points = updated.annotations.reduce((count, annotation) => count +
          (annotation.kind === 'ink' && annotation.geometry.kind === 'path' ? annotation.geometry.points.length : 0), 0);
        if (points > EDIT_LIMITS.pagePoints) reject('page-point-limit');
      }
      next = { ...parent, version: batch.id, pages: parent.pages.map(p => p.id === page.id ? updated : p),
        ...(parent.translation ? { translation: { ...parent.translation,
          pages: parent.translation.pages.map(p => p.id === page.id ? updated : p) } } : {}) }; break;
    }
    case 'document': {
      if (parent.kind !== 'document') return reject('target-kind');
      const mappingChange = batch.changes.find(change => change.type === 'translation');
      if (mappingChange) {
        if (batch.changes.length !== 1) reject('translation-command-alone');
        next = applyTranslation(parent, mappingChange, batch.id); break;
      }
      const mapping = batch.changes.filter(change => change.type === 'mapping');
      if (mapping.length > 1) reject('duplicate-mapping-change');
      if (mapping.length && (!parent.translation || mapping[0].expectedRevision !== parent.translation.revision)) reject('stale-translation');
      const changes = batch.changes.filter(change => change.type !== 'translation' && change.type !== 'mapping');
      const pages = [...parent.pages], deletedPages = [...parent.deletedPages];
      const translatedPages = parent.translation ? [...parent.translation.pages] : undefined;
      unique(changes.map(change => change.type === 'insert' ? change.page.id : change.expected.pageId), 'duplicate-change-page');
      for (const change of changes) {
        if (change.type === 'insert') {
          const collection = change.collection === 'translation' ? translatedPages : pages;
          if (!collection || activeDocumentPages(parent).some(page => page.id === change.page.id) || change.index > collection.length) reject('insert-page');
          const tombstone = deletedPages.findIndex(page => page.id === change.page.id);
          if (tombstone >= 0) deletedPages.splice(tombstone, 1);
          collection!.splice(change.index, 0, { ...change.page, lifecycleVersion: batch.id, annotationVersion: batch.id });
        } else {
          expectedPage(parent, change.expected);
          const collection = pages.some(page => page.id === change.expected.pageId) ? pages : translatedPages ?? [];
          const index = collection.findIndex(page => page.id === change.expected.pageId);
          if (index < 0) reject('missing-page');
          if (change.type === 'remove') deletedPages.push({ ...collection.splice(index, 1)[0], lifecycleVersion: batch.id });
          else if (change.type === 'move') {
            if (change.index >= collection.length) reject('move-page');
            collection.splice(change.index, 0, collection.splice(index, 1)[0]);
          } else {
            if (change.page.id !== change.expected.pageId) reject('replace-page-id');
            const old = collection[index];
            const backgroundChanged = canonicalJson(old.background) !== canonicalJson(change.page.background)
              || old.widthPt !== change.page.widthPt || old.heightPt !== change.page.heightPt;
            collection[index] = { ...change.page, lifecycleVersion: old.lifecycleVersion, annotationVersion: batch.id,
              backgroundRevision: backgroundChanged ? batch.id : old.backgroundRevision };
          }
        }
      }
      next = { ...parent, version: batch.id, pages, deletedPages,
        ...(parent.translation ? { translation: { ...parent.translation, pages: translatedPages!,
          ...(mapping.length ? { revision: batch.id, bindings: mapping[0].bindings } : {}) } } : {}) }; break;
    }
    case 'markdown':
      if (parent.kind !== 'markdown') return reject('target-kind');
      if (batch.appendId && parent.appendIds.includes(batch.appendId)) reject('append-already-applied');
      next = { ...parent, version: batch.id, content: batch.content, imageResources: structuredClone(batch.imageResources),
        appendIds: batch.appendId ? [...parent.appendIds, batch.appendId] : parent.appendIds }; break;
    case 'library': {
      if (parent.kind !== 'library') return reject('target-kind');
      const items = new Map(parent.items.map(item => [item.id, item]));
      const folders = new Map(parent.folders.map(folder => [folder.id, folder]));
      const links = new Map(parent.links.map(link => [`${link.pdfId}:${link.noteId}`, link]));
      const deletions = new Map(parent.deletions.map(record => [record.id, record]));
      unique(batch.changes.map(change => change.type === 'put-item' ? `item:${change.item.id}`
        : change.type === 'put-folder' ? `folder:${change.folder.id}` : change.type === 'remove-folder' ? `folder:${change.id}`
        : change.type === 'put-deletion' ? `deletion:${change.deletion.id}` : `link:${change.link.pdfId}:${change.link.noteId}`), 'duplicate-catalog-change');
      for (const change of batch.changes) {
        if (change.type === 'put-item') {
          const old = items.get(change.item.id);
          if (old && (old.kind !== change.item.kind || old.resourceId !== change.item.resourceId)) reject('catalog-content-rebind');
          if (old && isNoteTemplate(old) !== isNoteTemplate(change.item)) reject('note-template-role-rebind');
          items.set(change.item.id, change.item);
        } else if (change.type === 'put-folder') folders.set(change.folder.id, change.folder);
        else if (change.type === 'remove-folder') { if (!folders.delete(change.id)) reject('missing-folder'); }
        else if (change.type === 'put-deletion') {
          const old = deletions.get(change.deletion.id);
          if (old && canonicalJson({ ...change.deletion, active: old.active }) !== canonicalJson(old)) reject('catalog-history-loss');
          deletions.set(change.deletion.id, change.deletion);
        } else {
          const key = `${change.link.pdfId}:${change.link.noteId}`;
          if (change.type === 'add-link') { if (links.has(key)) reject('duplicate-link'); links.set(key, change.link); }
          else if (!links.delete(key)) reject('missing-link');
        }
      }
      next = { ...parent, version: batch.id, items: [...items.values()], folders: [...folders.values()], links: [...links.values()], deletions: [...deletions.values()] }; break;
    }
  }
  if (!validatedParent || batch.kind !== 'page') assertSnapshot(next);
  return next;
}

import type { DocumentEditBatch, DocumentSnapshot, EditBatch, HistoryRecord, Page, PageChange, PageEditBatch } from '../../../runtime/edits/contracts.ts';
import { activeDocumentPages, pageExpectation } from '../../../runtime/edits/documentPages.ts';
import { applyBatch, canonicalJson, EditRejected } from '../../../runtime/edits/editModel.ts';

type DocumentBatch = PageEditBatch | DocumentEditBatch;
export type DocumentHistoryEntry = { operationId: string; executionId: string };
export interface DocumentVersions {
  batch(id: string): EditBatch | undefined;
  snapshot(id: string): DocumentSnapshot | undefined;
}
export type HistoryCommand = { batch: DocumentBatch; history: HistoryRecord; affectedPages: string[] };
const content = (page: Page) => canonicalJson({ ...page, backgroundRevision: '', lifecycleVersion: '', annotationVersion: '',
  annotations: page.annotations.map(annotation => annotation.kind === 'highlight' ? { ...annotation, backgroundRevision: '' } : annotation) });
const backgroundEqual = (a: Page, b: Page) => a.widthPt === b.widthPt && a.heightPt === b.heightPt && canonicalJson(a.background) === canonicalJson(b.background);
function restoredBindings(before: DocumentSnapshot, final: DocumentSnapshot) {
  return before.translation!.bindings.map(binding => {
    const reference = (ref: typeof binding.original) => {
      const previous = [...activeDocumentPages(before), ...before.deletedPages].find(page => page.id === ref.pageId);
      const page = [...activeDocumentPages(final), ...final.deletedPages].find(page => page.id === ref.pageId);
      return previous && page && previous.backgroundRevision === ref.backgroundRevision && backgroundEqual(previous, page)
        ? { ...ref, backgroundRevision: page.backgroundRevision } : ref;
    };
    return { original: reference(binding.original), candidates: binding.candidates.map(reference) };
  });
}

/** Construct a finite inverse against the current immutable version; history stores references only. */
export function inverseDocumentEdit(versions: DocumentVersions, executionId: string, current: DocumentSnapshot, id: string): DocumentBatch {
  const original = versions.batch(executionId), before = original && versions.snapshot(original.parents[0]), after = versions.snapshot(executionId);
  if (!original || !before || !after || (original.kind !== 'page' && original.kind !== 'document')) throw new EditRejected('history-version-missing');
  if (before.id !== current.id || after.id !== current.id) throw new EditRejected('history-target');
  const envelope = { id, libraryId: original.libraryId, targetId: current.id, parents: [current.version] };
  if (original.kind === 'page') {
    const previous = activeDocumentPages(before).find(page => page.id === original.expected.pageId);
    const expectedAfter = activeDocumentPages(after).find(page => page.id === original.expected.pageId);
    const page = activeDocumentPages(current).find(page => page.id === original.expected.pageId);
    if (!previous || !page || !expectedAfter || content(page) !== content(expectedAfter)) throw new EditRejected('history-diverged');
    const existing = new Map(page.annotations.map(annotation => [annotation.id, annotation]));
    const target = new Map(previous.annotations.map(annotation => [annotation.id, annotation]));
    const changes: PageEditBatch['changes'] = [];
    for (const annotation of page.annotations) if (!target.has(annotation.id)) changes.push({ type: 'delete', id: annotation.id });
    for (const old of previous.annotations) {
      const annotation = old.kind === 'highlight' ? { ...old, backgroundRevision: page.backgroundRevision } : old;
      if (!existing.has(annotation.id)) changes.push({ type: 'create', annotation });
      else if (canonicalJson(existing.get(annotation.id)) !== canonicalJson(annotation)) changes.push({ type: 'update', annotation });
    }
    if (canonicalJson(page.annotations.map(annotation => annotation.id)) !== canonicalJson(previous.annotations.map(annotation => annotation.id))) {
      changes.push({ type: 'order', ids: previous.annotations.map(annotation => annotation.id) });
    }
    if (!changes.length) throw new EditRejected('history-no-change');
    return { ...envelope, kind: 'page', expected: pageExpectation(page), changes };
  }
  if (original.changes.some(change => change.type === 'translation')) {
    const translation = before.translation ? { bindings: restoredBindings(before, current), pages: before.translation.pages.map(page => {
      const live = current.translation?.pages.find(value => value.id === page.id);
      if (live && content(live) !== content(page)) throw new EditRejected('history-diverged');
      return live ?? page;
    }) } : null;
    return { ...envelope, kind: 'document', changes: [{ type: 'translation', expectedRevision: current.translation?.revision ?? null, translation }] };
  }
  const changes: PageChange[] = [], simulated = structuredClone(current);
  const desired = new Map(activeDocumentPages(before).map(page => [page.id, page]));
  const altered = new Map(original.changes.filter(change => change.type !== 'translation' && change.type !== 'mapping')
    .map(change => [change.type === 'insert' ? change.page.id : change.expected.pageId, change]));
  for (const [pageId] of altered) {
    const actual = activeDocumentPages(current).find(page => page.id === pageId), expected = activeDocumentPages(after).find(page => page.id === pageId);
    if (actual && expected && content(actual) !== content(expected)) throw new EditRejected('history-diverged');
    if (!!actual !== !!expected) throw new EditRejected('history-diverged');
  }
  // Remove originally inserted pages first; all indices below refer to the evolving collection.
  for (const [pageId, change] of altered) if (change.type === 'insert') {
    const page = activeDocumentPages(current).find(page => page.id === pageId);
    if (!page) throw new EditRejected('history-diverged');
    changes.push({ type: 'remove', expected: pageExpectation(page) });
    const list = simulated.pages.some(value => value.id === pageId) ? simulated.pages : simulated.translation!.pages;
    list.splice(list.findIndex(value => value.id === pageId), 1);
  }
  for (const [collection, target] of [['original', before.pages], ['translation', before.translation?.pages ?? []]] as const) {
    const list = collection === 'original' ? simulated.pages : simulated.translation?.pages;
    if (!list && target.length) throw new EditRejected('history-diverged');
    // Work from right to left: the next desired neighbour is already in its final position.
    for (let i = target.length - 1; i >= 0; i--) {
      const page = target[i], change = altered.get(page.id);
      if (!change || (change.type !== 'remove' && change.type !== 'move')) continue;
      const index = list!.findIndex(value => value.id === page.id);
      const existing = index >= 0 ? list!.splice(index, 1)[0] : undefined;
      const following = new Set(target.slice(i + 1).map(value => value.id));
      const followingIndex = list!.findIndex(value => following.has(value.id));
      const destination = followingIndex < 0 ? list!.length : followingIndex;
      if (change.type === 'remove') {
        const tombstone = current.deletedPages.find(value => value.id === page.id);
        if (!tombstone || content(tombstone) !== content(page)) throw new EditRejected('history-diverged');
        changes.push({ type: 'insert', index: destination, page,
          ...(collection === 'translation' ? { collection: 'translation' as const } : {}) });
      } else {
        if (!existing) throw new EditRejected('history-diverged');
        changes.push({ type: 'move', expected: pageExpectation(existing), index: destination });
      }
      list!.splice(destination, 0, page);
    }
  }
  for (const [pageId, change] of altered) if (change.type === 'replace') {
    const page = activeDocumentPages(current).find(page => page.id === pageId), previous = desired.get(pageId);
    if (!page || !previous) throw new EditRejected('history-diverged');
    const revision = backgroundEqual(page, previous) ? page.backgroundRevision : id;
    changes.push({ type: 'replace', expected: pageExpectation(page), page: { ...previous, backgroundRevision: revision,
      annotations: previous.annotations.map(annotation => annotation.kind === 'highlight' ? { ...annotation, backgroundRevision: revision } : annotation) } });
  }
  if (before.translation) {
    if (!current.translation) throw new EditRejected('history-diverged');
    const preliminary = changes.length ? applyBatch(current, { ...envelope, kind: 'document', changes }) as DocumentSnapshot : current;
    const bindings = restoredBindings(before, preliminary);
    if (canonicalJson(bindings) !== canonicalJson(current.translation.bindings)) {
      changes.push({ type: 'mapping', expectedRevision: current.translation.revision, bindings });
    }
  }
  if (!changes.length) throw new EditRejected('history-no-change');
  const batch: DocumentEditBatch = { ...envelope, kind: 'document', changes };
  applyBatch(current, batch); // Validate the complete inverse before exposing it to the queue/UI.
  return batch;
}

/** One stack per document, shared by all pages and surfaces. No previous-document snapshots in entries. */
export class DocumentEditHistory {
  private undoEntries: DocumentHistoryEntry[] = [];
  private redoEntries: DocumentHistoryEntry[] = [];
  getSnapshot = () => ({ undo: structuredClone(this.undoEntries), redo: structuredClone(this.redoEntries) });
  record(batch: DocumentBatch, record: HistoryRecord) {
    if (record.operationId !== batch.id || record.afterVersion !== batch.id || record.beforeVersion !== batch.parents[0]) throw new EditRejected('history-mismatch');
    const action = record.action;
    if (!action) {
      this.undoEntries.push({ operationId: batch.id, executionId: batch.id }); this.redoEntries = [];
    } else {
      const source = action.kind === 'undo' ? this.undoEntries : this.redoEntries;
      const target = action.kind === 'undo' ? this.redoEntries : this.undoEntries;
      const latest = source[source.length - 1];
      if (!latest || latest.operationId !== action.operationId) throw new EditRejected('history-action-order');
      source.pop(); target.push({ operationId: latest.operationId, executionId: batch.id });
    }
    if (this.undoEntries.length > 50) this.undoEntries.shift();
  }
  command(kind: 'undo' | 'redo', versions: DocumentVersions, current: DocumentSnapshot, id: string): HistoryCommand | undefined {
    const entries = kind === 'undo' ? this.undoEntries : this.redoEntries, latest = entries[entries.length - 1];
    if (!latest) return undefined;
    const batch = inverseDocumentEdit(versions, latest.executionId, current, id);
    const affectedPages = batch.kind === 'page' ? [batch.expected.pageId] : [...new Set(batch.changes.flatMap(change =>
      change.type === 'translation' ? [...(current.translation?.pages ?? []), ...(change.translation?.pages ?? [])].map(page => page.id)
        : change.type === 'mapping' ? change.bindings.map(binding => binding.original.pageId)
        : [change.type === 'insert' ? change.page.id : change.expected.pageId]))];
    return { batch, affectedPages, history: { operationId: id, beforeVersion: current.version, afterVersion: id,
      undoRequested: false, action: { kind, operationId: latest.operationId } } };
  }
  restore(versions: DocumentVersions, head: string, records: HistoryRecord[]) {
    const path: EditBatch[] = [], seen = new Set<string>(), byId = new Map(records.map(record => [record.operationId, record]));
    let id = head;
    while (!seen.has(id)) {
      seen.add(id); const batch = versions.batch(id); if (!batch) break;
      if (batch.kind === 'resolution' || batch.parents.length !== 1) break;
      path.push(batch); id = batch.parents[0];
    }
    const restored = new DocumentEditHistory();
    let incomplete = false;
    for (const batch of path.reverse()) {
      const record = byId.get(batch.id);
      if (!record) { incomplete = true; restored.undoEntries = []; restored.redoEntries = []; }
      // A bare batch is a history boundary until its metadata arrives. New normal
      // operations still form a usable stack after that boundary. Actions referring
      // across the gap stay unavailable and are reconstructed on a later refresh.
      if (record && (batch.kind === 'page' || batch.kind === 'document')) {
        if (incomplete && record.action) {
          const source = record.action.kind === 'undo' ? restored.undoEntries : restored.redoEntries;
          if (source[source.length - 1]?.operationId !== record.action.operationId) {
            restored.undoEntries = []; restored.redoEntries = []; continue;
          }
        }
        restored.record(batch, record);
      }
    }
    this.undoEntries = restored.undoEntries; this.redoEntries = restored.redoEntries;
  }
}

import { validateEditRecord, type EditRecord, type Snapshot } from './contracts.ts';
import { assertBatch, canonicalJson, EditRejected } from './editModel.ts';
import { publicationItem } from './contentPublication.ts';

/** One immutable transfer/archive record. Recovery intent and peer receipts stay device-local/separate. */
export function assertEditRecord(value: unknown): asserts value is EditRecord {
  validateEditRecord(value);
  const { batch, history, publication } = value;
  assertBatch(batch);
  if (history && (history.operationId !== batch.id || history.afterVersion !== batch.id || history.beforeVersion !== batch.parents[0]
    || history.action?.operationId === batch.id)) throw new EditRejected('history-mismatch');
  if (publication) {
    publicationItem(publication);
    if (canonicalJson(publication.libraryBatch) !== canonicalJson(batch)) throw new EditRejected('publication-id-reused');
  }
}
export function mergeEditRecord(previous: EditRecord, incoming: EditRecord): EditRecord {
  if (canonicalJson(previous.batch) !== canonicalJson(incoming.batch)) throw new EditRejected('batch-id-reused');
  for (const key of ['history', 'publication'] as const) {
    if (previous[key] && incoming[key] && canonicalJson(previous[key]) !== canonicalJson(incoming[key])) {
      throw new EditRejected(key === 'history' ? 'history-id-reused' : 'publication-id-reused');
    }
  }
  const history = previous.history ?? incoming.history, publication = previous.publication ?? incoming.publication;
  return { batch: previous.batch, ...(history ? { history } : {}), ...(publication ? { publication } : {}) };
}

/** A closed causal chain proves invalid references; missing batches/history remain pending. */
export function historyStatus(record: EditRecord, records: EditRecord[], roots: Snapshot[]): 'valid' | 'pending' | 'invalid' {
  const action = record.history?.action;
  if (!action) return 'valid';
  const byId = new Map(records.map(value => [value.batch.id, value])), rootVersions = new Set(roots.map(root => root.version));
  const path: EditRecord[] = [], seen = new Set<string>(); let current = record.batch.parents[0], complete = false;
  while (!seen.has(current)) {
    seen.add(current); const ancestor = byId.get(current);
    if (!ancestor) { if (!rootVersions.has(current)) return 'pending'; complete = true; break; }
    const batch = ancestor.batch;
    if (batch.targetId !== record.batch.targetId) return 'invalid';
    if (batch.kind === 'resolution' || batch.parents.length !== 1) { complete = true; break; }
    path.push(ancestor); current = batch.parents[0];
  }
  if (!complete) return 'pending';
  const referenced = path.find(value => value.batch.id === action.operationId);
  if (!referenced || referenced.history?.action) return 'invalid';
  if (path.some(value => !value.history)) return 'pending';
  const undo: string[] = [], redo: string[] = [];
  for (const value of [...path.reverse(), record]) {
    const history = value.history!, step = history.action;
    if (!step) { undo.push(history.operationId); redo.length = 0; }
    else {
      const source = step.kind === 'undo' ? undo : redo, target = step.kind === 'undo' ? redo : undo;
      if (source[source.length - 1] !== step.operationId) return 'invalid';
      target.push(source.pop()!);
    }
    if (undo.length > 50) undo.shift();
  }
  return 'valid';
}

export function validateHistories<T extends EditRecord>(records: Map<string, T>, roots: Snapshot[], incomingIds: Set<string>): void {
  const values = [...records.values()];
  for (const [id, record] of records) if (historyStatus(record, values, roots) === 'invalid') {
    if (incomingIds.has(id)) throw new EditRejected('history-action-order');
    const cleaned = { ...record }; delete cleaned.history; records.set(id, cleaned);
  }
}

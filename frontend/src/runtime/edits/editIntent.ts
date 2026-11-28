import { validateEditIntentRecord, type BatchWriteRequest, type EditIntentRecord } from './contracts.ts';
import { assertBatch, canonicalJson, EditRejected } from './editModel.ts';
import { publicationItem } from './contentPublication.ts';

export const requestedBatch = (request: BatchWriteRequest) => 'batch' in request ? request.batch : request.publication.libraryBatch;
export function assertEditIntent(record: EditIntentRecord, libraryId: string, targetId: string): void {
  validateEditIntentRecord(record);
  const { intent } = record, original = requestedBatch(intent.request);
  assertBatch(original);
  if ('publication' in intent.request) publicationItem(intent.request.publication);
  if (original.libraryId !== libraryId || original.targetId !== targetId) throw new EditRejected('intent-scope');
  for (const request of [intent.request, ...(intent.inverse ? [intent.inverse] : [])]) {
    const batch = requestedBatch(request), history = request.history;
    assertBatch(batch);
    if (history && (history.operationId !== batch.id || history.afterVersion !== batch.id || history.beforeVersion !== batch.parents[0])) throw new EditRejected('history-mismatch');
  }
  if (intent.inverse) {
    const inverse = intent.inverse.batch;
    if (!intent.undoRequested || !intent.dispatched || inverse.id === original.id || inverse.libraryId !== libraryId || inverse.targetId !== targetId
      || canonicalJson(inverse.parents) !== canonicalJson([original.id])) throw new EditRejected('intent-inverse');
  }
}
export function assertIntentTransition(previous: EditIntentRecord, next: EditIntentRecord): void {
  const a = previous.intent, b = next.intent;
  if (canonicalJson(a.request) !== canonicalJson(b.request) || (a.dispatched && !b.dispatched) || (a.undoRequested && !b.undoRequested)
    || (a.inverse && (!b.inverse || canonicalJson(a.inverse) !== canonicalJson(b.inverse)))) throw new EditRejected('intent-history-loss');
}

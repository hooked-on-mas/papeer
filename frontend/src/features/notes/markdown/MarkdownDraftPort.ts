import type { HistoryRecord, MarkdownEditBatch, MarkdownImageResource } from '../../../runtime/edits/contracts.ts';
import type { EditScope } from '../../../runtime/edits/ports.ts';

/** Scratch retains the exact dispatched operation as well as input received after it. */
export type MarkdownDraft = {
  version: 1;
  documentId: string;
  baseVersion: string;
  content: string;
  imageResources: MarkdownImageResource[];
  generation: number;
  appendIds: string[];
  appendSnapshots?: { id: string; content: string; imageResources: MarkdownImageResource[]; generation: number }[];
  flight?: { batch: MarkdownEditBatch; history: HistoryRecord; generation: number };
};

/** Synchronous device-local scratch, shared by both hosts. Invalid raw data is never cleared by the session. */
export interface MarkdownDraftPort {
  readonly scope: EditScope;
  targets(): string[];
  read(documentId: string): unknown;
  write(documentId: string, draft: MarkdownDraft): void;
  remove(documentId: string): void;
}

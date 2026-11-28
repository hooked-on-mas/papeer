import type { DocumentSnapshot, LibraryItem } from '../../../runtime/edits/contracts.ts';
import type { ContentRepository } from '../../../runtime/edits/ports.ts';
import { EditGraph } from '../../../runtime/edits/editGraph.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import type { AnnotationBrowserSource } from './canonicalAnnotationBrowser.ts';

export type AnnotationCorpusEntry = {
  documentId: string; heads: readonly string[]; sources: readonly AnnotationBrowserSource[];
  status: 'complete' | 'partial' | 'missing'; conflicted: boolean; error: string;
};
export interface AnnotationCorpusPort {
  read(items: readonly LibraryItem[], signal: AbortSignal): Promise<readonly AnnotationCorpusEntry[]>;
}
export type ExistingConfirmedAnnotationModel = (documentId: string) => DocumentSnapshot | null | undefined;

/** Durable heads only: no editor acquisition, resource bytes, PDF extraction or network requests. */
export function createCanonicalAnnotationCorpus(repository: Pick<ContentRepository, 'scope' | 'read'>,
  readExistingConfirmed?: ExistingConfirmedAnnotationModel): AnnotationCorpusPort {
  return { async read(items, signal) {
    const result: AnnotationCorpusEntry[] = [];
    for (const item of items) {
      signal.throwIfAborted();
      if (item.kind !== 'pdf' && item.kind !== 'notebook') continue;
      const entry: AnnotationCorpusEntry = { documentId: item.id, heads: [], sources: [], status: 'missing', conflicted: false, error: '' };
      try {
        const read = await repository.read(item.id); signal.throwIfAborted();
        if (read.checkpoint.libraryId !== repository.scope.libraryId || read.checkpoint.root.id !== item.id
          || read.checkpoint.root.kind !== 'document') throw new Error('annotation-corpus-scope');
        entry.heads = [...read.heads].sort(); entry.conflicted = read.heads.length > 1;
        const graph = new EditGraph(read.checkpoint), sources: AnnotationBrowserSource[] = [];
        const confirmed = readExistingConfirmed?.(item.id);
        for (const head of entry.heads) {
          signal.throwIfAborted();
          const snapshot = graph.snapshot(head);
          if (snapshot?.kind !== 'document' || snapshot.id !== item.id) continue;
          // A retained session may hold a historical checkout or a pending preview. Neither may replace a durable head.
          const document = confirmed?.version === head && canonicalJson(confirmed) === canonicalJson(snapshot) ? confirmed : snapshot;
          sources.push({ libraryId: repository.scope.libraryId, title: item.title, document: structuredClone(document) });
        }
        entry.sources = sources;
        entry.status = sources.length === 0 ? 'missing' : sources.length !== entry.heads.length || read.waiting.length ? 'partial' : 'complete';
      } catch (cause) { signal.throwIfAborted(); entry.error = String(cause); }
      result.push(entry);
    }
    return result;
  } };
}

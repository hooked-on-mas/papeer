import type { Page } from '../../../runtime/edits/contracts.ts';
import type { ContentRepository, StoredResource } from '../../../runtime/edits/ports.ts';
import { EditGraph } from '../../../runtime/edits/editGraph.ts';
import { resourceHash } from '../../../runtime/edits/contentPublication.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import type { LibraryCorpusEntry, LibraryCorpusPort } from './LibraryQuerySession.ts';

export type LibraryPdfTextExtractor = (resource: StoredResource, pages: readonly number[], signal: AbortSignal) => Promise<ReadonlyMap<number, string>>;
const annotationText = (page: Page) => page.annotations.map(annotation => annotation.kind === 'ink'
  ? annotation.geometry.kind === 'text' ? annotation.geometry.text : ''
  : `${annotation.text}\n${annotation.quote ?? ''}`).join('\n');

/** Saved, locally available content only. No Drive, network index, editor acquisition or invented OCR. */
export function createCanonicalLibraryCorpus(repository: Pick<ContentRepository, 'scope' | 'read'> & Partial<Pick<ContentRepository, 'readResource' | 'resourceMetadata'>>,
  extractPdf?: LibraryPdfTextExtractor): LibraryCorpusPort {
  return { async revision(items, signal) {
    const revisions: unknown[] = [];
    for (const item of items) {
      signal.throwIfAborted(); if (item.kind === 'attachment') continue;
      try {
        const read = await repository.read(item.id); signal.throwIfAborted();
        if (read.checkpoint.libraryId !== repository.scope.libraryId || read.checkpoint.root.id !== item.id) throw new Error('library-corpus-scope');
        const graph = new EditGraph(read.checkpoint), resources = new Map<string, string>();
        for (const head of read.heads) {
          const snapshot = graph.snapshot(head); if (snapshot?.kind !== 'document') continue;
          for (const page of [...snapshot.pages, ...(snapshot.translation?.pages ?? [])]) {
            if (page.background.kind === 'pdf') resources.set(page.background.resourceId, page.background.sourceRevision);
          }
        }
        const available: unknown[] = [];
        for (const [id, expectedHash] of [...resources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
          const metadata = await repository.resourceMetadata?.(id); signal.throwIfAborted();
          available.push([id, expectedHash, metadata ?? null]);
        }
        revisions.push([item.id, read.checkpoint.root.version, [...read.heads].sort(), [...read.waiting].sort(), available]);
      } catch { signal.throwIfAborted(); revisions.push([item.id, 'missing']); }
    }
    return canonicalJson(revisions);
  }, async read(items, signal) {
    const result: LibraryCorpusEntry[] = [];
    // Resources are shared only within this generation, never across scope or source revision changes.
    const pdfText = new Map<string, Promise<ReadonlyMap<number, string>>>();
    for (const item of items) {
      signal.throwIfAborted();
      if (item.kind === 'attachment') { result.push({ itemId: item.id, text: '', status: 'unsupported' }); continue; }
      const text: string[] = []; let complete = true, available = false;
      try {
        const read = await repository.read(item.id); signal.throwIfAborted();
        if (read.checkpoint.libraryId !== repository.scope.libraryId || read.checkpoint.root.id !== item.id) throw new Error('library-corpus-scope');
        const graph = new EditGraph(read.checkpoint);
        if (!read.heads.length || read.waiting.length) complete = false;
        for (const head of read.heads) {
          const snapshot = graph.snapshot(head);
          if (snapshot?.kind === 'markdown' && item.kind === 'markdown') { text.push(snapshot.content); available = true; continue; }
          if (snapshot?.kind !== 'document' || !['pdf', 'notebook'].includes(item.kind)) { complete = false; continue; }
          available = true;
          const pages = [...snapshot.pages, ...(snapshot.translation?.pages ?? [])];
          for (const page of pages) {
            signal.throwIfAborted(); text.push(annotationText(page));
            const background = page.background; if (background.kind !== 'pdf') continue;
            const key = `${background.resourceId}:${background.sourceRevision}`;
            let pending = pdfText.get(key);
            if (!pending) {
              pending = (async () => {
                const resource = await repository.readResource?.(background.resourceId); signal.throwIfAborted();
                if (!resource || resource.metadata.id !== background.resourceId || resource.metadata.sha256 !== background.sourceRevision
                  || resource.metadata.mediaType !== 'application/pdf' || resource.metadata.byteLength !== resource.bytes.length
                  || await resourceHash(resource.bytes) !== background.sourceRevision) throw new Error('library-corpus-resource');
                // Extract each physical page once so another logical page/head can safely reuse this resource.
                if (!extractPdf) throw new Error('library-corpus-pdf-extractor-unavailable');
                return extractPdf(resource, (resource.metadata.pdfPages ?? []).map((_, index) => index + 1), signal);
              })();
              pdfText.set(key, pending);
            }
            try {
              const body = (await pending).get(background.pdfPage); signal.throwIfAborted();
              if (body === undefined) complete = false; else text.push(body);
            } catch { signal.throwIfAborted(); complete = false; }
          }
        }
      } catch { signal.throwIfAborted(); complete = false; }
      result.push({ itemId: item.id, text: text.join('\n'), status: !available ? 'missing' : complete ? 'complete' : 'partial' });
    }
    return result;
  } };
}

import type { Page } from '../../../runtime/edits/contracts';
import type { ContentRepository } from '../../../runtime/edits/ports';
import { pdfjs, pdfRenderingOptions } from './pdfRendering';
import { assertCanonicalPdfDocument, assertCanonicalPdfPage, canonicalPdfResourceBinding, readCanonicalPdfResource } from './canonicalPdfResource';
import { PDF_SEARCH_PAGE_LIMIT, type PdfSearchPage } from './pdfTextSearch';

export const PDF_SEARCH_RESOURCE_LIMIT = 128 * 1024 * 1024;

/** One PDF lease at a time, released on completion, error, or cancellation. */
export async function* canonicalPdfSearchPages(pages: readonly Page[], resources: Pick<ContentRepository, 'scope' | 'readResource'>,
  signal: AbortSignal): AsyncGenerator<PdfSearchPage> {
  let loading: ReturnType<typeof pdfjs.getDocument> | null = null;
  let key = '', metadata: Awaited<ReturnType<typeof readCanonicalPdfResource>>['metadata'] | null = null;
  const abort = () => { if (loading) void loading.destroy().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (const source of pages) {
      signal.throwIfAborted();
      if (source.background.kind !== 'pdf') continue;
      const page = structuredClone(source), binding = canonicalPdfResourceBinding(resources.scope, page);
      const nextKey = JSON.stringify([binding.resourceId, binding.sourceRevision]);
      if (key !== nextKey || !loading || !metadata) {
        if (loading) await loading.destroy();
        loading = null; key = '';
        const resource = await readCanonicalPdfResource(binding, resources); signal.throwIfAborted();
        if (resource.bytes.byteLength > PDF_SEARCH_RESOURCE_LIMIT) throw new Error('pdf-search-resource-too-large');
        metadata = resource.metadata; loading = pdfjs.getDocument({ ...pdfRenderingOptions, data: resource.bytes }); key = nextKey;
      }
      const lease = loading, checkedMetadata = metadata;
      yield { id: page.id, backgroundRevision: page.backgroundRevision, text: async () => {
        signal.throwIfAborted();
        const pdf = await lease.promise; signal.throwIfAborted();
        assertCanonicalPdfDocument(binding, checkedMetadata, pdf.numPages);
        const physical = await pdf.getPage(binding.pdfPage); signal.throwIfAborted();
        try {
          assertCanonicalPdfPage(binding, physical);
          const content = await physical.getTextContent(); signal.throwIfAborted();
          const parts: string[] = [], anchors: { start: number; end: number; x: number; y: number; width: number; height: number }[] = []; let length = 0;
          const viewport = physical.getViewport({ scale: 1 });
          for (const item of content.items) {
            if (!('str' in item)) continue;
            const start = length;
            length += item.str.length + 1;
            if (length > PDF_SEARCH_PAGE_LIMIT) throw new Error('pdf-search-page-too-large');
            const first = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
            const second = viewport.convertToViewportPoint(item.transform[4] + item.width, item.transform[5] + item.height);
            const rect = [...first, ...second];
            const [x1, y1, x2, y2] = rect;
            if (rect.every(Number.isFinite) && viewport.height > 0 && viewport.width > 0) {
              const x = Math.max(0, Math.min(1, Math.min(x1, x2) / viewport.width)), y = Math.max(0, Math.min(1, Math.min(y1, y2) / viewport.height));
              const right = Math.max(0, Math.min(1, Math.max(x1, x2) / viewport.width)), bottom = Math.max(0, Math.min(1, Math.max(y1, y2) / viewport.height));
              if (right > x && bottom > y) anchors.push({ start, end: start + item.str.length, x, y, width: right - x, height: bottom - y });
            }
            parts.push(item.str, item.hasEOL ? '\n' : ' ');
          }
          return { text: parts.join(''), anchors };
        } finally { physical.cleanup(); }
      } };
    }
  } finally { signal.removeEventListener('abort', abort); if (loading) await loading.destroy(); }
}

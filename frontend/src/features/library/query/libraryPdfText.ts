import type { LibraryPdfTextExtractor } from './canonicalLibraryCorpus';
import { pdfjs, pdfRenderingOptions } from '../../reader/pdf/pdfRendering';

/** The same PDF.js worker and extraction policy is used by both compositions. */
export const readLibraryPdfText: LibraryPdfTextExtractor = async (resource, pages, signal) => {
  signal.throwIfAborted();
  const loading = pdfjs.getDocument({ ...pdfRenderingOptions, data: Uint8Array.from(resource.bytes) });
  const abort = () => { void loading.destroy().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const pdf = await loading.promise, result = new Map<number, string>();
    for (const pageNumber of pages) {
      signal.throwIfAborted();
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent(); signal.throwIfAborted();
        result.set(pageNumber, content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join(''));
      } finally { page.cleanup(); }
    }
    return result;
  } finally { signal.removeEventListener('abort', abort); await loading.destroy(); }
};

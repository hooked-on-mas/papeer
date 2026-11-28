import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { ResourceInspectionPort } from '../../runtime/edits/ports.ts';

GlobalWorkerOptions.workerSrc = workerUrl;
export const pdfResourceInspection: ResourceInspectionPort = {
  async inspectPdf(bytes) {
    const task = getDocument({ data: Uint8Array.from(bytes) });
    try {
      const document = await task.promise;
      if (!document.numPages || document.numPages > 100000) throw new Error('pdf-page-limit');
      const pages = [];
      for (let index = 1; index <= document.numPages; index++) {
        const page = await document.getPage(index), viewport = page.getViewport({ scale: 1 });
        pages.push({ widthPt: viewport.width, heightPt: viewport.height });
        page.cleanup();
      }
      return pages;
    } finally { await task.destroy(); }
  },
};

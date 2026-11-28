import { exportCanonicalPdf } from './vectorWriter.ts';
import type { PdfExportRequest } from './ports.ts';

self.onmessage = (event: MessageEvent<{ id: string; request: PdfExportRequest }>) => {
  const { id, request } = event.data;
  void exportCanonicalPdf(request).then(bytes => self.postMessage({ id, bytes }), error => self.postMessage({ id, error: error instanceof Error ? error.message : 'pdf-export-failed' }));
};

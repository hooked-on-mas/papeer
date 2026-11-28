import type { Page } from '../../../runtime/edits/contracts';
import type { PdfExportRequest } from '../pdf/export/ports';
import type { OutputFont } from './outputFonts';

/** Host I/O and worker lifetime only; composing the document stays shared. */
export type OutputFilePort = {
  save(bytes: Uint8Array, mediaType: 'application/pdf' | 'image/png', suggestedName: string): Promise<'saved' | 'cancelled' | 'downloaded'>;
  fonts(pages: readonly Page[], signal: AbortSignal): Promise<OutputFont[]>;
  renderPdf(request: PdfExportRequest, signal: AbortSignal): Promise<Uint8Array>;
  copyImage(bytes: Uint8Array): Promise<void>;
};

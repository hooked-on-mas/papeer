import { BootstrapSession } from '../features/bootstrap/BootstrapSession';
import type { BootstrapHostDriver } from '../features/bootstrap/bootstrapPorts';
import { createBrowserBootstrapHostDriver } from '../adapters/browser/bootstrapHostDriver';
import type { ResourceInspectionPort } from '../runtime/edits/ports';

/** PDF.js stays out of the startup path: it loads only when a PDF resource is first stored. */
const lazyPdfInspection: ResourceInspectionPort = {
  inspectPdf: async bytes => (await import('../adapters/browser/pdfResources')).pdfResourceInspection.inspectPdf(bytes),
};

/**
 * The Web production factory: one real same-origin host driver and one BootstrapSession that owns it.
 * No grant, lease, binding or window value is accepted; the driver derives authority from the origin's own storage.
 */
export function createWebBootstrap(): { driver: BootstrapHostDriver; session: BootstrapSession } {
  const driver = createBrowserBootstrapHostDriver({ inspection: lazyPdfInspection });
  return { driver, session: new BootstrapSession(driver) };
}

import { usePdfSurfaceInput } from "../features/reader/input/usePdfSurfaceInput";
export { getPdfPinchOwner, MIN_PDF_ZOOM, MAX_PDF_ZOOM } from "../features/reader/input/usePdfSurfaceInput";
/** Web markup adapter. Recognition, limits and ownership live in the shared controller. */
export function usePdfPinchZoom(...[root, zoom, onZoom, key, options]: Parameters<typeof usePdfSurfaceInput>) {
  return usePdfSurfaceInput(root, zoom, onZoom, key, {
    ...options,
    scroller: element => element.closest<HTMLElement>(".web-pdf-pane"),
    surface: element => element.querySelector<HTMLElement>(".web-pdf-surface"),
    scope: element => element.closest<HTMLElement>("[data-reader-root], .web-document-reader") ?? element,
  });
}

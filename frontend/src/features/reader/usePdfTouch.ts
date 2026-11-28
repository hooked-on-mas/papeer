import { writingContactActive } from "../notebooks/writingContact";
import { usePdfPointerInput } from "./useLegacyPdfPointerInput";
import { setZoomOf, zoomOf, type ZoomSubject } from "./navigation";
export { usePdfTouchOwner, getPdfPointerOwner } from "./useLegacyPdfPointerInput";
/** Desktop composition: the pointer adapter itself never imports desktop navigation. */
export function usePdfTouch({ zoomSubject = "pdf", ...options }: Omit<Parameters<typeof usePdfPointerInput>[0], "zoom"> & { zoomSubject?: ZoomSubject }) {
  return usePdfPointerInput({ ...options, allowTouch: () => !writingContactActive(), zoom: { get: () => zoomOf(zoomSubject), set: value => setZoomOf(zoomSubject, value) } });
}

import { pdfjs } from "react-pdf";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export const pdfRenderingOptions = {
  cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
};
export { pdfjs };

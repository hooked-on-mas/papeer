/** PDF rendering policy shared by desktop and the static Web reader; no transport or auth imports. */
import "./pdfStreamCompatibility";
import { useMemo, type ComponentProps } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const assets = {
  cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
};

export function PdfDocument({ options, ...props }: ComponentProps<typeof Document>) {
  const resolved = useMemo(() => ({ ...assets, ...options }), [options]);
  return <Document {...props} suspense={false} options={resolved} />;
}

export { Page as PdfPage };

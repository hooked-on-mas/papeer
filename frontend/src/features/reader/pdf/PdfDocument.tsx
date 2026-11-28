/** PDF rendering policy shared by desktop and the static Web reader; no transport or auth imports. */
import { useMemo, type ComponentProps } from "react";
import { Document, Page } from "react-pdf";
import { pdfRenderingOptions } from "./pdfRendering";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";



export function PdfDocument({ options, ...props }: ComponentProps<typeof Document>) {
  const resolved = useMemo(() => ({ ...pdfRenderingOptions, ...options }), [options]);
  return <Document {...props} suspense={false} options={resolved} />;
}

export { Page as PdfPage };

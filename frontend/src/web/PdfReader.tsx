import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
const options = { cMapUrl: "./pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "./pdfjs/standard_fonts/" };

export function PdfReader({ url }: { url: string }) {
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(700);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.min(1100, Math.max(200, entry.contentRect.width))));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  return <div className="pdf" ref={container}>
    <div className="pdf-tools">
      <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← 前</button>
      <label>ページ <input aria-label="ページ番号" type="number" min="1" max={pages || 1} value={page}
        onChange={e => setPage(Math.max(1, Math.min(pages || 1, Number(e.target.value) || 1)))} /> / {pages || "…"}</label>
      <button disabled={page >= pages} onClick={() => setPage(p => p + 1)}>次 →</button>
    </div>
    <Document file={url} options={options} loading="PDFを読み込んでいます…" error="PDFを表示できません。ダウンロードしてご確認ください。"
      onLoadSuccess={({ numPages }) => { setPages(numPages); setPage(1); }}>
      <Page pageNumber={page} width={width} renderAnnotationLayer={false} />
    </Document>
  </div>;
}

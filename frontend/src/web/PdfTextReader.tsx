import { useEffect, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PdfDocument } from "../features/reader/PdfDocument";

/** Ordinary HTML text, outside the canvas, ink and custom touch-selection layers. */
export function PdfTextReader({ url, pageNumber, onPageCount }: {
  url: string; pageNumber: number; onPageCount?: (count: number) => void;
}) {
  const [document, setDocument] = useState<PDFDocumentProxy>();
  return <PdfDocument file={url} loading="PDFを読み込んでいます…"
    error="PDFを表示できません。ダウンロードしてご確認ください。"
    onLoadSuccess={pdf => { setDocument(pdf); onPageCount?.(pdf.numPages); }}>
    {document && (pageNumber < 1 || pageNumber > document.numPages
      ? <p role="alert" className="error">保存されたPDFに指定ページがありません。PCから再アップロードしてください。</p>
      : <TextPage key={pageNumber} document={document} pageNumber={pageNumber} />)}
  </PdfDocument>;
}

function TextPage({ document, pageNumber }: { document: PDFDocumentProxy; pageNumber: number }) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void document.getPage(pageNumber).then(page => page.getTextContent()).then(content => {
      if (!cancelled) setText(content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "").join(""));
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [document, pageNumber, attempt]);
  if (error) return <p role="alert" className="error">本文の文字を読み込めませんでした。
    <button onClick={() => { setError(false); setText(undefined); setAttempt(value => value + 1); }}>本文を再試行</button></p>;
  if (text === undefined) return <p role="status">本文の文字を読み込んでいます…</p>;
  if (!text.trim()) return <p role="status" className="empty">このページには取り出せる文字情報がありません。画像のみのPDFは、PCでOCRを行ってから再アップロードしてください。</p>;
  return <div className="web-pdf-text-view">
    <p className="web-pdf-text-help">文字を長押しして、必要な部分を選択・コピーできます。段組みや数式はPDFと並びが異なる場合があります。</p>
    <div className="web-pdf-text-body" role="document" aria-label="ページ本文" tabIndex={0}>{text}</div>
  </div>;
}

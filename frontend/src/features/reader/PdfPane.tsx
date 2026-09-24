import React, { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";

interface PdfPaneProps {
  url: string | null;
  pageNumber: number;
  zoom: number; // 0 for fit-width, otherwise scale factor
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}

export function PdfPane({ url, pageNumber, zoom, onScroll, scrollRef }: PdfPaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setPdfDoc(null);
      return;
    }

    let isCanceled = false;
    const token = import.meta.env.VITE_PAPERDESK_TOKEN || "";
    
    const loadingTask = pdfjsLib.getDocument({ 
      url,
      httpHeaders: token ? { Authorization: `Bearer ${token}` } : undefined,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/"
    });

    loadingTask.promise
      .then((doc) => {
        if (!isCanceled) {
          setPdfDoc(doc);
          setError(null);
        }
      })
      .catch((err) => {
        if (!isCanceled) {
          console.error("Error loading PDF:", err);
          setError(err.message || "Failed to load PDF");
        }
      });

    return () => {
      isCanceled = true;
      loadingTask.destroy();
    };
  }, [url]);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current || !containerRef.current) return;

    let isCanceled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;

    const renderPage = async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (isCanceled) return;

        const canvas = canvasRef.current;
        if (!canvas) return;

        const context = canvas.getContext("2d");
        if (!context) return;

        // Calculate scale
        let scale = zoom;
        if (scale === 0) {
          // Fit width
          const viewport1 = page.getViewport({ scale: 1 });
          const containerWidth = containerRef.current!.clientWidth - 32; // padding
          scale = containerWidth / viewport1.width;
        }

        const viewport = page.getViewport({ scale });
        const outputScale = window.devicePixelRatio || 1;

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = Math.floor(viewport.width) + "px";
        canvas.style.height = Math.floor(viewport.height) + "px";

        const transform = outputScale !== 1
          ? [outputScale, 0, 0, outputScale, 0, 0]
          : undefined;

        const renderContext = {
          canvasContext: context,
          transform,
          viewport: viewport,
        };

        renderTask = page.render(renderContext as any);
        await renderTask.promise;
      } catch (err: any) {
        if (!isCanceled && err.name !== 'RenderingCancelledException') {
          console.error("Error rendering page:", err);
        }
      }
    };

    renderPage();

    return () => {
      isCanceled = true;
      if (renderTask) {
        renderTask.cancel();
      }
    };
  }, [pdfDoc, pageNumber, zoom]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (onScroll) onScroll(e);
  };

  return (
    <div
      ref={(node) => {
        // @ts-ignore
        containerRef.current = node;
        if (scrollRef) {
          // @ts-ignore
          scrollRef.current = node;
        }
      }}
      onScroll={handleScroll}
      className="w-full h-full overflow-auto bg-muted/30 p-4 flex justify-center items-start"
    >
      {error ? (
        <div className="text-destructive p-4 border rounded bg-background">Error: {error}</div>
      ) : !url ? (
        <div className="text-muted-foreground p-4">No PDF provided</div>
      ) : (
        <div className="relative shadow-md bg-white">
          <canvas ref={canvasRef} />
          {/* TextLayer would go here */}
        </div>
      )}
    </div>
  );
}


import React, { useRef, useState, useEffect } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs?url";

import { useStore } from "@/store";
import { useReading } from "@/api/hooks";
import { PdfPane } from "./PdfPane";
import { ReaderToolbar } from "./ReaderToolbar";
import { PageStatusOverlay } from "./PageStatusOverlay";
import { PaperStatusBadge } from "@/components/ui/PaperStatusBadge";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { FilePlus2 } from "lucide-react";
import { shell } from "@/shell";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export function Reader() {
  const { activePaperId, currentPage, zoom, readerSplit, setReaderSplit, activeJobs } = useStore();
  const { data: reading } = useReading(activePaperId);
  const job = activeJobs.find((j) => j.paper_id === activePaperId && j.status === "running");
  const queryClient = useQueryClient();
  
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  const isSyncingLeft = useRef(false);
  const isSyncingRight = useRef(false);
  const [pdfTimestamp, setPdfTimestamp] = useState(Date.now());
  useEffect(() => {
    const onTranslated = (e: any) => { if (e.detail?.paper_id === activePaperId) setPdfTimestamp(Date.now()); };
    window.addEventListener("pdf-translated", onTranslated);
    return () => window.removeEventListener("pdf-translated", onTranslated);
  }, [activePaperId]);

  

  const port = import.meta.env.VITE_PAPERDESK_PORT || 8000;
  const leftUrl = activePaperId ? `http://127.0.0.1:${port}/api/papers/${activePaperId}/files/original.pdf?t=${pdfTimestamp}` : null;
  const rightUrl = activePaperId ? `http://127.0.0.1:${port}/api/papers/${activePaperId}/files/translated.pdf?t=${pdfTimestamp}` : null;

  const handleLeftScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (isSyncingRight.current) {
      isSyncingRight.current = false;
      return;
    }
    const right = rightScrollRef.current;
    if (right) {
      isSyncingLeft.current = true;
      const target = e.currentTarget;
      const ratio = target.scrollTop / (target.scrollHeight - target.clientHeight || 1);
      right.scrollTop = ratio * (right.scrollHeight - right.clientHeight);
    }
  };

  const handleRightScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (isSyncingLeft.current) {
      isSyncingLeft.current = false;
      return;
    }
    const left = leftScrollRef.current;
    if (left) {
      isSyncingRight.current = true;
      const target = e.currentTarget;
      const ratio = target.scrollTop / (target.scrollHeight - target.clientHeight || 1);
      left.scrollTop = ratio * (left.scrollHeight - left.clientHeight);
    }
  };

  const handleAddPdf = async () => {
    try {
      const paths = await shell.openFiles([{ name: "PDF Files", extensions: ["pdf"] }]);
      if (paths.length > 0) {
        const res = await api.POST("/api/papers/import", { body: { paths } });
        if (!res.error) queryClient.invalidateQueries({ queryKey: ["papers"] });
      } else {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".pdf";
        input.multiple = true;
        input.onchange = async (e) => {
          const files = (e.target as HTMLInputElement).files;
          if (!files || files.length === 0) return;
          for (let i = 0; i < files.length; i++) {
            const formData = new FormData();
            formData.append("file", files[i]);
            try {
              const port = import.meta.env.VITE_PAPERDESK_PORT || 8000;
              const token = import.meta.env.VITE_PAPERDESK_TOKEN || "";
              await fetch(`http://127.0.0.1:${port}/api/papers/upload`, {
                method: "POST",
                headers: token ? { Authorization: `Bearer ${token}` } : {},
                body: formData
              });
            } catch (err) { console.error("Upload err", err); }
          }
          queryClient.invalidateQueries({ queryKey: ["papers"] });
        };
        input.click();
      }
    } catch (err) {
      console.error(err);
    }
  };

  if (!activePaperId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8">
        <FilePlus2 className="w-16 h-16 mb-4 opacity-20" />
        <p className="text-[15px] font-medium mb-1 text-foreground">論文が選択されていません</p>
        <p className="text-[13px] mb-6">左のライブラリから論文を選ぶか、PDF を追加してください</p>
        <button onClick={handleAddPdf} className="bg-primary text-primary-foreground px-4 py-2 rounded-md font-medium hover:opacity-90 transition-opacity">
          PDF を追加
        </button>
      </div>
    );
  }

  const isTranslated = reading?.completed_pages?.includes(currentPage);

  return (
    <div className="flex flex-col h-full w-full bg-reader-bg">
      <ReaderToolbar />
      <ResizablePanelGroup 
        orientation="horizontal" 
        className="flex-1 min-h-0"
        onLayoutChange={(sizes) => {
          if (sizes.length === 2) {
            setReaderSplit(sizes[0] / 100);
          }
        }}
      >
        <ResizablePanel id="original" defaultSize={readerSplit * 100 + "%"} minSize="20%" className="flex flex-col">
          <div className="h-[28px] border-b flex items-center px-4 bg-background shrink-0 text-muted-foreground font-medium text-xs">
            原文
          </div>
          <div className="flex-1 relative">
            <PdfPane 
              url={leftUrl} 
              pageNumber={currentPage} 
              zoom={zoom} 
              onScroll={handleLeftScroll} 
              scrollRef={leftScrollRef} 
            />
          </div>
        </ResizablePanel>
        
        <ResizableHandle className="w-1 bg-border hover:bg-accent hover:w-[6px] transition-all cursor-col-resize active:bg-primary z-10" />
        
        <ResizablePanel id="translated" defaultSize={(1 - readerSplit) * 100 + "%"} minSize="20%" className="flex flex-col">
          <div className="h-[28px] border-b flex items-center px-4 bg-background shrink-0 justify-between">
            <span className="text-muted-foreground font-medium text-xs">訳文</span>
            {isTranslated ? (
              <PaperStatusBadge status="translated" text="翻訳済み" className="text-xs" />
            ) : (
              <PaperStatusBadge status="untranslated" text="未翻訳" className="text-xs" />
            )}
          </div>
          <div className="flex-1 relative">
            <PageStatusOverlay 
              status={job ? "translating" : isTranslated ? "translated" : "untranslated"}
              progress={job ? { done: job.done || 0, total: job.total || 0 } : undefined}
            />
            {/* If not translated, we might show a placeholder, but for now we let PdfPane handle it or just show original text if pdf.js handles 404 */}
            <PdfPane 
              url={rightUrl} 
              pageNumber={currentPage} 
              zoom={zoom} 
              onScroll={handleRightScroll} 
              scrollRef={rightScrollRef} 
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}


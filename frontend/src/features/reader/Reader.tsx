import React, { useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs?url";

import { useStore } from "@/store";
import { PdfPane } from "./PdfPane";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export function Reader() {
  const { activePaperId, currentPage, zoom, setCurrentPage } = useStore();
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  const isSyncingLeft = useRef(false);
  const isSyncingRight = useRef(false);

  // Example URLs for testing (in reality these would come from the API client based on activePaperId)
  const leftUrl = activePaperId ? `http://127.0.0.1:1420/api/papers/${activePaperId}/files/original.pdf` : null;
  const rightUrl = activePaperId ? `http://127.0.0.1:1420/api/papers/${activePaperId}/files/translated.pdf` : null;

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

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-center gap-2 p-2 border-b shrink-0 bg-background">
        <button 
          className="px-2 py-1 text-sm border rounded"
          onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
        >
          Prev
        </button>
        <span className="text-sm">Page {currentPage}</span>
        <button 
          className="px-2 py-1 text-sm border rounded"
          onClick={() => setCurrentPage(currentPage + 1)}
        >
          Next
        </button>
      </div>
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 border-r relative">
          <PdfPane 
            url={leftUrl} 
            pageNumber={currentPage} 
            zoom={zoom} 
            onScroll={handleLeftScroll} 
            scrollRef={leftScrollRef} 
          />
        </div>
        <div className="flex-1 relative">
          <PdfPane 
            url={rightUrl} 
            pageNumber={currentPage} 
            zoom={zoom} 
            onScroll={handleRightScroll} 
            scrollRef={rightScrollRef} 
          />
        </div>
      </div>
    </div>
  );
}


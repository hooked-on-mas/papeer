import { useStore } from "@/store";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize2, Search } from "lucide-react";
import { useReading, usePaper } from "@/api/hooks";

export function ReaderToolbar() {
  const { activePaperId, currentPage, zoom, setZoom, setCurrentPage, translatedOnly, setTranslatedOnly, focusMode, setFocusMode } = useStore();
  const { data: reading } = useReading(activePaperId);
  const { data: paper } = usePaper(activePaperId);
  const completedPages = reading?.completed_pages || [];

  const handlePrev = () => {
    if (translatedOnly) {
      const idx = [...completedPages].reverse().find(p => p < currentPage);
      if (idx) setCurrentPage(idx);
    } else {
      setCurrentPage(Math.max(1, currentPage - 1));
    }
  };

  const handleNext = () => {
    // Assuming a max page count isn't easily known here without passing it, but let's just increment
    if (translatedOnly) {
      const idx = completedPages.find(p => p > currentPage);
      if (idx) setCurrentPage(idx);
    } else {
      setCurrentPage(currentPage + 1);
    }
  };

  const handleZoomIn = () => setZoom(zoom === 0 ? 1.25 : zoom + 0.25);
  const handleZoomOut = () => setZoom(zoom === 0 ? 0.75 : Math.max(0.25, zoom - 0.25));

  return (
    <div className="h-[40px] flex items-center px-4 border-b shrink-0 bg-background/50 text-[13px]">
      <div className="flex items-center gap-1">
        <button onClick={handlePrev} className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-1 px-2">
          <input 
            type="text" 
            value={currentPage} 
            onChange={(e) => {
              const val = parseInt(e.target.value);
              if (!isNaN(val)) setCurrentPage(Math.max(1, Math.min(val, paper?.pages || 9999)));
            }}
            className="w-8 h-6 text-center border rounded bg-background focus:ring-2 focus:ring-ring focus:outline-none tabular-nums"
          />
          <span className="text-muted-foreground">/ {paper?.pages || "?"}</span>
        </div>
        <button onClick={handleNext} className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <div className="w-px h-4 bg-border mx-4"></div>

      <div className="flex items-center gap-2">
        <select 
          value={zoom} 
          onChange={(e) => setZoom(Number(e.target.value))}
          className="h-6 bg-transparent border-none text-[13px] focus:outline-none hover:bg-muted rounded px-1 cursor-pointer"
        >
          <option value={0}>幅に合わせる</option>
          <option value={1}>100%</option>
          <option value={1.25}>125%</option>
          <option value={1.5}>150%</option>
          <option value={2}>200%</option>
        </select>
        <button onClick={handleZoomOut} className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground">
          <ZoomOut className="w-4 h-4" />
        </button>
        <button onClick={handleZoomIn} className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground">
          <ZoomIn className="w-4 h-4" />
        </button>
      </div>

      <div className="w-px h-4 bg-border mx-4"></div>

      <label className="flex items-center gap-2 cursor-pointer hover:text-foreground text-muted-foreground">
        <input 
          type="checkbox" 
          checked={translatedOnly} 
          onChange={(e) => setTranslatedOnly(e.target.checked)}
          className="rounded border-border text-primary focus:ring-ring"
        />
        翻訳済みのみ
      </label>

      <div className="ml-auto flex items-center gap-2">
        <button className="p-1.5 hover:bg-muted rounded text-muted-foreground hover:text-foreground" title="検索 (Ctrl+Shift+F)">
          <Search className="w-[18px] h-[18px]" />
        </button>
        <button 
          onClick={() => setFocusMode(!focusMode)} 
          className={`p-1.5 rounded hover:bg-muted transition-colors ${focusMode ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'}`} 
          title="集中 (F11)"
        >
          <Maximize2 className="w-[18px] h-[18px]" />
        </button>
      </div>
    </div>
  );
}


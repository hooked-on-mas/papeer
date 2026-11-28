import { useEffect, useRef, useState, type ReactNode } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../../../components/ui/resizable";

/** The desktop reader and its optional right pane. Hosts supply content and persistence. */
export function ReaderDock({ children, open, panel, panelId, label, width = 380, onWidthChange, stacked = false, preserveWidth = false, onClosePanel }: {
  children: ReactNode; open: boolean; panel?: ReactNode; panelId?: string; label?: string;
  onClosePanel?: () => void;
  width?: number; onWidthChange?: (width: number) => void; stacked?: boolean; preserveWidth?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(1000);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(entries => setAvailableWidth(entries[0].contentRect.width));
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const fullPanel = open && !!panel && availableWidth < 644 && !!onClosePanel;
  // Read the saved width once when opening; changing it during a drag must not re-register the pane.
  const [openWidth, setOpenWidth] = useState<number | null>(null);
  if (open && openWidth === null) setOpenWidth(width);
  if (!open && openWidth !== null) setOpenWidth(null);
  return <div ref={host} className="relative flex flex-1 min-h-0 min-w-0">
    {fullPanel && <div className="absolute inset-0 z-10 flex flex-col bg-background"><button className="min-h-11 self-start px-3" onClick={onClosePanel}>本文に戻る</button><aside className="flex min-h-0 flex-1 flex-col" aria-label={label}>{panel}</aside></div>}
    <ResizablePanelGroup orientation={stacked ? "vertical" : "horizontal"} className="flex-1 min-h-0" data-reader-dock="">
    <ResizablePanel id="reader" minSize={stacked ? "120px" : "320px"} className="flex flex-col min-w-0 min-h-0">
      {children}
    </ResizablePanel>
    {open && !fullPanel && <>
      <ResizableHandle className={stacked ? "h-1 bg-border hover:bg-primary/60 cursor-row-resize" : "w-1 bg-border hover:bg-primary/60 cursor-col-resize"} />
      <ResizablePanel id="side-panel" defaultSize={stacked ? "45%" : `${openWidth ?? width}px`}
        groupResizeBehavior={preserveWidth && !stacked ? "preserve-pixel-size" : undefined}
        minSize={stacked ? "140px" : "320px"} maxSize="80%"
        onResize={size => { if (!stacked && size.inPixels > 0) onWidthChange?.(Math.round(size.inPixels)); }}
        className="flex flex-col min-w-0 min-h-0 bg-background">
        {panel && <aside className="flex-1 flex flex-col min-h-0 overflow-hidden" aria-label={label} data-side-panel={panelId}>{panel}</aside>}
      </ResizablePanel>
    </>}
  </ResizablePanelGroup></div>;
}

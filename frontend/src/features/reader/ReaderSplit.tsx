import type { ReactNode } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../../components/ui/resizable";

/** Layout only. Each host supplies its PDF panes and owns navigation, transport and editing. */
export function ReaderSplit({ original, translated, fraction = .5, onResize, stacked = false }: {
  original: ReactNode; translated?: ReactNode; fraction?: number; onResize?: (fraction: number) => void; stacked?: boolean;
}) {
  const split = translated !== undefined;
  return <ResizablePanelGroup key={split ? "split" : "single"} orientation={stacked ? "vertical" : "horizontal"} className="flex-1 min-h-0"
    onLayoutChanged={layout => {
      const total = (layout.original ?? 0) + (layout.translated ?? 0);
      if (split && total > 0 && layout.original !== undefined) onResize?.(layout.original / total);
    }}>
    <ResizablePanel id="original" defaultSize={split ? `${fraction * 100}%` : "100%"} minSize="15%" className="flex flex-col min-w-0">
      {original}
    </ResizablePanel>
    {split && <><ResizableHandle className={`${stacked ? "h-1 cursor-row-resize" : "w-1 cursor-col-resize"} bg-border hover:bg-primary/60 transition-colors z-10`} />
      <ResizablePanel id="translated" defaultSize={`${(1 - fraction) * 100}%`} minSize="15%" className="flex flex-col min-w-0">
        {translated}
      </ResizablePanel>
    </>}
  </ResizablePanelGroup>;
}

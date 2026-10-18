/** Shared desktop/Web chrome. This module never imports a data store, sidecar or Tauri API. */
import { useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "cn";
import { TabsList } from "./ui/tabs";
import { ResizablePanel } from "./ui/resizable";

export function WorkspaceRoot({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex h-dvh w-full flex-col bg-background text-foreground overflow-hidden", className)} {...props} />;
}

export function WorkspaceSidebar({ children, footer, onCollapse, collapseTitle = "左パネルを閉じる", className }: {
  children: ReactNode; footer?: ReactNode; onCollapse: () => void; collapseTitle?: string; className?: string;
}) {
  return <div className={cn("flex h-full min-h-0 flex-col bg-sidebar", className)} data-workspace-sidebar="">
    <button type="button" className="h-12 flex items-center gap-2 px-4 border-0 rounded-none font-semibold text-[0.9375rem] shrink-0 hover:bg-muted/50 transition-colors text-left"
      onClick={onCollapse} title={collapseTitle} aria-label={collapseTitle}>
      <span className="flex size-8 shrink-0 items-center justify-center">
        <img src={`${import.meta.env.BASE_URL}papeer.png`} alt="" className="size-8 object-contain" />
      </span>
      Papeer
    </button>
    <div className="flex-1 min-h-0">{children}</div>
    {footer}
  </div>;
}

export function WorkspaceHeader({ className, ...props }: ComponentProps<"header">) {
  return <header className={cn("h-13 border-b flex items-center pl-3 pr-4 justify-between shrink-0 bg-background/50", className)}
    data-workspace-header="" {...props} />;
}

/** Children are the capability-filtered tabs supplied by each host. */
export function WorkspaceTabList({ children, hidden = false }: { children: ReactNode; hidden?: boolean }) {
  return <div hidden={hidden} className="border-b px-4 shrink-0 bg-background/50 overflow-x-auto">
    <TabsList variant="line" className="h-10 bg-transparent border-b-0 space-x-2">{children}</TabsList>
  </div>;
}

/** Collapsed library rail, shared with the desktop host's available actions. */
export function WorkspaceRail({ onExpand, children, title = "ライブラリを表示" }: { onExpand: () => void; children?: ReactNode; title?: string }) {
  return <div className="w-12 bg-sidebar border-r flex flex-col items-center py-2 gap-1 shrink-0" data-workspace-rail="">
    <button data-slot="library-expand" className="w-8 h-8 flex items-center justify-center hover:bg-muted rounded" title={title} aria-label="ライブラリを表示" onClick={onExpand}>
      <img src={`${import.meta.env.BASE_URL}papeer.png`} alt="Papeer" className="size-8 object-contain" />
    </button>{children}
  </div>;
}

/** Preserve the opening width during a drag; the host remembers the resulting width. */
export function WorkspaceLibraryPanel({ width, onWidthChange, children }: { width: number; onWidthChange: (width: number) => void; children: ReactNode }) {
  const [initialWidth] = useState(width);
  return <ResizablePanel id="sidebar" defaultSize={`${initialWidth}px`} minSize="200px" maxSize="80%"
    onResize={size => { if (size.inPixels > 0) onWidthChange(Math.round(size.inPixels)); }} className="bg-sidebar flex flex-col border-r">
    {children}
  </ResizablePanel>;
}

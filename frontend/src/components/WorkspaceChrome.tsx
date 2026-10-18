/** Shared desktop/Web chrome. This module never imports a data store, sidecar or Tauri API. */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "cn";
import { TabsList } from "./ui/tabs";

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

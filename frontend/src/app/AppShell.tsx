import type { ReactNode } from "react";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { WorkspaceRoot, WorkspaceLibraryPanel, WorkspaceTabList } from "@/components/WorkspaceChrome";
import { Tabs } from "@/components/ui/tabs";

export interface AppShellProps {
  contained?: boolean;
  activeTab: string;
  onTabChange: (tab: string) => void;
  focusMode: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  onSidebarWidth: (width: number) => void;
  sidePanelOpen: boolean;
  sidebar: ReactNode;
  rail: ReactNode;
  header: ReactNode;
  tabs: ReactNode;
  children: ReactNode;
  status?: ReactNode;
  overlays?: ReactNode;
  banner?: ReactNode;
  beforeTabs?: ReactNode;
}

/** Desktop layout. Its host supplies content, state and actions. */
export function AppShell({ activeTab, onTabChange, focusMode, sidebarCollapsed, sidebarWidth,
  onSidebarWidth, sidePanelOpen, sidebar, rail, header, tabs, children, status, overlays, banner, beforeTabs, contained }: AppShellProps) {
  return (
    <WorkspaceRoot contained={contained}>
      {banner}
      <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
        {!focusMode && !sidebarCollapsed && (
          <>
            <WorkspaceLibraryPanel width={sidebarWidth} onWidthChange={onSidebarWidth}>
              {sidebar}
            </WorkspaceLibraryPanel>
            <ResizableHandle className="w-1 bg-border hover:bg-primary/60 transition-colors cursor-col-resize" />
          </>
        )}
        {!focusMode && sidebarCollapsed && rail}
        {/* Room for the reader and the side panel within it (320px each) when the panel is open. */}
        <ResizablePanel id="main" minSize={focusMode ? "320px" : sidePanelOpen ? "644px" : "480px"} className="flex flex-col min-w-0 bg-background">
          {!focusMode && header}
          {beforeTabs}
          <Tabs value={activeTab} onValueChange={(value) => onTabChange(String(value))} className="flex-1 flex flex-col min-h-0 gap-0">
            <WorkspaceTabList hidden={focusMode}>{tabs}</WorkspaceTabList>
            <div className="relative flex-1 flex flex-col min-h-0">
              {children}
            </div>
          </Tabs>
        </ResizablePanel>
      </ResizablePanelGroup>
      {status}
      {overlays}
    </WorkspaceRoot>
  );
}

import type { ReactNode } from 'react';
import { WorkspaceLibraryPanel } from '../components/WorkspaceChrome';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../components/ui/resizable';

export type WebLibraryProps = {
  compactReading: boolean; transitioning: boolean; narrow: boolean; collapsed: boolean; focusMode: boolean;
  onCloseSidebar(): void; sidebar: ReactNode; rail: ReactNode;
  sidebarWidth: number; onSidebarWidth(width: number): void;
  mainMinSize: string; main: ReactNode;
};

/** The library frame accepts its data connection without starting services. */
export function WebLibrary({ compactReading, transitioning, narrow, collapsed, focusMode, onCloseSidebar,
  sidebar, rail, sidebarWidth, onSidebarWidth, mainMinSize, main }: WebLibraryProps) {
  return <div className={`workspace ${compactReading ? 'compact-reading' : ''}`} inert={transitioning} aria-busy={transitioning}>
    {narrow && !collapsed && !focusMode && <>
      <button className="sidebar-backdrop" aria-label="ライブラリを閉じる" onClick={onCloseSidebar} />
      <aside className="web-sidebar web-sidebar-overlay" aria-label="ライブラリ一覧">{sidebar}</aside>
    </>}
    {!narrow && collapsed && !focusMode && rail}
    <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0 min-w-0">
      {!narrow && !collapsed && !focusMode && <>
        <WorkspaceLibraryPanel width={sidebarWidth} onWidthChange={onSidebarWidth}>
          <aside className="h-full min-h-0" aria-label="ライブラリ一覧">{sidebar}</aside>
        </WorkspaceLibraryPanel>
        <ResizableHandle className="w-1 bg-border hover:bg-primary/60 cursor-col-resize" />
      </>}
      <ResizablePanel key="main" id="main" minSize={mainMinSize} className="flex flex-col min-w-0 min-h-0">{main}</ResizablePanel>
    </ResizablePanelGroup>
  </div>;
}

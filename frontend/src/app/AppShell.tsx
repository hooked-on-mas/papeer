import { useState } from "react";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { useStore } from "../store";
import { Header } from "./Header";
import { StatusBar } from "./StatusBar";
import { LibrarySidebar } from "../features/library/LibrarySidebar";
import { Reader } from "../features/reader/Reader";
import { SummaryPane } from "../features/summary/SummaryPane";
import { ChatPane } from "../features/chat/ChatPane";
import { SettingsDialog } from "../features/settings/SettingsDialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function AppShell() {
  const { activeTab, setActiveTab, sidebarCollapsed, focusMode } = useStore();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  
  if (focusMode) {
    return (
      <div className="flex h-screen w-full flex-col bg-background text-foreground overflow-hidden">
        <main className="flex-1 flex flex-col min-h-0 relative">
           <Reader />
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground overflow-hidden">
      <ResizablePanelGroup orientation="horizontal" className="flex-1">
        {!sidebarCollapsed && (
          <>
            <ResizablePanel
              id="sidebar"
              defaultSize={260}
              minSize={200}
              maxSize={400}
              className="bg-sidebar flex flex-col border-r"
            >
              <div className="h-12 flex items-center px-4 font-semibold shrink-0 cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => useStore.getState().setSidebarCollapsed(true)}>
                ▣ PaperDesk
              </div>
              <div className="flex-1 overflow-auto">
                <LibrarySidebar />
              </div>
              <div className="h-12 border-t flex items-center px-4 shrink-0 cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => setIsSettingsOpen(true)}>
                ⚙ 設定
              </div>
            </ResizablePanel>
            <ResizableHandle className="w-1 bg-border hover:bg-accent hover:w-1.5 transition-all cursor-col-resize active:bg-primary" />
          </>
        )}
        
        {sidebarCollapsed && (
          <div className="w-12 bg-sidebar border-r flex flex-col items-center py-2 shrink-0">
             <div className="w-8 h-8 flex items-center justify-center cursor-pointer hover:bg-muted rounded" onClick={() => useStore.getState().setSidebarCollapsed(false)}>
               ▣
             </div>
             <div className="mt-auto w-8 h-8 flex items-center justify-center cursor-pointer hover:bg-muted rounded" onClick={() => setIsSettingsOpen(true)}>
               ⚙
             </div>
          </div>
        )}

        <ResizablePanel id="main" className="flex flex-col min-w-0 bg-background">
          <Header />
          
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
            <div className="border-b px-4 shrink-0 bg-background/50">
              <TabsList className="h-[40px] bg-transparent border-b-0 space-x-2">
                <TabsTrigger value="reader" className="data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none shadow-none bg-transparent">
                  PDF を読む
                </TabsTrigger>
                <TabsTrigger value="summary" className="data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none shadow-none bg-transparent">
                  サマリー
                </TabsTrigger>
                <TabsTrigger value="chat" className="data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none shadow-none bg-transparent">
                  質問
                </TabsTrigger>
                <TabsTrigger value="notes" className="data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none shadow-none bg-transparent">
                  メモ・整理
                </TabsTrigger>
              </TabsList>
            </div>
            
            <TabsContent value="reader" className="flex-1 p-0 m-0 overflow-hidden outline-none data-[state=active]:flex">
              <Reader />
            </TabsContent>
            
            <TabsContent value="summary" className="flex-1 p-0 m-0 overflow-hidden outline-none data-[state=active]:flex">
              <SummaryPane />
            </TabsContent>
            
            <TabsContent value="chat" className="flex-1 p-0 m-0 overflow-hidden outline-none data-[state=active]:flex bg-card">
              <ChatPane />
            </TabsContent>
            
            <TabsContent value="notes" className="flex-1 p-0 m-0 overflow-hidden outline-none data-[state=active]:flex">
              <div className="p-4">メモ・整理 (To be implemented)</div>
            </TabsContent>
          </Tabs>
        </ResizablePanel>
      </ResizablePanelGroup>

      <StatusBar />
      <SettingsDialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen} />
    </div>
  );
}

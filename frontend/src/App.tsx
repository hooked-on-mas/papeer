import { useState } from "react";
import { SidebarProvider, Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuItem, SidebarMenuButton } from "@/components/ui/sidebar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FileText, MessageSquare, BookOpen, Settings, ListPlus } from "lucide-react";

import { Reader } from "./features/reader/Reader";
import { LibrarySidebar } from "./features/library/LibrarySidebar";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { GlobalProgress } from "./features/jobs/GlobalProgress";
import { SummaryPane } from "./features/summary/SummaryPane";
import { ChatPane } from "./features/chat/ChatPane";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { shell } from "./shell";
import { api } from "./api/client";

const queryClient = new QueryClient();

export default function App() {
  const [activeTab, setActiveTab] = useState("reader");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const handleAddPdf = async () => {
    try {
      const paths = await shell.openFiles([{ name: "PDF Files", extensions: ["pdf"] }]);
      if (paths.length > 0) {
        const res = await api.POST("/api/papers/import", {
          body: { paths }
        });
        if (res.error) {
          console.error("Failed to import papers", res.error);
        } else {
          queryClient.invalidateQueries({ queryKey: ["papers"] });
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <QueryClientProvider client={queryClient}>
      <SidebarProvider>
        <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
          <Sidebar className="border-r">
            <SidebarContent className="h-full flex flex-col">
              <SidebarGroup className="flex-1 overflow-hidden flex flex-col">
                <SidebarGroupLabel>PaperDesk</SidebarGroupLabel>
                <div className="px-2 mb-2">
                  <SidebarMenuButton onClick={handleAddPdf}>
                    <ListPlus className="w-4 h-4 mr-2" />
                    <span>Add PDF</span>
                  </SidebarMenuButton>
                </div>
                <div className="flex-1 overflow-auto">
                  <LibrarySidebar />
                </div>
              </SidebarGroup>
              
              <SidebarGroup className="mt-auto shrink-0">
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton onClick={() => setIsSettingsOpen(true)}>
                        <Settings className="w-4 h-4 mr-2" />
                        <span>Settings</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <SettingsDialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen} />

        <main className="flex-1 flex flex-col h-full overflow-hidden">
          <header className="h-12 border-b flex items-center px-4 justify-between shrink-0">
            <h1 className="text-sm font-medium truncate">No Paper Selected</h1>
            <div className="flex items-center gap-2">
              {/* Toolbar placeholder */}
            </div>
          </header>
          
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
            <div className="border-b px-4 shrink-0">
              <TabsList className="h-10">
                <TabsTrigger value="reader" className="gap-2"><BookOpen className="w-4 h-4"/> Reader</TabsTrigger>
                <TabsTrigger value="summary" className="gap-2"><FileText className="w-4 h-4"/> Summary</TabsTrigger>
                <TabsTrigger value="chat" className="gap-2"><MessageSquare className="w-4 h-4"/> Chat</TabsTrigger>
              </TabsList>
            </div>
            
            <TabsContent value="reader" className="flex-1 p-0 m-0 overflow-hidden outline-none data-[state=active]:flex">
              <Reader />
            </TabsContent>
            
            <TabsContent value="summary" className="flex-1 p-0 m-0 overflow-hidden outline-none data-[state=active]:flex">
              <SummaryPane />
            </TabsContent>
            
            <TabsContent value="chat" className="flex-1 p-0 m-0 overflow-auto outline-none data-[state=active]:flex">
                <ChatPane />
            </TabsContent>
          </Tabs>
          
          <footer className="h-8 border-t flex items-center px-4 text-xs text-muted-foreground shrink-0 justify-between">
            <div>Ready</div>
            <div className="flex gap-4">
              <GlobalProgress />
            </div>
          </footer>
        </main>
      </div>
      </SidebarProvider>
    </QueryClientProvider>
  );
}

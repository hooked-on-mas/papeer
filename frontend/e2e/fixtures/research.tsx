import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReferencesPane } from "../../src/features/references/ReferencesPane";
import { Tabs, TabsContent } from "../../src/components/ui/tabs";
import { ReferenceReturnBar } from "../../src/features/references/researchNavigation";
import { ChatPane } from "../../src/features/chat/ChatPane";
import { SummaryPane } from "../../src/features/summary/SummaryPane";
import { summaryJobHandlers } from "../../src/features/summary/summaryJobs";
import { Header } from "../../src/app/Header";
import { useJobEvents } from "../../src/features/jobs/jobEvents";
import { registerJobHandlers } from "../../src/features/jobs/jobHandlers";
import { researchJobHandlers } from "../../src/features/references/researchJobs";
import { chatJobHandlers } from "../../src/features/chat/chatJobs";
import { useStore } from "../../src/store";
import { useSettings } from "../../src/api/hooks";
import { useSaveSettings } from "../../src/api/mutations";
import { ConnectionSection, useConnectionForm } from "../../src/features/settings/ConnectionSection";
import { openSettings, useSettingsNavigation } from "../../src/features/settings/settingsNavigation";
import "../../src/index.css";

const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
registerJobHandlers({ ...researchJobHandlers, ...chatJobHandlers, ...summaryJobHandlers });
const parallel = new URLSearchParams(window.location.search).has("parallel");
useStore.setState({ activePaperId: "a".repeat(32), activeTab: "references" });
function SettingsFixture() {
  const { data: settings } = useSettings();
  const form = useConnectionForm(true, settings);
  const save = useSaveSettings();
  return <section className="fixed inset-0 z-50 overflow-auto bg-background p-5" aria-label="情報取得の設定">
    <ConnectionSection form={form} />
    <button onClick={async () => {
      await save.mutateAsync({ settings: form.values() });
      useSettingsNavigation.setState({ open: false });
    }}>設定を保存</button>
  </section>;
}
function Fixture() {
  useJobEvents();
  const state = useStore();
  const settingsOpen = useSettingsNavigation(s => s.open);
  return <div className="h-screen overflow-hidden flex flex-col bg-background text-foreground">
    <output data-testid="navigation">{state.activePaperId}:{state.activeTab}</output>
    {parallel && <Header />}
    <nav className="flex gap-4 p-2 border-b">
      <button onClick={() => state.setActiveTab("references")}>論文マップタブ</button>
      <button onClick={() => state.setActiveTab("chat")}>チャットタブ</button>
      {parallel && <button onClick={() => state.setActiveTab("summary")}>サマリータブ</button>}
      <button onClick={() => openSettings("connection")}>設定タブ</button>
    </nav>
    <ReferenceReturnBar />
    {settingsOpen && <SettingsFixture />}
    {state.activeTab === "references" ? <Tabs value="references" className="flex-1 flex flex-col min-h-0 gap-0"><div className="relative flex-1 flex flex-col min-h-0"><TabsContent value="references" className="flex-1 p-0 m-0 overflow-hidden outline-none flex data-hidden:hidden min-h-0"><ReferencesPane /></TabsContent></div></Tabs> : state.activeTab === "chat" || (state.activeTab === "reader" && state.sidePanel === "chat")
      ? <ChatPane /> : state.activeTab === "summary" && parallel ? <SummaryPane /> : <p className="p-8">{state.activeTab === "summary" ? "サマリー本文" : "PDF本文"}</p>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={query}><Fixture /></QueryClientProvider>);

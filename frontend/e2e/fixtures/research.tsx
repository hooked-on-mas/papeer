import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReferencesPane } from "../../src/features/references/ReferencesPane";
import { ReferenceReturnBar } from "../../src/features/references/researchNavigation";
import { ChatPane } from "../../src/features/chat/ChatPane";
import { useJobEvents } from "../../src/features/jobs/jobEvents";
import { registerJobHandlers } from "../../src/features/jobs/jobHandlers";
import { researchJobHandlers } from "../../src/features/references/researchJobs";
import { chatJobHandlers } from "../../src/features/chat/chatJobs";
import { useStore } from "../../src/store";
import "../../src/index.css";

const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
registerJobHandlers({ ...researchJobHandlers, ...chatJobHandlers });
useStore.setState({ activePaperId: "a".repeat(32), activeTab: "references" });
function Fixture() {
  useJobEvents();
  const state = useStore();
  return <div className="h-screen flex flex-col bg-background text-foreground">
    <output data-testid="navigation">{state.activePaperId}:{state.activeTab}</output>
    <nav className="flex gap-4 p-2 border-b">
      <button onClick={() => state.setActiveTab("references")}>参考文献タブ</button>
      <button onClick={() => state.setActiveTab("chat")}>チャットタブ</button>
    </nav>
    <ReferenceReturnBar />
    {state.activeTab === "references" ? <ReferencesPane /> : state.activeTab === "chat" || (state.activeTab === "reader" && state.sidePanel === "chat")
      ? <ChatPane /> : <p className="p-8">{state.activeTab === "summary" ? "サマリー本文" : "PDF本文"}</p>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={query}><Fixture /></QueryClientProvider>);

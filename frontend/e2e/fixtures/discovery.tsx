import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReferencesPane } from "../../src/features/references/ReferencesPane";
import { useJobEvents } from "../../src/features/jobs/jobEvents";
import { registerJobHandlers } from "../../src/features/jobs/jobHandlers";
import { researchJobHandlers } from "../../src/features/references/researchJobs";
import { useStore } from "../../src/store";
import "../../src/index.css";
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
registerJobHandlers(researchJobHandlers);
useStore.setState({ activePaperId: new URLSearchParams(window.location.search).get("paper") ?? "a".repeat(32), activeTab: "references" });
function Fixture() {
  useJobEvents();
  const state = useStore();
  return <div className="h-screen flex flex-col overflow-hidden bg-background text-foreground">
    <button onClick={() => state.setActiveTab(state.activeTab === "references" ? "reader" : "references")}>タブを切り替える</button>
    {state.activeTab === "references" ? <ReferencesPane /> : <p>PDF閲覧中</p>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={query}><Fixture /></QueryClientProvider></StrictMode>);

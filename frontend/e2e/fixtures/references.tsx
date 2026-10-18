import { createRoot } from "react-dom/client";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReferencesPane } from "../../src/features/references/ReferencesPane";
import { ReferenceReturnBar } from "../../src/features/references/researchNavigation";
import { useStore } from "../../src/store";
import "../../src/index.css";

const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
useStore.setState({ activePaperId: new URLSearchParams(window.location.search).get("paper") ?? "a", activeTab: "references" });
function Fixture() {
  const state = useStore();
  const [instance, setInstance] = useState(0);
  return <QueryClientProvider client={query}><div className="h-screen overflow-hidden flex flex-col bg-background text-foreground">
    <output data-testid="navigation">{state.activePaperId}:{state.activeTab}:{state.currentPage}</output>
    <button onClick={() => setInstance(value => value + 1)}>パネルを開き直す</button>
    <button onClick={() => state.setActiveTab("references")}>論文マップタブ</button>
    <ReferenceReturnBar />
    {state.activeTab === "references" && <ReferencesPane key={instance} />}
  </div></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

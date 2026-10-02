import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReferencesPane } from "../../src/features/references/ReferencesPane";
import { useStore } from "../../src/store";
import "../../src/index.css";

const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
useStore.setState({ activePaperId: "a", activeTab: "references" });
function Fixture() {
  const state = useStore();
  return <QueryClientProvider client={query}><div className="h-screen flex flex-col bg-background text-foreground">
    <output data-testid="navigation">{state.activePaperId}:{state.activeTab}:{state.currentPage}</output>
    <ReferencesPane />
  </div></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

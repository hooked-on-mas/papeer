import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TermFeedback } from "../../src/features/reader/TermFeedback";
import { useJobEvents } from "../../src/features/jobs/jobEvents";
import { registerJobHandlers } from "../../src/features/jobs/jobHandlers";
import { translationJobHandlers } from "../../src/features/reader/translationJobs";
import { useStore } from "../../src/store";
import "../../src/index.css";

const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
query.setQueryData(["settings"], { provider: "codex", model: "test", reasoning_effort: "" });
query.setQueryData(["providers"], [{ id: "codex", label: "Test", web_search: true }]);
registerJobHandlers(translationJobHandlers);
useStore.setState({ activePaperId: "driving", activeTab: "reader" });
function Fixture() {
  useJobEvents();
  return <main className="max-w-3xl mx-auto p-4"><TermFeedback paperId="driving" selection={{ side: "translated", text: "ポリシー" }} /></main>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={query}><Fixture /></QueryClientProvider>);

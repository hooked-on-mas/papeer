import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TranslationDialog } from "../../src/features/reader/TranslationDialog";
import { useGlossaryDrafts } from "../../src/features/reader/glossaryDraft";
import { AppDialogs } from "../../src/components/AppDialogs";
import "../../src/index.css";

const paper = "driving";
const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
const shared = [{ source: "slope", target: "法面", domain: "ロボティクス・建設機械" },
  { source: "trajectory", target: "軌道", domain: "ロボティクス・建設機械" }];
query.setQueryData(["glossary"], shared);
query.setQueryData(["paper-glossary", paper], { terms: [], dismissed: [] });
query.setQueryData(["glossary-domains", paper], { domains: ["ロボティクス・建設機械"], new_domain: "自動車の自動運転",
  chosen_by: "ai", known_domains: ["ロボティクス・建設機械"], available: ["ロボティクス・建設機械"], stale: false,
  split_at: 150, scope_terms: [shared[1]], scope_stale: false, selection_key: "checked" });
query.setQueryData(["settings"], { provider: "codex", model: "test", reasoning_effort: "" });
query.setQueryData(["providers"], [{ id: "codex", label: "Test" }]);
query.setQueryData(["models", "codex", null], []);
query.setQueryData(["efforts", "codex", "test", null], []);
query.setQueryData(["reading", paper], { page_count: 1, source_page_count: 1, preview: null, completed_pages: [], empty_pages: [] });
query.setQueryData(["ink-pages", paper], []);
query.setQueryData(["translation-plan", paper, "", ""], { model: "test", selected_pages: [1], reusable_pages: [],
  pending_pages: [1], retranslated_pages: [], previous_models: [], needs_ai: true });
useGlossaryDrafts.setState({ drafts: { [paper]: { status: "done", jobId: "draft", terms: [
  { source: "motion primitive", target: "動作プリミティブ", reason: "基本動作の単位を表すため、表記を確認します。", context: "The planner chooses a motion primitive." },
  { source: "driving policy", target: "運転方策", reason: "規則と学習された方策で意味が異なります。", context: "The learned driving policy is evaluated." },
] } } });

function Fixture() {
  const [open, setOpen] = useState(true);
  return <QueryClientProvider client={query}><button onClick={() => setOpen(true)}>設定を再度開く</button>
    <TranslationDialog open={open} onOpenChange={setOpen} paperId={paper} currentPage={1} /><AppDialogs /></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

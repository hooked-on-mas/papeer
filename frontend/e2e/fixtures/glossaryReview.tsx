import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Header, TranslationDialogHost } from "../../src/app/Header";
import { useStore } from "../../src/store";
import { useGlossaryDrafts } from "../../src/features/reader/glossaryDraft";
import { AppDialogs } from "../../src/components/AppDialogs";
import type { Term } from "../../src/features/reader/translationStart";
import "../../src/index.css";

const paper = "driving";
const query = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
const parameters = new URLSearchParams(location.search);
const provenance = parameters.has("provenance");
const shared: Term[] = [{ source: "slope", target: "法面", domain: "ロボティクス・建設機械" },
  { source: "trajectory", target: "軌道", domain: "ロボティクス・建設機械" }];
if (provenance) shared.push({ source: "control", target: "制御" },
  { source: "cell", target: "細胞", domain: "生物" }, { source: "cell", target: "セル", domain: "電池" });
query.setQueryData(["glossary"], shared);
query.setQueryData(["paper-glossary", paper], { terms: provenance ? [{ source: "control", target: "制御入力" }] : [], dismissed: [] });
const available = provenance ? ["ロボティクス・建設機械", "生物", "電池"] : ["ロボティクス・建設機械"];
query.setQueryData(["glossary-domains", paper], { domains: provenance ? ["ロボティクス・建設機械", "電池"] : ["ロボティクス・建設機械"], new_domain: provenance ? null : "自動車の自動運転",
  chosen_by: "ai", known_domains: available, available, stale: false,
  split_at: 150, scope_terms: provenance ? [shared[1], shared[4]] : [shared[1]], scope_stale: parameters.has("stale"), selection_key: "checked" });
query.setQueryData(["settings"], { provider: "codex", model: "test", reasoning_effort: "" });
query.setQueryData(["papers", paper], { id: paper, title: "Driving Policy", pages: 1, translated_count: 0 });
query.setQueryData(["providers"], [{ id: "codex", label: "Test" }]);
query.setQueryData(["models", "codex", null], []);
query.setQueryData(["efforts", "codex", "test", null], []);
query.setQueryData(["reading", paper], { page_count: 1, source_page_count: 1, preview: null, completed_pages: [], empty_pages: [] });
query.setQueryData(["ink-pages", paper], []);
query.setQueryData(["translation-plan", paper, "", ""], { model: "test", selected_pages: [1], reusable_pages: [],
  pending_pages: [1], retranslated_pages: [], previous_models: [], needs_ai: true });
if (!parameters.has("noDraft") && !provenance) useGlossaryDrafts.setState({ drafts: { [paper]: { status: "done", jobId: "draft", terms: [
  { source: "motion primitive", target: "動作プリミティブ", reason: "基本動作の単位を表すため、表記を確認します。", context: "The planner chooses a motion primitive." },
  { source: "driving policy", target: "運転方策", reason: "規則と学習された方策で意味が異なります。", context: "The learned driving policy is evaluated." },
] } } });

function Fixture() {
  return <QueryClientProvider client={query}><Header /><TranslationDialogHost /><AppDialogs /></QueryClientProvider>;
}
useStore.setState({ activePaperId: paper, currentPage: 1, uiStateLoaded: true });
createRoot(document.getElementById("root")!).render(<Fixture />);

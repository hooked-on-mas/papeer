import { create } from "zustand";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";

export const useReferenceReturn = create<{ source: string | null }>(() => ({ source: null }));

export function openReferencePaper(source: string, target: string, summary = false) {
  const store = useStore.getState();
  const view = store.activePaperId ? referenceViews.get(store.activePaperId) : undefined;
  const center = view?.trail[view.trail.length - 1] ?? store.activePaperId;
  const origin = store.activeTab === "references" && center === source ? store.activePaperId ?? source : source;
  if (origin !== target) useReferenceReturn.setState({ source: origin });
  store.setActivePaperId(target);
  store.setFocusMode(false);
  store.setActiveTab(summary ? "summary" : "reader");
}

export function ReferenceReturnBar() {
  const source = useReferenceReturn(s => s.source);
  const active = useStore(s => s.activePaperId);
  if (!source || source === active) return null;
  return <div className="border-b px-4 py-1.5 bg-muted/30">
    <Button variant="ghost" size="sm" onClick={() => {
      const store = useStore.getState();
      store.setActivePaperId(source);
      store.setActiveTab("references");
      useReferenceReturn.setState({ source: null });
    }}><ArrowLeft /> 元の論文の参考文献へ戻る</Button>
  </div>;
}

/** The reference tab remounts after reading its target; keep its selected neighbourhood. */
export const referenceViews = new Map<string, {
  trail: string[]; selectedId: string | null; scope: "nearby" | "library"; external: boolean;
  search: string; listMode: "references" | "incoming" | "related"; zoom: number; referenceId?: string;
  sort?: "original" | "newest" | "cited"; graphMode?: "citations" | "similarity";
  detailsOpen?: boolean; listScroll?: number; graphScroll?: { top: number; left: number };
}>();

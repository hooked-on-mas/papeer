import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "./client";
import { invalidate } from "./mutations";
import { QK } from "@/lib/queryKeys";
import { showError } from "@/components/errorDialog";

export function useItemLinks() {
  return useQuery({ queryKey: [QK.itemLinks], queryFn: () => unwrap(api.GET("/api/item-links")), retry: false });
}

export function useLinkedItems(owner: string) {
  return useQuery({ queryKey: [QK.linkedItems, owner], enabled: !!owner,
    queryFn: () => unwrap(api.GET("/api/papers/{paper_id}/links", { params: { path: { paper_id: owner } } })), retry: false });
}

export async function linkPapers(ids: readonly string[], notebook: string): Promise<boolean> {
  try {
    for (const paper_id of ids) await unwrap(api.POST("/api/papers/{paper_id}/links", {
      params: { path: { paper_id } }, body: { target_id: notebook } }));
    return true;
  } catch (error) { showError(error, "紐づけできませんでした"); return false; }
  finally { await invalidate({ kind: "library" }); }
}

export async function removeItemLink(paper_id: string, target_id: string): Promise<void> {
  try { await unwrap(api.DELETE("/api/papers/{paper_id}/links/{target_id}", { params: { path: { paper_id, target_id } } })); }
  catch (error) { showError(error, "紐づけを外せませんでした"); }
  finally { await invalidate({ kind: "library" }); }
}

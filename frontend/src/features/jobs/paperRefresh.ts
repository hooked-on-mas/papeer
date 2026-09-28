import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { ApiError } from "@/api/client";
import { getPaper, type PaperData } from "@/api/hooks";
import { requestPaperRefresh, type PaperChanges } from "@/lib/libraryRefresh";
import { paperChangeEffects, withPaperRow } from "@/lib/paperRows";
import { QK } from "@/lib/queryKeys";

/**
 * One paper changed: load it (GET /api/papers/{id}) and put its row into the loaded library lists,
 * rather than loading every list again. The paper's own query is refreshed as any change refreshed it before.
 */
export async function refreshPaper(queryClient: QueryClient, paperId: string): Promise<void> {
  void queryClient.invalidateQueries({ queryKey: [QK.papers, paperId] });
  const lists = queryClient.getQueriesData<PaperData[]>({ queryKey: [QK.papers, "list"] });
  if (!lists.length) return;
  let paper: PaperData | null;
  try {
    paper = await getPaper(paperId);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) {
      void queryClient.invalidateQueries({ queryKey: [QK.papers, "list"] });
      return;
    }
    paper = null; // Removed meanwhile.
  }
  // Read again: a list may have loaded meanwhile.
  for (const [key, rows] of queryClient.getQueriesData<PaperData[]>({ queryKey: [QK.papers, "list"] })) {
    if (!rows) continue;
    // A list still loading may answer with the row as it was before: load it again instead (the
    // running request is cancelled), rather than have that answer replace the row set here.
    if (queryClient.getQueryState(key)?.fetchStatus === "fetching") {
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
      continue;
    }
    const [, , query, sort] = key as QueryKey & [string, string, unknown, unknown];
    const next = withPaperRow(rows, paperId, paper, String(query ?? ""), Number(sort ?? 0));
    if (next === null) void queryClient.invalidateQueries({ queryKey: key, exact: true });
    else if (next !== rows) queryClient.setQueryData(key, next);
  }
}

/**
 * A paper.changed event (sidecar/deps.py, paper_changed): reloaded with the others that come in quick
 * succession, and not while an action on several papers runs, which sends one per paper (libraryRefresh.ts).
 */
export function handlePaperChanged(queryClient: QueryClient, paperId: string, fields: string[] | undefined): void {
  requestPaperRefresh(paperId, paperChangeEffects(fields), (changes) => refreshPapers(queryClient, changes));
}

/** Reloads the papers changed together: their rows, or with many, the lists (and each paper's own query) as a whole. */
function refreshPapers(queryClient: QueryClient, changes: PaperChanges): void {
  if (changes.rows === "all") void queryClient.invalidateQueries({ queryKey: [QK.papers] });
  else for (const paperId of changes.rows) void refreshPaper(queryClient, paperId);
  if (changes.collections) void queryClient.invalidateQueries({ queryKey: [QK.collections] });
  if (changes.tags) void queryClient.invalidateQueries({ queryKey: [QK.tags] });
  void queryClient.invalidateQueries({ queryKey: [QK.librarySearch] });
}

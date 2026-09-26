import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { QK } from "@/lib/queryKeys";

/** Choices offered for paper tags, sticky-note labels and reading statuses, editable in the settings. */
export type TagKind = "paper" | "sticky" | "status";
export const DEFAULT_READING_STATUSES = ["未読", "読書中", "読了", "再読したい"];
export const DEFAULT_STICKY_LABELS = ["重要", "疑問", "あとで確認", "引用", "確認済み"];
export const tagChoicesEndpoint = (kind: TagKind) => kind === "paper" ? "/api/tags" : kind === "status" ? "/api/reading-statuses" : "/api/sticky-labels";
export function useTagChoices(kind: TagKind) {
  const query = useQuery({ queryKey: [kind === "paper" ? QK.tags : kind === "status" ? QK.readingStatuses : QK.stickyLabels], queryFn: () => apiRequest<string[]>("GET", tagChoicesEndpoint(kind)) });
  // Missing data is not an empty saved list. Keep the defaults while loading or offline,
  // but respect an explicitly saved empty list when every choice was deleted.
  const defaults = kind === "status" ? DEFAULT_READING_STATUSES : kind === "sticky" ? DEFAULT_STICKY_LABELS : undefined;
  return { ...query, data: query.data ?? defaults };
}

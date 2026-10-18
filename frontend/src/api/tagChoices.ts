import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "./client";
import { QK } from "@/lib/queryKeys";

/** Choices offered for paper tags, sticky-note labels and reading statuses, editable in the settings. */
export type TagKind = "paper" | "sticky" | "status";
export const DEFAULT_READING_STATUSES = ["未読", "読書中", "読了", "再読したい"];
export const DEFAULT_STICKY_LABELS = ["重要", "疑問", "あとで確認", "引用", "確認済み"];
const ENDPOINTS = { paper: "/api/tags", status: "/api/reading-statuses", sticky: "/api/sticky-labels" } as const;
/** GET lists the choices, POST adds one, DELETE ?name= deletes one. */
export const tagChoicesEndpoint = (kind: TagKind) => ENDPOINTS[kind];
export function useTagChoices(kind: TagKind) {
  const query = useQuery({ queryKey: [kind === "paper" ? QK.tags : kind === "status" ? QK.readingStatuses : QK.stickyLabels],
    queryFn: async () => await unwrap(api.GET(tagChoicesEndpoint(kind))) as string[] });
  // Missing data is not an empty saved list. Keep the defaults while loading or offline,
  // but respect an explicitly saved empty list when every choice was deleted.
  const defaults = kind === "status" ? DEFAULT_READING_STATUSES : kind === "sticky" ? DEFAULT_STICKY_LABELS : undefined;
  return { ...query, data: query.data ?? defaults };
}

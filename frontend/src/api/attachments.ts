import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api, unwrap } from "./client";
import type { components } from "./schema";
import { QK } from "@/lib/queryKeys";

export type Attachment = components["schemas"]["Attachment"];
export type MemoContent = components["schemas"]["MemoContent"];
export const memoPath = (paper_id: string, attachment_id: string) => ({ paper_id, attachment_id });

export function useAttachments(owner?: string) {
  return useQuery({ queryKey: [QK.attachments, owner ?? "all"],
    queryFn: () => owner
      ? unwrap(api.GET("/api/papers/{paper_id}/attachments", { params: { path: { paper_id: owner } } }))
      : unwrap(api.GET("/api/attachments")), retry: false });
}

export function useMemoContent(owner: string, id: string) {
  return useQuery({ queryKey: [QK.memo, owner, id], enabled: !!id, retry: false,
    queryFn: () => unwrap(api.GET("/api/papers/{paper_id}/attachments/{attachment_id}", { params: { path: memoPath(owner, id) } })) });
}

export async function refreshAttachments(client: QueryClient) {
  await Promise.all([client.invalidateQueries({ queryKey: [QK.attachments] }),
    client.invalidateQueries({ queryKey: [QK.papers] })]);
}

export async function createMemo(owner: string, title = "メモ.md", content = "", source: "user" | "imported" = "user") {
  return unwrap(api.POST("/api/papers/{paper_id}/attachments", { params: { path: { paper_id: owner } }, body: { title, content, source } }));
}

export async function importMemoPaths(owner: string, paths: string[], client: QueryClient) {
  try {
    return await unwrap(api.POST("/api/papers/{paper_id}/attachments/import", { params: { path: { paper_id: owner } }, body: { paths } }));
  } finally { await refreshAttachments(client); }
}

export async function importMemoFiles(owner: string, files: File[], client: QueryClient) {
  if (files.some(file => !file.name.toLowerCase().endsWith(".md"))) throw new Error("メモには .md ファイルをドロップしてください。");
  const contents = await Promise.all(files.map(async file => ({ title: file.name,
    content: new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()) })));
  const added = [];
  try { for (const file of contents) added.push(await createMemo(owner, file.title, file.content, "imported")); }
  finally { await refreshAttachments(client); }
  return added;
}

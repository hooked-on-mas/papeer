import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api, unwrap } from "./client";
import { createMemo, refreshAttachments, type Attachment } from "./attachments";
import { QK } from "@/lib/queryKeys";

export function useDocumentInfo(owner: string, id: string) {
  return useQuery({ queryKey: [QK.htmlDocument, owner, id], enabled: !!id, retry: false,
    queryFn: () => unwrap(api.GET("/api/papers/{paper_id}/documents/{attachment_id}", { params: { path: { paper_id: owner, attachment_id: id } } })) });
}
export function createDocument(owner: string, title: string, content: string) {
  return unwrap(api.POST("/api/papers/{paper_id}/documents", { params: { path: { paper_id: owner } }, body: { title, content, source: "imported" } }));
}
export function documentView(owner: string, id: string, content_hash: string, allow_scripts: boolean) {
  return unwrap(api.POST("/api/papers/{paper_id}/documents/{attachment_id}/view", { params: { path: { paper_id: owner, attachment_id: id } }, body: { content_hash, allow_scripts } }));
}
export async function importAttachmentFiles(owner: string, files: File[], client: QueryClient) {
  if (files.some(file => !/\.(md|html)$/i.test(file.name))) throw new Error(".md または .html ファイルをドロップしてください。");
  const contents = await Promise.all(files.map(async file => ({ title: file.name,
    content: new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()) })));
  const rows: Attachment[] = [];
  try { for (const file of contents) rows.push(file.title.toLowerCase().endsWith(".html")
    ? await createDocument(owner, file.title, file.content) : await createMemo(owner, file.title, file.content, "imported")); }
  finally { await refreshAttachments(client); }
  return rows;
}

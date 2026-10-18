import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Maximize2, Minimize2, Pencil, Trash2, Upload } from "lucide-react";
import { api, backendUrl, unwrap } from "@/api/client";
import { importMemoPaths, memoPath, refreshAttachments, useAttachments, type Attachment } from "@/api/attachments";
import { documentView, importAttachmentFiles, useDocumentInfo } from "@/api/documents";
import { askConfirm, askText } from "@/components/AppDialogs";
import { showError } from "@/components/errorDialog";
import { shell } from "@/shell";
import { enlargeDocument, selectDocument, shrinkDocument, useDocumentState } from "./documentState";
import { scriptPermission, setScriptPermission } from "./documentPermissions";
import { reorderedAttachments } from "./attachmentOrder";
import { chooseDocument } from "./documentSelection";

const button = "inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40";
export function DocumentsPane({ owner, enlarged = false }: { owner: string; enlarged?: boolean }) {
  const client = useQueryClient();
  const { data, isError, refetch } = useAttachments(owner);
  const documents = data?.filter(row => row.format === "html") ?? [];
  const selected = useDocumentState(s => s.selected[owner]);
  const choice = chooseDocument(data && documents, selected);
  const current = choice.kind === "document" ? choice.document : undefined;
  const missing = choice.kind === "missing" ? choice.id : undefined;
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await action(); } catch (error) { showError(error, "資料を更新できませんでした"); } finally { setBusy(false); }
  };
  const importPaths = async () => {
    const paths = await shell.openFiles([{ name: "HTML 資料", extensions: ["html"] }]);
    if (!paths.length) return;
    const rows = await importMemoPaths(owner, paths, client);
    if (rows[0]) selectDocument(owner, rows[0].id);
  };
  const rename = async () => {
    if (!current) return;
    const title = await askText("資料の名前を変更", "名前", current.title);
    if (title === null) return;
    await unwrap(api.PATCH("/api/papers/{paper_id}/attachments/{attachment_id}", { params: { path: memoPath(owner, current.id) }, body: { title } }));
    await refreshAttachments(client);
  };
  const remove = async () => {
    if (!current || !await askConfirm("資料を削除", `「${current.title}」を削除します。`, "削除する", true)) return;
    await unwrap(api.DELETE("/api/papers/{paper_id}/attachments/{attachment_id}", { params: { path: memoPath(owner, current.id) } }));
    setScriptPermission(current.id, "", false);
    selectDocument(owner, documents.find(row => row.id !== current.id)?.id ?? "");
    await refreshAttachments(client);
  };
  const reorder = async (direction: number) => {
    if (!current || !data) return;
    await unwrap(api.PUT("/api/papers/{paper_id}/attachments/order", { params: { path: { paper_id: owner } }, body: { ids: reorderedAttachments(data, current.id, direction) } }));
    await refreshAttachments(client);
  };
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background" data-memo-owner={owner} data-html-owner={owner} aria-busy={busy}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); } }}
    onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); event.stopPropagation();
      const files = Array.from(event.dataTransfer.files);
      void run(async () => { const rows = await importAttachmentFiles(owner, files, client); const html = rows.find(row => row.format === "html"); if (html) selectDocument(owner, html.id); }); }}>
    <div className="flex flex-wrap items-center gap-1.5 border-b p-2">
      <span className="text-sm font-semibold">資料{documents.length ? ` (${documents.length})` : ""}</span>
      <button className={button} disabled={busy || !data} onClick={() => void run(importPaths)}><Upload className="size-3" />資料を追加</button>
      <button className={button} disabled={busy || (!enlarged && !current)} onClick={() => enlarged ? shrinkDocument(owner) : enlargeDocument(owner)}>
        {enlarged ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}{enlarged ? "右パネルに戻す" : "大きく開く"}</button>
      {!!documents.length && <div className="flex w-full min-w-0 flex-wrap items-center gap-1">
        <select aria-label="資料を選択" className="min-w-0 flex-1 rounded border bg-background p-1 text-sm" value={current?.id ?? missing ?? ""} disabled={busy} onChange={e => selectDocument(owner, e.target.value)}>
          {missing && <option value={missing} disabled>（見つからない資料）</option>}
          {documents.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}
        </select>
        <button className={button} disabled={busy || !current} aria-label="資料の名前を変更" onClick={() => void run(rename)}><Pencil className="size-3" /></button>
        <button className={button} disabled={busy || !current || current.id === documents[0]?.id} aria-label="資料を前へ" onClick={() => void run(() => reorder(-1))}><ArrowUp className="size-3" /></button>
        <button className={button} disabled={busy || !current || current.id === documents[documents.length - 1]?.id} aria-label="資料を後ろへ" onClick={() => void run(() => reorder(1))}><ArrowDown className="size-3" /></button>
        <button className={button} disabled={busy || !current} aria-label="資料を削除" onClick={() => void run(remove)}><Trash2 className="size-3" /></button>
      </div>}
    </div>
    <p className="px-3 py-1 text-xs text-muted-foreground">HTML の表示専用です。画像は埋め込み形式、外部通信は使えません。</p>
    {isError ? <div role="alert" className="p-3 text-sm">資料を読み込めませんでした。<button onClick={() => void refetch()}>再読み込み</button></div>
      : choice.kind === "document" ? <DocumentFrame key={choice.document.id} document={choice.document} />
        : choice.kind === "missing" ? <p role="status" className="p-4 text-sm text-muted-foreground">
          {documents.length ? "資料が見つかりません。削除されたか、移動した可能性があります。上の一覧から開く資料を選んでください。"
            : "資料が見つかりません。削除された可能性があります。「資料を追加」で .html ファイルを取り込めます。"}</p>
          : <p className="p-4 text-sm text-muted-foreground">{choice.kind === "empty" ? "「資料を追加」で .html ファイルを取り込んでください。" : "資料を読み込み中…"}</p>}
  </div>;
}

function DocumentFrame({ document }: { document: Attachment }) {
  const { data, isError, refetch } = useDocumentInfo(document.owner_id, document.id);
  const hash = data?.content_hash;
  const [permission, setPermission] = useState<{ hash: string; allowed: boolean } | null>(null);
  const allowed = !!hash && (permission?.hash === hash ? permission.allowed : scriptPermission(document.id, hash));
  const [frame, setFrame] = useState<{ key: string; path?: string; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const key = `${hash}:${allowed}:${retry}`;
  useEffect(() => {
    if (!hash) return;
    let live = true;
    void documentView(document.owner_id, document.id, hash, allowed).then(value => { if (live) setFrame({ key, path: value.path }); })
      .catch(error => { if (live) setFrame({ key, error: String(error) }); });
    return () => { live = false; };
  }, [document.owner_id, document.id, hash, allowed, key]);
  const toggle = async () => {
    if (!hash) return;
    const next = !allowed;
    if (next && !await askConfirm("資料内の動きを許可", "この資料のボタンや図を動かします。外部通信やアプリの操作は許可しません。信頼できる資料にだけ許可してください。", "この資料に許可")) return;
    try { setScriptPermission(document.id, hash, next); setPermission({ hash, allowed: next }); }
    catch (error) { showError(error, "この PC に許可を保存できませんでした"); }
  };
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1 text-xs">
      <label className="flex items-center gap-1"><input type="checkbox" checked={allowed} disabled={!hash} onChange={() => void toggle()} />この資料のスクリプトを許可</label>
      <button className={button} onClick={() => { setRetry(value => value + 1); void refetch(); }}>再読み込み</button>
    </div>
    {isError || frame?.key === key && frame.error ? <div role="alert" className="p-3 text-sm">資料を表示できませんでした。再読み込みしてください。</div>
      : frame?.key === key && frame.path ? <iframe key={key} title={document.title} src={backendUrl(frame.path)} sandbox={allowed ? "allow-scripts" : ""}
        referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 border-0 bg-white" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" />
        : <p role="status" className="p-3 text-sm">資料を読み込み中…</p>}
  </div>;
}

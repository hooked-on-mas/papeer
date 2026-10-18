import { useEffect, useRef, useState } from "react";
import { openDocument } from "@/features/documents/documentState";
import { create } from "zustand";
import { NotebookPen } from "lucide-react";
import { api, unwrap } from "@/api/client";
import { useCollections, usePaperList, type PaperData } from "@/api/hooks";
import { invalidate } from "@/api/mutations";
import { askConfirm } from "@/components/AppDialogs";
import { showError } from "@/components/errorDialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStore } from "@/store";
import { openPaper } from "@/features/library/selectionStore";
import { expandMemoOwner, openMemo } from "@/features/notes/memoState";
import { useAttachments } from "@/api/attachments";
import { useLinkedItems } from "@/api/itemLinks";
import { paperDisplayName } from "@/api/hooks";
import { emitAppEvent } from "@/lib/appEvents";
import { normalizeCollection } from "@/lib/collectionPath";
import { DEFAULT_PAPER, useNotebooks, type NotebookPaper } from "./notebooks";
import { defaultNotebookTitle } from "./paperSpec";
import { PaperSettings } from "./PaperSettings";

type Request = { kind: "create"; owner?: PaperData; collection: string; serial: number } | { kind: "move"; item: PaperData } | { kind: "holdings"; owner: PaperData; includeLinks: boolean }
  | { kind: "delete"; message: string; children: PaperData[]; resolve: (keep: boolean | null) => void };
const useDialog = create<{ request: Request | null }>(() => ({ request: null }));
let creations = 0;
/**
 * Opens the dialog that makes a notebook: held by `owner` (a 専用ノート, which is in its owner's folder), else in
 * `collection` (a folder's path, "" for 未分類), by default the folder new PDFs go into.
 */
export const newNotebook = ({ owner, collection }: { owner?: PaperData; collection?: string } = {}) =>
  useDialog.setState({ request: { kind: "create", owner, collection: normalizeCollection(collection ?? useStore.getState().currentCollection), serial: ++creations } });
export const moveNotebook = (item: PaperData) => useDialog.setState({ request: { kind: "move", item } });
export const showHoldings = (owner: PaperData, includeLinks = true) => useDialog.setState({ request: { kind: "holdings", owner, includeLinks } });

export async function confirmItemDeletion(ids: string[], message: string): Promise<{ keep: boolean; children: PaperData[] } | null> {
  const notebooks = await unwrap(api.GET("/api/notebooks"));
  const children = notebooks.filter(row => row.parent_id && ids.includes(row.parent_id));
  if (!children.length) return await askConfirm("削除の確認", message, "削除", true) ? { keep: false, children } : null;
  const keep = await new Promise<boolean | null>(resolve => useDialog.setState({ request: { kind: "delete", message, children, resolve } }));
  return keep === null ? null : { keep, children };
}

const NO_COLLECTIONS: string[] = [];
const NO_PAPERS: PaperData[] = [];

/**
 * The form that makes a notebook. Mounted afresh for each opening (the dialog's `serial`), so that its name,
 * folder and paper start from the defaults: the name 「ノート 10/17」 (with a number when the folder has it),
 * selected so that typing replaces it, the folder it was asked for, and the paper of the notebook made last.
 */
function CreateNotebookForm({ request, busy, setBusy, close }: {
  request: Extract<Request, { kind: "create" }>; busy: boolean; setBusy: (busy: boolean) => void; close: () => void;
}) {
  const { owner } = request;
  const { data: notebooks = NO_PAPERS } = useNotebooks();
  const { data: folders = NO_COLLECTIONS } = useCollections();
  const [destination, setDestination] = useState(request.collection);
  const [paper, setPaper] = useState<NotebookPaper>(() => useStore.getState().lastNotebookPaper ?? DEFAULT_PAPER);
  const [today] = useState(() => new Date());
  // What was typed, once something was; until then the name follows the folder chosen.
  const [typed, setTyped] = useState<string | null>(null);
  const taken = notebooks.filter(row => owner ? row.parent_id === owner.id : !row.parent_id && normalizeCollection(row.collection_name || "") === destination).map(row => row.title);
  const title = typed ?? defaultNotebookTitle(today, taken);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
    return () => cancelAnimationFrame(frame);
  }, []);
  const choices = ["", ...folders.filter(path => path !== "")];
  if (!choices.includes(destination)) choices.push(destination);
  const submit = async () => {
    if (busy || !title.trim()) return;
    setBusy(true);
    try {
      const row = await unwrap(api.POST("/api/notebooks", { body: { ...paper, title, parent_id: owner?.id ?? null, collection: destination } }));
      useStore.getState().setLastNotebookPaper(paper);
      await invalidate({ kind: "library" });
      const store = useStore.getState();
      // A search replaces the tree with its hits, which the new notebook is not among.
      store.setLibrarySearch("");
      store.setActiveTab("reader");
      if (owner) expandMemoOwner(owner.id, true);
      openPaper(row.id, normalizeCollection(owner?.collection_name ?? row.collection_name));
      // The library may not list the notebook yet: its tree waits for it (LibrarySidebar).
      emitAppEvent("reveal-paper", { paperId: row.id, focus: false });
      useDialog.setState({ request: null });
    } catch (error) { showError(error); } finally { setBusy(false); }
  };
  return <form onSubmit={e => { e.preventDefault(); void submit(); }} className="space-y-4">
    <label className="block text-sm">ノート名<Input ref={input} aria-label="ノート名" value={title} maxLength={200} onChange={e => setTyped(e.target.value)} disabled={busy} autoFocus /></label>
    {owner ? <p className="text-sm">持ち主：<span className="font-medium">{owner.title}</span></p>
      : <label className="flex items-center gap-2 text-sm">作成先：
        <select aria-label="作成先" value={destination} onChange={e => setDestination(e.target.value)} disabled={busy} className="border rounded p-1 min-w-0 flex-1 bg-background">
          {choices.map(path => <option key={path || "(unfiled)"} value={path}>{path || "未分類"}</option>)}
        </select></label>}
    <fieldset disabled={busy}><PaperSettings value={paper} onChange={setPaper} /></fieldset>
    <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={close} disabled={busy}>キャンセル</Button><Button type="submit" disabled={busy || !title.trim()}>{busy ? "作成中…" : "作成"}</Button></div>
  </form>;
}

export function NotebookDialogs() {
  const request = useDialog(s => s.request);
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (request?.kind === "move") setDestination(request.item.parent_id ?? ""); }, [request]);
  const { data: papers = [] } = usePaperList("", 0);
  const { data: notebooks = [] } = useNotebooks();
  const { data: attachments = [] } = useAttachments();
  const { data: linked = [], isError: linksError, refetch: reloadLinks } = useLinkedItems(request?.kind === "holdings" && request.includeLinks ? request.owner.id : "");
  const close = () => {
    if (busy) return;
    if (request?.kind === "delete") request.resolve(null);
    useDialog.setState({ request: null });
  };
  const submit = async () => {
    if (!request || busy) return;
    setBusy(true);
    try {
      if (request.kind === "move") {
        await unwrap(api.POST("/api/notebooks/{notebook_id}/placement", { params: { path: { notebook_id: request.item.id } }, body: { parent_id: destination || null, collection: useStore.getState().currentCollection } }));
        if (destination) {
          const owner = papers.find(row => row.id === destination);
          if (owner) { useStore.getState().setCurrentCollection(owner.collection_name); expandMemoOwner(owner.id, true); }
        }
        await invalidate({ kind: "library" });
      }
      useDialog.setState({ request: null });
    } catch (error) { showError(error); } finally { setBusy(false); }
  };
  return <Dialog open={!!request} onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader><DialogTitle>{request?.kind === "create" ? request.owner ? "専用ノートを作る" : "ノートを作る" : request?.kind === "move" ? "ノートの持ち主を変更" : request?.kind === "delete" ? "持ち物も削除されます" : "持ち物"}</DialogTitle>
        <DialogDescription>{request?.kind === "create" ? request.owner ? `「${request.owner.title}」の持ち物として作ります。` : "用紙を選んで手書きを始めます。" : request?.kind === "delete" ? request.message : "専用ノートは中央で、メモは右パネルで開きます。"}</DialogDescription>
      </DialogHeader>
      {request?.kind === "create" && <CreateNotebookForm key={request.serial} request={request} busy={busy} setBusy={setBusy} close={close} />}
      {request?.kind === "move" && <div className="space-y-3">
        <select aria-label="ノートの持ち主" value={destination} onChange={e => setDestination(e.target.value)} disabled={busy} className="border rounded p-2 w-full">
          <option value="">独立ノート（現在の追加先へ）</option>{papers.filter(row => row.id !== request.item.id && !row.parent_id).map(row => <option key={row.id} value={row.id}>{row.title}</option>)}
        </select><p className="text-xs text-muted-foreground">中身や紐づけのあるノートは、先に整理すると持ち物にできます。</p>
        <Button onClick={() => void submit()} disabled={busy}>{busy ? "変更中…" : "変更"}</Button>
      </div>}
      {request?.kind === "holdings" && <div className="max-h-80 overflow-auto space-y-1">
        {notebooks.filter(row => row.parent_id === request.owner.id).map(row => <Button key={row.id} variant="ghost" className="w-full justify-start" onClick={() => { useStore.getState().setActiveTab("reader"); openPaper(row.id, request.owner.collection_name); close(); }}><NotebookPen className="size-4 mr-2" />{row.title}</Button>)}
        {attachments.filter(row => row.owner_id === request.owner.id).map(row => <Button key={row.id} variant="ghost" className="w-full justify-start" onClick={() => { openPaper(request.owner.id, request.owner.collection_name); if (row.format === "html") openDocument(request.owner.id, row.id); else openMemo(request.owner.id, row.id); close(); }}>{row.format === "html" ? "🌐 " : ""}{row.title}</Button>)}
        {request.includeLinks && linked.length > 0 && <p className="text-xs text-muted-foreground border-t pt-2">紐づけ（本体は元のフォルダーにあります）</p>}
        {request.includeLinks && linksError && <p role="alert" className="text-xs">紐づけを読み込めませんでした。<button className="underline" onClick={() => void reloadLinks()}>再試行</button></p>}
        {request.includeLinks && linked.map(row => <Button key={`link:${row.id}`} variant="ghost" className="w-full justify-start" onClick={() => { useStore.getState().setActiveTab("reader"); openPaper(row.id, row.collection_name); close(); }}>↗ {paperDisplayName(row)}</Button>)}
      </div>}
      {request?.kind === "delete" && <>
        <ul className="text-sm max-h-48 overflow-auto">{request.children.map(row => <li key={row.id}>専用ノート：{row.title}（{row.pages}ページ）</li>)}</ul>
        <p className="text-sm">メモ・資料は持ち主と一緒に削除されます。専用ノートは独立させて残せます。</p>
        <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={close}>キャンセル</Button><Button onClick={() => { request.resolve(true); useDialog.setState({ request: null }); }}>専用ノートを残して削除</Button><Button variant="destructive" onClick={() => { request.resolve(false); useDialog.setState({ request: null }); }}>持ち物もすべて削除</Button></div>
      </>}
    </DialogContent>
  </Dialog>;
}

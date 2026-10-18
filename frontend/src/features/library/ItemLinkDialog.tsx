import { useState } from "react";
import { create } from "zustand";
import { Link2 } from "lucide-react";
import { paperDisplayName, usePaperList, type PaperData } from "@/api/hooks";
import { linkPapers, useLinkedItems } from "@/api/itemLinks";
import { canLinkItems, itemCapabilities } from "@/lib/itemKinds";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const useLinkDialog = create<{ owner: PaperData | null }>(() => ({ owner: null }));
export const chooseItemLink = (owner: PaperData) => useLinkDialog.setState({ owner });

export function ItemLinkDialog() {
  const owner = useLinkDialog(s => s.owner);
  return <Dialog open={!!owner} onOpenChange={open => { if (!open) useLinkDialog.setState({ owner: null }); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader><DialogTitle>{owner && itemCapabilities(owner).linkNotebook ? "関連論文を追加" : "ノートに紐づける"}</DialogTitle>
        <DialogDescription>置き場所を変えずに結びます。紐づけを外しても本体は残ります。</DialogDescription></DialogHeader>
      {owner && <LinkChoices key={owner.id} owner={owner} />}
    </DialogContent>
  </Dialog>;
}

function LinkChoices({ owner }: { owner: PaperData }) {
  const { data: items, isError, refetch } = usePaperList("", 0);
  const { data: linked, isError: linksError, refetch: reloadLinks } = useLinkedItems(owner.id);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const existing = new Set(linked?.map(row => row.id));
  const candidates = items?.filter(row => row.id !== owner.id && canLinkItems(owner, row) && !existing.has(row.id));
  const add = async (target: PaperData) => {
    setBusy(true);
    const paper = itemCapabilities(owner).linkPaper ? owner : target;
    const notebook = itemCapabilities(owner).linkNotebook ? owner : target;
    const saved = await linkPapers([paper.id], notebook.id);
    setBusy(false);
    if (saved) useLinkDialog.setState(s => s.owner?.id === owner.id ? { owner: null } : {});
  };
  return <div className="space-y-3">
    <p className="text-sm truncate">{paperDisplayName(owner)}</p>
    <input aria-label="紐づけ先を検索" value={query} onChange={e => setQuery(e.target.value)} className="w-full border rounded p-2 text-sm bg-background" placeholder="名前で絞り込む" />
    <div className="max-h-80 overflow-y-auto space-y-1" aria-busy={busy}>
      {isError || linksError ? <div role="alert">候補を読み込めませんでした。<Button variant="outline" onClick={() => { void refetch(); void reloadLinks(); }}>再試行</Button></div>
        : !items || !linked ? <p className="text-sm text-muted-foreground">読み込み中…</p>
          : !candidates?.length ? <p className="text-sm text-muted-foreground">追加できる項目がありません。独立したノートと論文を紐づけられます。</p>
            : candidates.filter(row => paperDisplayName(row).toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(row =>
              <Button key={row.id} variant="ghost" className="w-full h-auto justify-start text-left" disabled={busy} onClick={() => void add(row)}>
                <Link2 className="size-4 shrink-0" /><span className="min-w-0"><span className="block truncate">{paperDisplayName(row)}</span><span className="block text-xs text-muted-foreground">{row.collection_name || "未分類"}</span></span>
              </Button>)}
    </div>
  </div>;
}

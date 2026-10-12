import { useState } from "react";
import { Link2, X } from "lucide-react";
import { paperDisplayName, usePaper } from "@/api/hooks";
import { removeItemLink, useLinkedItems } from "@/api/itemLinks";
import { itemCapabilities } from "@/lib/itemKinds";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";
import { openPaper } from "./selectionStore";
import { chooseItemLink } from "./ItemLinkDialog";

/** The notebook's related-paper strip and the paper-details related-notebook section share actions. */
export function RelatedItems({ paperId, compact = false }: { paperId: string; compact?: boolean }) {
  const { data: owner } = usePaper(paperId);
  const { data: linked, isError, refetch } = useLinkedItems(paperId);
  const [removing, setRemoving] = useState<string | null>(null);
  const caps = itemCapabilities(owner);
  if (!owner || !(caps.linkPaper || caps.linkNotebook)) return null;
  const title = caps.linkNotebook ? "関連論文" : "関連ノート";
  const contents = <>
    <div className="flex items-center justify-between gap-2">
      {!compact && <h3 className="text-[0.8125rem] font-semibold">{title}</h3>}
      <Button size="sm" variant="ghost" onClick={() => chooseItemLink(owner)}><Link2 className="size-3.5" />紐づけを追加…</Button>
    </div>
    {isError ? <p role="alert" className="text-xs">読み込めませんでした。<button className="underline" onClick={() => void refetch()}>再試行</button></p>
      : !linked ? <p className="text-xs text-muted-foreground">読み込み中…</p>
        : linked.length === 0 ? <p className="text-xs text-muted-foreground">紐づけはありません。</p>
          : <ul className="space-y-1 max-h-40 overflow-auto">{linked.map(row => <li key={row.id} className="flex items-center gap-1 text-xs">
            <button className="flex-1 min-w-0 text-left truncate rounded px-1 py-1 hover:bg-muted" title={`${paperDisplayName(row)} — ${row.collection_name || "未分類"}`}
              onClick={() => { useStore.getState().setActiveTab("reader"); openPaper(row.id, row.collection_name); }}>↗ {paperDisplayName(row)}</button>
            <Button size="icon" variant="ghost" className="size-6 shrink-0" aria-label={`「${paperDisplayName(row)}」との紐づけを外す`} disabled={removing !== null}
              onClick={() => { setRemoving(row.id); void removeItemLink(owner.id, row.id).finally(() => setRemoving(null)); }}><X className="size-3" /></Button>
          </li>)}</ul>}
  </>;
  return compact ? <details className="shrink-0 border-b bg-background/80 px-3 py-1 text-xs">
    <summary className="cursor-pointer text-muted-foreground">{title}{linked ? `（${linked.length}件）` : ""}</summary>
    <div className="py-1">{contents}</div>
  </details> : <section className="space-y-2 border-t pt-3">{contents}</section>;
}

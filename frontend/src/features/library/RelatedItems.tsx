import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Link2, X } from "lucide-react";
import { paperDisplayName, usePaper } from "@/api/hooks";
import { removeItemLink, useLinkedItems } from "@/api/itemLinks";
import { itemCapabilities } from "@/lib/itemKinds";
import { Button } from "@/components/ui/button";
import { useStore } from "@/store";
import { openPaper } from "./selectionStore";
import { chooseItemLink } from "./ItemLinkDialog";

/**
 * The related papers of a notebook and the related notebooks of a paper: a section of the paper's details,
 * or (`popover`) a button for the notebook's header that opens them over the page. Both share the actions.
 */
export function RelatedItems({ paperId, variant = "section" }: { paperId: string; variant?: "section" | "popover" }) {
  const { data: owner } = usePaper(paperId);
  const { data: linked, isError, refetch } = useLinkedItems(paperId);
  const [removing, setRemoving] = useState<string | null>(null);
  const caps = itemCapabilities(owner);
  if (!owner || !(caps.linkPaper || caps.linkNotebook)) return null;
  const title = caps.linkNotebook ? "関連論文" : "関連ノート";
  const contents = <>
    <div className="flex items-center justify-between gap-2">
      {variant === "section" && <h3 className="text-[0.8125rem] font-semibold">{title}</h3>}
      <Button size="sm" variant="ghost" onClick={() => chooseItemLink(owner)}><Link2 className="size-3.5" />紐づけを追加…</Button>
    </div>
    {isError ? <p role="alert" className="text-xs">読み込めませんでした。<button className="underline" onClick={() => void refetch()}>再試行</button></p>
      : !linked ? <p className="text-xs text-muted-foreground">読み込み中…</p>
        : linked.length === 0 ? <p className="text-xs text-muted-foreground">紐づけはありません。</p>
          : <ul className="space-y-1 max-h-40 overflow-auto">{linked.map(row => <li key={row.id} className="flex items-center gap-1 text-xs">
            <button className="flex-1 min-w-0 text-left truncate rounded px-1 py-1 hover:bg-muted" title={`${paperDisplayName(row)} — ${row.collection_name || "未分類"}`}
              onClick={() => { useStore.getState().setActiveTab("reader"); openPaper(row.id, row.collection_name); }}><span aria-hidden="true">↗ </span>{paperDisplayName(row)}</button>
            <Button size="icon" variant="ghost" className="size-6 shrink-0" aria-label={`「${paperDisplayName(row)}」との紐づけを外す`} disabled={removing !== null}
              onClick={() => { setRemoving(row.id); void removeItemLink(owner.id, row.id).finally(() => setRemoving(null)); }}><X className="size-3" /></Button>
          </li>)}</ul>}
  </>;
  if (variant === "section") return <section className="space-y-2 border-t pt-3">{contents}</section>;
  return <Popover.Root>
    <Popover.Trigger className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[0.8125rem] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      title="このノートに紐づけた論文を開く・追加する・外す">
      {/* The arrow is a sign for the eye; the button is read as 「関連論文 2」. */}
      <span aria-hidden="true">↗</span> {title}{linked ? ` ${linked.length}` : ""}
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50 outline-none">
        <Popover.Popup aria-label={title} className="w-[min(24rem,calc(100vw-2rem))] space-y-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg outline-none origin-(--transform-origin) transition-[opacity,transform] duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0">
          {contents}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

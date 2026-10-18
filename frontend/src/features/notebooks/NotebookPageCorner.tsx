import { useRef, type RefObject } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { useStore } from "@/store";
import { movePage } from "@/features/reader/navigation";
import { usePenNear } from "./writingContact";
import { usePageActions } from "./useNotebookPageActions";

/** The button's width, which the room right of the paper has to hold (see cornerPlacement). */
export const CORNER_WIDTH = 112;

/**
 * 「次のページ ›」 at the paper's lower right, and on the last page 「＋ 新しいページ」, which adds a page of
 * the same paper at the end and moves to it. It is no band under the paper, which would take room from
 * a paper that fits the view; it stands in the room right of the paper, or else is laid over its corner
 * and steps aside (fades and stops taking presses) when the pen is on the page or coming near it.
 */
export function NotebookPageCorner({ area, overlay, gutter }: {
  /** The element the pen is followed over: the whole view. */
  area: RefObject<HTMLElement | null>;
  /** Over the paper, rather than in the room beside it. */
  overlay: boolean;
  /** The scrollbar's width, which the button keeps clear of. */
  gutter: number;
}) {
  const actions = usePageActions();
  const current = useStore((s) => s.currentPage);
  const button = useRef<HTMLButtonElement>(null);
  const penNear = usePenNear(area, button, overlay);
  const last = actions.count > 0 && current >= actions.count;
  const hidden = overlay && penNear;
  return <button ref={button} disabled={actions.busy || actions.count === 0} tabIndex={hidden ? -1 : 0}
    aria-label={last ? "新しいページ（末尾に追加）" : "次のページ（用紙の右下）"}
    onClick={() => { if (last) void actions.append(); else movePage(1); }}
    title={last ? "同じ用紙のページを末尾に追加して、そこへ移動します" : "次のページ（→ / PageDown）"}
    className={`absolute bottom-3 z-10 flex h-8 items-center justify-center gap-1 rounded-full border px-3 text-xs shadow-sm transition-opacity duration-150 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40 ${overlay ? "bg-background/60 text-foreground/80 backdrop-blur-sm" : "bg-background text-foreground"} ${hidden ? "pointer-events-none opacity-0" : ""}`}
    style={{ right: gutter + 12, width: CORNER_WIDTH }}>
    {last ? <><Plus className="size-3.5" aria-hidden="true" />新しいページ</> : <>次のページ<ChevronRight className="size-3.5" aria-hidden="true" /></>}
  </button>;
}

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { isImeKey } from "@/lib/imeKeys";
import { withShortcutLabels } from "@/lib/platform";
import { jumpToPage, movePage } from "./navigation";

const button = "p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:pointer-events-none shrink-0";

/**
 * ‹ [page] › of the reading toolbars: the page field (also what Ctrl+G focuses, by its id) between the
 * buttons to the previous and next page. `compact` writes the page count after the field ("3 / 12"),
 * for a toolbar that has no room for a label of its own; `showGo` adds the 移動 button.
 */
export function PageNavigator({ paperId, currentPage, count, atStart, atEnd, showGo = false, compact = false }: {
  paperId: string;
  currentPage: number;
  /** Pages in all; 0 while unknown. */
  count: number;
  atStart: boolean;
  atEnd: boolean;
  showGo?: boolean;
  compact?: boolean;
}) {
  const [pageText, setPageText] = useState(String(currentPage));
  const cancelledPageEdit = useRef(false);
  useEffect(() => setPageText(String(currentPage)), [currentPage, paperId]);

  const commitPage = () => {
    const value = parseInt(pageText.normalize("NFKC"), 10);
    if (Number.isFinite(value)) {
      const target = Math.max(1, Math.min(value, count || currentPage));
      setPageText(String(target));
      if (target !== currentPage) jumpToPage(target);
    }
    else setPageText(String(currentPage));
  };

  return <>
    <button onClick={() => movePage(-1)} disabled={atStart} className={button} aria-label="前のページ" title="前のページ（← / PageUp / ページ先頭でホイール上）">
      <ChevronLeft className="w-4 h-4" />
    </button>
    <input
      id="page-input"
      type="text"
      inputMode="numeric"
      value={pageText}
      onChange={(e) => setPageText(e.target.value.replace(/[^0-9０-９]/g, ""))}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !isImeKey(e.nativeEvent)) commitPage();
        if (e.key === "Escape" && !isImeKey(e.nativeEvent)) {
          e.preventDefault();
          cancelledPageEdit.current = true;
          setPageText(String(currentPage));
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        if (cancelledPageEdit.current) cancelledPageEdit.current = false;
        else commitPage();
      }}
      aria-label="ページ番号"
      title={withShortcutLabels("ページ番号を入力し、Enterで移動（Ctrl+G）")}
      className={compact
        ? "w-9 h-6 shrink-0 text-center border border-transparent rounded bg-transparent hover:border-border focus:border-border focus:bg-background focus:ring-2 focus:ring-ring focus:outline-none tabular-nums"
        : "w-11 h-6 shrink-0 text-center border rounded bg-background focus:ring-2 focus:ring-ring focus:outline-none tabular-nums"}
    />
    {compact && <span className="shrink-0 text-muted-foreground tabular-nums whitespace-nowrap" aria-hidden="true">/ {count || "—"}</span>}
    {showGo && (
      <button onClick={commitPage} className="h-6 px-2 shrink-0 rounded border text-[0.75rem] hover:bg-muted">
        移動
      </button>
    )}
    <button onClick={() => movePage(1)} disabled={atEnd} className={button} aria-label="次のページ" title="次のページ（→ / PageDown / ページ末尾でホイール下）">
      <ChevronRight className="w-4 h-4" />
    </button>
  </>;
}

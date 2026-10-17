import { useId, useMemo } from "react";
import { BookOpen } from "lucide-react";
import { paperDisplayName, usePaperList } from "@/api/hooks";
import { useStore } from "@/store";
import { emitAppEvent } from "@/lib/appEvents";
import { openedAgo, recentlyOpened } from "@/lib/recentPapers";
import { normalizeCollection } from "@/lib/collectionPath";
import { itemCapabilities } from "@/lib/itemKinds";
import { openPaper } from "./selectionStore";

/** How many papers 続きから読む offers. */
const SHOWN = 5;

/**
 * 続きから読む, for the reader while no paper is open: the papers last opened on this PC, each opening at
 * the page it was left at. Nothing while none has been opened. From the library's own list (the same
 * query as the sidebar), so it costs no request of its own.
 */
export function ContinueReading() {
  const sortOrder = useStore((s) => s.sortOrder);
  const { data: papers } = usePaperList("", sortOrder);
  const paperPages = useStore((s) => s.paperPages);
  const recent = useMemo(() => recentlyOpened(papers ?? [], SHOWN), [papers]);
  const headingId = useId();
  if (!recent.length) return null;
  const now = Date.now();
  return (
    <section aria-labelledby={headingId} className="w-full max-w-md mb-6 text-left">
      <h2 id={headingId} className="flex items-center gap-1.5 mb-2 text-[0.8125rem] font-semibold text-foreground">
        <BookOpen className="w-4 h-4 text-muted-foreground" aria-hidden="true" /> 続きから読む
      </h2>
      <ul className="rounded-lg border divide-y bg-background">
        {recent.map((paper) => {
          const page = paperPages[paper.id];
          const detail = [page ? `${page}ページ` : "", (itemCapabilities(paper).readStatus && paper.read_status) || "", openedAgo(paper.last_opened_at!, now)]
            .filter(Boolean).join(" · ");
          return (
            <li key={paper.id}>
              <button
                type="button"
                onClick={() => {
                  openPaper(paper.id, normalizeCollection(paper.collection_name || ""));
                  emitAppEvent("reveal-paper", { paperId: paper.id, focus: false });
                }}
                className="w-full px-3 py-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring first:rounded-t-lg last:rounded-b-lg"
              >
                <span className="block truncate text-[0.8125rem] text-foreground">{paperDisplayName(paper)}</span>
                <span className="block text-[0.75rem] text-muted-foreground tabular-nums">{detail}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

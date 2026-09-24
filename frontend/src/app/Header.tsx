import { useStore } from "../store";
import { usePaper, useReading } from "../api/hooks";
import { PaperStatusBadge, PaperStatus } from "../components/ui/PaperStatusBadge";

export function Header() {
  const activePaperId = useStore((s) => s.activePaperId);
  const activeJobs = useStore((s) => s.activeJobs);
  
  const { data: paper } = usePaper(activePaperId);
  const { data: reading } = useReading(activePaperId);

  if (!activePaperId) {
    return (
      <header className="h-[48px] border-b flex items-center px-4 shrink-0 bg-background/50">
        <h1 className="text-sm text-muted-foreground">論文を選択してください</h1>
      </header>
    );
  }

  // Determine status
  const job = activeJobs.find(j => j.paper_id === activePaperId && j.status === "running");
  
  let status: PaperStatus = "untranslated";
  let statusText = "未翻訳";
  
  if (job) {
    status = "translating";
    statusText = `翻訳中 ${job.done || 0}/${job.total || "?"}`;
  } else if (reading?.has_translated && reading?.completed_pages && reading.completed_pages.length > 0) {
    // We should technically check if all pages are translated, but this is a rough proxy
    status = "translated";
    statusText = "翻訳済み";
  } else if (reading?.completed_pages && reading.completed_pages.length > 0) {
    status = "partial";
    statusText = `翻訳済み ${reading.completed_pages.length}`;
  }
  // TODO: Add failed state based on job history if needed

  return (
    <header className="h-[48px] border-b flex items-center px-4 justify-between shrink-0 bg-background/50">
      <div className="flex flex-col min-w-0 pr-4">
        <div className="flex items-center gap-2">
          <h1 className="text-[15px] font-semibold truncate cursor-pointer hover:underline" title={paper?.title || "Untitled"}>
            {paper?.title || "Loading..."}
          </h1>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground mt-0.5">
          <span className="truncate max-w-[200px]">
            {paper?.first_author || "Unknown"} · {paper?.publication_year || "?"} · {paper?.collection_name || "未分類"}
          </span>
          <span className="text-border">|</span>
          <PaperStatusBadge status={status} text={statusText} hasSummary={!!paper?.has_article} />
        </div>
      </div>
      
      <div className="flex items-center gap-2 shrink-0">
        {status === "translating" ? (
          <button className="bg-destructive text-destructive-foreground px-3 py-1.5 rounded-md text-[13px] font-medium hover:opacity-90 transition-opacity">
            中止
          </button>
        ) : (
          <button className="bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-[13px] font-medium hover:opacity-90 transition-opacity">
            {status === "partial" ? "再開 ▾" : status === "translated" ? "再翻訳 ▾" : "翻訳する ▾"}
          </button>
        )}
        <button className="p-1.5 hover:bg-muted rounded-md text-muted-foreground transition-colors">
          ⋯
        </button>
      </div>
    </header>
  );
}

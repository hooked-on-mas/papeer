import { cn } from "@/lib/utils";
import { Circle, CircleAlert, CircleCheck, CircleDashed, FileText, Loader2, Pause } from "lucide-react";
import type { PaperStatus } from "@/lib/paperStatus";

interface Props {
  status: PaperStatus;
  text: string;
  className?: string;
  hasSummary?: boolean;
  description?: string;
}

export function PaperStatusBadge({ status, text, className, hasSummary, description }: Props) {
  const tone = {
    untranslated: "bg-muted text-muted-foreground",
    translating: "bg-primary/10 text-primary",
    partial: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    paused: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    translated: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    review: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    failed: "bg-destructive/10 text-destructive",
    ocr: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  }[status];
  const Icon = { untranslated: Circle, translating: Loader2, partial: CircleDashed, paused: Pause,
    translated: CircleCheck, review: CircleAlert, failed: CircleAlert, ocr: CircleAlert }[status];

  return (
    <div className={cn("inline-flex items-center gap-1.5", className)}>
      <span title={description ?? text} className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-4 whitespace-nowrap", tone)}>
        <Icon aria-hidden="true" className={cn("size-3 shrink-0", status === "translating" && "animate-spin")} />{text}
      </span>
      {hasSummary && <span title="サマリーあり" aria-label="サマリーあり"><FileText className="size-3 text-muted-foreground" /></span>}
    </div>
  );
}

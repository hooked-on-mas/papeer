import { cn } from "@/lib/utils";

export type PaperStatus = "untranslated" | "translating" | "partial" | "translated" | "failed";

interface Props {
  status: PaperStatus;
  text: string;
  className?: string;
  hasSummary?: boolean;
}

export function PaperStatusBadge({ status, text, className, hasSummary }: Props) {
  const dotColor = {
    untranslated: "bg-muted-foreground",
    translating: "bg-primary animate-pulse", // Using pulse to represent spinner
    partial: "bg-warning",
    translated: "bg-success",
    failed: "bg-destructive",
  }[status];

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <span className={cn("w-2 h-2 rounded-full shrink-0", dotColor)}></span>
      <span>{text}</span>
      {hasSummary && <span className="ml-1 text-[10px] leading-none" title="サマリーあり">📄</span>}
    </div>
  );
}


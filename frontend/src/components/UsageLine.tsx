import { Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import { usageDetails, usageSummary, type Usage } from "@/lib/usage";

/** Small muted line under an AI result: tokens used, with the breakdown on hover. */
export function UsageLine({ usage, className }: { usage: Usage | null | undefined; className?: string }) {
  if (!usage) return null;
  return (
    <div
      className={cn("flex items-center gap-1 text-[0.75rem] text-muted-foreground tabular-nums", className)}
      title={usageDetails(usage)}
    >
      <Gauge className="w-3 h-3 shrink-0" />
      <span className="truncate">{usageSummary(usage)}</span>
    </div>
  );
}

import { Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import { usageDetails, type Usage } from "@/lib/usage";

/** Optional AI accounting, kept out of the reading text until requested. */
export function UsageLine({ usage, className }: { usage: Usage | null | undefined; className?: string }) {
  if (!usage) return null;
  return (
    <div
      className={cn("flex items-center gap-1 text-[0.75rem] text-muted-foreground tabular-nums", className)}
    >
      <details className="min-w-0 max-w-full">
        <summary className="cursor-pointer" title="モデル、トークン数、取得できた料金を確認します">
          <Gauge className="inline-block w-3 h-3 mx-1" aria-hidden="true" />AIの使用量
        </summary>
        <p className="mt-1 whitespace-pre-line break-words">{usageDetails(usage)}</p>
      </details>
    </div>
  );
}

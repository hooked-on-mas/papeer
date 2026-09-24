import { Loader2 } from "lucide-react";
import { PaperStatus } from "@/components/ui/PaperStatusBadge";

interface Props {
  status: PaperStatus;
  progress?: { done: number; total: number };
}

export function PageStatusOverlay({ status, progress }: Props) {
  if (status !== "translating") return null;

  return (
    <div className="absolute inset-0 bg-background/80 backdrop-blur-sm z-20 flex flex-col items-center justify-center">
      <div className="bg-background border shadow-lg rounded-xl p-6 flex flex-col items-center gap-4 max-w-[280px] text-center">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
        <div>
          <h3 className="font-semibold text-[15px] mb-1">翻訳中...</h3>
          <p className="text-muted-foreground text-[13px]">
            このページは現在翻訳処理を行っています。
            {progress && progress.total > 0 && (
              <span className="block mt-1 font-mono">
                {progress.done} / {progress.total}
              </span>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}


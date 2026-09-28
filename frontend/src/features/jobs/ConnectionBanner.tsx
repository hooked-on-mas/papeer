import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { isAppClosing } from "@/app/appClosing";
import { useConnection } from "./connection";
import { connectionBanner, connectionBannerDelay } from "./jobList";

/**
 * A strip across the top of the window while the job event stream is down; it goes once reconnected.
 * It takes its own room above the app (AppShell), pushing the rest down, so that it never covers the
 * paper's title and details in the header.
 */
export function ConnectionBanner() {
  const state = useConnection();
  const [now, setNow] = useState(() => Date.now());

  // Show up only once the drop has lasted a moment (connectionBanner's grace).
  useEffect(() => {
    const current = Date.now();
    setNow(current);
    const delay = connectionBannerDelay(state, current);
    if (delay === null) return;
    const timer = setTimeout(() => setNow(Date.now()), delay + 50);
    return () => clearTimeout(timer);
  }, [state]);

  const text = connectionBanner(state, now, isAppClosing());
  return (
    // The live region stays mounted so that screen readers announce the text when it appears.
    <div role="status" aria-live="polite" className="shrink-0">
      {text && (
        <div className="flex items-center justify-center gap-2 border-b border-amber-500/40 bg-amber-50 px-4 py-1.5 text-[0.8125rem] text-amber-950 dark:bg-amber-950 dark:text-amber-100">
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
          <span>{text}</span>
        </div>
      )}
    </div>
  );
}

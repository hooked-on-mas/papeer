import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { isAppClosing } from "@/app/appClosing";
import { useConnection } from "./connection";
import { connectionBanner, connectionBannerDelay } from "./jobList";

/** A strip at the top of the window while the job event stream is down; it goes once reconnected. */
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
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 top-2 z-[70] flex justify-center px-4">
      {text && (
        <div className="pointer-events-auto flex max-w-2xl items-center gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-1.5 text-[0.8125rem] text-amber-950 shadow-md dark:bg-amber-950 dark:text-amber-100">
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
          <span>{text}</span>
        </div>
      )}
    </div>
  );
}

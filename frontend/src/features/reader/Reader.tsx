import type { ReactNode, RefObject } from "react";

/** Shared reader frame. Hosts supply the toolbar, status and page panes. */
export function Reader({ rootRef, children }: { rootRef?: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  return <div ref={rootRef} data-reader-root className="flex flex-col h-full w-full bg-reader-bg">{children}</div>;
}

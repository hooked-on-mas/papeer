import type { ComponentProps, ReactNode } from "react";
import { ReaderDock } from "@/features/reader/layout/ReaderDock";
import { TabsContent } from "@/components/ui/tabs";

/** Reader layout with host-supplied content and dock actions. */
export function ReaderArea({ dock, children }: {
  dock: Omit<ComponentProps<typeof ReaderDock>, "children">;
  children: ReactNode;
}) {
  return <ReaderDock {...dock}>{children}</ReaderDock>;
}

/**
 * The 「本文」 tab's panel. The reader stays mounted while another tab is shown, so that its PDFs,
 * page and scroll position are there on coming back. It is hidden with visibility rather than
 * display: none (hidden={false} overrides the panel's own hidden attribute), which keeps its size and
 * scroll position, so it is neither laid out anew nor redrawn meanwhile. The panel is inert while
 * inactive, so the hidden reader takes no keys, clicks, wheel or focus.
 */
export function ReaderTab({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <TabsContent value="reader" keepMounted hidden={false}
      className={`flex-1 p-0 m-0 overflow-hidden outline-none flex min-h-0 ${active ? "" : "invisible absolute inset-0"}`}>
      {children}
    </TabsContent>
  );
}

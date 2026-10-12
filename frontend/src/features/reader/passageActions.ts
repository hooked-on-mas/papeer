import type { ItemCapabilities } from "../../lib/itemKinds.ts";

/** What can be done with a passage selected in a pane, or a highlight clicked on it. */
export type PassageAction = "fix-paragraph" | "fix-terms" | "explain" | "attach" | "quote" | "sticky" | "highlight";

/**
 * The actions of the context menu (PdfContextMenu) and the toolbar (SelectionToolbar) over a passage that
 * an item can do. Each needs the same thing the matching tab or pane does: the translation to fix, the
 * chat to ask, the memo to quote into, the 付箋 for a sticky note or a highlight (which is kept as one).
 * Copying needs none, so it is not here.
 */
export function passageActions(caps: ItemCapabilities): ReadonlySet<PassageAction> {
  const offered = new Set<PassageAction>();
  if (caps.translate) { offered.add("fix-paragraph"); offered.add("fix-terms"); }
  if (caps.chat) { offered.add("explain"); offered.add("attach"); }
  if (caps.memo) offered.add("quote");
  if (caps.stickyNotes) { offered.add("sticky"); offered.add("highlight"); }
  return offered;
}

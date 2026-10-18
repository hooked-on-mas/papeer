import { useRef, type ComponentProps } from "react";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { CopyPlus, FilePlus2, Settings2, Trash2 } from "lucide-react";
import { usePageActions } from "./useNotebookPageActions";

type OpenChange = NonNullable<ComponentProps<typeof ContextMenu>["onOpenChange"]>;

/**
 * A context menu that only the mouse's right button opens. A finger's long press or a pen held down
 * would otherwise open it while writing (the hand resting on the page, a pen pausing), so for the menus
 * over the notebook the last pointer pressed must have been a mouse; the others are cancelled as they open.
 */
export function useMouseOnlyMenu() {
  const lastPointer = useRef("mouse");
  return {
    /** For the trigger's onPointerDownCapture. */
    remember: (event: { pointerType: string }) => { lastPointer.current = event.pointerType; },
    /** Cancels an opening that did not come from the mouse; true if it did. */
    allows: (open: boolean, details: Parameters<OpenChange>[1]) => {
      // A finger's long press reaches the trigger as touch events, with or without a pointer press before them.
      const touch = typeof details.event?.type === "string" && details.event.type.startsWith("touch");
      if (!open || (lastPointer.current === "mouse" && !touch)) return true;
      details.cancel();
      return false;
    },
  };
}

/**
 * The menu items that work on one page: adding a page before or after it, duplicating it, changing its
 * paper, deleting it. The menu over the paper and the one over a thumbnail share them (§4.2).
 */
export function NotebookPageMenuItems({ pageId }: { pageId: string }) {
  const actions = usePageActions();
  const { busy } = actions;
  return <>
    <ContextMenuItem disabled={busy} onClick={() => void actions.insert(pageId, "before")}>
      <FilePlus2 /> このページの前にページを追加
    </ContextMenuItem>
    <ContextMenuItem disabled={busy} onClick={() => void actions.insert(pageId, "after")}>
      <FilePlus2 /> このページの後ろにページを追加
    </ContextMenuItem>
    <ContextMenuItem disabled={busy} onClick={() => void actions.duplicate(pageId)}>
      <CopyPlus /> このページを複製
    </ContextMenuItem>
    <ContextMenuItem disabled={busy} onClick={() => actions.editPaper(pageId)}>
      <Settings2 /> 用紙を変更…
    </ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem variant="destructive" disabled={busy || actions.count <= 1} onClick={() => void actions.remove(pageId)}>
      <Trash2 /> このページを削除
    </ContextMenuItem>
  </>;
}

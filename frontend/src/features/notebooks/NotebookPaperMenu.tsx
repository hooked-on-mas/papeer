import { useRef } from "react";
import { ClipboardPaste, StickyNote } from "lucide-react";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { PageMenuProps } from "@/features/reader/PdfPane";
import { openStickyNote } from "@/features/reader/stickyNotesStore";
import { shortcutLabel } from "@/lib/platform";
import { NotebookPageMenuItems, useMouseOnlyMenu } from "./NotebookPageMenu";

/** Where on the page a point is, as fractions of its width and height (clamped to the page). */
function placeOnPage(area: HTMLElement | null, at: { x: number; y: number }): { x: number; y: number } {
  const surface = area?.querySelector<HTMLElement>("[data-pdf-surface]");
  const box = surface?.getBoundingClientRect();
  if (!box || !box.width || !box.height) return { x: 0.5, y: 0.5 };
  // The page's 1px border sits outside what is written on.
  const fraction = (value: number, start: number, size: number) => Math.max(0, Math.min(1, (value - start - 1) / Math.max(1, size - 2)));
  return { x: fraction(at.x, box.left, box.width), y: fraction(at.y, box.top, box.height) };
}

/**
 * The menu over a notebook's paper, in place of the PDF's (§4.2): paste writing that was copied, put a
 * sticky note where the click was, and the page operations. Only the mouse's right button opens it.
 */
export function NotebookPaperMenu({ disabled, editor, inkPage, children }: PageMenuProps) {
  const mouse = useMouseOnlyMenu();
  const area = useRef<HTMLDivElement>(null);
  const clicked = useRef({ x: 0, y: 0 });
  const pageId = inkPage?.pageId;
  const canWrite = editor.ink.ready && !editor.locked && editor.visible;

  return <ContextMenu disabled={disabled}
    onOpenChange={(open, details) => {
      if (open && disabled) { details.cancel(); return; }
      mouse.allows(open, details);
    }}>
    <ContextMenuTrigger ref={area} className="h-full w-full select-auto"
      onPointerDownCapture={mouse.remember}
      onContextMenuCapture={(event) => { clicked.current = { x: event.clientX, y: event.clientY }; }}
      onContextMenu={(event) => { if (disabled) event.preventDefault(); }}>
      {children}
    </ContextMenuTrigger>
    <ContextMenuContent className="w-64">
      {editor.hasClipboard && <ContextMenuItem disabled={!canWrite} onClick={() => { editor.beforeCommand.current?.(); editor.paste(); }}>
        <ClipboardPaste /> 貼り付け <ContextMenuShortcut>{shortcutLabel("Ctrl+V")}</ContextMenuShortcut>
      </ContextMenuItem>}
      <ContextMenuItem disabled={!inkPage} onClick={() => {
        if (!inkPage) return;
        const at = placeOnPage(area.current, clicked.current);
        void openStickyNote({ paperId: inkPage.paperId, pageId: inkPage.pageId, page: inkPage.page, side: "original", quote: "", anchorY: at.y, anchorX: at.x });
      }}>
        <StickyNote /> ここに付箋を貼る
      </ContextMenuItem>
      {pageId && <>
        <ContextMenuSeparator />
        <NotebookPageMenuItems pageId={pageId} />
      </>}
    </ContextMenuContent>
  </ContextMenu>;
}

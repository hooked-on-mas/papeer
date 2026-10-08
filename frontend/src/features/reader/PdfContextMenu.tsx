import React, { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  StickyNote, ChevronLeft, ChevronRight, Copy, Highlighter, Languages, MoveHorizontal, NotebookPen, Paperclip, Sparkles, ZoomIn, ZoomOut, Scan,
} from "lucide-react";
import { useStore, ZOOM_FIT_PAGE } from "@/store";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { showError } from "@/components/errorDialog";
import { changeZoom, movePage } from "./navigation";
import { attachPassage, capturePassage, explainPassage, highlightPassage, quotePassageInNote, stickyNoteForPassage, type Passage } from "./readerPassage";
import { highlightColor } from "./highlights";
import { useStickyNotes } from "./stickyNotesStore";
import { emitAppEvent } from "@/lib/appEvents";
import { shortcutLabel } from "@/lib/platform";

/**
 * Replaces the webview's browser menu (戻る, 印刷, 検査…) over a PDF page:
 * selected text goes to the clipboard, チャット, メモ, a sticky note or a highlight; otherwise it offers
 * page and zoom controls. The toolbar over a selection (SelectionToolbar) offers the most used of these.
 */
export function PdfContextMenu({ translated, children }: { translated: boolean; children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const areaRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(false);
  // Taken when the menu opens, so the translation text is usually loaded before an item is chosen.
  const passage = useRef<Passage | null>(null);
  const lastColor = useStickyNotes(s => s.highlightColor);

  const handleOpen = (open: boolean) => {
    if (!open) return;
    passage.current = capturePassage(areaRef.current, translated);
    setSelected(!!passage.current);
  };

  const withPassage = (action: (passage: Passage) => unknown) => () => {
    const current = passage.current;
    if (current) void action(current);
  };

  const copy = withPassage(async (current) => {
    navigator.clipboard.writeText(await current.text).catch((error) => showError(error, "コピーできませんでした"));
  });

  return (
    <ContextMenu onOpenChange={handleOpen}>
      {/* The trigger's default select-none would stop text selection in the PDF. */}
      <ContextMenuTrigger ref={areaRef} className="h-full w-full select-auto">
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        {selected ? (
          <>
            <ContextMenuItem onClick={copy}>
              <Copy /> コピー <ContextMenuShortcut>{shortcutLabel("Ctrl+C")}</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={async () => {
              const current = passage.current;
              if (!current) return;
              emitAppEvent("open-paragraph-editor", {
                page: current.page, side: translated ? "translated" : "original", text: await current.text,
              });
            }}>
              <Languages /> この段落の翻訳を修正…
            </ContextMenuItem>
            <ContextMenuItem onClick={withPassage(async (current) => {
              emitAppEvent("open-term-feedback", { side: translated ? "translated" : "original", text: await current.text });
            })}>
              <Languages /> この訳語を一括修正…
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={withPassage(explainPassage)}>
              <Sparkles /> この箇所を説明してもらう
            </ContextMenuItem>
            <ContextMenuItem onClick={withPassage(attachPassage)}>
              <Paperclip /> この箇所をチャットに添付
            </ContextMenuItem>
            <ContextMenuItem onClick={withPassage(quotePassageInNote)}>
              <NotebookPen /> メモに引用
            </ContextMenuItem>
            <ContextMenuItem onClick={withPassage(stickyNoteForPassage)}>
              <StickyNote /> 選択した文章に付箋を貼る…
            </ContextMenuItem>
            <ContextMenuItem onClick={withPassage(async (current) => {
              if (await highlightPassage(current, lastColor, queryClient)) window.getSelection()?.removeAllRanges();
            })}>
              <Highlighter /> ハイライト（{highlightColor(lastColor).label}）
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuItem onClick={() => movePage(-1)}>
              <ChevronLeft /> 前のページ <ContextMenuShortcut>←</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => movePage(1)}>
              <ChevronRight /> 次のページ <ContextMenuShortcut>→</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => changeZoom(1)}>
              <ZoomIn /> 拡大 <ContextMenuShortcut>{shortcutLabel("Ctrl++")}</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => changeZoom(-1)}>
              <ZoomOut /> 縮小 <ContextMenuShortcut>{shortcutLabel("Ctrl+-")}</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => useStore.getState().setZoom(1)}>
              <MoveHorizontal /> 幅に合わせる <ContextMenuShortcut>{shortcutLabel("Ctrl+0")}</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => useStore.getState().setZoom(ZOOM_FIT_PAGE)}>
              <Scan /> ページ全体を表示
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => emitAppEvent("open-translate-dialog")}>
              <Languages /> 翻訳する… <ContextMenuShortcut>{shortcutLabel("Ctrl+T")}</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

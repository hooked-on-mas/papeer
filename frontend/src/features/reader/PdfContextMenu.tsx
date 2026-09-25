import React, { useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, Copy, Languages, MessageSquareQuote, MoveHorizontal, NotebookPen, Sparkles, ZoomIn, ZoomOut,
} from "lucide-react";
import { useStore } from "@/store";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { apiRequest } from "@/api/client";
import { cleanPdfSelection, quoteForNote, restoreFormulas } from "@/lib/pdfSelection";
import { showError } from "@/features/jobs/jobEvents";
import { changeZoom, movePage } from "./navigation";

/** Raw selected text inside `area`, or "" when the selection is empty or elsewhere. */
function selectionWithin(area: HTMLElement | null): string {
  const selection = window.getSelection();
  if (!area || !selection || selection.isCollapsed || !selection.rangeCount) return "";
  if (!area.contains(selection.getRangeAt(0).commonAncestorContainer)) return "";
  return selection.toString();
}

/** The translated PDF shows inline math as images; take the passage with its math from the translation text. */
async function translatedPassage(raw: string, paperId: string, page: number): Promise<string> {
  try {
    const { blocks } = await apiRequest<{ blocks: string[] }>("GET", `/api/papers/${paperId}/translation-text/${page}`);
    return restoreFormulas(raw, blocks) ?? cleanPdfSelection(raw);
  } catch {
    return cleanPdfSelection(raw);
  }
}

/**
 * Replaces the webview's browser menu (戻る, 印刷, 検査…) over a PDF page:
 * selected text goes to the clipboard, 質問 or メモ; otherwise it offers page and zoom controls.
 */
export function PdfContextMenu({ translated, children }: { translated: boolean; children: React.ReactNode }) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(false);
  // Resolved when the menu opens, so the translation text is usually loaded before an item is chosen.
  const passage = useRef<{ paperId: string; page: number; text: Promise<string> } | null>(null);

  const handleOpen = (open: boolean) => {
    if (!open) return;
    const raw = selectionWithin(areaRef.current);
    const { activePaperId, currentPage } = useStore.getState();
    const cleaned = cleanPdfSelection(raw);
    setSelected(!!cleaned);
    passage.current = cleaned && activePaperId ? {
      paperId: activePaperId,
      page: currentPage,
      text: translated ? translatedPassage(raw, activePaperId, currentPage) : Promise.resolve(cleaned),
    } : null;
  };

  const withPassage = (action: (text: string, source: string, paperId: string) => void) => async () => {
    const current = passage.current;
    if (!current) return;
    action(await current.text, `p.${current.page}${translated ? "（訳文）" : ""}`, current.paperId);
  };

  const handOff = (tab: "chat" | "notes", paperId: string, text: string, send = false) => {
    const store = useStore.getState();
    if (store.activePaperId !== paperId) return;
    const handoff = { paperId, text, send };
    if (tab === "chat") store.setChatDraft(handoff);
    else store.setNoteInsert(handoff);
    store.setActiveTab(tab);
  };

  const copy = withPassage((text) => {
    navigator.clipboard.writeText(text).catch((error) => showError(error, "コピーできませんでした"));
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
              <Copy /> コピー <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={withPassage((text, source, paperId) =>
              handOff("chat", paperId, `次の箇所をわかりやすく説明してください（${source}）。\n\n> ${text}`, true))}>
              <Sparkles /> この箇所を説明してもらう
            </ContextMenuItem>
            <ContextMenuItem onClick={withPassage((text, _source, paperId) => handOff("chat", paperId, `> ${text}\n\n`))}>
              <MessageSquareQuote /> この箇所について質問…
            </ContextMenuItem>
            <ContextMenuItem onClick={withPassage((text, source, paperId) => handOff("notes", paperId, quoteForNote(text, source)))}>
              <NotebookPen /> メモに引用
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
              <ZoomIn /> 拡大 <ContextMenuShortcut>Ctrl++</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => changeZoom(-1)}>
              <ZoomOut /> 縮小 <ContextMenuShortcut>Ctrl+-</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => useStore.getState().setZoom(1)}>
              <MoveHorizontal /> 幅に合わせる <ContextMenuShortcut>Ctrl+0</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => window.dispatchEvent(new Event("open-translate-dialog"))}>
              <Languages /> 翻訳する… <ContextMenuShortcut>Ctrl+T</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

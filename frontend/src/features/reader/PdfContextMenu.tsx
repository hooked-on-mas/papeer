import React, { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  StickyNote, ChevronLeft, ChevronRight, Copy, Languages, MoveHorizontal, NotebookPen, Paperclip, Sparkles, ZoomIn, ZoomOut,
} from "lucide-react";
import { useStore, type PassageAttachment } from "@/store";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { apiRequest } from "@/api/client";
import { cleanPdfSelection, quoteForNote, restoreFormulas } from "@/lib/pdfSelection";
import { showError } from "@/components/errorDialog";
import { changeZoom, movePage } from "./navigation";
import { askText } from "@/components/AppDialogs";
import { openStickyNote } from "./stickyNotesStore";
import { textLayerOffsets } from "./textLayerRange";
import { emitAppEvent } from "@/lib/appEvents";
import { QK } from "@/lib/queryKeys";

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
 * selected text goes to the clipboard, チャット or メモ; otherwise it offers page and zoom controls.
 */
export function PdfContextMenu({ translated, children }: { translated: boolean; children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const areaRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(false);
  // Resolved when the menu opens, so the translation text is usually loaded before an item is chosen.
  const passage = useRef<{
    paperId: string; page: number; text: Promise<string>; anchorY: number;
    offsets: ReturnType<typeof textLayerOffsets>;
  } | null>(null);

  const handleOpen = (open: boolean) => {
    if (!open) return;
    const raw = selectionWithin(areaRef.current);
    const { activePaperId, currentPage } = useStore.getState();
    const cleaned = cleanPdfSelection(raw);
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const selectedRect = range?.getClientRects()[0];
    const pageRect = areaRef.current?.querySelector(".react-pdf__Page")?.getBoundingClientRect();
    const anchorY = selectedRect && pageRect ? Math.max(0, Math.min(1, (selectedRect.top - pageRect.top) / pageRect.height)) : 0;
    setSelected(!!cleaned);
    passage.current = cleaned && activePaperId ? {
      paperId: activePaperId,
      page: currentPage,
      anchorY,
      offsets: range && textLayerOffsets(range),
      text: translated ? translatedPassage(raw, activePaperId, currentPage) : Promise.resolve(cleaned),
    } : null;
  };

  const withPassage = (action: (text: string, source: string, paperId: string, anchorY: number) => void) => async () => {
    const current = passage.current;
    if (!current) return;
    action(await current.text, `p.${current.page}${translated ? "（訳文）" : ""}`, current.paperId, current.anchorY);
  };

  const attachment = async (): Promise<PassageAttachment | null> => {
    const current = passage.current;
    if (!current) return null;
    return {
      id: crypto.randomUUID(), paperId: current.paperId, page: current.page, side: translated ? "translated" : "original",
      text: await current.text, anchor_y: current.anchorY, ...current.offsets,
    };
  };

  const quoteInNote = (paperId: string, text: string) => {
    const store = useStore.getState();
    if (store.activePaperId !== paperId) return;
    store.setNoteInsert({ paperId, text });
    store.setActiveTab("notes");
  };

  const explain = async () => {
    const item = await attachment();
    const store = useStore.getState();
    if (!item || store.activePaperId !== item.paperId) return;
    store.setChatDraft({ paperId: item.paperId, text: "この箇所をわかりやすく説明してください。", send: true, attachments: [item] });
    store.setActiveTab("chat");
  };

  // Stays in the reader so that more passages can be attached; focus mode opens the chat beside it.
  const attach = async () => {
    const item = await attachment();
    const store = useStore.getState();
    if (!item || store.activePaperId !== item.paperId) return;
    store.addChatAttachment(item);
    if (store.focusMode) store.setActiveTab("chat");
    const count = useStore.getState().chatAttachments.filter((x) => x.paperId === item.paperId).length;
    store.setStatus(`チャットに添付しました（${count}件）。「チャット」タブで送信できます。`);
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
            <ContextMenuItem onClick={() => emitAppEvent("open-paragraph-editor")}>
              <Languages /> このページの段落を修正…
            </ContextMenuItem>
            <ContextMenuItem onClick={withPassage(async (text) => {
              const source = await askText("共通辞書に登録", "原語（100文字まで）", text.slice(0, 100));
              if (!source?.trim()) return;
              const target = await askText("共通辞書に登録", `「${source}」の訳語`);
              if (!target?.trim()) return;
              try {
                const terms = await apiRequest<{ source: string; target: string }[]>("GET", "/api/glossary");
                await apiRequest("PUT", "/api/glossary", { expected_terms: terms, terms: [...terms.filter(t => t.source.toLocaleLowerCase() !== source.trim().toLocaleLowerCase()), { source: source.trim(), target: target.trim() }] });
                queryClient.invalidateQueries({ queryKey: [QK.glossary] });
                queryClient.invalidateQueries({ queryKey: [QK.effectiveGlossary] });
                queryClient.invalidateQueries({ queryKey: [QK.paragraphs] });
                useStore.getState().setStatus("共通辞書に登録しました。すべての論文の次の翻訳から適用します。");
              } catch (error) { showError(error, "用語を登録できませんでした"); }
            })}>
              <Languages /> 共通辞書に登録…
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={explain}>
              <Sparkles /> この箇所を説明してもらう
            </ContextMenuItem>
            <ContextMenuItem onClick={attach}>
              <Paperclip /> この箇所をチャットに添付
            </ContextMenuItem>
            <ContextMenuItem onClick={withPassage((text, source, paperId) => quoteInNote(paperId, quoteForNote(text, source)))}>
              <NotebookPen /> メモに引用
            </ContextMenuItem>
            <ContextMenuItem onClick={withPassage((text, _source, paperId, anchorY) => {
              void openStickyNote({
                paperId, page: passage.current!.page, side: translated ? "translated" : "original", quote: text, anchorY,
              });
            })}>
              <StickyNote /> 選択した文章に付箋を貼る…
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
            <ContextMenuItem onClick={() => emitAppEvent("open-translate-dialog")}>
              <Languages /> 翻訳する… <ContextMenuShortcut>Ctrl+T</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

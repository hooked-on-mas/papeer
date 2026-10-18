/**
 * Text selected in a PDF pane and what can be done with it: explained in the chat, attached to it,
 * quoted in the memo, given a sticky note or highlighted. Shared by the right-click menu
 * (PdfContextMenu) and the small toolbar over a selection (SelectionToolbar).
 */
import type { QueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { showError } from "@/components/errorDialog";
import { citationLink } from "@/lib/markdownUrl";
import { cleanPdfSelection, quoteForNote, restoreFormulas } from "@/lib/pdfSelection";
import { useStore, type PassageAttachment } from "@/store";
import { QK } from "@/lib/queryKeys";
import { highlightColor, highlightRects, sameHighlightRects, type Box, type HighlightColor, type PageRect } from "./highlights";
import { isHighlight, type StickyNote } from "./stickyNotes";
import { addHighlight, deleteStickyNote, openStickyNote, recolorHighlight } from "./stickyNotesStore";
import { textLayerOffsets } from "./textLayerRange";

export interface Passage {
  paperId: string;
  page: number;
  side: "original" | "translated";
  /** Where the selection starts, as a fraction of the page's height. */
  anchorY: number;
  offsets: ReturnType<typeof textLayerOffsets>;
  /** The selected text's rectangles on the page, for a highlight (see highlights.ts). */
  rects: PageRect[];
  /** The passage as it is quoted: its lines joined, with the math of a translated page restored. */
  text: Promise<string>;
}

/** The selection's range when it is inside `area` and not empty, or null. */
export function selectedRange(area: HTMLElement | null): Range | null {
  const selection = window.getSelection();
  if (!area || !selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return area.contains(range.commonAncestorContainer) ? range : null;
}

/** The translated PDF shows inline math as images; take the passage with its math from the translation text. */
async function translatedPassage(raw: string, paperId: string, page: number): Promise<string> {
  try {
    const { blocks } = await unwrap(api.GET("/api/papers/{paper_id}/translation-text/{page}", { params: { path: { paper_id: paperId, page } } }));
    return restoreFormulas(raw, blocks) ?? cleanPdfSelection(raw);
  } catch {
    return cleanPdfSelection(raw);
  }
}

/**
 * Client rectangles of the text-layer text in `range`, text node by text node: the boxes of whole
 * elements (a span, pdf.js's endOfContent filler) would cover more than the text.
 */
export function selectionTextBoxes(range: Range): Box[] {
  const boxes: Box[] = [];
  const add = (node: Text, start: number, end: number) => {
    if (end <= start || !node.parentElement?.closest(".textLayer")) return;
    const part = document.createRange();
    part.setStart(node, start);
    part.setEnd(node, end);
    for (const rect of Array.from(part.getClientRects())) boxes.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  };
  const root = range.commonAncestorContainer;
  if (root instanceof Text) {
    add(root, range.startOffset, range.endOffset);
    return boxes;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || !range.intersectsNode(node)) continue;
    add(node, node === range.startContainer ? range.startOffset : 0, node === range.endContainer ? range.endOffset : node.length);
  }
  return boxes;
}

/** The passage selected in `area` (a pane), or null when no text of the open paper is selected there. */
export function capturePassage(area: HTMLElement | null, translated: boolean): Passage | null {
  const range = selectedRange(area);
  const raw = range ? window.getSelection()?.toString() ?? "" : "";
  const cleaned = cleanPdfSelection(raw);
  const { activePaperId, currentPage } = useStore.getState();
  if (!range || !cleaned || !activePaperId) return null;
  const pageRect = area?.querySelector(".react-pdf__Page")?.getBoundingClientRect();
  const first = range.getClientRects()[0];
  const anchorY = first && pageRect?.height ? Math.max(0, Math.min(1, (first.top - pageRect.top) / pageRect.height)) : 0;
  return {
    paperId: activePaperId,
    page: currentPage,
    side: translated ? "translated" : "original",
    anchorY,
    offsets: textLayerOffsets(range),
    rects: pageRect ? highlightRects(selectionTextBoxes(range), pageRect) : [],
    text: translated ? translatedPassage(raw, activePaperId, currentPage) : Promise.resolve(cleaned),
  };
}

/** Where a quote comes from, linked to its page: [p.3](papeer://<id>/3)（訳文）. */
export function passageSource({ paperId, page, side }: Pick<Passage, "paperId" | "page" | "side">): string {
  return citationLink(paperId, page) + (side === "translated" ? "（訳文）" : "");
}

async function attachment(passage: Passage): Promise<PassageAttachment> {
  return {
    id: crypto.randomUUID(), paperId: passage.paperId, page: passage.page, side: passage.side,
    text: await passage.text, anchor_y: passage.anchorY, ...passage.offsets,
  };
}

/** Whether the paper the passage came from is still the one open. */
const stillOpen = (passage: Passage) => useStore.getState().activePaperId === passage.paperId;

/** Asks the chat, beside the reader, to explain the passage. */
export async function explainPassage(passage: Passage): Promise<void> {
  const item = await attachment(passage);
  if (!stillOpen(passage)) return;
  const store = useStore.getState();
  store.setChatDraft({ paperId: item.paperId, text: "この箇所をわかりやすく説明してください。", send: true, attachments: [item] });
  store.openSidePanel("chat");
}

/** Attaches the passage to the chat beside the reader, which stays on screen so that more can be attached. */
export async function attachPassage(passage: Passage): Promise<void> {
  const item = await attachment(passage);
  if (!stillOpen(passage)) return;
  const store = useStore.getState();
  store.addChatAttachment(item);
  store.openSidePanel("chat");
  const count = useStore.getState().chatAttachments.filter((x) => x.paperId === item.paperId).length;
  store.setStatus(`チャットに添付しました（${count}件）。右のチャットで送信できます。`);
}

/** Quotes the passage at the end of the memo beside the reader, with a link to its page. */
export async function quotePassageInNote(passage: Passage): Promise<void> {
  const text = await passage.text;
  if (!stillOpen(passage)) return;
  const store = useStore.getState();
  store.setNoteInsert({ paperId: passage.paperId, text: quoteForNote(text, passageSource(passage)) });
  store.openSidePanel("notes");
}

/** Opens the sticky-note dialog for the passage. */
export async function stickyNoteForPassage(passage: Passage): Promise<void> {
  const quote = await passage.text;
  void openStickyNote({ paperId: passage.paperId, page: passage.page, side: passage.side, quote, anchorY: passage.anchorY });
}

/** Same range and colour removes the highlight; another colour recolours it. */
export async function highlightPassage(passage: Passage, color: HighlightColor, client: QueryClient): Promise<boolean> {
  const store = useStore.getState();
  if (!passage.rects.length) {
    store.setStatus("この選択はハイライトできません。PDFの文章を選び直してください。");
    return false;
  }
  try {
    const notes = await client.fetchQuery({
      queryKey: [QK.stickyNotes, passage.paperId],
      queryFn: async () => await unwrap(api.GET("/api/papers/{paper_id}/sticky-notes", {
        params: { path: { paper_id: passage.paperId } },
      })) as StickyNote[],
    });
    const existing = [...notes].reverse().find(item => isHighlight(item) && item.page === passage.page && item.side === passage.side
      && sameHighlightRects(item.rects, passage.rects));
    if (existing) {
      if (highlightColor(existing.color).id === color) {
        if (!await deleteStickyNote(existing, client)) return false;
        useStore.getState().setStatus("ハイライトを削除しました。付箋タブの「削除を取り消す」で戻せます。");
      } else {
        await recolorHighlight(existing, color, client);
        useStore.getState().setStatus(`ハイライトの色を変更しました（${highlightColor(color).label}）。`);
      }
      return true;
    }
    await addHighlight({ ...passage, text: await passage.text }, color, client);
    useStore.getState().setStatus(`ハイライトしました（${highlightColor(color).label}）。クリックすると色の変更・メモ・削除ができます。`);
    return true;
  } catch (error) {
    showError(error, "ハイライトできませんでした");
    return false;
  }
}

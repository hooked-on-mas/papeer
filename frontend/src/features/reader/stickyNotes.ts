import { citationLink } from "../../lib/markdownUrl.ts";
import { highlightColor, type PageRect } from "./highlights.ts";

export type StickyNote = {
  id: number; paper_id: string; paper_title?: string; paper_name?: string;
  page_id?: string | null; page: number; side: "original" | "translated"; quote: string; label: string; note: string;
  anchor_y: number; anchor_x: number; created_at: string;
  /** "highlight": text highlighted from a selection (see highlights.ts). Missing from an older sidecar. */
  kind?: "note" | "highlight"; color?: string; rects?: PageRect[];
};
export type StickyDraft = {
  paperId: string; pageId?: string | null; page: number; side: "original" | "translated"; quote: string;
  anchorY: number; anchorX?: number; id?: number; label?: string; note?: string; kind?: "note" | "highlight";
};
export type StickyFilters = {
  scope: "paper" | "all"; query: string; label: string; side: string; sort: "page" | "newest";
  /** "" for both, or only sticky notes or highlights. */
  kind: "" | "note" | "highlight";
};
export const stickyColors: Record<string, string> = {
  "重要": "border-amber-300 bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-100",
  "疑問": "border-purple-300 bg-purple-50 text-purple-950 dark:bg-purple-950 dark:text-purple-100",
  "あとで確認": "border-blue-300 bg-blue-50 text-blue-950 dark:bg-blue-950 dark:text-blue-100",
  "引用": "border-emerald-300 bg-emerald-50 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100",
  "確認済み": "border-border bg-muted text-muted-foreground",
};
export const isHighlight = (item: Pick<StickyNote, "kind">) => item.kind === "highlight";
/** How the list names an item: a sticky note by its label, a highlight by its colour (and label, if any). */
export function stickyTitle(item: Pick<StickyNote, "kind" | "color" | "label">): string {
  if (!isHighlight(item)) return item.label;
  const name = `ハイライト（${highlightColor(item.color).label}）`;
  return item.label ? `${name}・${item.label}` : name;
}
export const stickyQuote = (quote: string) => /^(p\.\d+ の読書位置|書き込み（\d+件）の位置)$/.test(quote) ? "" : quote;
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
export function filterStickyNotes(notes: StickyNote[], paperId: string, filters: StickyFilters): StickyNote[] {
  const terms = normalize(filters.query).trim().split(/\s+/).filter(Boolean);
  return notes.filter(item => {
    const text = normalize(`${item.paper_title ?? ""} ${item.paper_name ?? ""} ${stickyQuote(item.quote)} ${item.note} ${stickyTitle(item)} p.${item.page}`);
    return (filters.scope === "all" || item.paper_id === paperId) && (!filters.label || item.label === filters.label)
      && (!filters.side || item.side === filters.side) && (!filters.kind || (item.kind ?? "note") === filters.kind)
      && terms.every(term => text.includes(term));
  }).sort((a, b) => filters.sort === "newest" ? b.id - a.id
    : (a.paper_title ?? a.paper_id).localeCompare(b.paper_title ?? b.paper_id, "ja") || a.paper_id.localeCompare(b.paper_id)
      || a.page - b.page || a.side.localeCompare(b.side) || a.anchor_y - b.anchor_y || a.id - b.id);
}

export const noteDraft = (note: StickyNote): StickyDraft => ({ ...note, paperId: note.paper_id, pageId: note.page_id, anchorY: note.anchor_y, anchorX: note.anchor_x });

/** Indents every line of `text` into a list item, with `prefix` ("> " for a quote) after the indent. */
const indented = (text: string, prefix = "") => text.split("\n").map(line => `  ${prefix}${line}`.trimEnd()).join("\n");

/**
 * One paper's sticky notes (and highlights, with `includeHighlights`) as Markdown for its memo, in page
 * order: a list whose items start with a p.N link to the page (papeer://<paper id>/<page>, which the
 * memo opens in the reader), then the quote and the note. Empty when there is nothing to write.
 */
export function stickyNotesMarkdown(notes: readonly StickyNote[], { includeHighlights, date }: { includeHighlights: boolean; date: string }): string {
  const items = notes.filter(item => includeHighlights || !isHighlight(item))
    .slice().sort((a, b) => a.page - b.page || a.side.localeCompare(b.side) || a.anchor_y - b.anchor_y || a.id - b.id);
  if (!items.length) return "";
  const heading = `## ${includeHighlights && items.some(isHighlight) ? "付箋とハイライト" : "付箋"}（${date} 書き出し）`;
  const entries = items.map(item => {
    const side = item.side === "translated" ? "（訳文）" : "";
    const parts = [`- ${citationLink(item.paper_id, item.page)}${side} ${stickyTitle(item)}`];
    const quote = stickyQuote(item.quote).trim();
    if (quote) parts.push(indented(quote, "> "));
    if (item.note.trim()) parts.push(indented(item.note.trim()));
    return parts.join("\n\n");
  });
  return `${heading}\n\n${entries.join("\n")}`;
}

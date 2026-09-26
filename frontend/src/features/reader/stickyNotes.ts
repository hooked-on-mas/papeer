export type StickyNote = {
  id: number; paper_id: string; paper_title?: string; paper_name?: string;
  page: number; side: "original" | "translated"; quote: string; label: string; note: string;
  anchor_y: number; anchor_x: number; created_at: string;
};
export type StickyDraft = {
  paperId: string; page: number; side: "original" | "translated"; quote: string;
  anchorY: number; anchorX?: number; id?: number; label?: string; note?: string;
};
export type StickyFilters = { scope: "paper" | "all"; query: string; label: string; side: string; sort: "page" | "newest" };
export const stickyColors: Record<string, string> = {
  "重要": "border-amber-300 bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-100",
  "疑問": "border-purple-300 bg-purple-50 text-purple-950 dark:bg-purple-950 dark:text-purple-100",
  "あとで確認": "border-blue-300 bg-blue-50 text-blue-950 dark:bg-blue-950 dark:text-blue-100",
  "引用": "border-emerald-300 bg-emerald-50 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100",
  "確認済み": "border-border bg-muted text-muted-foreground",
};
export const stickyQuote = (quote: string) => /^(p\.\d+ の読書位置|書き込み（\d+件）の位置)$/.test(quote) ? "" : quote;
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
export function filterStickyNotes(notes: StickyNote[], paperId: string, filters: StickyFilters): StickyNote[] {
  const terms = normalize(filters.query).trim().split(/\s+/).filter(Boolean);
  return notes.filter(item => {
    const text = normalize(`${item.paper_title ?? ""} ${item.paper_name ?? ""} ${stickyQuote(item.quote)} ${item.note} ${item.label} p.${item.page}`);
    return (filters.scope === "all" || item.paper_id === paperId) && (!filters.label || item.label === filters.label)
      && (!filters.side || item.side === filters.side) && terms.every(term => text.includes(term));
  }).sort((a, b) => filters.sort === "newest" ? b.id - a.id
    : (a.paper_title ?? a.paper_id).localeCompare(b.paper_title ?? b.paper_id, "ja") || a.paper_id.localeCompare(b.paper_id)
      || a.page - b.page || a.side.localeCompare(b.side) || a.anchor_y - b.anchor_y || a.id - b.id);
}

export const noteDraft = (note: StickyNote): StickyDraft => ({ ...note, paperId: note.paper_id, anchorY: note.anchor_y, anchorX: note.anchor_x });

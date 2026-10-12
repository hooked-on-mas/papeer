import type { PaperData } from "@/api/hooks";
import { orderFields } from "./librarySort.ts";

/**
 * Updating one paper's row in the loaded library lists (GET /api/papers) instead of loading them again.
 *
 * The sidecar announces a change of one paper as paper.changed with the columns written (sidecar/deps.py,
 * paper_changed); a job of one paper ending changes only that paper too. The list itself is loaded again only
 * when the row cannot simply be replaced (see withPaperRow).
 */

/**
 * `rows` (a list for `query` and `sort`) with the paper's row replaced by `paper`, or without it when
 * `paper` is null (removed). null when the list must be loaded again instead: the paper is not in it
 * (new, or filtered out), whether it still matches `query` is the sidecar's call, or its place in the
 * order may have changed (a value the order goes by changed: the title, year, author or when it was opened).
 */
export function withPaperRow(rows: PaperData[], paperId: string, paper: PaperData | null, query: string, sort: number): PaperData[] | null {
  const index = rows.findIndex((row) => row.id === paperId);
  if (paper === null) return index < 0 ? rows : rows.filter((row) => row.id !== paperId);
  if (index < 0 || query.trim()) return null;
  if (orderFields(sort).some((field) => (rows[index][field] ?? null) !== (paper[field] ?? null))) return null;
  // The list rows leave out the memo (papeer/core/library_list.py, paper_row).
  const row: PaperData = { ...paper };
  return rows.map((current, i) => (i === index ? row : current));
}

/**
 * `rows` with the paper shown in the folder `collection` at once, when it has just moved there, before
 * paper.changed brings its row as the sidecar keeps it (withPaperRow). The same array when the paper is
 * not in the list (the event puts it in) or is there already. The folder is not a value the lists are
 * ordered or searched by, so the row keeps its place.
 */
export function withPaperCollection(rows: PaperData[], paperId: string, collection: string): PaperData[] {
  const index = rows.findIndex((row) => row.id === paperId);
  if (index < 0 || (rows[index].collection_name ?? "") === collection) return rows;
  return rows.map((row, i) => (i === index ? { ...row, collection_name: collection } : row));
}

export type PaperChangeEffects = {
  /** The paper's row and the paper itself are loaded again. */
  row: boolean;
  collections: boolean;
  tags: boolean;
};

/**
 * What a paper.changed event makes stale besides the library search (which covers the memo, the metadata
 * and the translation): `fields` are the papers columns written, undefined when anything may have changed.
 * A memo saved as it is typed reloads nothing else: the list does not show it, and the memo pane keeps its own text.
 */
export function paperChangeEffects(fields: string[] | undefined): PaperChangeEffects {
  if (fields === undefined) return { row: true, collections: true, tags: true };
  return {
    row: fields.length > 0,
    collections: fields.includes("collection_name"),
    tags: fields.includes("tags"),
  };
}

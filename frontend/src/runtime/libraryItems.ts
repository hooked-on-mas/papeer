import type { LibraryItemView } from "./contracts.ts";

/** Structural input accepts both a desktop PaperData row and a published snapshot row. */
export type LibraryItemSource = {
  id: string;
  title?: unknown;
  original_name?: unknown;
  first_author?: unknown;
  publication_year?: unknown;
  kind?: unknown;
  parent_id?: unknown;
  collection_name?: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function libraryItemTitle(row: Pick<LibraryItemSource, "first_author" | "publication_year" | "title" | "original_name">): string {
  const author = text(row.first_author).trim();
  const year = text(row.publication_year).trim();
  const prefix = [author, year ? `(${year})` : ""].filter(Boolean).join(" ");
  const title = text(row.title) || text(row.original_name) || "無題";
  return prefix ? `${prefix} ${title}` : title;
}

export function toLibraryItem(row: LibraryItemSource): LibraryItemView {
  return Object.freeze({
    id: row.id,
    title: libraryItemTitle(row),
    displayTitle: text(row.title) || libraryItemTitle(row),
    kind: row.kind == null || row.kind === "pdf" ? "pdf" : row.kind === "notebook" ? "notebook" : "unknown",
    parentId: text(row.parent_id) || null,
    collectionName: text(row.collection_name),
  });
}

export function toLibraryItems(rows: readonly LibraryItemSource[]): LibraryItemView[] {
  return rows.map(toLibraryItem);
}

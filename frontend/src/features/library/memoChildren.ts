import type { PaperChild } from "./treeLines.ts";

/** Five small rows, then a route to the complete list in the memo pane. Counts use the same input. */
export function memoChildren(rows: readonly { id: string; title: string; format?: "md" | "html" }[], notebooks: readonly { id: string; title: string }[] = [],
  links: readonly { id: string; title: string; original_name?: string | null; collection_name?: string }[] = []): PaperChild[] {
  const all: PaperChild[] = [...notebooks.map(row => ({ kind: "owned" as const, id: row.id, title: row.title })),
    ...rows.map(row => ({ kind: "attachment" as const, id: row.id, title: row.title, ...(row.format ? { format: row.format } : {}) })),
    ...links.map(row => ({ kind: "link" as const, id: row.id, title: row.title || row.original_name || row.id, collection: row.collection_name }))];
  const shown = all.slice(0, 5);
  if (all.length > 5) shown.push({ kind: "more", id: "more", title: `ほか ${all.length - 5}件` });
  return shown;
}

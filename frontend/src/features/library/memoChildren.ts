import type { PaperChild } from "./treeLines.ts";

/** Five small rows, then a route to the complete list in the memo pane. Counts use the same input. */
export function memoChildren(rows: readonly { id: string; title: string }[]): PaperChild[] {
  const shown: PaperChild[] = rows.slice(0, 5).map(row => ({ kind: "attachment", id: row.id, title: row.title }));
  if (rows.length > 5) shown.push({ kind: "more", id: "more", title: `ほか ${rows.length - 5}件` });
  return shown;
}

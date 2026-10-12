import type { PaperData } from "../../api/hooks.ts";
import { canLinkItems, itemCapabilities } from "../../lib/itemKinds.ts";

export type ItemLink = { a: string; b: string };

/** Both directions share the same edge; only loaded original items become child rows. */
export function linkedItemsByOwner(links: readonly ItemLink[], items: readonly PaperData[]): Map<string, PaperData[]> {
  const byId = new Map(items.map(item => [item.id, item]));
  const result = new Map<string, PaperData[]>();
  for (const { a, b } of links) {
    for (const [owner, target] of [[a, b], [b, a]]) {
      const row = byId.get(target);
      if (!row) continue;
      const rows = result.get(owner) ?? [];
      if (!rows.some(existing => existing.id === row.id)) rows.push(row);
      result.set(owner, rows);
    }
  }
  for (const rows of result.values()) rows.sort((a, b) => (a.title || a.original_name || a.id).localeCompare(b.title || b.original_name || b.id));
  return result;
}

/** A multi-selection links as one action only when every selected original is a paper. */
export function canDropLink(ids: readonly string[], target: PaperData | undefined, items: readonly PaperData[]): boolean {
  if (!target || !itemCapabilities(target).linkNotebook || !ids.length) return false;
  const byId = new Map(items.map(item => [item.id, item]));
  return ids.every(id => id !== target.id && canLinkItems(byId.get(id), target));
}

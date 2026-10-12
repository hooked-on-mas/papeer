export type DocumentChoice<T extends { id: string }> =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "missing"; id: string }
  | { kind: "document"; document: T };

/** Which document the pane shows: the first one only when nothing was chosen; a chosen one that is no longer
 * there is "missing" (never another document in its place, which would pass B off as the A that was asked for). */
export function chooseDocument<T extends { id: string }>(documents: readonly T[] | undefined, selected: string | undefined): DocumentChoice<T> {
  if (!documents) return { kind: "loading" };
  if (!selected) return documents[0] ? { kind: "document", document: documents[0] } : { kind: "empty" };
  const found = documents.find(row => row.id === selected);
  return found ? { kind: "document", document: found } : { kind: "missing", id: selected };
}

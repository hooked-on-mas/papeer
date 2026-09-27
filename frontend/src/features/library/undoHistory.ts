/**
 * The library's undo history (the store's moveHistory): what its button says, and what is left of it
 * once papers are deleted. Pure, so that it can be tested; app/actions.ts records and undoes.
 */
import type { LibraryUndoRecord, MoveRecord } from "../../store/index.ts";

/** The label of the button that undoes `record`, the newest in the history. */
export function undoLabel(record: LibraryUndoRecord | undefined): string {
  if (record && "kind" in record) {
    return record.kind === "delete-folder" ? `「${record.path}」の削除を元に戻す` : `${record.moves.length}件の論文の移動を元に戻す`;
  }
  return "論文の移動を元に戻す";
}

/** The history without the moves of the papers `ids` (just deleted); papers moved together keep the others'. */
export function forgetPapers(history: LibraryUndoRecord[], ids: ReadonlySet<string>): LibraryUndoRecord[] {
  return history.flatMap((entry): LibraryUndoRecord[] => {
    if (!("kind" in entry)) return ids.has(entry.paperId) ? [] : [entry];
    if (entry.kind !== "move-papers") return [entry];
    const moves = entry.moves.filter((m) => !ids.has(m.paperId));
    return moves.length === entry.moves.length ? [entry] : moves.length ? [{ ...entry, moves }] : [];
  });
}

/** Papers moved together, as the history records them: a single move as before, several as one record. */
export function movesRecord(moves: MoveRecord[]): LibraryUndoRecord | null {
  if (!moves.length) return null;
  return moves.length === 1 ? moves[0] : { kind: "move-papers", moves };
}

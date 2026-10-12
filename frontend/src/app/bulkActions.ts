import { confirmItemDeletion } from "@/features/notebooks/NotebookDialogs";
/**
 * Actions on the papers selected in the library: moving them to a folder, tagging them or taking a tag
 * off, setting their reading status, deleting them. The sidecar has no bulk API, so each paper is sent
 * its own request in turn (features/library/bulkOutcome.ts), which the automatic sync may hold back
 * and send again like any other (libraryBusy.ts); the status bar then says how many were done, and an
 * error dialog which could not be and why. One runs at a time, holding the library's reloads until it
 * reloads the library once at the end, and can be stopped (bulkState.ts). A single paper (its own context
 * menu, or a selection of one) goes the way it always has (actions.ts).
 */
import { api, ApiError, unwrap } from "@/api/client";
import { patchPaper } from "@/api/mutations";
import { askText } from "@/components/AppDialogs";
import { showError } from "@/components/errorDialog";
import { clearJobFailure } from "@/features/jobs/jobFailures";
import { useStore, type MoveRecord } from "@/store";
import { bulkReport, runBulk, type BulkOutcome, type BulkStep, type BulkWording } from "@/features/library/bulkOutcome";
import {
  deletePaper, expandToCollection, forgetPapers, listedTitle, movePaper, paper,
  recordMoves, refreshAfterChanges, setPaperReadStatus, stopsAllRequests, tagPaper, changePaperTag,
} from "./actions";
import { MAX_TAG_LENGTH } from "@/features/notes/tagOptions";
import { normalizeCollection } from "@/lib/collectionPath";
import { pyStrip } from "@/lib/pyWhitespace";
import { BULK_BUSY_MESSAGE, beginBulk, isBulkRunning } from "./bulkState";
import { forgetDraftsOfPapers } from "@/lib/pendingSaves";

/**
 * Runs `step` on each paper and reports it, then `finish` with the outcome, while the library's reloads
 * are held; `finish` reloads the library. Null when another action is still running.
 */
async function eachPaper<R>(ids: string[], working: string, step: (id: string) => Promise<BulkStep>, wording: BulkWording,
  finish: (outcome: BulkOutcome<string>) => Promise<R>): Promise<R | null> {
  const { setStatus } = useStore.getState();
  const run = beginBulk(working, ids.length);
  if (!run) {
    setStatus(BULK_BUSY_MESSAGE);
    return null;
  }
  try {
    setStatus(`${working}…`);
    const outcome = await runBulk(ids, step, { stopsAll: stopsAllRequests, progress: run.progress, signal: run.signal });
    const report = bulkReport(outcome, listedTitle, wording);
    const result = await finish(outcome);
    setStatus(report.status);
    if (report.error) showError(report.error.message, report.error.title);
    return result;
  } finally {
    run.end();
  }
}

/** Moves the papers to the folder `collection`, as one move to undo; whether any moved. */
export async function movePapers(ids: string[], collection: string): Promise<boolean> {
  if (ids.length === 1) return movePaper(ids[0], collection);
  const destination = normalizeCollection(collection);
  const label = destination || "未分類";
  const moves: MoveRecord[] = [];
  const moved = await eachPaper(ids, `「${label}」へ移動中`, async (id) => {
    const previous = normalizeCollection((await paper(id)).collection_name || "");
    if (previous === destination) return "unchanged";
    await patchPaper(id, { collection: destination });
    moves.push({ paperId: id, from: previous, to: destination });
    return "done";
  }, {
    done: (n) => `${n}件の論文を「${label}」へ移動しました。`,
    unchanged: (n) => `${n}件はすでに「${label}」にあります。`,
    failed: (n) => `${n}件の論文を移動できませんでした`,
  }, async () => {
    recordMoves(moves);
    const current = useStore.getState();
    if (current.selectedFolder === null && moves.some((m) => m.paperId === current.activePaperId)) current.setCurrentCollection(destination);
    // Open before the reload, so that the papers show in their folder and stay selected.
    expandToCollection(destination);
    await refreshAfterChanges();
    return moves.length > 0;
  });
  return moved ?? false;
}

/** Asks for a folder name and moves the papers there. */
export async function movePapersToNewCollection(ids: string[], current: string): Promise<void> {
  const name = await askText("新しい分類", "フォルダー名（例：制御工学 / 読書会）", current);
  if (name !== null && normalizeCollection(name)) await movePapers(ids, name);
}

/** Puts the tag `tag` on the papers (`add`), or takes it off. */
export async function tagPapers(ids: string[], tag: string, add: boolean): Promise<void> {
  if (ids.length === 1) return tagPaper(ids[0], tag, add);
  // In each paper's turn with the changes made to it one by one (tagQueue.ts), so that neither is lost.
  await eachPaper(ids, add ? `タグ「${tag}」を付けています` : `タグ「${tag}」を外しています`,
    (id) => changePaperTag(id, tag, add), add ? {
    done: (n) => `${n}件の論文にタグ「${tag}」を付けました。`,
    unchanged: (n) => `${n}件にはすでに付いています。`,
    failed: (n) => `${n}件の論文にタグを付けられませんでした`,
  } : {
    done: (n) => `${n}件の論文からタグ「${tag}」を外しました。`,
    unchanged: (n) => `${n}件には付いていませんでした。`,
    failed: (n) => `${n}件の論文からタグを外せませんでした`,
  }, refreshAfterChanges);
}

/**
 * Asks for the name of a tag, which need not exist yet, and puts it on the papers (one, from its context
 * menu, or those selected together). A new name becomes one of the tag choices as it is saved.
 */
export async function tagPapersWithNew(ids: string[]): Promise<void> {
  const typed = await askText("新しいタグ", ids.length > 1 ? `${ids.length}件の論文に付けるタグの名前` : "論文に付けるタグの名前", "");
  const name = typed == null ? "" : pyStrip(typed);
  if (!name) return;
  if (Array.from(name).length > MAX_TAG_LENGTH) {
    showError(`タグ名は${MAX_TAG_LENGTH}文字までです。`, "タグを付けられませんでした");
    return;
  }
  await tagPapers(ids, name, true);
}

/** Sets the papers' reading status. */
export async function setPapersReadStatus(ids: string[], status: string): Promise<void> {
  if (ids.length === 1) {
    await setPaperReadStatus(ids[0], status);
    return;
  }
  await eachPaper(ids, `読書状態を「${status}」にしています`, async (id) => {
    if (((await paper(id)).read_status ?? "") === status) return "unchanged";
    await patchPaper(id, { read_status: status });
    return "done";
  }, {
    done: (n) => `${n}件の論文の読書状態を「${status}」にしました。`,
    unchanged: (n) => `${n}件はすでに「${status}」です。`,
    failed: (n) => `${n}件の論文の読書状態を変更できませんでした`,
  }, refreshAfterChanges);
}

/** The titles a confirmation lists; more are counted. */
const LISTED_TITLES = 5;

/**
 * Deletes the papers after asking, with how many and which; this cannot be undone. Whether any was
 * deleted, once the library shows them gone.
 */
export async function deletePapers(ids: string[]): Promise<boolean> {
  if (ids.length === 1) return deletePaper(ids[0]);
  // Before asking, rather than after a confirmation that would then do nothing.
  if (isBulkRunning()) {
    useStore.getState().setStatus(BULK_BUSY_MESSAGE);
    return false;
  }
  const titles = ids.slice(0, LISTED_TITLES).map((id) => `・${listedTitle(id)}`);
  if (ids.length > LISTED_TITLES) titles.push(`ほか${ids.length - LISTED_TITLES}件`);
  let choice;
  try { choice = await confirmItemDeletion(ids, `選択した${ids.length}件をライブラリから削除しますか？\n${titles.join("\n")}\n\n訳文・サマリー・チャット履歴・メモも削除され、元に戻せません。`); }
  catch (error) { showError(error); return false; }
  if (!choice) return false;
  const deleted = await eachPaper(ids, "削除中", async (id) => {
    try {
      await unwrap(api.DELETE("/api/papers/{paper_id}", { params: { path: { paper_id: id }, query: { keep_notebooks: choice.keep } } }));
    } catch (error) {
      // Already gone, which is what was asked.
      if (error instanceof ApiError && error.status === 404) return "unchanged";
      throw error;
    }
    return "done";
  }, {
    done: (n) => `${n}件の論文を削除しました。`,
    unchanged: (n) => `${n}件はすでに削除されていました。`,
    failed: (n) => `${n}件の論文を削除できませんでした`,
  }, async (outcome) => {
    const gone = new Set([...outcome.done, ...outcome.unchanged]);
    if (!choice.keep) choice.children.forEach(row => { if (row.parent_id && gone.has(row.parent_id)) gone.add(row.id); });
    const s = useStore.getState();
    if (s.activePaperId !== null && gone.has(s.activePaperId)) s.setActivePaperId(null);
    for (const id of gone) clearJobFailure(id);
    forgetDraftsOfPapers(gone);
    useStore.setState({ moveHistory: forgetPapers(useStore.getState().moveHistory, gone) });
    await refreshAfterChanges();
    return gone.size > 0;
  });
  return deleted ?? false;
}

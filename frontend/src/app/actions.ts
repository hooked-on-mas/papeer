import { api, ApiError, unwrap } from "@/api/client";
import { getPaper, type PaperData, type ReadingData } from "@/api/hooks";
import { invalidate, patchPaper } from "@/api/mutations";
import { askConfirm, askText, showMessage } from "@/components/AppDialogs";
import { showStartedJob, startJob } from "@/features/jobs/jobEvents";
import { showError } from "@/components/errorDialog";
import { clearJobFailure } from "@/features/jobs/jobFailures";
import { joinPath, shell } from "@/shell";
import { useStore, type MovePapersRecord, type MoveRecord } from "@/store";
import { bibtexFilename, paperExportFilename } from "@/lib/exportFilename";
import { addPendingImports, removePendingImports, usePendingImports } from "./pendingImports";
import { showSaved } from "./savedNotice";
import { emitAppEvent } from "@/lib/appEvents";
import { QK } from "@/lib/queryKeys";
import { queryClient } from "@/lib/queryClient";
import { summaryQuestionKey, summaryStartQuestion } from "@/features/summary/summaryStart";
import { countInFolder, isInsideFolder, normalizeCollection } from "@/features/library/libraryTree";
import { bulkReport, runBulk } from "@/features/library/bulkOutcome";
import { forgetPapers, movesRecord, undoLabel } from "@/features/library/undoHistory";
import { LIBRARY_BUSY } from "@/lib/libraryBusy";
import { BULK_BUSY_MESSAGE, beginBulk } from "./bulkState";
import { applyTagChange, createTagQueue } from "@/lib/tagQueue";
import { forgetDraftsOfPapers } from "@/lib/pendingSaves";

/** Reloads the library (each paper's own query too); the promise settles once the lists shown have been fetched again. */
export function refreshLibrary(): Promise<void> {
  return invalidate({ kind: "folders" });
}

export const paper = getPaper;

/**
 * Reloads what the library.changed event reloads (jobEvents.ts): the lists, the library's search and the
 * tag choices. For actions on several papers, which hold that event's reloads until they are done.
 */
export function refreshAfterChanges(): Promise<void> {
  return invalidate({ kind: "library" });
}

/** The paper's name as the library last listed it, for messages about papers that may be gone. */
export function listedTitle(paperId: string): string {
  for (const [, data] of queryClient.getQueriesData<PaperData[]>({ queryKey: [QK.papers, "list"] })) {
    const found = data?.find((p) => p.id === paperId);
    if (found) return found.title || found.original_name || paperId;
  }
  return paperId;
}

/**
 * A failure after which the requests that follow would fail too, so that an action on several papers
 * stops sending them: the sidecar not answering, or the library held by a sync, backup or restore
 * that the request did not wait out (libraryBusy.ts).
 */
export function stopsAllRequests(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.code === LIBRARY_BUSY);
}

// --- The undo history -------------------------------------------------------------------

export { forgetPapers, undoLabel };

/** Records papers moved together: a single move as before, several as one record undone together. */
export function recordMoves(moves: MoveRecord[]): void {
  const record = movesRecord(moves);
  if (record) useStore.getState().setMoveHistory([...useStore.getState().moveHistory, record]);
}

export { normalizeCollection };

// --- Import ---------------------------------------------------------------------------

export async function importPaths(paths: string[], collection?: string): Promise<void> {
  // A file dropped again while it is still being added would only duplicate its placeholder row.
  const pending = new Set(usePendingImports.getState().items.map((i) => i.path));
  const pdfs = paths.filter((p) => p.toLowerCase().endsWith(".pdf") && !pending.has(p));
  const { currentCollection, setStatus } = useStore.getState();
  if (!pdfs.length) {
    if (paths.some((p) => pending.has(p))) setStatus("そのPDFはすでに追加中です。");
    return;
  }
  // Show the files right away; extraction can take a while for long papers, and the sidecar
  // queues this import behind any that are still running.
  const destination = normalizeCollection(collection ?? currentCollection);
  addPendingImports(pdfs, destination);
  expandToCollection(destination);
  try {
    // Rows still pending at the end (failure, cancel, lost events) go once the list has caught up.
    await startJob("/api/papers/import", { paths: pdfs, collection: destination }, { kind: "import", paperId: null },
      () => void invalidate({ kind: "imported" }).finally(() => removePendingImports(pdfs)));
  } catch (error) {
    removePendingImports(pdfs);
    showError(error, "PDFを追加できませんでした");
  }
}

export async function importPdfs(): Promise<void> {
  const paths = await shell.openFiles([{ name: "PDF", extensions: ["pdf"] }]);
  await importPaths(paths);
}

// --- Moving papers between folders ------------------------------------------------------

export function expandToCollection(collection: string): void {
  const { expandedCollections, setExpandedCollections } = useStore.getState();
  if (expandedCollections === null) return;
  const parts = collection ? collection.split(" / ") : [];
  const ancestors = parts.map((_, i) => parts.slice(0, i + 1).join(" / "));
  const next = new Set(expandedCollections);
  ancestors.forEach((a) => next.add(a));
  if (!collection) next.add("");
  setExpandedCollections([...next]);
}

export async function movePaper(paperId: string, collection: string, record = true): Promise<boolean> {
  const destination = normalizeCollection(collection);
  const store = useStore.getState();
  try {
    const previous = normalizeCollection((await paper(paperId)).collection_name || "");
    if (previous === destination) return false;
    await patchPaper(paperId, { collection: destination });
    if (record) recordMoves([{ paperId, from: previous, to: destination }]);
  } catch (error) {
    showError(error, "分類を変更できませんでした");
    return false;
  }
  const current = useStore.getState();
  if (paperId === current.activePaperId && current.selectedFolder === null) current.setCurrentCollection(destination);
  expandToCollection(destination);
  // The paper as the sidecar keeps it; its row in the lists, and the folders, follow from paper.changed.
  void invalidate({ kind: "paper", paperId, collection: true });
  store.setStatus(`「${destination || "未分類"}」へ移動しました。`);
  return true;
}

// --- Tags and reading status of one paper ---------------------------------------------------

// Changes waiting to be saved are shown over the paper as loaded (shownTags, shownStatus), which a load
// in between may still give from before them; the screen follows them through useOrganizing.ts.
const organizingListeners = new Set<() => void>();
let organizingVersion = 0;

function organizingChanged(): void {
  organizingVersion++;
  for (const listener of organizingListeners) listener();
}

export function subscribeOrganizing(listener: () => void): () => void {
  organizingListeners.add(listener);
  return () => { organizingListeners.delete(listener); };
}

export function currentOrganizing(): number {
  return organizingVersion;
}

// Tags are sent as differences, each applied in its turn to the tags the sidecar holds (tagQueue.ts).
const tagQueue = createTagQueue({
  read: async (paperId) => (await paper(paperId)).tags ?? [],
  write: async (paperId, tags) => { await patchPaper(paperId, { tags }); },
  onWaitingChange: organizingChanged,
});

/** The paper's tags as loaded (`tags`), with its changes not saved yet: what the screen shows. */
export function shownTags(paperId: string, tags: readonly string[]): string[] {
  return tagQueue.shown(paperId, tags);
}

/**
 * Puts the tag on the paper or takes it off in the paper's turn (tagQueue.ts): "unchanged" when it already
 * was so. For actions on several papers, which report each paper themselves.
 */
export function changePaperTag(paperId: string, tag: string, add: boolean): Promise<"done" | "unchanged"> {
  return tagQueue.change(paperId, { name: tag, add });
}

/**
 * Shows a change in the paper's query at once. A load of it still under way is cancelled first, so that
 * it cannot answer with the paper as it was afterwards.
 */
async function showInPaper(paperId: string, change: (paper: PaperData) => PaperData): Promise<void> {
  await queryClient.cancelQueries({ queryKey: [QK.papers, paperId], exact: true });
  const before = queryClient.getQueryData<PaperData | null>([QK.papers, paperId]);
  if (before) queryClient.setQueryData<PaperData>([QK.papers, paperId], change(before));
}

/**
 * Puts the tag on one paper or takes it off (メモ・整理, its context menu). `quiet` leaves the status
 * line alone, for the tag field, which says it itself. The library's row follows from paper.changed.
 */
export async function tagPaper(paperId: string, tag: string, add: boolean, { quiet = false } = {}): Promise<void> {
  const change = { name: tag, add };
  const task = changePaperTag(paperId, tag, add); // In turn from the click, before anything is awaited.
  void showInPaper(paperId, (current) => ({ ...current, tags: applyTagChange(current.tags ?? [], change) }));
  try {
    if (await task === "done") {
      void invalidate({ kind: "paperTags" });
      if (!quiet) useStore.getState().setStatus(add ? `タグ「${tag}」を付けました。` : `タグ「${tag}」を外しました。`);
    }
  } catch (error) {
    // Taken back from the screen at once, before the paper is loaded again.
    void showInPaper(paperId, (current) => ({ ...current, tags: applyTagChange(current.tags ?? [], { name: tag, add: !add }) }));
    showError(error, add ? "タグを付けられませんでした" : "タグを外せませんでした");
  } finally {
    void invalidate({ kind: "paper", paperId });
  }
}

// Reading statuses are sent in the order chosen; the last one chosen is the one kept, and shown until
// every one sent has been answered.
const statusTurns = new Map<string, Promise<unknown>>();
const waitingStatuses = new Map<string, { status: string; count: number }>();

/** The paper's reading status as loaded (`status`), or the one last chosen while it is being saved. */
export function shownStatus(paperId: string, status: string): string {
  return waitingStatuses.get(paperId)?.status ?? status;
}

/** Sets one paper's reading status (メモ・整理, its context menu); `quiet` as for tagPaper. Whether it was saved. */
export async function setPaperReadStatus(paperId: string, status: string, { quiet = false } = {}): Promise<boolean> {
  const task = (statusTurns.get(paperId) ?? Promise.resolve()).catch(() => undefined)
    .then(() => patchPaper(paperId, { read_status: status }));
  statusTurns.set(paperId, task);
  waitingStatuses.set(paperId, { status, count: (waitingStatuses.get(paperId)?.count ?? 0) + 1 });
  organizingChanged();
  void task.catch(() => undefined).then(() => {
    if (statusTurns.get(paperId) === task) statusTurns.delete(paperId);
    const waiting = waitingStatuses.get(paperId);
    if (waiting && waiting.count > 1) waitingStatuses.set(paperId, { ...waiting, count: waiting.count - 1 });
    else waitingStatuses.delete(paperId);
    organizingChanged();
  });
  void showInPaper(paperId, (current) => ({ ...current, read_status: status }));
  try {
    await task;
    if (!quiet) useStore.getState().setStatus(`読書状態を「${status}」にしました。`);
    return true;
  } catch (error) {
    showError(error, "読書状態を変更できませんでした");
    return false;
  } finally {
    void invalidate({ kind: "paper", paperId });
  }
}

// A double click must not undo one move but drop two records.
let undoingMove = false;

export async function undoMove(): Promise<void> {
  if (undoingMove) return;
  undoingMove = true;
  try {
    await undoLastMove();
  } finally {
    undoingMove = false;
  }
}

async function undoLastMove(): Promise<void> {
  const history = useStore.getState().moveHistory;
  const last = history[history.length - 1];
  if (!last) return;
  const { setMoveHistory, setStatus } = useStore.getState();
  const removeRecord = () => setMoveHistory(useStore.getState().moveHistory.filter((entry) => entry !== last));
  if ("kind" in last && last.kind === "move-papers") {
    await undoMovedPapers(last);
    return;
  }
  if ("kind" in last) {
    try {
      const result = await unwrap(api.POST("/api/collections/restore/{undo_token}", { params: { path: { undo_token: last.token } } }));
      removeRecord();
      expandToCollection(result.name);
      useStore.getState().setSelectedFolder(result.name);
      useStore.getState().setCurrentCollection(result.name);
      refreshLibrary();
      setStatus(`「${result.name}」と論文の配置を復元しました。`);
    } catch (error) {
      showError(error, "フォルダーを復元できませんでした");
    }
    return;
  }
  try {
    // Do not overwrite a later edit made through the metadata form.
    const current = normalizeCollection((await paper(last.paperId)).collection_name || "");
    if (current !== last.to) {
      removeRecord();
      setStatus("分類が別の操作で変更されています。この移動は取り消せません。");
      return;
    }
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) {
      showError(error, "移動を取り消せませんでした");
      return;
    }
    removeRecord();
    setStatus("移動した論文が見つかりません。この移動は取り消せません。");
    return;
  }
  if (await movePaper(last.paperId, last.from, false)) {
    removeRecord();
    setStatus(`移動を取り消しました：${last.from || "未分類"}`);
  }
}

/**
 * Undoes papers moved together, each that is still where it was moved to; one moved again since, or
 * deleted, stays. Moves that fail stay in the history, to be undone again.
 */
async function undoMovedPapers(record: MovePapersRecord): Promise<void> {
  // One action on several papers at a time, as for the others (bulkState.ts).
  const run = beginBulk("移動を取り消し中", record.moves.length);
  if (!run) {
    useStore.getState().setStatus(BULK_BUSY_MESSAGE);
    return;
  }
  try {
    await undoMovesOf(record, run);
  } finally {
    run.end();
  }
}

async function undoMovesOf(record: MovePapersRecord, run: { signal: AbortSignal; progress: (ran: number, total: number) => void }) {
  const outcome = await runBulk([...record.moves].reverse(), async (move) => {
    try {
      // Do not overwrite a later edit, as undoing a single move does not.
      if (normalizeCollection((await paper(move.paperId)).collection_name || "") !== move.to) return "unchanged";
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return "unchanged";
      throw error;
    }
    await patchPaper(move.paperId, { collection: move.from });
    return "done";
  }, { stopsAll: stopsAllRequests, progress: run.progress, signal: run.signal });
  const left = new Set([...outcome.failed.map((f) => f.item), ...outcome.notRun]);
  const { moveHistory, setMoveHistory, setStatus } = useStore.getState();
  setMoveHistory(left.size
    ? moveHistory.map((entry) => entry === record ? { ...record, moves: record.moves.filter((m) => left.has(m)) } : entry)
    : moveHistory.filter((entry) => entry !== record));
  const current = useStore.getState();
  for (const move of outcome.done) {
    expandToCollection(move.from);
    if (move.paperId === current.activePaperId && current.selectedFolder === null) current.setCurrentCollection(move.from);
  }
  const report = bulkReport(outcome, (move) => listedTitle(move.paperId), {
    done: (n) => `${n}件の論文の移動を取り消しました。`,
    unchanged: (n) => `${n}件は別の操作で分類が変わったか削除されたため、取り消していません。`,
    failed: (n) => `${n}件の論文の移動を取り消せませんでした`,
  });
  await refreshAfterChanges();
  setStatus(report.status);
  if (report.error) showError(report.error.message, report.error.title);
}

export async function chooseNewCollection(paperId: string, current: string): Promise<void> {
  const name = await askText("新しい分類", "フォルダー名（例：制御工学 / 読書会）", current);
  if (name !== null && normalizeCollection(name)) await movePaper(paperId, name);
}

// --- Folders ------------------------------------------------------------------------------

export async function createFolder(parent: string | null): Promise<void> {
  const store = useStore.getState();
  const label = parent !== null
    ? `「${parent || "ライブラリ"}」内のフォルダー名`
    : "フォルダー名（ / でサブフォルダーを指定）";
  const initial = parent === null && store.currentCollection ? `${store.currentCollection} / ` : "";
  const name = await askText("フォルダーを作成", label, initial);
  if (name === null) return;
  if (!normalizeCollection(name)) {
    showError("フォルダー名を入力してください。", "フォルダーを作成できませんでした");
    return;
  }
  const full = parent ? `${parent} / ${name}` : name;
  try {
    const result = await unwrap(api.POST("/api/collections", { body: { name: full } }));
    store.setLibrarySearch("");
    expandToCollection(result.name);
    store.setSelectedFolder(result.name);
    store.setCurrentCollection(result.name);
    refreshLibrary();
    store.setStatus(`「${result.name}」を作成しました。PDFをドロップして追加できます。`);
  } catch (error) {
    showError(error, "フォルダーを作成できませんでした");
  }
}

/** Asks for a new name; the folder's new path once renamed, else null. */
export async function renameFolder(path: string): Promise<string | null> {
  const name = await askText("フォルダー名を変更", "新しい名前", path.split(" / ").pop() ?? "");
  if (name === null) return null;
  let destination: string;
  try {
    destination = (await unwrap(api.PATCH("/api/collections/rename", { body: { old_name: path, new_name: name } }))).name;
  } catch (error) {
    showError(error, "名前を変更できませんでした");
    return null;
  }
  const mapped = (value: string) => isInsideFolder(value, path) ? destination + normalizeCollection(value).slice(path.length) : value;
  const s = useStore.getState();
  useStore.setState({
    currentCollection: mapped(s.currentCollection),
    selectedFolder: s.selectedFolder === null ? null : mapped(s.selectedFolder),
    moveHistory: s.moveHistory.map((m) => {
      const move = (r: MoveRecord): MoveRecord => ({ ...r, from: mapped(r.from), to: mapped(r.to) });
      if (!("kind" in m)) return move(m);
      return m.kind === "move-papers" ? { ...m, moves: m.moves.map(move) } : m;
    }),
    expandedCollections: s.expandedCollections?.map(mapped) ?? null,
  });
  refreshLibrary();
  s.setStatus(`「${path}」を「${destination}」に変更しました。`);
  return destination;
}

/**
 * Deletes the folder, asking first when it holds papers; `papers` is the whole library, or null while
 * the list has not loaded, when the folder may hold papers that cannot be counted. Whether it was
 * deleted, once the library shows it gone.
 */
export async function deleteFolder(path: string, papers: PaperData[] | null): Promise<boolean> {
  const count = countInFolder(papers, path);
  if (count !== 0) {
    const ok = await askConfirm("フォルダーを削除", count === null
      ? `論文の一覧を読み込めていないため、「${path}」に入っている論文の数を確かめられません。\nフォルダーを削除しますか？\n入っている論文はすべて未分類へ移動します。`
      : `「${path}」には、子フォルダーを含めて${count}件の論文が入っています。\nフォルダーを削除しますか？\n論文はすべて未分類へ移動します。`,
      "削除", true);
    if (!ok) return false;
  }
  let moved: string[] = [];
  let token: string;
  try {
    const result = await unwrap(api.DELETE("/api/collections/{name}", { params: { path: { name: path } } })) as { moved?: string[]; undo_token: string };
    moved = result.moved ?? [];
    token = result.undo_token;
  } catch (error) {
    showError(error, "フォルダーを削除できませんでした");
    return false;
  }
  const s = useStore.getState();
  useStore.setState({
    currentCollection: isInsideFolder(s.currentCollection, path) ? "" : s.currentCollection,
    selectedFolder: s.selectedFolder !== null && isInsideFolder(s.selectedFolder, path) ? null : s.selectedFolder,
    moveHistory: [...s.moveHistory, { kind: "delete-folder", path, token }],
    expandedCollections: s.expandedCollections?.filter((e) => !isInsideFolder(e, path)) ?? null,
  });
  s.setStatus(`「${path}」を削除しました。` + (moved.length ? `${moved.length}件の論文を未分類へ移動しました。` : ""));
  await refreshLibrary();
  return true;
}

// --- Papers ---------------------------------------------------------------------------------

export async function renamePaperFile(paperId: string): Promise<void> {
  let current: PaperData;
  try {
    current = await paper(paperId);
  } catch (error) {
    showError(error);
    return;
  }
  const name = await askText("ファイル名を変更", "新しいファイル名（.pdfは自動で付きます）", current.original_name || current.title);
  if (name === null) return;
  try {
    const result = await unwrap(api.POST("/api/papers/{paper_id}/rename", { params: { path: { paper_id: paperId } }, body: { new_title: name } }));
    // Its row in the lists follows from paper.changed.
    void invalidate({ kind: "paper", paperId });
    useStore.getState().setStatus(`ファイル名を「${result.name}」に変更しました。取り込み元のファイル名は変更されません。`);
  } catch (error) {
    showError(error, "名前を変更できませんでした");
  }
}

/** Whether the paper was deleted, once the library shows it gone. */
export async function deletePaper(paperId: string): Promise<boolean> {
  let current: PaperData;
  try {
    current = await paper(paperId);
  } catch (error) {
    showError(error);
    return false;
  }
  const ok = await askConfirm("論文を削除",
    `「${current.title}」をライブラリから削除しますか？\n訳文・サマリー・チャット履歴・メモも削除され、元に戻せません。`, "削除", true);
  if (!ok) return false;
  try {
    await unwrap(api.DELETE("/api/papers/{paper_id}", { params: { path: { paper_id: paperId } } }));
  } catch (error) {
    showError(error, "削除できませんでした");
    return false;
  }
  const s = useStore.getState();
  if (s.activePaperId === paperId) s.setActivePaperId(null);
  clearJobFailure(paperId);
  forgetDraftsOfPapers([paperId]);
  useStore.setState({ moveHistory: forgetPapers(s.moveHistory, new Set([paperId])) });
  s.setStatus(`「${current.title}」を削除しました。`);
  await refreshLibrary();
  return true;
}

export async function openPaperFolder(paperId: string | null): Promise<void> {
  try {
    if (paperId) {
      const folder = (await paper(paperId)).folder_path;
      if (folder) await shell.openPath(folder);
    }
  } catch (error) {
    showError(error, "フォルダーを開けませんでした");
  }
}

export async function openPaperFile(paperId: string, name: "original.pdf" | "translated.pdf" | "interleaved.pdf"): Promise<void> {
  try {
    const current = await paper(paperId);
    if (name === "interleaved.pdf") {
      // Built on demand beside the paper and reused while the translation is unchanged.
      await startJob(`/api/papers/${paperId}/interleaved`, {}, { kind: "interleaved", paperId });
      return;
    }
    if (current.folder_path) await shell.openPath(joinPath(current.folder_path, name));
  } catch (error) {
    useStore.getState().setStatus("PDFを開けませんでした。既定のPDFアプリを確認してください。");
    showError(error, "PDFを開けませんでした");
  }
}

export async function saveOriginal(paperId: string): Promise<void> {
  try {
    const current = await paper(paperId);
    const destination = await shell.saveFile(paperExportFilename(current, "original"), [{ name: "PDF", extensions: ["pdf"] }]);
    if (!destination) return;
    await exportRequest(paperId, "original", destination);
    showSaved("原文PDFを保存しました", destination);
  } catch (error) {
    showError(error, "保存できませんでした");
  }
}

/**
 * Puts text still being fetched on the clipboard. The write starts during the click, as the image copy
 * does (InkCapture.tsx), so that the WebView still counts it as the user's action when the text arrives.
 */
async function copyWhenReady(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) })]);
  } else {
    await navigator.clipboard.writeText(await text);
  }
}

/**
 * Copies the BibTeX entries of the papers (one, or those selected together), made from the library's own
 * data; after `ready` (the paper's details being saved), which the copy waits for within the click.
 */
export async function copyBibtex(paperIds: string[], ready: Promise<unknown> = Promise.resolve()): Promise<void> {
  const request = ready.then(async () =>
    await unwrap(api.POST("/api/papers/bibtex", { body: { paper_ids: paperIds } })) as { text: string; count: number });
  request.catch(() => undefined); // Reported below, not as an unhandled rejection.
  try {
    try {
      await copyWhenReady(request.then((result) => result.text));
    } catch (error) {
      await request; // When the request failed, its error says more than the clipboard's.
      throw error;
    }
    const { count } = await request;
    useStore.getState().setStatus(count > 1 ? `${count}件の論文の BibTeX をコピーしました。` : "BibTeX をコピーしました。");
  } catch (error) {
    showError(error, "BibTeX をコピーできませんでした");
  }
}

/** Saves the BibTeX entries of the papers in folder `path` and its subfolders to a .bib file the user chooses. */
export async function exportFolderBibtex(path: string): Promise<void> {
  try {
    const destination = await shell.saveFile(bibtexFilename(path), [{ name: "BibTeX", extensions: ["bib"] }]);
    if (!destination) return;
    const result = await unwrap(api.POST("/api/collections/bibtex", { body: { collection: path, destination } })) as { count: number };
    useStore.getState().setStatus(`${result.count}件の論文の BibTeX を保存しました：${destination}`);
  } catch (error) {
    showError(error, "BibTeX を保存できませんでした");
  }
}

export type PdfExportKind = "translated" | "interleaved" | "bilingual";

/** POST /api/papers/{id}/export: saved at once, or (a PDF to typeset) a job. */
function exportRequest(paperId: string, kind: PdfExportKind | "original" | "markdown", destination: string) {
  return unwrap(api.POST("/api/papers/{paper_id}/export", { params: { path: { paper_id: paperId } }, body: { kind, destination } }));
}

export async function exportPdf(paperId: string, kind: PdfExportKind): Promise<void> {
  const reading = queryClient.getQueryData<ReadingData>([QK.reading, paperId]);
  if (reading?.in_progress) {
    await showMessage("翻訳途中", "指定したページの翻訳が終わると書き出せます。完了したページはアプリ内で確認できます。");
    return;
  }
  if (reading && !reading.has_translated) {
    await showMessage("未翻訳", "先に日本語訳を作成してください。");
    return;
  }
  try {
    const current = await paper(paperId);
    const destination = await shell.saveFile(paperExportFilename(current, kind), [{ name: "PDF", extensions: ["pdf"] }]);
    if (!destination) return;
    const result: { job_id?: string; destination?: string } = await exportRequest(paperId, kind, destination);
    if (result.job_id) {
      showStartedJob(result.job_id, { kind: "export", paperId });
    } else {
      showSaved("日本語訳PDFを保存しました", result.destination ?? destination);
    }
  } catch (error) {
    showError(error, "PDFを書き出せませんでした");
  }
}

export async function exportMarkdown(paperId: string): Promise<void> {
  const reading = queryClient.getQueryData<ReadingData>([QK.reading, paperId]);
  if (reading && !reading.has_article) {
    await showMessage("未作成", "先に解説を作成してください。");
    return;
  }
  try {
    const current = await paper(paperId);
    const destination = await shell.saveFile(paperExportFilename(current, "markdown"), [{ name: "Markdown", extensions: ["md"] }]);
    if (!destination) return;
    await exportRequest(paperId, "markdown", destination);
    showSaved("サマリーを保存しました", destination);
  } catch (error) {
    showError(error, "Markdownを保存できませんでした");
  }
}

/** Make the paper's サマリー; one that exists is replaced only after a confirmation (features/summary/summaryStart.ts). */
export async function generateArticle(paperId: string): Promise<void> {
  const hasSummary = await paper(paperId).then((target) => !!target.has_article, () => null);
  const question = summaryStartQuestion(hasSummary);
  if (question && !await askConfirm(question.title, question.message, question.okLabel, false, { key: summaryQuestionKey(paperId) })) return;
  try {
    await startJob(`/api/papers/${paperId}/article`, {}, { kind: "article", paperId });
  } catch (error) {
    showError(error, "サマリーを作成できませんでした");
  }
}

// --- Navigation -----------------------------------------------------------------------------

/** Open a `papeer://<id>/<page>` citation in the reader, as the old follow_citation did. */
export async function followCitation(paperId: string, page: number): Promise<void> {
  const store = useStore.getState();
  try {
    const target = await paper(paperId);
    if (!(page >= 1 && page <= (target.pages ?? 0))) return;
  } catch {
    store.setStatus("参照先が見つかりませんでした。");
    return;
  }
  store.setTranslatedOnly(false);
  store.setActivePaperId(paperId, page);
  store.setActiveTab("reader");
  emitAppEvent("reveal-paper", { paperId, focus: false });
}

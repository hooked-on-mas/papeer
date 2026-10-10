/**
 * What the organize dialog does (OrganizeDialog.tsx): asking the AI for a proposal of folders as a
 * library-wide job (`library-organize`), and applying the checked moves in one request. The state is
 * in organizeStore.ts, the proposal's editing in organizePlan.ts.
 */
import { api, ApiError, unwrap } from "@/api/client";
import type { OrganizeProposal } from "@/api/jobTypes";
import { askConfirm } from "@/components/AppDialogs";
import { showError } from "@/components/errorDialog";
import { showToast } from "@/components/toast";
import { expandToCollection, recordMoves, refreshAfterChanges, undoMove } from "@/app/actions";
import { cancelJob, startJob, type JobFinished } from "@/features/jobs/jobEvents";
import { emitAppEvent } from "@/lib/appEvents";
import { normalizeCollection } from "@/lib/collectionPath";
import { notifyIfAway } from "@/shell";
import { useStore, type MoveRecord } from "@/store";
import {
  applyPayload, draftEdited, draftFromProposal, movingMoves, proposalFromDraft, renameNewFolder, setDestination, setIncluded,
  type OrganizeDraft,
} from "./organizePlan";
import { INITIAL_TARGET, useOrganize, type OrganizeTarget } from "./organizeStore";

const set = useOrganize.setState;
const get = useOrganize.getState;

/** What opens the dialog (the "open-organize-dialog" event): nothing opens it as it is, e.g. from the toast. */
export type OrganizeOpenRequest = { source?: string; paperIds?: string[] };

const sameTarget = (a: OrganizeTarget, b: OrganizeTarget) =>
  a.source === b.source && (a.paperIds === null ? b.paperIds === null
    : b.paperIds !== null && a.paperIds.length === b.paperIds.length && a.paperIds.every((id, at) => id === b.paperIds![at]));

/**
 * Opens the dialog for a folder (`source`, "" for 未分類) or for papers (`paperIds`), or, with neither,
 * as it was left (the proposal, or the job still running). A proposal still there for another target
 * is replaced, after asking when the user has changed it; a job still running keeps the dialog on its target.
 */
export async function openOrganize(request: OrganizeOpenRequest = {}): Promise<void> {
  const state = get();
  const asked = request.paperIds?.length ? { source: "", paperIds: [...new Set(request.paperIds)] }
    : request.source !== undefined ? { source: normalizeCollection(request.source), paperIds: null } : null;
  if (!asked) {
    set({ open: true });
    return;
  }
  if (state.busy) {
    useStore.getState().setStatus("フォルダー整理の案を作成中です。できあがるまでお待ちください。");
    set({ open: true });
    return;
  }
  if (state.draft && !sameTarget(state.target, asked)) {
    if (draftEdited(state.draft) && !await askConfirm("整理の案が残っています",
      "前回の案には、まだ適用していない変更があります。破棄して、新しい対象で始めますか？", "破棄して始める", true)) {
      set({ open: true });
      return;
    }
    set({ draft: null, requested: null, usage: null, conflict: false, outcome: null, feedback: "" });
  }
  if (!state.draft || !sameTarget(state.target, asked)) set({ target: asked, outcome: null });
  set({ open: true });
}

export function closeOrganize(): void {
  set({ open: false });
}

export function setOrganizeSource(source: string): void {
  set({ target: { source: normalizeCollection(source), paperIds: null }, outcome: null });
}

export function setOrganizeInstruction(instruction: string): void {
  set({ instruction });
}

export function setOrganizeFeedback(feedback: string): void {
  set({ feedback });
}

/** The job that makes a proposal has ended (a watcher of its start): the proposal replaces the draft, a failure is the error dialog's. */
function proposalEnded(event: JobFinished<"library-organize">): void {
  if (event.status !== "succeeded") {
    set({ busy: false, jobId: null, outcome: { kind: event.status === "cancelled" ? "cancelled" : "failed", message: event.error ?? "" } });
    return;
  }
  const proposal: OrganizeProposal = event.result;
  const draft = draftFromProposal(proposal);
  set({ busy: false, jobId: null, outcome: null, draft, usage: proposal.usage ?? null, conflict: false, feedback: "" });
  if (get().open) return;
  const count = movingMoves(draft).length;
  const message = count ? `${count}件の論文の移動案があります。` : "移動する論文はありませんでした。";
  showToast({
    id: "organize-proposal", title: "フォルダー整理の案ができました", description: message, tone: "success", timeout: 15_000,
    action: { label: "確認する", run: () => emitAppEvent("open-organize-dialog", {}) },
  });
  notifyIfAway("フォルダー整理の案ができました", message);
}

async function requestProposal(request: OrganizeTarget, revision?: { feedback: string; previous: OrganizeProposal }): Promise<void> {
  const state = get();
  if (state.busy || state.applying) return;
  set({ busy: true, jobId: null, outcome: null, conflict: false, requested: request });
  let ended = false;
  try {
    const jobId = await startJob("/api/collections/organize", {
      source: request.source, instruction: state.instruction.trim(), paper_ids: request.paperIds,
      feedback: revision?.feedback.trim() ?? "", previous: revision?.previous ?? null,
    }, { kind: "library-organize", paperId: null }, (event) => {
      ended = true;
      proposalEnded(event);
    });
    // A job that ended before its start was answered has been handled already.
    if (!ended) set({ jobId });
  } catch (error) {
    set({ busy: false });
    showError(error, "フォルダー整理の案を作れませんでした");
  }
}

/** 「案を作る」: the first proposal for the target, with `source` the folder new folders go under (the target's own, or a selection's common folder). */
export function startOrganize(source: string): Promise<void> {
  return requestProposal({ source: normalizeCollection(source), paperIds: get().target.paperIds });
}

/** 「作り直す」: the AI revises the proposal as it stands now, with the additional instruction. */
export function reviseOrganize(): Promise<void> {
  const { draft, requested, feedback } = get();
  if (!draft || !requested) return Promise.resolve();
  return requestProposal(requested, { feedback, previous: proposalFromDraft(draft) });
}

/** 「案を作り直す」 after the library changed: a new proposal for the same target and instruction. */
export function restartOrganize(): Promise<void> {
  const { requested } = get();
  return requested ? requestProposal(requested) : Promise.resolve();
}

/** Back to the first step, dropping the proposal (after asking when the user has changed it). */
export async function discardProposal(): Promise<boolean> {
  const { draft } = get();
  if (draft && draftEdited(draft) && !await askConfirm("案を破棄", "変更した内容は失われます。案を破棄して、対象や指示を選び直しますか？", "破棄する", true)) return false;
  set({ draft: null, requested: null, usage: null, conflict: false, outcome: null, feedback: "" });
  return true;
}

export async function cancelOrganize(): Promise<void> {
  const { jobId } = get();
  if (jobId) await cancelJob(jobId);
}

// --- Editing the proposal ---

function edit(change: (draft: OrganizeDraft) => OrganizeDraft): void {
  const { draft } = get();
  if (!draft) return;
  const next = change(draft);
  if (next !== draft) set({ draft: next });
}

export function includePapers(paperIds: readonly string[], included: boolean): void {
  edit((draft) => setIncluded(draft, paperIds, included));
}

export function chooseDestination(paperId: string, to: string): void {
  edit((draft) => setDestination(draft, paperId, to));
}

/** Renames a new folder; the reason it cannot be, or null. */
export function renameProposedFolder(path: string, leaf: string, existing: ReadonlySet<string>): string | null {
  const { draft } = get();
  if (!draft) return "案がありません。";
  const result = renameNewFolder(draft, path, leaf, existing);
  if ("error" in result) return result.error;
  if (result.draft !== draft) set({ draft: result.draft });
  return null;
}

// --- Applying ---

/**
 * Applies the checked moves, all or none (POST /api/collections/apply-moves), as one move to undo. The
 * folders that the moves empty, and the ones it made that undoing leaves empty, stay.
 */
export async function applyOrganize(): Promise<void> {
  const { draft, applying, busy } = get();
  if (!draft || applying || busy) return;
  const payload = applyPayload(draft);
  if (!payload.moves.length) return;
  const moves: MoveRecord[] = movingMoves(draft).map((move) => ({ paperId: move.paperId, from: move.from, to: normalizeCollection(move.to) }));
  set({ applying: true, conflict: false });
  let result: { moved: number; created: string[] };
  try {
    result = await unwrap(api.POST("/api/collections/apply-moves", { body: payload }));
  } catch (error) {
    set({ applying: false });
    if (error instanceof ApiError && error.status === 409 && error.code === "collection_changed") set({ conflict: true });
    else showError(error, "フォルダー分けを適用できませんでした");
    return;
  }
  recordMoves(moves);
  const history = useStore.getState().moveHistory;
  const record = history[history.length - 1];
  set({
    open: false, applying: false, draft: null, requested: null, usage: null, conflict: false, outcome: null,
    target: INITIAL_TARGET, instruction: "", feedback: "",
  });
  const store = useStore.getState();
  // As moving papers does (bulkActions.ts): the open paper's folder is the 追加先 while no folder is chosen.
  const open = moves.find((move) => move.paperId === store.activePaperId);
  if (open && store.selectedFolder === null) store.setCurrentCollection(open.to);
  for (const destination of new Set(moves.map((move) => move.to))) expandToCollection(destination);
  const made = result.created.length;
  showToast({
    id: "organize-applied", title: `${result.moved}件を移動しました${made ? `（${made}個のフォルダーを作成）` : ""}`, tone: "success", timeout: 15_000,
    action: {
      label: "元に戻す",
      run: () => {
        const now = useStore.getState().moveHistory;
        // Undoing takes the newest move; another one made since must be undone first.
        if (record && now[now.length - 1] === record) void undoMove();
        else useStore.getState().setStatus("その後に別の移動があったため、ここからは元に戻せません。ライブラリの「元に戻す」で新しい移動から順に取り消せます。");
      },
    },
  });
  await refreshAfterChanges();
}

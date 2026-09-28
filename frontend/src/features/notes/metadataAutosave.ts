/**
 * The 論文情報 drafts (metadataSaver.ts) connected to the sidecar and the app.
 *
 * Before closing, a backup or a sync, every draft is saved (registerPendingSaves); only a save that
 * failed (the sidecar not answering) stops them, as for the memo. A value that cannot be saved as it is
 * (a year that is not four digits, a DOI the sidecar refused) does not: the library still holds the
 * value saved before. Such a draft is an open edit (beginOpenEdit) meanwhile, so that a sync that would
 * take in another PC's library, and reload the page, waits or asks first; and closing asks whether to
 * close without it, naming the papers and fields (registerHeldDrafts).
 */
import { useStore as useZustandStore } from "zustand";
import type { PaperData } from "@/api/hooks";
import { invalidate, patchPaper } from "@/api/mutations";
import { expandToCollection, recordMoves } from "@/app/actions";
import { normalizeCollection } from "@/lib/collectionPath";
import { pyStrip } from "@/lib/pyWhitespace";
import { beginOpenEdit, registerHeldDrafts, registerPendingSaves } from "@/lib/pendingSaves";
import { QK } from "@/lib/queryKeys";
import { queryClient as client } from "@/lib/queryClient";
import { useStore } from "@/store";
import { createMetadataSaver, type HeldDraft, type MetaEntry } from "./metadataSaver";
import { META_LABELS } from "./paperMetadata";

/** How long after the last key a field is saved: about the memo's (600 ms), a little longer since each
 * save of a title or year may move the paper's row in the library. */
export const SAVE_DELAY_MS = 800;

const saver = createMetadataSaver({
  delay: SAVE_DELAY_MS,
  patch: async (paperId, body) => {
    // A load of the paper still under way would answer with the values from before this save.
    await client.cancelQueries({ queryKey: [QK.papers, paperId], exact: true });
    return patchPaper(paperId, body);
  },
  saved: (paperId, fields, sent, before) => {
    const moved = fields.includes("collection");
    if (moved) {
      const from = normalizeCollection(before);
      const to = normalizeCollection(sent.collection);
      if (from !== to) recordMoves([{ paperId, from, to }]);
      const store = useStore.getState();
      if (store.selectedFolder === null && store.activePaperId === paperId) store.setCurrentCollection(to);
      expandToCollection(to);
      if (from !== to) store.setStatus(`「${to || "未分類"}」へ移動しました。`);
    }
    // The paper as the sidecar keeps it (a DOI pasted as a link comes back bare), and the folders when it
    // moved; the library's row follows from the paper.changed event.
    void invalidate({ kind: "paper", paperId, collection: moved });
  },
});

export const { showDraft, hideDraft, typeField, revertField, flushDraft } = saver;

export function useMetadataDraft(paperId: string): MetaEntry | undefined {
  return useZustandStore(saver.store, (drafts) => drafts[paperId]);
}

/** The paper's name for a message: as typed, else as saved. */
function describe({ paperId, draft, fields }: HeldDraft): string {
  const title = pyStrip(draft.values.title) || draft.saved.title
    || client.getQueryData<PaperData | null>([QK.papers, paperId])?.title || paperId;
  const why = fields.map((field) => `${META_LABELS[field]}：${draft.problems[field] || draft.failure || "未保存"}`);
  return [`「${title}」の論文情報`, ...why].join("\n");
}

let endOpenEdit: (() => void) | null = null;
saver.store.subscribe(() => {
  const holding = saver.held().length > 0;
  if (holding && !endOpenEdit) endOpenEdit = beginOpenEdit("論文情報");
  else if (!holding && endOpenEdit) {
    endOpenEdit();
    endOpenEdit = null;
  }
});

registerPendingSaves(async () => {
  await saver.flushAll();
  const failed = saver.failed();
  if (failed.length) throw new Error(failed.map(describe).join("\n\n"));
}, "論文情報を保存できませんでした。");

/** Forgets the drafts of papers that were deleted (see metadataSaver's forget). */
export function forgetMetadataDrafts(paperIds: Iterable<string>): void {
  for (const paperId of paperIds) saver.forget(paperId);
}

// Through pendingSaves, so that deleting papers (actions.ts) needs not load the memo pane's code.
registerHeldDrafts({ describe: () => saver.held().map(describe), discard: saver.discardHeld, forget: forgetMetadataDrafts });

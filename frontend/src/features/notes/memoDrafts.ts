/**
 * The text of each memo being edited, kept while its editor is closed so an unsaved edit is never lost
 * (memoState.ts connects it to the sidecar and the app; here it only depends on `patch`).
 *
 * Two orderings are guarded, as a reply may arrive after the situation it answers has changed:
 * - a save answered after its draft was forgotten (the paper or memo deleted, the drafts discarded)
 *   must not bring the draft back, neither on success nor on failure;
 * - a load that read the memo before a save must not put the older text back over it: each draft
 *   keeps the `updated_at` of the newest version it knows, and a load older than that is ignored.
 */
import { createStore } from "zustand/vanilla";

export type MemoDraft = {
  owner: string;
  text: string;
  /** The text the library holds. */
  saved: string;
  /** The memo's updated_at as of `saved`. */
  revision: string;
  saving: boolean;
  error: string;
};
type MemoSnapshot = { id: string; owner_id: string; content: string; updated_at: string };
type DraftState = { drafts: Record<string, MemoDraft> };

/**
 * A sortable form of a memo's updated_at: the library writes "YYYY-MM-DD HH:MM:SS" when it adds one and
 * an ISO UTC time with microseconds at each save. Null for anything else (it then orders nothing).
 */
export function revisionKey(stamp: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|\+00:00)?$/.exec(stamp);
  return match ? `${match[1]}T${match[2]}.${(match[3] ?? "").padEnd(6, "0").slice(0, 6)}` : null;
}

export function isOlderRevision(stamp: string, than: string): boolean {
  const a = revisionKey(stamp), b = revisionKey(than);
  return a !== null && b !== null && a < b;
}

export function createMemoDrafts(deps: {
  /** Saves the text of a memo; the memo as the library now holds it. */
  patch: (owner: string, id: string, content: string) => Promise<MemoSnapshot>;
  /** Called with the saved memo, for the caches that show it. */
  saved?: (memo: MemoSnapshot) => void;
}) {
  const store = createStore<DraftState>(() => ({ drafts: {} }));
  const inFlight = new Map<string, Promise<void>>();
  // Bumped when a draft is forgotten: a save started before that belongs to a draft that no longer exists.
  const lives = new Map<string, number>();
  const lifeOf = (id: string) => lives.get(id) ?? 0;

  /** Never recreates a draft: one that is gone stays gone. */
  function patchDraft(id: string, fields: Partial<MemoDraft>) {
    store.setState(s => s.drafts[id] ? { drafts: { ...s.drafts, [id]: { ...s.drafts[id], ...fields } } } : s);
  }

  function hydrate(memo: MemoSnapshot) {
    const existing = store.getState().drafts[memo.id];
    if (existing && (existing.text !== existing.saved || existing.saving)) return;
    if (existing && isOlderRevision(memo.updated_at, existing.revision)) return;
    store.setState(s => ({ drafts: { ...s.drafts, [memo.id]: {
      owner: memo.owner_id, text: memo.content, saved: memo.content, revision: memo.updated_at, saving: false, error: "" } } }));
  }

  function change(id: string, text: string) {
    patchDraft(id, { text, error: "" });
  }

  function forget(id: string) {
    lives.set(id, lifeOf(id) + 1);
    store.setState(s => { const drafts = { ...s.drafts }; delete drafts[id]; return { drafts }; });
  }

  /** Serialized per memo. A draft that is not saved stays and can be tried again. */
  function save(id: string): Promise<void> {
    const previous = inFlight.get(id) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      const draft = store.getState().drafts[id];
      if (!draft || draft.text === draft.saved) return;
      const life = lifeOf(id);
      const text = draft.text;
      patchDraft(id, { saving: true, error: "" });
      try {
        const memo = await deps.patch(draft.owner, id, text);
        // Forgotten meanwhile: the answer, saved or refused, is of no use to a draft that is gone.
        if (lifeOf(id) !== life) return;
        patchDraft(id, { saved: text, revision: memo.updated_at, saving: false });
        deps.saved?.(memo);
      } catch (error) {
        if (lifeOf(id) !== life) return;
        patchDraft(id, { saving: false, error: error instanceof Error ? error.message : "メモを保存できませんでした。" });
        throw error;
      }
    });
    inFlight.set(id, task);
    void task.finally(() => { if (inFlight.get(id) === task) inFlight.delete(id); }).catch(() => undefined);
    return task;
  }

  return { store, hydrate, change, forget, save };
}

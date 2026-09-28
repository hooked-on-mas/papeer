/**
 * Saving the 論文情報 form as it is typed: the drafts of every paper (paperMetadata.ts) and their saves,
 * apart from React, the sidecar and the app's stores (metadataAutosave.ts connects them), so that
 * tests/metadataSaver.test.ts can check them.
 *
 * Each paper's draft lives here rather than in the form, so that switching tabs or papers keeps what was
 * typed but not saved (a value that breaks a rule, or one the sidecar refused), and the form shows it
 * again with why on coming back. A field is saved `delay` ms after typing in it stops, and at once when it
 * is left or Enter is pressed (flushDraft); the folder only then, since each save moves the paper and a
 * folder name is typed in steps. A form closed (another tab or paper) saves what is waiting at once.
 */
import { createStore } from "zustand/vanilla";
import {
  fieldsToSend, newDraft, requestBody, unsavedFields, withRejected, withReverted, withSaved, withServerValues, withTyped,
  type MetaDraft, type MetaField, type MetaValues,
} from "./paperMetadata.ts";

export type MetaEntry = MetaDraft & {
  saving: boolean;
  /** A failure other than a refused value (the sidecar not answering…); tried again with the next save. */
  failure: string;
};

export type MetadataSaverDeps = {
  /** PATCH /api/papers/{id} with `body`; rejects with an error whose `status` is the HTTP status. */
  patch: (paperId: string, body: Record<string, string>) => Promise<unknown>;
  /** After `fields` were saved with `sent`; `from` is the folder the paper was in before. */
  saved?: (paperId: string, fields: MetaField[], sent: MetaValues, from: string) => void;
  delay: number;
};

/** A paper whose draft holds values that cannot be saved as they are, and why, by field. */
export type HeldDraft = { paperId: string; draft: MetaEntry; fields: MetaField[] };

const status = (error: unknown): number | undefined => (error as { status?: unknown } | null)?.status as number | undefined;

export function createMetadataSaver(deps: MetadataSaverDeps) {
  const store = createStore<Record<string, MetaEntry>>(() => ({}));
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const turns = new Map<string, Promise<void>>();
  const shown = new Set<string>();

  const entry = (paperId: string): MetaEntry | undefined => store.getState()[paperId];

  function update(paperId: string, change: (current: MetaEntry) => MetaEntry): void {
    const current = entry(paperId);
    if (current) store.setState({ [paperId]: change(current) });
  }

  function drop(paperId: string): void {
    const { [paperId]: _dropped, ...rest } = store.getState();
    store.setState(rest, true);
  }

  /** Once nothing is waiting and the form is not shown, a draft with nothing unsaved is forgotten. */
  function forgetIfDone(paperId: string): void {
    const current = entry(paperId);
    if (current && !shown.has(paperId) && !current.saving && !timers.has(paperId) && !turns.has(paperId)
        && !unsavedFields(current).length) drop(paperId);
  }

  function stopTimer(paperId: string): void {
    clearTimeout(timers.get(paperId));
    timers.delete(paperId);
  }

  /** The form of the paper is shown with the paper's values `server`: its draft, begun or brought up to date. */
  function showDraft(paperId: string, server: MetaValues): void {
    shown.add(paperId);
    const current = entry(paperId);
    if (!current) store.setState({ [paperId]: { ...newDraft(server), saving: false, failure: "" } });
    else {
      const next = withServerValues(current, server);
      if (next !== current) store.setState({ [paperId]: { ...current, ...next } });
    }
  }

  /** The form was closed: what is waiting is saved now; the draft stays while anything is unsaved. */
  function hideDraft(paperId: string): Promise<void> {
    shown.delete(paperId);
    return flushDraft(paperId).then(() => forgetIfDone(paperId));
  }

  function typeField(paperId: string, field: MetaField, value: string): void {
    update(paperId, (current) => ({ ...current, ...withTyped(current, field, value) }));
    stopTimer(paperId);
    if (field !== "collection") {
      timers.set(paperId, setTimeout(() => {
        timers.delete(paperId);
        void saveDraft(paperId);
      }, deps.delay));
    }
  }

  function revertField(paperId: string, field: MetaField): void {
    update(paperId, (current) => ({ ...current, ...withReverted(current, field) }));
    forgetIfDone(paperId);
  }

  /** Saves what is waiting now. */
  function flushDraft(paperId: string): Promise<void> {
    stopTimer(paperId);
    return saveDraft(paperId);
  }

  /** One save of the paper's draft at a time, in turn: each sends what the one before left unsaved. */
  function saveDraft(paperId: string): Promise<void> {
    const task = (turns.get(paperId) ?? Promise.resolve()).then(() => sendDraft(paperId));
    turns.set(paperId, task);
    void task.finally(() => {
      if (turns.get(paperId) === task) turns.delete(paperId);
      forgetIfDone(paperId);
    });
    return task;
  }

  async function sendDraft(paperId: string): Promise<void> {
    const current = entry(paperId);
    if (!current) return;
    const { send, problems } = fieldsToSend(current);
    update(paperId, (draft) => ({ ...draft, problems: { ...draft.problems, ...problems } }));
    if (!send.length) {
      if (current.failure) update(paperId, (draft) => ({ ...draft, failure: "" }));
      return;
    }
    const sent = { ...current.values };
    const from = current.saved.collection;
    update(paperId, (draft) => ({ ...draft, saving: true }));
    const saved: MetaField[] = [];
    let failure = "";
    try {
      try {
        await deps.patch(paperId, requestBody(send, sent));
        saved.push(...send);
      } catch (error) {
        if (status(error) !== 400) throw error;
        if (send.length === 1) {
          update(paperId, (draft) => ({ ...draft, ...withRejected(draft, send[0], sent[send[0]], (error as Error).message) }));
        } else {
          // Which value was refused: each is sent on its own, so that the others are saved.
          for (const field of send) {
            try {
              await deps.patch(paperId, requestBody([field], sent));
              saved.push(field);
            } catch (fieldError) {
              if (status(fieldError) !== 400) throw fieldError;
              update(paperId, (draft) => ({ ...draft, ...withRejected(draft, field, sent[field], (fieldError as Error).message) }));
            }
          }
        }
      }
    } catch (error) {
      if (status(error) === 404) {
        // The paper was deleted meanwhile: there is nothing left to save its details to.
        drop(paperId);
        return;
      }
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      update(paperId, (draft) => ({ ...draft, ...withSaved(draft, saved, sent), saving: false, failure }));
    }
    if (saved.length) deps.saved?.(paperId, saved, sent, from);
  }

  /** Saves every draft (closing, a backup, a sync). */
  async function flushAll(): Promise<void> {
    await Promise.allSettled(Object.keys(store.getState()).map(flushDraft));
  }

  /** The drafts holding values the sidecar will not take as they are (why: in their problems). */
  function held(): HeldDraft[] {
    return Object.entries(store.getState()).flatMap(([paperId, draft]) => {
      const fields = unsavedFields(draft).filter((field) => draft.problems[field]);
      return fields.length ? [{ paperId, draft, fields }] : [];
    });
  }

  /** The drafts that could not be saved for another reason (the sidecar not answering). */
  function failed(): HeldDraft[] {
    return Object.entries(store.getState()).flatMap(([paperId, draft]) => {
      const fields = unsavedFields(draft).filter((field) => !draft.problems[field]);
      return draft.failure && fields.length ? [{ paperId, draft, fields }] : [];
    });
  }

  /** Drops what was typed but cannot be saved (closing without it). */
  function discardHeld(): void {
    for (const { paperId, fields } of held()) {
      for (const field of fields) update(paperId, (current) => ({ ...current, ...withReverted(current, field) }));
      forgetIfDone(paperId);
    }
  }

  /**
   * Forgets the paper's draft, whatever it holds: the paper was deleted. A draft holding only values that
   * are never sent would otherwise stay, and never meet the sidecar's 404.
   */
  function forget(paperId: string): void {
    stopTimer(paperId);
    drop(paperId);
  }

  return { store, showDraft, hideDraft, typeField, revertField, flushDraft, flushAll, held, failed, discardHeld, forget };
}

export type MetadataSaver = ReturnType<typeof createMetadataSaver>;

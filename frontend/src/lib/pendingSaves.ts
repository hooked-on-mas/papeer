import { useEffect } from "react";

/**
 * Edits that are saved in the background (notes, ink) register here, so closing the app
 * or taking a backup can wait for all of them without knowing each feature.
 *
 * Edits that only a person can finish (a dialog holding a draft: a sticky note, a translation
 * fix, the glossary) register as open edits instead: they cannot be flushed, so automatic sync
 * waits while any is open, and a manual one asks first, since taking in another PC's library
 * reloads the page and would discard the draft.
 */
type PendingSaves = { flush: () => Promise<void>; failure: string };

export type SaveFailure = { message: string; cause: unknown };

const registered = new Set<PendingSaves>();

/** failure names what could not be saved and how to retry, e.g. "メモを保存できませんでした。". */
export function registerPendingSaves(flush: () => Promise<void>, failure: string): () => void {
  const entry = { flush, failure };
  registered.add(entry);
  return () => registered.delete(entry);
}

/** Save everything still pending; resolves to the first failure, or null when all saved. */
export async function flushPendingSaves(): Promise<SaveFailure | null> {
  const entries = [...registered];
  const results = await Promise.allSettled(entries.map((entry) => entry.flush()));
  const failed = results.findIndex((result) => result.status === "rejected");
  if (failed < 0) return null;
  return { message: entries[failed].failure, cause: (results[failed] as PromiseRejectedResult).reason };
}

export function describeFailure(failure: SaveFailure): string {
  const cause = failure.cause instanceof Error ? failure.cause.message : failure.cause ? String(failure.cause) : "";
  return cause ? `${failure.message}\n${cause}` : failure.message;
}

const openEdits = new Map<symbol, string>();

/** label names the edit in a sentence, e.g. "付箋". Returns the function that ends it. */
export function beginOpenEdit(label: string): () => void {
  const key = Symbol(label);
  openEdits.set(key, label);
  return () => { openEdits.delete(key); };
}

/** Labels of the edits open now, each once. */
export function openEditLabels(): string[] {
  return [...new Set(openEdits.values())];
}

/** An open edit for as long as `active` holds (a dialog is open) and the component is mounted. */
export function useOpenEdit(active: boolean, label: string): void {
  useEffect(() => (active ? beginOpenEdit(label) : undefined), [active, label]);
}

/**
 * Edits kept back because they cannot be saved as they are (a value the sidecar refuses), which saving
 * leaves as they are: closing the app asks whether to close without them, listing `describe()`.
 */
type HeldDrafts = { describe: () => string[]; discard: () => void; forget: (paperIds: Iterable<string>) => void };

const heldDrafts = new Set<HeldDrafts>();

export function registerHeldDrafts(entry: HeldDrafts): () => void {
  heldDrafts.add(entry);
  return () => heldDrafts.delete(entry);
}

/** What is kept back now, a paragraph each; empty when nothing is. */
export function heldDraftDescriptions(): string[] {
  return [...heldDrafts].flatMap((entry) => entry.describe());
}

/** Drops the drafts of papers that were deleted, which there is nothing left to save to. */
export function forgetDraftsOfPapers(paperIds: Iterable<string>): void {
  const ids = [...paperIds];
  for (const entry of heldDrafts) entry.forget(ids);
}

/** Drops what is kept back (closing without it). */
export function discardHeldDrafts(): void {
  for (const entry of heldDrafts) entry.discard();
}

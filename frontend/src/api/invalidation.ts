import { QK } from "../lib/queryKeys.ts";

/**
 * What each change of the library's data makes stale: the one table the actions, the saves, the dialogs
 * and the sidecar's events go by (api/mutations.ts runs it), so that two places saving the same thing
 * cannot refresh different queries. Kept free of React and the query client for tests/invalidation.test.ts.
 *
 * A change of one paper made through PATCH /api/papers/{id} refreshes the paper's own query only: its
 * row in the library lists follows from the paper.changed event the sidecar sends (jobs/paperRefresh.ts),
 * which a whole-list reload here would only repeat.
 */
export type DataChange =
  /** The folders or the papers in them: a folder created, renamed, deleted or restored, a paper deleted, a PDF imported. */
  | { kind: "folders" }
  /** Anything in the library (the library.changed event; an action on several papers once it is done). */
  | { kind: "library" }
  /** The event stream is back: what the events missed meanwhile would have refreshed. */
  | { kind: "reconnected" }
  /** An import finished: the lists (the job's end refreshes the folders). */
  | { kind: "imported" }
  /**
   * Papers changed as paper.changed events said (jobs/paperRefresh.ts, which puts each one's row into the
   * lists itself, or with `all`, too many to, has the lists loaded again); the library's search covers
   * the memo, the details and the translation.
   */
  | { kind: "papersChanged"; all: boolean; collections: boolean; tags: boolean }
  /** A page of the paper translated while its translation runs (job.page_ready). */
  | { kind: "pageTranslated"; paperId: string }
  /** One paper's details, tags or reading status (its row: paper.changed); `collection` when it moved folder. */
  | { kind: "paper"; paperId: string; collection?: boolean }
  /** A tag put on a paper or taken off: a new name becomes one of the tag choices. */
  | { kind: "paperTags" }
  /** A memo saved: the library's search finds its text (the memo pane keeps the paper's query itself). */
  | { kind: "note" }
  /** A choice of paper tag, reading status or sticky-note label added or deleted (設定 → タグ). */
  | { kind: "tagChoice"; tagKind: "paper" | "status" | "sticky"; removed: boolean }
  /** A sticky note or highlight added, edited, recoloured, deleted or put back. */
  | { kind: "stickyNote" }
  /** A sticky note dragged: only its place changed, which the library's search does not cover. */
  | { kind: "stickyNoteMoved" }
  /** The common glossary saved (the translation dialog, the PDF's context menu). */
  | { kind: "glossary" }
  /** The domain dictionaries a paper uses chosen (by the AI, or in the dialog): which of the glossary applies to it. */
  | { kind: "glossaryDomains"; paperId: string }
  /** A paragraph's translation revised (TranslationReview). */
  | { kind: "translationRevised"; paperId: string }
  /** A note template saved or deleted. */
  | { kind: "noteTemplates" }
  /** The settings or prompts saved. */
  | { kind: "settings" }
  /** The sync folder's settings or state changed. */
  | { kind: "drive" };

/** One query (or, without `exact`, every query whose key starts with `queryKey`) to refresh. */
export type StaleQuery = { queryKey: readonly unknown[]; exact?: boolean };

const roots = (...keys: string[]): StaleQuery[] => keys.map((key) => ({ queryKey: [key] }));

export function invalidationsFor(change: DataChange): StaleQuery[] {
  switch (change.kind) {
    case "folders":
      return roots(QK.papers, QK.collections);
    case "library":
      return roots(QK.papers, QK.collections, QK.librarySearch, QK.tags);
    case "reconnected":
      return roots(QK.papers, QK.collections, QK.librarySearch, QK.tags, QK.reading);
    case "imported":
      return roots(QK.papers);
    case "papersChanged":
      return [...(change.all ? roots(QK.papers) : []), ...(change.collections ? roots(QK.collections) : []),
        ...(change.tags ? roots(QK.tags) : []), ...roots(QK.librarySearch)];
    case "pageTranslated":
      return [{ queryKey: [QK.reading, change.paperId] }, { queryKey: [QK.paperSearch, change.paperId] }];
    case "paper":
      return [{ queryKey: [QK.papers, change.paperId], exact: true }, ...(change.collection ? roots(QK.collections) : [])];
    case "paperTags":
      return roots(QK.tags);
    case "note":
      return roots(QK.librarySearch);
    case "tagChoice":
      switch (change.tagKind) {
        // Deleting a tag takes it off every paper; the others stay on the papers and notes that have them.
        case "paper": return change.removed ? roots(QK.tags, QK.papers, QK.librarySearch) : roots(QK.tags);
        case "status": return roots(QK.readingStatuses);
        case "sticky": return roots(QK.stickyLabels);
      }
      break;
    case "stickyNote":
      return roots(QK.stickyNotes, QK.librarySearch);
    case "stickyNoteMoved":
      return roots(QK.stickyNotes);
    case "glossary":
      // A term changes the source of the pages that contain it, so which saved translations can be reused.
      // The domains a paper uses follow the dictionary (a domain gone, a new one), so they are read again too.
      return roots(QK.glossary, QK.glossaryDomains, QK.effectiveGlossary, QK.paragraphs, QK.translationPlan);
    case "glossaryDomains":
      // Which dictionaries apply changes the terms the paper's pages were translated with, like a term edit does.
      return [{ queryKey: [QK.glossaryDomains, change.paperId] }, { queryKey: [QK.translationPlan, change.paperId] },
        { queryKey: [QK.paragraphs, change.paperId] }, { queryKey: [QK.effectiveGlossary, change.paperId] }];
    case "translationRevised":
      return [{ queryKey: [QK.paragraphs, change.paperId] }, { queryKey: [QK.revisions, change.paperId] }];
    case "noteTemplates":
      return roots(QK.noteTemplates);
    case "settings":
      // Model lists depend on the CLI path, and the plan usage on the connection.
      return roots(QK.settings, QK.prompts, QK.models, QK.efforts, QK.usageLimits);
    case "drive":
      return roots(QK.drive);
  }
  return [];
}

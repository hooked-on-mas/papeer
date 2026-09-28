/**
 * The paper's details in the 論文情報 form (title, first author, year, venue, DOI, arXiv ID, folder), saved
 * as they are typed (metadataAutosave.ts). Kept apart so that it can be tested.
 *
 * A draft holds what is typed (`values`) and what the sidecar holds as far as is known (`saved`): the
 * paper's values, then each value saved. A field is unsaved while the two differ by more than the spaces
 * the sidecar trims, so a space typed at the end of a word is neither sent on its own nor taken away
 * when the saved value comes back (see withServerValues).
 */
import type { PaperData } from "../../api/hooks.ts";
import { normalizeCollection } from "../../lib/collectionPath.ts";
import { PY_SPACE, pyStrip } from "../../lib/pyWhitespace.ts";

export const META_FIELDS = ["title", "author", "year", "venue", "doi", "arxiv_id", "collection"] as const;
export type MetaField = (typeof META_FIELDS)[number];
export type MetaValues = Record<MetaField, string>;

export type MetaDraft = {
  values: MetaValues;
  saved: MetaValues;
  /** Why a field was not saved: its value breaks a rule (localProblem), or the sidecar refused it. */
  problems: Partial<Record<MetaField, string>>;
  /** The value the sidecar refused for a field (400) and why: not sent again while the field holds it,
   * and its reason shown again when the field comes back to it after other edits. */
  rejected: Partial<Record<MetaField, { value: string; message: string }>>;
};

export const META_LABELS: Record<MetaField, string> = {
  title: "タイトル", author: "筆頭著者", year: "出版年", venue: "掲載誌", doi: "DOI", arxiv_id: "arXiv ID", collection: "フォルダー",
};

export function metaValues(paper: PaperData): MetaValues {
  return {
    title: paper.title ?? "", author: paper.first_author ?? "", year: paper.publication_year ?? "", venue: paper.venue ?? "",
    doi: paper.doi ?? "", arxiv_id: paper.arxiv_id ?? "", collection: paper.collection_name ?? "",
  };
}

export function newDraft(server: MetaValues): MetaDraft {
  return { values: { ...server }, saved: { ...server }, problems: {}, rejected: {} };
}

/** A run of whitespace, where Python's str.split() splits. */
const PY_WHITESPACE_RUN = new RegExp(`${PY_SPACE}+`);

/** The value as the sidecar would keep it, as far as spaces go (Library.update, and PATCH's title). */
export function looseValue(field: MetaField, value: string): string {
  if (field === "venue") return value.split(PY_WHITESPACE_RUN).filter(Boolean).join(" ");
  if (field === "collection") return normalizeCollection(value);
  return pyStrip(value);
}

/** A rule the value breaks, said before sending it; the sidecar checks the DOI and arXiv ID itself. */
export function localProblem(field: MetaField, value: string): string | null {
  const loose = looseValue(field, value);
  if (field === "title" && !loose) return "タイトルを入力してください。";
  if (field === "year" && loose && !/^[0-9]{4}$/.test(loose)) return "出版年は半角数字4桁で入力してください（不明なら空欄）。";
  if (field === "venue" && loose.length > 300) return "掲載誌は300文字以内で入力してください。";
  return null;
}

/** The fields whose typed value is not saved yet. */
export function unsavedFields(draft: MetaDraft): MetaField[] {
  return META_FIELDS.filter((field) => looseValue(field, draft.values[field]) !== looseValue(field, draft.saved[field]));
}

/**
 * What a save sends: the unsaved fields, except those that break a rule (with why, in `problems`) and
 * those still holding a value the sidecar refused.
 */
export function fieldsToSend(draft: MetaDraft): { send: MetaField[]; problems: Partial<Record<MetaField, string>> } {
  const problems: Partial<Record<MetaField, string>> = {};
  const send: MetaField[] = [];
  for (const field of unsavedFields(draft)) {
    const value = draft.values[field];
    const problem = localProblem(field, value);
    const refused = draft.rejected[field];
    if (problem) problems[field] = problem;
    else if (refused?.value === value) problems[field] = refused.message;
    else send.push(field);
  }
  return { send, problems };
}

/** PATCH /api/papers/{id}'s body for `fields`. */
export function requestBody(fields: readonly MetaField[], values: MetaValues): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field, field === "title" || field === "year" ? pyStrip(values[field]) : values[field]]));
}

/** The draft once `fields` were saved with `sent` (the values as sent), which is then what the sidecar holds. */
export function withSaved(draft: MetaDraft, fields: readonly MetaField[], sent: MetaValues): MetaDraft {
  const saved = { ...draft.saved };
  const problems = { ...draft.problems };
  const rejected = { ...draft.rejected };
  for (const field of fields) {
    saved[field] = sent[field];
    delete problems[field];
    delete rejected[field];
  }
  return { ...draft, saved, problems, rejected };
}

/** The draft once the sidecar refused `field` with `sent` (400), for `message`. */
export function withRejected(draft: MetaDraft, field: MetaField, sent: string, message: string): MetaDraft {
  return { ...draft, problems: { ...draft.problems, [field]: message }, rejected: { ...draft.rejected, [field]: { value: sent, message } } };
}

/** The draft once `field` is typed into: its problem goes until it is saved again. */
export function withTyped(draft: MetaDraft, field: MetaField, value: string): MetaDraft {
  const problems = { ...draft.problems };
  delete problems[field];
  return { ...draft, values: { ...draft.values, [field]: value }, problems };
}

/** The draft with a field put back to its saved value, dropping what was typed. */
export function withReverted(draft: MetaDraft, field: MetaField): MetaDraft {
  const next = withTyped(draft, field, draft.saved[field]);
  const rejected = { ...next.rejected };
  delete rejected[field];
  return { ...next, rejected };
}

/**
 * The draft once the paper was loaded again with `server`'s values (after a save, or a change made
 * elsewhere). An unsaved field keeps what is typed. A saved one shows the sidecar's value (a DOI pasted
 * as a link comes back bare), unless the two differ only by trimmed spaces, so that saving while a
 * word is being typed does not take its last space away.
 */
export function withServerValues(draft: MetaDraft, server: MetaValues): MetaDraft {
  const unsaved = new Set(unsavedFields(draft));
  const values = { ...draft.values };
  const saved = { ...draft.saved };
  let changed = false;
  for (const field of META_FIELDS) {
    if (unsaved.has(field) || looseValue(field, values[field]) === server[field]) {
      if (!unsaved.has(field) || saved[field] === server[field]) continue;
      saved[field] = server[field];
    } else {
      values[field] = server[field];
      saved[field] = server[field];
    }
    changed = true;
  }
  return changed ? { ...draft, values, saved } : draft;
}

/**
 * The AI's folder proposal (OrganizeProposal) as the organize dialog edits it: papers left out, moved
 * somewhere else, new folders renamed. Pure, so that it can be tested; OrganizeDialog.tsx shows it and
 * organizeActions.ts sends it (POST /api/collections/apply-moves).
 *
 * Folders are virtual paths ("a / b", "" is 未分類; lib/collectionPath.ts). The proposal itself is never
 * changed: an edit gives a new draft, which keeps what the AI proposed (`proposedTo`, `proposedName`)
 * to tell what the user changed.
 */
import type { OrganizeProposal } from "../../api/jobTypes.ts";
import { folderAncestors, normalizeCollection, parentFolder, subfolderPath } from "../../lib/collectionPath.ts";
import { itemCapabilities } from "../../lib/itemKinds.ts";

/** The most papers one proposal covers (MAX_PAPERS in papeer/core/library_organize.py). */
export const MAX_ORGANIZE_PAPERS = 300;
/** The longest one folder name (NAME_LIMIT in papeer/core/library_organize.py), in characters. */
export const FOLDER_NAME_LIMIT = 80;

export type DraftMove = {
  paperId: string;
  title: string;
  /** The folder the paper is in, as the proposal saw it. */
  from: string;
  /** Where it goes now: the proposal's, or the one chosen. */
  to: string;
  proposedTo: string;
  /** Unchecked: the paper stays where it is. */
  included: boolean;
};

export type DraftFolder = {
  name: string;
  proposedName: string;
  reason: string;
  /** Made by applying the proposal (the only ones that can be renamed). */
  isNew: boolean;
};

export type OrganizeDraft = {
  source: string;
  instruction: string;
  message: string;
  folders: DraftFolder[];
  moves: DraftMove[];
  /** The folder of each proposed paper when the proposal was made: what apply-moves checks them against. */
  expected: Record<string, string>;
};

export function draftFromProposal(proposal: OrganizeProposal): OrganizeDraft {
  return {
    source: normalizeCollection(proposal.source),
    instruction: proposal.instruction,
    message: proposal.message,
    folders: proposal.folders.map((folder) => {
      const name = normalizeCollection(folder.name);
      return { name, proposedName: name, reason: folder.reason, isNew: folder.new };
    }),
    moves: proposal.moves.map((move) => {
      const to = normalizeCollection(move.to);
      return { paperId: move.paper_id, title: move.title, from: normalizeCollection(move.from), to, proposedTo: to, included: true };
    }),
    expected: { ...proposal.expected },
  };
}

/** Whether the paper would change folders: checked, and not sent where it already is. */
export function isMoving(move: DraftMove): boolean {
  return move.included && move.to !== move.from;
}

export function movingMoves(draft: OrganizeDraft): DraftMove[] {
  return draft.moves.filter(isMoving);
}

/** What 「N件を移動」 sends: only the checked moves that change a folder, with the folders they were proposed from. */
export function applyPayload(draft: OrganizeDraft): { moves: { paper_id: string; to: string }[]; expected: Record<string, string> } {
  const moving = movingMoves(draft);
  return {
    moves: moving.map((move) => ({ paper_id: move.paperId, to: move.to })),
    expected: Object.fromEntries(moving.map((move) => [move.paperId, draft.expected[move.paperId] ?? move.from])),
  };
}

/** Whether the user changed anything of what the AI proposed. */
export function draftEdited(draft: OrganizeDraft): boolean {
  return draft.moves.some((move) => !move.included || move.to !== move.proposedTo)
    || draft.folders.some((folder) => folder.name !== folder.proposedName);
}

/**
 * The draft as a proposal again, to have the AI revise it: the papers the user left out, and those sent
 * where they are, are not in it (they are not to move), so that the AI starts from what the user would apply.
 */
export function proposalFromDraft(draft: OrganizeDraft): OrganizeProposal {
  const moving = movingMoves(draft);
  const folders: OrganizeProposal["folders"] = [];
  const known = new Set<string>();
  const used = new Set(moving.map((move) => move.to));
  for (const folder of draft.folders) {
    if (!folder.name || !used.has(folder.name) || known.has(folder.name)) continue;
    known.add(folder.name);
    folders.push({ name: folder.name, reason: folder.reason, new: folder.isNew });
  }
  // A destination chosen from the existing folders, which the proposal did not name.
  for (const move of moving) {
    if (!move.to || known.has(move.to)) continue;
    known.add(move.to);
    folders.push({ name: move.to, reason: "", new: false });
  }
  return {
    source: draft.source,
    instruction: draft.instruction,
    folders,
    moves: moving.map((move) => ({ paper_id: move.paperId, title: move.title, from: move.from, to: move.to })),
    expected: Object.fromEntries(moving.map((move) => [move.paperId, draft.expected[move.paperId] ?? move.from])),
    message: draft.message,
  };
}

function replaceMoves(draft: OrganizeDraft, change: (move: DraftMove) => DraftMove): OrganizeDraft {
  let changed = false;
  const moves = draft.moves.map((move) => {
    const next = change(move);
    if (next !== move) changed = true;
    return next;
  });
  return changed ? { ...draft, moves } : draft;
}

/** Checks or unchecks the papers; the draft itself when nothing changes. */
export function setIncluded(draft: OrganizeDraft, paperIds: readonly string[], included: boolean): OrganizeDraft {
  const wanted = new Set(paperIds);
  return replaceMoves(draft, (move) => wanted.has(move.paperId) && move.included !== included ? { ...move, included } : move);
}

/** Sends the paper to the folder `to` ("" for 未分類) instead. */
export function setDestination(draft: OrganizeDraft, paperId: string, to: string): OrganizeDraft {
  const folder = normalizeCollection(to);
  return replaceMoves(draft, (move) => move.paperId === paperId && move.to !== folder ? { ...move, to: folder } : move);
}

/** What `existing` (the library's folder names) means as a set: each folder with its parents. */
export function withAncestors(names: Iterable<string>): Set<string> {
  const all = new Set<string>();
  for (const name of names) folderAncestors(name).forEach((ancestor) => all.add(ancestor));
  return all;
}

const fold = (value: string) => value.toLowerCase();

export type RenameResult = { draft: OrganizeDraft } | { error: string };

/**
 * Renames the new folder `path` (one the proposal names, or a parent of those that does not exist yet)
 * to `leaf` (its last name; a "/" in it makes a deeper path), under the same parent. The new folders
 * below it follow, as any folder's subfolders do, and so do the papers sent to them. The name must be one the AI's own names would be: not empty, no "." or ".." and no name
 * over FOLDER_NAME_LIMIT characters; and not one of an existing folder (`existing`: every folder with its
 * parents, see withAncestors) or of another folder of the proposal, ignoring case.
 */
export function renameNewFolder(draft: OrganizeDraft, path: string, leaf: string, existing: ReadonlySet<string>): RenameResult {
  // A parent the proposal does not name itself (only "a / b" is, a being new too) is a new folder as well.
  if (!path || !isNewPath(draft, existing, path)) return { error: "このフォルダーの名前は変更できません。" };
  const name = normalizeCollection(leaf);
  if (!name) return { error: "フォルダー名を入力してください。" };
  const parts = name.split(" / ");
  if (parts.some((part) => part === "." || part === "..")) return { error: "「.」と「..」はフォルダー名に使えません。" };
  if (parts.some((part) => [...part].length > FOLDER_NAME_LIMIT)) return { error: `フォルダー名は${FOLDER_NAME_LIMIT}文字までです。` };
  const target = subfolderPath(parentFolder(path), name);
  if (target === path) return { draft };
  const prefix = path + " / ";
  const rename = (value: string) => value === path ? target : value.startsWith(prefix) ? target + value.slice(path.length) : value;
  const affected = draft.folders.filter((folder) => folder.isNew && (folder.name === path || folder.name.startsWith(prefix)));
  const taken = new Set([...existing, ...draft.folders.filter((folder) => !affected.includes(folder)).map((folder) => folder.name)].map(fold));
  // The folder itself too, which the proposal need not name (a parent of the folders it names).
  if ([...new Set([path, ...affected.map((folder) => folder.name)])].some((name) => taken.has(fold(rename(name))))) {
    return { error: "同じ名前のフォルダーがすでにあります。" };
  }
  return {
    draft: {
      ...draft,
      folders: draft.folders.map((folder) => affected.includes(folder) ? { ...folder, name: rename(folder.name) } : folder),
      moves: draft.moves.map((move) => rename(move.to) === move.to ? move : { ...move, to: rename(move.to) }),
    },
  };
}

/** The folders a paper can be sent to: 未分類 (""), the existing ones, then the proposal's new ones. */
export function destinationChoices(draft: OrganizeDraft, existing: readonly string[]): string[] {
  const choices = ["", ...existing.filter(Boolean)];
  const known = new Set(choices);
  for (const name of [...draft.folders.map((folder) => folder.name), ...draft.moves.map((move) => move.to)]) {
    if (!known.has(name)) {
      known.add(name);
      choices.push(name);
    }
  }
  return choices;
}

/** Whether `path` is made by the proposal: named so by it (kept when renamed), else not an existing folder. */
function isNewPath(draft: OrganizeDraft, existing: ReadonlySet<string>, path: string): boolean {
  const entry = draft.folders.find((folder) => folder.name === path);
  return entry ? entry.isNew : !existing.has(path);
}

/** The folders applying the checked moves makes (the destinations that do not exist, and their parents), in tree order. */
export function createdFolders(draft: OrganizeDraft, existing: ReadonlySet<string>): string[] {
  const created = new Set<string>();
  for (const move of movingMoves(draft)) {
    for (const path of folderAncestors(move.to)) if (!existing.has(path)) created.add(path);
  }
  return [...created];
}

export type OrganizeRow =
  | {
    kind: "folder"; key: string; path: string; name: string; depth: number; isNew: boolean; reason: string;
    /** The papers sent here, how many of them are checked, and how many would move. */
    paperIds: string[]; included: number; moving: number;
  }
  | { kind: "paper"; key: string; move: DraftMove; depth: number };

const collator = new Intl.Collator("ja", { sensitivity: "base" });

/**
 * The folder structure the proposal makes, as the lines to show: each destination folder (under its
 * parents, which are shown for the place they give), then the papers sent to it. The proposal's order
 * comes first, then the folders it did not name by name; 未分類 is last.
 */
export function organizeRows(draft: OrganizeDraft, existing: ReadonlySet<string>): OrganizeRow[] {
  const groups = new Map<string, DraftMove[]>();
  for (const move of draft.moves) {
    const group = groups.get(move.to);
    if (group) group.push(move);
    else groups.set(move.to, [move]);
  }
  const seen = new Set<string>();
  const order: string[] = [];
  const add = (path: string) => {
    for (const ancestor of folderAncestors(path)) {
      if (seen.has(ancestor)) continue;
      seen.add(ancestor);
      order.push(ancestor);
    }
  };
  for (const folder of draft.folders) if (groups.has(folder.name)) add(folder.name);
  for (const path of [...groups.keys()].filter((path) => path && !seen.has(path)).sort(collator.compare)) add(path);
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const path of order) {
    const parent = parentFolder(path);
    if (!parent) {
      roots.push(path);
      continue;
    }
    const list = children.get(parent);
    if (list) list.push(path);
    else children.set(parent, [path]);
  }
  const rows: OrganizeRow[] = [];
  const reasons = new Map(draft.folders.map((folder) => [folder.name, folder.reason]));
  const visit = (path: string, depth: number) => {
    const moves = groups.get(path) ?? [];
    rows.push({
      kind: "folder", key: `folder:${path}`, path, name: path.split(" / ").pop() ?? path, depth, isNew: isNewPath(draft, existing, path),
      reason: reasons.get(path) ?? "", paperIds: moves.map((move) => move.paperId),
      included: moves.filter((move) => move.included).length, moving: moves.filter(isMoving).length,
    });
    for (const move of moves) rows.push({ kind: "paper", key: `paper:${move.paperId}`, move, depth: depth + 1 });
    for (const child of children.get(path) ?? []) visit(child, depth + 1);
  };
  for (const path of roots) visit(path, 0);
  const unfiled = groups.get("");
  if (unfiled) {
    rows.push({
      kind: "folder", key: "folder:", path: "", name: "未分類", depth: 0, isNew: false, reason: "",
      paperIds: unfiled.map((move) => move.paperId), included: unfiled.filter((move) => move.included).length,
      moving: unfiled.filter(isMoving).length,
    });
    for (const move of unfiled) rows.push({ kind: "paper", key: `paper:${move.paperId}`, move, depth: 1 });
  }
  return rows;
}

/** The folder that holds all of `folders` (their longest common path); "" when they share none. */
export function commonFolder(folders: readonly string[]): string {
  if (!folders.length) return "";
  const split = folders.map((folder) => normalizeCollection(folder).split(" / ").filter(Boolean));
  const first = split[0];
  let length = first.length;
  for (const parts of split) {
    let same = 0;
    while (same < length && same < parts.length && parts[same] === first[same]) same++;
    length = same;
  }
  return first.slice(0, length).join(" / ");
}

/** The papers (each once) that one proposal can cover; null for none, or more than MAX_ORGANIZE_PAPERS. */
export function organizableIds(paperIds: readonly string[]): string[] | null {
  const unique = [...new Set(paperIds)];
  return unique.length > 0 && unique.length <= MAX_ORGANIZE_PAPERS ? unique : null;
}

/** The papers directly in folder `source` ("" for 未分類), which an organization of it covers (not those of its subfolders). */
export function papersDirectlyIn<T extends { collection_name?: string | null }>(papers: readonly T[], source: string): T[] {
  const folder = normalizeCollection(source);
  return papers.filter((paper) => normalizeCollection(paper.collection_name || "") === folder);
}

/** The items an organization can cover: those the sidecar reads the text of to sort (not a notebook). */
export function organizableItems<T extends { kind?: string | null }>(items: readonly T[]): T[] {
  return items.filter((item) => itemCapabilities(item).organize);
}

/** Whether all of `items` can be organized: a selection with a notebook in it cannot (its menu entry is off; the dialog refuses it). */
export function allOrganizable(items: readonly { kind?: string | null }[]): boolean {
  return items.every((item) => itemCapabilities(item).organize);
}

export type OrganizeCandidates<T> = {
  /** The papers the proposal will cover. */
  papers: T[];
  /** The items asked for that it cannot cover (notebooks): said in the dialog, never counted as papers. */
  excluded: number;
};

/**
 * What an organization of a folder (`paperIds` null: the items directly in `source`) or of a selection
 * (`paperIds`) covers out of `items`, the library's list.
 */
export function organizeCandidates<T extends { id: string; collection_name?: string | null; kind?: string | null }>(
  items: readonly T[], target: { source: string; paperIds: readonly string[] | null },
): OrganizeCandidates<T> {
  let asked: T[];
  if (target.paperIds) {
    const wanted = new Set(target.paperIds);
    asked = items.filter((item) => wanted.has(item.id));
  } else {
    asked = papersDirectlyIn(items, target.source);
  }
  const papers = organizableItems(asked);
  return { papers, excluded: asked.length - papers.length };
}

/** How many papers each folder ("" for 未分類) holds directly, as an organization of it would cover. */
export function organizableCounts(items: readonly { collection_name?: string | null; kind?: string | null }[]): Map<string, number> {
  const byFolder = new Map<string, number>();
  for (const item of items) {
    if (!itemCapabilities(item).organize) continue;
    const folder = normalizeCollection(item.collection_name || "");
    byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1);
  }
  return byFolder;
}

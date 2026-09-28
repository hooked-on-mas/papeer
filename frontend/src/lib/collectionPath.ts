/**
 * Folder paths: a folder is the path "親 / 子" (" / " between the names), and "" is 未分類. The sidecar
 * keeps the same rules (papeer/core/storage.py: normalize_collection_name, collection_ancestors,
 * in_collection); both are tested against tests/fixtures/collection_paths.json.
 */
import { pyStrip } from "./pyWhitespace.ts";

export const FOLDER_SEPARATOR = " / ";

/** A folder path as the library shows it: "親 / 子", from either slash. */
export function normalizeCollection(value: string): string {
  return value.split(/[\\/]/).map(pyStrip).filter(Boolean).join(FOLDER_SEPARATOR);
}

/** The folder names along the path, outermost first; none for 未分類. */
export function folderParts(path: string): string[] {
  const name = normalizeCollection(path);
  return name ? name.split(FOLDER_SEPARATOR) : [];
}

/** The folder and its parents, outermost first: "a / b" gives ["a", "a / b"]; none for 未分類. */
export function folderAncestors(path: string): string[] {
  const parts = folderParts(path);
  return parts.map((_, i) => parts.slice(0, i + 1).join(FOLDER_SEPARATOR));
}

/** The folder's own name, the last of its path; "" for 未分類. */
export function folderName(path: string): string {
  return folderParts(path).pop() ?? "";
}

/** The folder that holds `path`; "" at the top. */
export function parentFolder(path: string): string {
  return folderParts(path).slice(0, -1).join(FOLDER_SEPARATOR);
}

/** The path of `name` inside `parent` (the top when ""), left for the sidecar to normalize. */
export function subfolderPath(parent: string, name: string): string {
  return parent ? `${parent}${FOLDER_SEPARATOR}${name}` : name;
}

/** Whether the folder `value` is `path` (normalized) or one of its subfolders. */
export function isInsideFolder(value: string, path: string): boolean {
  const name = normalizeCollection(value);
  return name === path || name.startsWith(path + FOLDER_SEPARATOR);
}

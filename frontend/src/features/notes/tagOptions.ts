/**
 * The tag field of 読書状態・タグ: a combobox that filters the library's tags as the name is typed, and
 * offers the typed name as a new tag when no tag has exactly that name. A new tag needs no step of its
 * own: saving the paper's tags adds it to the choices (Library.update in papeer/core/storage.py).
 */

/** As Library.update refuses them. */
export const MAX_TAG_LENGTH = 80;
export const MAX_TAGS = 100;

export type TagOption =
  | { kind: "tag"; name: string; selected: boolean }
  | { kind: "create"; name: string };

/**
 * The options for what is typed: the tags whose name contains it (case aside), those it begins first,
 * then the typed name as a new tag unless a tag has exactly that name. Everything when nothing is typed.
 */
export function tagOptions(choices: readonly string[], selected: readonly string[], typed: string): TagOption[] {
  const text = typed.trim();
  const wanted = text.toLocaleLowerCase();
  const names = [...new Set([...choices, ...selected])];
  const matching = wanted ? names.filter((name) => name.toLocaleLowerCase().includes(wanted)) : names;
  const starting = matching.filter((name) => name.toLocaleLowerCase().startsWith(wanted));
  const ordered = [...starting, ...matching.filter((name) => !starting.includes(name))];
  const options: TagOption[] = ordered.map((name) => ({ kind: "tag", name, selected: selected.includes(name) }));
  if (text && !names.includes(text)) options.push({ kind: "create", name: text });
  return options;
}

/** Why the tag cannot be put on the paper, or null. */
export function tagProblem(name: string, selected: readonly string[]): string | null {
  if (Array.from(name).length > MAX_TAG_LENGTH) return `タグ名は${MAX_TAG_LENGTH}文字までです。`;
  if (!selected.includes(name) && selected.length >= MAX_TAGS) return `タグは1つの論文に${MAX_TAGS}個までです。`;
  return null;
}

/** The option the arrow keys, Home and End move to among `count`, from `current` (-1: none). */
export function movedOption(current: number, key: string, count: number): number {
  if (!count) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return current < 0 ? 0 : (current + 1) % count;
  if (key === "ArrowUp") return current < 0 ? count - 1 : (current - 1 + count) % count;
  return current;
}

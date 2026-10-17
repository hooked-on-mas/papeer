/**
 * The paper a notebook page is made on (size, orientation, ruling, colour): the choices, the default, and
 * what is remembered of the last notebook made. Pure, so that the store's saved data and the tests can use
 * it without the notebook screens.
 */
import type { components } from "../../api/schema";

export type NotebookPaper = components["schemas"]["NotebookPaper"];

export const DEFAULT_PAPER = { size: "A4", orientation: "portrait", template: "ruled7", color: "white" } satisfies NotebookPaper;
export const PAPER_SIZES = ["A4", "B5", "A5", "Letter", "16:9"] as const;
export const PAPER_TEMPLATES = [
  ["blank", "無地"], ["ruled7", "横罫 7mm"], ["ruled6", "横罫 6mm"], ["ruled5", "横罫 5mm"],
  ["grid5", "方眼 5mm"], ["grid10", "方眼 10mm"], ["dot5", "ドット 5mm"], ["cornell", "コーネル"],
] as const;
const ORIENTATIONS = ["portrait", "landscape"] as const;
const COLORS = ["white", "cream", "dark"] as const;

/**
 * A paper read back from what was saved: the whole of it, or null when anything is missing or unknown (a
 * value from a newer version, or edited by hand), so that a broken value gives the default and not half of one.
 */
export function savedNotebookPaper(value: unknown): NotebookPaper | null {
  if (typeof value !== "object" || value === null) return null;
  const { size, orientation, template, color } = value as Record<string, unknown>;
  const size_ = PAPER_SIZES.find((candidate) => candidate === size);
  const orientation_ = ORIENTATIONS.find((candidate) => candidate === orientation);
  const template_ = PAPER_TEMPLATES.find(([candidate]) => candidate === template)?.[0];
  const color_ = COLORS.find((candidate) => candidate === color);
  if (!size_ || !orientation_ || !template_ || !color_) return null;
  return { size: size_, orientation: orientation_, template: template_, color: color_ };
}

/** 「ノート 10/17」: the name a new notebook starts with, and 「ノート 10/17 (2)」… when `taken` (the names in the same place) has it. */
export function defaultNotebookTitle(today: Date, taken: Iterable<string>): string {
  const base = `ノート ${today.getMonth() + 1}/${today.getDate()}`;
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let number = 2; ; number++) if (!names.has(`${base} (${number})`)) return `${base} (${number})`;
}

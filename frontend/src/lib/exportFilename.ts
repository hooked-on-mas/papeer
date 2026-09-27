type PaperIdentity = { id: string; title?: string; original_name?: string };

export type PaperExportKind = "original" | "translated" | "interleaved" | "bilingual" | "markdown" | "original-annotated" | "translated-annotated";

const labels: Record<PaperExportKind, string> = {
  original: "原文",
  translated: "日本語訳",
  interleaved: "原文と日本語訳-交互ページ",
  bilingual: "原文と日本語訳-対訳",
  markdown: "サマリー",
  "original-annotated": "原文-書き込み付き",
  "translated-annotated": "日本語訳-書き込み付き",
};

function safeStem(value: string): string {
  return value.replace(/\.pdf$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
}

/** Shared by native save dialogs and browser downloads. */
export function paperExportFilename(paper: PaperIdentity, kind: PaperExportKind): string {
  const stem = safeStem(paper.title ?? "") || safeStem(paper.original_name ?? "") || `論文-${safeStem(paper.id)}`;
  // Leave room for the kind and extension within Windows filename limits.
  const shortened = stem.slice(0, 160).replace(/[\uD800-\uDBFF]$/, "").replace(/[. ]+$/g, "");
  const extension = kind === "markdown" ? "md" : "pdf";
  return `${shortened}-${labels[kind]}.${extension}`;
}

/** The .bib file a folder's BibTeX is saved to by default: the folder's own name (the last part of its path). */
export function bibtexFilename(folder: string): string {
  const leaf = folder.split(/[\/]/).map((part) => part.trim()).filter(Boolean).pop() ?? "";
  const stem = safeStem(leaf).slice(0, 160).replace(/[\uD800-\uDBFF]$/, "").replace(/[. ]+$/g, "");
  return `${stem || "文献"}.bib`;
}

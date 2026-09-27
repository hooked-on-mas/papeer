/**
 * Destinations inside a PDF, for its links and its table of contents (outline): which page they
 * open, and where on the page.
 */

/** A place in the paper, as the reader jumps to it. */
export interface PdfPlace {
  page: number;
  /** How far down the page the destination is, from 0 at the top to 1 at the bottom, when it says. */
  anchor_y?: number;
}

/** The parts of pdf.js's PDFDocumentProxy used here. */
export interface PdfDocumentLike {
  numPages: number;
  getOutline(): Promise<OutlineNode[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: never): Promise<number>;
  getPage(pageNumber: number): Promise<{ view: number[] }>;
}

/** An item of pdf.js's outline. */
export interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  url?: string | null;
  items: OutlineNode[];
}

export interface OutlineEntry extends Partial<PdfPlace> {
  title: string;
  /** Nesting level, 0 at the top. */
  depth: number;
}

/**
 * How far down the page `dest` points, for the kinds of destination that give a height. `view` is the
 * page's box in PDF units, whose y axis points up.
 */
export function destAnchor(dest: readonly unknown[], view: readonly number[]): number | undefined {
  const kind = (dest[1] as { name?: unknown } | null | undefined)?.name;
  const top = kind === "XYZ" ? dest[3] : kind === "FitH" || kind === "FitBH" ? dest[2] : kind === "FitR" ? dest[5] : undefined;
  if (typeof top !== "number" || !Number.isFinite(top) || view.length < 4) return undefined;
  const height = view[3] - view[1];
  if (!(height > 0)) return undefined;
  return Math.max(0, Math.min(1, (view[3] - top) / height));
}

/** Reads each page's box once, since an outline often points at the same page many times. */
function pageViews(doc: PdfDocumentLike) {
  const views = new Map<number, Promise<number[] | null>>();
  return (page: number) => {
    let view = views.get(page);
    if (!view) {
      view = doc.getPage(page).then((proxy) => proxy.view, () => null);
      views.set(page, view);
    }
    return view;
  };
}

/** Where a named or explicit destination leads, or null when it leads nowhere in this document. */
export async function resolveDestination(doc: PdfDocumentLike, dest: unknown,
  viewOf: (page: number) => Promise<number[] | null> = pageViews(doc)): Promise<PdfPlace | null> {
  try {
    // Named, explicit, or (from pdf.js's link service) a promise of an explicit one.
    const explicit: unknown = typeof dest === "string" ? await doc.getDestination(dest) : await dest;
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const ref = explicit[0];
    const index = typeof ref === "number" ? ref
      : ref && typeof ref === "object" ? await doc.getPageIndex(ref as never) : null;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= doc.numPages) return null;
    const view = await viewOf(index + 1);
    const anchor_y = view ? destAnchor(explicit, view) : undefined;
    return anchor_y === undefined ? { page: index + 1 } : { page: index + 1, anchor_y };
  } catch {
    return null;
  }
}

/** More than any real paper's contents; keeps a malformed outline from flooding the menu. */
export const OUTLINE_LIMIT = 1000;

/**
 * The document's table of contents as a flat list in reading order. Entries that lead nowhere in the
 * document (web links, broken destinations) stay as headings for their children, without a page.
 */
export async function loadOutline(doc: PdfDocumentLike, limit = OUTLINE_LIMIT): Promise<OutlineEntry[]> {
  let outline: OutlineNode[] | null;
  try {
    outline = await doc.getOutline();
  } catch {
    return [];
  }
  const nodes: { node: OutlineNode; depth: number }[] = [];
  const visit = (items: OutlineNode[] | null | undefined, depth: number) => {
    for (const node of items ?? []) {
      if (nodes.length >= limit) return;
      nodes.push({ node, depth });
      visit(node.items, depth + 1);
    }
  };
  visit(outline, 0);
  const viewOf = pageViews(doc);
  return Promise.all(nodes.map(async ({ node, depth }) => {
    const title = (node.title ?? "").replace(/\s+/g, " ").trim() || "（無題）";
    const place = node.dest ? await resolveDestination(doc, node.dest, viewOf) : null;
    return { title, depth, ...place };
  }));
}

/** The entry whose section contains `page`: the last one that starts on it or before it. */
export function currentOutlineIndex(entries: readonly OutlineEntry[], page: number): number {
  let found = -1;
  entries.forEach((entry, index) => {
    if (entry.page !== undefined && entry.page <= page && (found < 0 || entry.page >= (entries[found].page ?? 0))) found = index;
  });
  return found;
}

/**
 * The original page shown as page `index` (0-based) of `file` in the translation pane. The translated
 * PDF keeps the original's pages, and pages outside the translation show the original itself.
 */
export function originalPageFor(pages: Record<string, { file: string; index: number } | null | undefined>,
  file: string, index: number): number | null {
  for (const [page, ref] of Object.entries(pages)) {
    if (ref && ref.file === file && ref.index === index) return Number(page);
  }
  // A page no one shows yet, in a PDF with every page.
  if (file === "original.pdf" || file === "translated.pdf") return index + 1;
  return null;
}

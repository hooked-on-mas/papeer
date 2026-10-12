/**
 * The kinds of item the library lists (`kind` of a paper row) and what each can do. The screens do not
 * compare `kind` themselves: they ask for a capability here, so that a new kind is one entry in KINDS
 * and the places that gate a feature (the header's menu, the reader's panes, the tabs, a row's status,
 * the library's context menu) need no change. Pure, so that it can be tested.
 *
 * A capability is on only where it works for the kind as it is built today. Those of a kind to come
 * (a notebook's text once it is read by OCR, say) are turned on in the step that makes them work.
 */
import type { PaperData } from "../api/hooks.ts";

/** The kinds the API lists (PaperRow.kind); a kind the schema gains must be given its capabilities below. */
export type ItemKind = PaperData["kind"];

export type ItemCapabilities = {
  /** Translating it and what follows from a translation: the terms dictionary, 翻訳の確認・修正, the translated PDFs, the translation status. */
  notebook: boolean;
  translate: boolean;
  /** The reader's right pane (the translation, side by side with the original). */
  split: boolean;
  /** Writing the サマリー (解説) of it, and its tab. */
  summary: boolean;
  /** Asking the AI about it, and the チャット tab. */
  chat: boolean;
  /** The メモ tab: a text memo of its own. */
  memo: boolean;
  /** 付箋 and highlights of selected text, which need the PDF's text layer. */
  stickyNotes: boolean;
  /** Its place in the 論文マップ: citations are read from the paper's own text and bibliography. */
  citationMap: boolean;
  /** 書誌情報 (author, year, venue, DOI, arXiv ID) and BibTeX. */
  bibliography: boolean;
  /** Reading the pages without a text layer by OCR. */
  ocr: boolean;
  /** Searching its text from inside it (論文内検索). */
  fullTextSearch: boolean;
  /** Being sorted into folders by the AI from what it says (AIで内容別に分ける): the sidecar reads the papers' text, and lists PDFs only. */
  organize: boolean;
  /** Writing on its pages by hand (書き込み). */
  annotate: boolean;
  /** Its original.pdf is the user's own file: opening it with another app, saving a copy of it. */
  originalPdf: boolean;
  /** Renaming it (ファイル名を変更). */
  rename: boolean;
  /** What renaming it appends to the name, "" for none. */
  fileExtension: string;
  /** Listed ahead of the papers in its folder. */
  listedFirst: boolean;
  /** Linking a paper to an independent notebook, without moving either. */
  linkPaper: boolean;
  linkNotebook: boolean;
};

/** What an item of a kind unknown to this app can do: nothing, so that nothing is offered that may not work. */
const NONE: ItemCapabilities = {
  notebook: false, translate: false, split: false, summary: false, chat: false, memo: false, stickyNotes: false, citationMap: false,
  bibliography: false, ocr: false, fullTextSearch: false, organize: false, annotate: false, originalPdf: false, rename: false,
  fileExtension: "", listedFirst: false, linkPaper: false, linkNotebook: false,
};

const PDF: ItemCapabilities = {
  notebook: false, translate: true, split: true, summary: true, chat: true, memo: true, stickyNotes: true, citationMap: true,
  bibliography: true, ocr: true, fullTextSearch: true, organize: true, annotate: true, originalPdf: true, rename: true,
  fileExtension: ".pdf", listedFirst: false, linkPaper: true, linkNotebook: false,
};

/**
 * A handwritten notebook: pages of ink on a blank PDF it makes itself, with no text and no layout of
 * a paper to translate. Its text-dependent features (summary, chat, search) are off until its
 * handwriting is read by OCR, which is a step of its own; so is being sorted into folders by the AI
 * (`organize`), which the sidecar does for PDFs only.
 */
const NOTEBOOK: ItemCapabilities = {
  ...NONE, notebook: true, memo: true, stickyNotes: true, annotate: true, rename: true, listedFirst: true, linkNotebook: true,
};

/** A Record, so that a kind the schema gains does not typecheck until it is given its capabilities. */
const BY_KIND: Record<ItemKind, ItemCapabilities> = { pdf: PDF, notebook: NOTEBOOK };

/** Looked up by a string, which a row's kind may be beyond the schema's (a newer Papeer's). */
const KINDS: ReadonlyMap<string, ItemCapabilities> = new Map(Object.entries(BY_KIND));

/**
 * The capabilities of a kind. A kind that is missing (a row from the cache or the data of a test that
 * predates kinds) is a PDF, which every item was; one not known here has none.
 */
export function kindCapabilities(kind: string | null | undefined): ItemCapabilities {
  if (kind === undefined || kind === null) return PDF;
  return KINDS.get(kind) ?? NONE;
}

/** The capabilities of a kind that holds HTML documents, by the kind's own (a notebook asked about for its documents). */
const WITH_DOCUMENTS = new WeakMap<ItemCapabilities, ItemCapabilities>();

/**
 * What an item can do. Not loaded yet (no item) it is taken to be a PDF: the screens keep what they
 * showed before kinds, rather than hide their controls for the moment the row takes to load.
 *
 * An item that stands on its own, of a kind that has memos, and holds an HTML document (`html_document_count`
 * of its row, 0 when unknown) can be asked about even where its pages have no text: the document's text
 * is what the chat reads, so a notebook with one can be talked about without OCR.
 */
export function itemCapabilities(item: { kind?: string | null; parent_id?: string | null; html_document_count?: number | null } | null | undefined): ItemCapabilities {
  const caps = kindCapabilities(item ? item.kind : undefined);
  if (item && item.parent_id) return { ...caps, memo: false, linkPaper: false, linkNotebook: false };
  if (!item || caps.chat || !caps.memo || !((item.html_document_count ?? 0) > 0)) return caps;
  let withDocuments = WITH_DOCUMENTS.get(caps);
  if (!withDocuments) {
    withDocuments = { ...caps, chat: true };
    WITH_DOCUMENTS.set(caps, withDocuments);
  }
  return withDocuments;
}

/** Only independent papers and notebooks may be linked. Missing rows cannot be drop targets. */
export function canLinkItems(first: { kind?: string | null; parent_id?: string | null } | null | undefined,
  second: { kind?: string | null; parent_id?: string | null } | null | undefined): boolean {
  if (!first || !second) return false;
  const a = itemCapabilities(first), b = itemCapabilities(second);
  return (a.linkPaper && b.linkNotebook) || (a.linkNotebook && b.linkPaper);
}

type FlagKey = { [K in keyof ItemCapabilities]: ItemCapabilities[K] extends boolean ? K : never }[keyof ItemCapabilities];

/** The capability each of the app's tabs (and the side panel's panes) needs; the reader's own tab needs none. */
const TAB_CAPABILITY: ReadonlyMap<string, FlagKey> = new Map<string, FlagKey>([
  ["summary", "summary"],
  ["chat", "chat"],
  ["notes", "memo"],
  ["sticky-notes", "stickyNotes"],
  ["references", "citationMap"],
]);

/** Whether the tab, or the side panel's pane of that name, is offered for an item that can do `caps`. */
export function tabAvailable(caps: ItemCapabilities, tab: string): boolean {
  const need = TAB_CAPABILITY.get(tab);
  return need === undefined || caps[need];
}

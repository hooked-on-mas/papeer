import assert from "node:assert/strict";
import { test } from "node:test";
import { CITATION_URL } from "../src/lib/markdownUrl.ts";
import {
  filterStickyNotes, stickyNotesMarkdown, stickyQuote, stickyTitle, type StickyNote, type StickyFilters,
} from "../src/features/reader/stickyNotes.ts";

const filters: StickyFilters = { scope: "paper", query: "", label: "", side: "", sort: "page", kind: "" };
const first: StickyNote = { id: 1, paper_id: "a", paper_title: "Alpha", paper_name: "alpha.pdf", page: 2, side: "original", quote: "Energy function", label: "疑問", note: "式を確認", anchor_x: .8, anchor_y: .6, created_at: "2026-01-01" };
const notes = [first, { ...first, id: 2, paper_id: "b", paper_title: "Beta", note: "あとで比較", side: "translated" as const }, { ...first, id: 3, anchor_y: .1, quote: "", note: "" }];

test("search combines words across quote, memo and title, normalizing width and case", () => {
  assert.deepEqual(filterStickyNotes(notes, "a", { ...filters, query: " ＡＬＰＨＡ energy 確認 " }).map(n => n.id), [1]);
  assert.deepEqual(filterStickyNotes(notes, "a", { ...filters, scope: "all", query: "beta 比較", side: "translated", label: "疑問" }).map(n => n.id), [2]);
  assert.equal(filterStickyNotes(notes, "a", { ...filters, query: "Beta" }).length, 0);
});
test("sorts by saved location or addition without mutating notes, retaining position-only notes", () => {
  assert.deepEqual(filterStickyNotes(notes, "a", filters).map(n => n.id), [3, 1]);
  assert.deepEqual(filterStickyNotes(notes, "a", { ...filters, scope: "all", sort: "newest" }).map(n => n.id), [3, 2, 1]);
  assert.deepEqual(notes.map(n => n.id), [1, 2, 3]);
  assert.equal(stickyQuote("p.8 の読書位置"), "");
  assert.equal(stickyQuote("書き込み（3件）の位置"), "");
});

const ID = "0123456789abcdef0123456789abcdef";
const highlight: StickyNote = { ...first, id: 4, paper_id: ID, page: 3, quote: "the energy term", label: "", note: "", anchor_y: .2,
  kind: "highlight", color: "green", rects: [[.1, .2, .5, .02]] };

test("highlights are named by their colour, found by it, and filtered apart from sticky notes", () => {
  assert.equal(stickyTitle(highlight), "ハイライト（緑）");
  assert.equal(stickyTitle({ ...highlight, label: "疑問" }), "ハイライト（緑）・疑問");
  assert.equal(stickyTitle(first), "疑問");
  const mixed = [{ ...first, paper_id: ID }, highlight];
  assert.deepEqual(filterStickyNotes(mixed, ID, { ...filters, kind: "highlight" }).map(n => n.id), [4]);
  // A note from an older sidecar has no kind: it is a sticky note.
  assert.deepEqual(filterStickyNotes(mixed, ID, { ...filters, kind: "note" }).map(n => n.id), [1]);
  assert.deepEqual(filterStickyNotes(mixed, ID, { ...filters, query: "ハイライト 緑" }).map(n => n.id), [4]);
});

test("a paper's sticky notes are written to its memo in page order, each with a link to its page", () => {
  const notes: StickyNote[] = [
    highlight,
    { ...first, id: 5, paper_id: ID, page: 1, side: "translated", quote: "一行目\n二行目", label: "重要", note: "式を確認\n\n次の節と比較" },
    { ...first, id: 6, paper_id: ID, page: 2, quote: "p.2 の読書位置", label: "あとで確認", note: "" },
  ];
  const text = stickyNotesMarkdown(notes, { includeHighlights: true, date: "2026-09-28" });
  assert.equal(text, [
    "## 付箋とハイライト（2026-09-28 書き出し）",
    "",
    `- [p.1](papeer://${ID}/1)（訳文） 重要`,
    "",
    "  > 一行目",
    "  > 二行目",
    "",
    "  式を確認",
    "",
    "  次の節と比較",
    `- [p.2](papeer://${ID}/2) あとで確認`,
    `- [p.3](papeer://${ID}/3) ハイライト（緑）`,
    "",
    "  > the energy term",
  ].join("\n"));
  // The links are citations the memo opens in the reader (MarkdownRenderer, markdownUrl.ts).
  for (const [, url] of text.matchAll(/\]\(([^)]+)\)/g)) assert.match(url, CITATION_URL);
  const notesOnly = stickyNotesMarkdown(notes, { includeHighlights: false, date: "2026-09-28" });
  assert.match(notesOnly, /^## 付箋（2026-09-28 書き出し）/);
  assert.doesNotMatch(notesOnly, /ハイライト|p\.3/);
  assert.equal(stickyNotesMarkdown([highlight], { includeHighlights: false, date: "2026-09-28" }), "");
  assert.equal(stickyNotesMarkdown([], { includeHighlights: true, date: "2026-09-28" }), "");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { filterStickyNotes, stickyQuote, type StickyNote, type StickyFilters } from "../src/features/reader/stickyNotes.ts";

const filters: StickyFilters = { scope: "paper", query: "", label: "", side: "", sort: "page" };
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

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  currentOutlineIndex, destAnchor, loadOutline, originalPageFor, resolveDestination,
  type OutlineNode, type PdfDocumentLike,
} from "../src/features/reader/pdfLinks.ts";
import { externalHttpUrl } from "../src/lib/externalLinks.ts";

// A US Letter page: 612 x 792 points, y pointing up.
const LETTER = [0, 0, 612, 792];

test("destinations that give a height point that far down the page", () => {
  assert.equal(destAnchor([{}, { name: "XYZ" }, 72, 792, null], LETTER), 0);
  assert.equal(destAnchor([{}, { name: "XYZ" }, 72, 396, 0], LETTER), 0.5);
  assert.equal(destAnchor([{}, { name: "FitH" }, 198], LETTER), 0.75);
  assert.equal(destAnchor([{}, { name: "FitBH" }, 0], LETTER), 1);
  assert.equal(destAnchor([{}, { name: "FitR" }, 0, 100, 300, 594], LETTER), 0.25);
  // Offset page boxes count from their own top.
  assert.equal(destAnchor([{}, { name: "XYZ" }, 0, 842], [0, 50, 612, 842]), 0);
  // Out-of-page heights are clamped.
  assert.equal(destAnchor([{}, { name: "XYZ" }, 0, 900], LETTER), 0);
});

test("destinations without a height leave the position to the page's start", () => {
  assert.equal(destAnchor([{}, { name: "Fit" }], LETTER), undefined);
  assert.equal(destAnchor([{}, { name: "FitV" }, 100], LETTER), undefined);
  assert.equal(destAnchor([{}, { name: "XYZ" }, null, null, null], LETTER), undefined);
  assert.equal(destAnchor([{}, { name: "XYZ" }, 0, 300], [0, 0, 0, 0]), undefined);
});

const refs = [{ num: 10, gen: 0 }, { num: 20, gen: 0 }, { num: 30, gen: 0 }];

function fakeDocument(outline: OutlineNode[] | null = null, named: Record<string, unknown[]> = {}) {
  let pageLoads = 0;
  const doc: PdfDocumentLike & { pageLoads: () => number } = {
    numPages: refs.length,
    getOutline: async () => outline,
    getDestination: async (id) => named[id] ?? null,
    getPageIndex: async (ref) => {
      const index = refs.indexOf(ref as unknown as { num: number; gen: number });
      if (index < 0) throw new Error("bad ref");
      return index;
    },
    getPage: async () => { pageLoads++; return { view: LETTER }; },
    pageLoads: () => pageLoads,
  };
  return doc;
}

test("links resolve to a page and a place on it", async () => {
  const doc = fakeDocument(null, { "section.2": [refs[1], { name: "XYZ" }, 72, 594, null] });
  assert.deepEqual(await resolveDestination(doc, [refs[2], { name: "XYZ" }, 0, 396, 0]), { page: 3, anchor_y: 0.5 });
  assert.deepEqual(await resolveDestination(doc, "section.2"), { page: 2, anchor_y: 0.25 });
  assert.deepEqual(await resolveDestination(doc, Promise.resolve([refs[0], { name: "Fit" }])), { page: 1 });
  // Page numbers instead of references, as some generators write them.
  assert.deepEqual(await resolveDestination(doc, [1, { name: "Fit" }]), { page: 2 });
});

test("broken destinations resolve to nothing instead of failing", async () => {
  const doc = fakeDocument();
  assert.equal(await resolveDestination(doc, "missing"), null);
  assert.equal(await resolveDestination(doc, [{ num: 99, gen: 0 }, { name: "Fit" }]), null);
  assert.equal(await resolveDestination(doc, [7, { name: "Fit" }]), null);
  assert.equal(await resolveDestination(doc, []), null);
  assert.equal(await resolveDestination(doc, null), null);
});

test("the outline becomes a flat list in reading order, with depth", async () => {
  const outline: OutlineNode[] = [
    { title: "1  Introduction", dest: [refs[0], { name: "XYZ" }, 0, 700, null], items: [] },
    { title: "2 Method", dest: "sec2", items: [
      { title: "2.1 Data", dest: [refs[1], { name: "FitH" }, 396], items: [] },
      { title: "Project page", dest: null, url: "https://example.com", items: [] },
    ] },
    { title: "  ", dest: [refs[2], { name: "Fit" }], items: [] },
  ];
  const doc = fakeDocument(outline, { sec2: [refs[1], { name: "XYZ" }, 0, 792, null] });
  const entries = await loadOutline(doc);
  assert.deepEqual(entries, [
    { title: "1 Introduction", depth: 0, page: 1, anchor_y: (792 - 700) / 792 },
    { title: "2 Method", depth: 0, page: 2, anchor_y: 0 },
    { title: "2.1 Data", depth: 1, page: 2, anchor_y: 0.5 },
    { title: "Project page", depth: 1 },
    { title: "（無題）", depth: 0, page: 3 },
  ]);
  // Each page's box is read once, however many entries point at it.
  assert.equal(doc.pageLoads(), 3);
});

test("a missing or failing outline gives no entries, and a huge one is cut short", async () => {
  assert.deepEqual(await loadOutline(fakeDocument(null)), []);
  const failing = { ...fakeDocument(), getOutline: async () => { throw new Error("broken"); } };
  assert.deepEqual(await loadOutline(failing), []);
  const many: OutlineNode[] = Array.from({ length: 50 }, (_, i) => ({ title: `S${i}`, dest: [0, { name: "Fit" }], items: [] }));
  assert.equal((await loadOutline(fakeDocument(many), 10)).length, 10);
});

test("the current section is the last one starting on or before the page", () => {
  const entries = [
    { title: "Abstract", depth: 0, page: 1 },
    { title: "Links", depth: 0 },
    { title: "Intro", depth: 0, page: 2 },
    { title: "Intro/a", depth: 1, page: 2 },
    { title: "Method", depth: 0, page: 5 },
  ];
  assert.equal(currentOutlineIndex(entries, 1), 0);
  assert.equal(currentOutlineIndex(entries, 3), 3);
  assert.equal(currentOutlineIndex(entries, 9), 4);
  assert.equal(currentOutlineIndex([{ title: "Late", depth: 0, page: 4 }], 2), -1);
});

test("links in the translation pane map back to the original's pages", () => {
  const pages = {
    "1": { file: "translated.pdf", index: 0 },
    "2": { file: "translation-pages/page-0002.pdf", index: 0 },
    "3": { file: "original.pdf", index: 2 },
    "4": null,
  };
  assert.equal(originalPageFor(pages, "translated.pdf", 0), 1);
  assert.equal(originalPageFor(pages, "original.pdf", 2), 3);
  // Pages not currently shown from that file, in a file with every page.
  assert.equal(originalPageFor(pages, "translated.pdf", 3), 4);
  assert.equal(originalPageFor(pages, "original.pdf", 0), 1);
  // A one-page preview has nothing else to link to.
  assert.equal(originalPageFor(pages, "translation-pages/page-0002.pdf", 1), null);
});

test("only http and https links open in the browser", () => {
  assert.equal(externalHttpUrl("https://arxiv.org/abs/1706.03762"), "https://arxiv.org/abs/1706.03762");
  assert.equal(externalHttpUrl(" http://example.com/a b "), "http://example.com/a%20b");
  for (const href of ["mailto:a@example.com", "file:///C:/Windows/system32/calc.exe", "javascript:alert(1)",
    "ftp://example.com/x", "tel:123", "/relative", "#", "", null, undefined, "https://"]) {
    assert.equal(externalHttpUrl(href), null, String(href));
  }
});

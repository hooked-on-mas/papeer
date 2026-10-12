import assert from "node:assert/strict";
import { test } from "node:test";
import { itemCapabilities, kindCapabilities, tabAvailable, type ItemCapabilities } from "../src/lib/itemKinds.ts";
import { paperData } from "./support/paperData.ts";

const FLAGS = (caps: ItemCapabilities) => Object.entries(caps).filter(([, value]) => typeof value === "boolean") as [string, boolean][];

test("a PDF can do everything a paper could before kinds, with the .pdf renaming adds", () => {
  const pdf = kindCapabilities("pdf");
  // Listed ahead of the papers is how a kind is placed, not something a PDF can do.
  for (const [name, value] of FLAGS(pdf)) assert.equal(value, name !== "listedFirst" && name !== "notebook", name);
  assert.equal(pdf.fileExtension, ".pdf");
});

test("a notebook is not translated and has no text: only writing, a memo and a name, listed ahead of the papers", () => {
  const notebook = kindCapabilities("notebook");
  const on = FLAGS(notebook).filter(([, value]) => value).map(([name]) => name).sort();
  assert.deepEqual(on, ["annotate", "listedFirst", "memo", "notebook", "rename", "stickyNotes"]);
  for (const name of ["translate", "split", "summary", "chat", "citationMap", "bibliography", "ocr", "fullTextSearch", "organize", "originalPdf"]) {
    assert.equal(notebook[name as keyof ItemCapabilities], false, name);
  }
  assert.equal(notebook.fileExtension, "");
});

test("a row without a kind (an old cache, a test's data) is a PDF, and a kind unknown to this app can do nothing", () => {
  assert.equal(kindCapabilities(undefined), kindCapabilities("pdf"));
  assert.equal(kindCapabilities(null), kindCapabilities("pdf"));
  const unknown = kindCapabilities("whiteboard");
  assert.deepEqual(FLAGS(unknown).filter(([, value]) => value), []);
  assert.equal(unknown.fileExtension, "");
  // Not a property of Object.prototype either.
  assert.deepEqual(FLAGS(kindCapabilities("constructor")).filter(([, value]) => value), []);
});

test("an item is asked by its row; before it has loaded it is taken to be a PDF", () => {
  assert.equal(itemCapabilities(undefined), kindCapabilities("pdf"));
  assert.equal(itemCapabilities(null), kindCapabilities("pdf"));
  assert.equal(itemCapabilities(paperData({ id: "n", kind: "notebook" })), kindCapabilities("notebook"));
  assert.equal(itemCapabilities({}), kindCapabilities("pdf"));
  assert.equal(itemCapabilities({ kind: "later" }).translate, false);
});

test("a tab shows for an item when it can do what the tab is for; the reader's tab always shows", () => {
  const pdf = kindCapabilities("pdf");
  const notebook = kindCapabilities("notebook");
  for (const tab of ["reader", "summary", "chat", "notes", "sticky-notes", "references"]) assert.equal(tabAvailable(pdf, tab), true, tab);
  assert.deepEqual(["reader", "summary", "chat", "notes", "sticky-notes", "references"].filter((tab) => tabAvailable(notebook, tab)),
    ["reader", "notes", "sticky-notes"]);
  assert.deepEqual(["reader", "summary", "notes"].filter((tab) => tabAvailable(kindCapabilities("whiteboard"), tab)), ["reader"]);
});

test("a held notebook has no memo children", () => { assert.equal(itemCapabilities(paperData({ id: "n", kind: "notebook", parent_id: "p" })).memo, false); });

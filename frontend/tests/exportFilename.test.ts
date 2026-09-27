import assert from "node:assert/strict";
import { test } from "node:test";
import { bibtexFilename, paperExportFilename } from "../src/lib/exportFilename.ts";

test("names a folder's .bib file after the folder itself", () => {
  assert.equal(bibtexFilename("研究 / 制御"), "制御.bib");
  assert.equal(bibtexFilename("A: B?"), "A_ B_.bib");
  assert.equal(bibtexFilename("  "), "文献.bib");
  assert.equal(bibtexFilename("x".repeat(300)), `${"x".repeat(160)}.bib`);
});

test("names a paper's export after its title and kind", () => {
  assert.equal(paperExportFilename({ id: "p", title: "Deep: Learning" }, "translated"), "Deep_ Learning-日本語訳.pdf");
});

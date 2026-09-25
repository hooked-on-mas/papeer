import assert from "node:assert/strict";
import test from "node:test";
import { cleanPdfSelection, quoteForNote, restoreFormulas } from "../src/lib/pdfSelection.ts";

const PAGE = [
  "上記の情報をもとに、y > 1.7 の場合に不安全領域における応答の確率を境界づけることを目指す。関数および目的の不安全領域を図2に示す。",
  "すべての q ∈ Q について、flowq, initq, jumpq によって定義される集合はボレル集合である。",
  "表Iにおいて、A の i 番目の焦点要素と B の j 番目の焦点要素が与えられたとき、Box#は 3(j − 1) + i で与えられる。",
];

test("Inline math missing from a translated-PDF selection is restored", () => {
  assert.equal(
    restoreFormulas("上記の情報をもとに、\n の場合に不安全領域における応答の確率", PAGE),
    "上記の情報をもとに、y > 1.7 の場合に不安全領域における応答の確率",
  );
  assert.equal(
    restoreFormulas("表Iにおいて、 の i 番目の焦点要素と の j 番目の焦点要素が与えられたとき、Box#は で与えられる。", PAGE),
    "表Iにおいて、A の i 番目の焦点要素と B の j 番目の焦点要素が与えられたとき、Box#は 3(j − 1) + i で与えられる。",
  );
});

test("Selections spanning blocks, ligatures and math appended after the paragraph", () => {
  assert.equal(
    restoreFormulas("図2に示す。y > 1.7\nすべての について、ﬂowq, initq", PAGE),
    "図2に示す。すべての q ∈ Q について、flowq, initq",
  );
});

test("A selection that is not in the translated text falls back", () => {
  assert.equal(restoreFormulas("Fig. 3. Focal elements from the induced DS structure", PAGE), null);
  assert.equal(restoreFormulas("上記の情報", []), null);
});

test("English lines rejoin with spaces and line-end hyphens close up", () => {
  assert.equal(
    cleanPdfSelection("We propose a trans-\nformer based\n  model for   state-of-the-art\r\nresults."),
    "We propose a transformer based model for state-of-the-art results.",
  );
});

test("A line-end hyphen before a capital or digit is kept, without a space", () => {
  assert.equal(cleanPdfSelection("see Fig-\nure 3, Monte-\nCarlo and GPT-\n4"), "see Figure 3, Monte-Carlo and GPT-4");
});

test("Japanese lines rejoin without a space, mixed text keeps one", () => {
  assert.equal(cleanPdfSelection("提案手法は従来\n手法よりも\nTransformer を\n用いる。"), "提案手法は従来手法よりも Transformer を用いる。");
});

test("Surrounding whitespace is trimmed", () => {
  assert.equal(cleanPdfSelection("\n  abc \n"), "abc");
});

test("Quotes for the memo are Markdown blockquotes with the source", () => {
  assert.equal(quoteForNote("abc", "p.3"), "> abc\n>\n> — p.3");
});

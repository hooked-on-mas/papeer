import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeMarkdown } from "../src/lib/normalizeMarkdown.ts";

function render(content) {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkMath],
    rehypePlugins: [rehypeKatex],
    urlTransform: (url) => url,
    children: normalizeMarkdown(content),
  }));
}

test("Japanese emphasis with punctuation, whitespace and inline math renders as strong", () => {
  const html = render(String.raw`手法が**確率制約（$CP_\epsilon$） **です。**分布非依存型（distribution-free）**の手法。`);
  assert.equal((html.match(/<strong>/g) ?? []).length, 2);
  assert.ok(html.includes('class="katex"'));
  assert.ok(!html.includes("**"));
});

test("citations accidentally enclosed in math become real links outside KaTeX", () => {
  const input = String.raw`\[ \hat p = \frac{1}{N} [p.3](paperdesk://abc123/3) \]`;
  const normalized = normalizeMarkdown(input);
  assert.match(normalized, /\$\$\n\n \[p\.3\]\(paperdesk:\/\/abc123\/3\)/);
  const html = render(input);
  assert.ok(html.includes('class="katex-display"'));
  assert.ok(html.includes('<a href="paperdesk://abc123/3">p.3</a>'));
  assert.ok(!html.includes("katex-error"));
});

test("code examples are untouched, including math delimiters and emphasis", () => {
  const code = '```md\n**literal ** \\(x\\) $y$\n```\n\n`**literal ** \\(x\\)`';
  assert.equal(normalizeMarkdown(code), code);
});

test("valid formulas, citation destinations and unmatched emphasis survive", () => {
  const input = String.raw`$x_i^2$ と **未完の強調 [p.2](paperdesk://abc123/2)`;
  assert.equal(normalizeMarkdown(input), input);
  assert.equal(normalizeMarkdown("**valid**"), " **valid** ");
});

test("collapsed summary table renders six columns and three data rows", () => {
  const table = String.raw`\| 反復 (t) | 下界 (LB) | 上界 (UB) | 相対ギャップ (%) | 分割要素数 ∣P(t)∣ | 投資比率 (x1,x2) | |:---:|:---:|:---:|:---:|:---:|:---:| | 1 | -0.0702 | 0.7641 | 109.184% | 1 | (0, 1) | | 5 | 0.4584 | 0.5104 | 10.1866% | 9 | (0.59, 0.41) | | 9 | 0.5082 | 0.5082 | 0.0039% | 34 | (0.6375, 0.3625) |  `;
  for (const input of [table, table.slice(1)]) {
    const html = render(`以下の表に示す通り。\n\n${input}\n\n![原文の表](media/table.png)`);
    assert.equal((html.match(/<table>/g) ?? []).length, 1);
    assert.equal((html.match(/<th /g) ?? []).length, 6);
    assert.equal((html.match(/<td /g) ?? []).length, 18);
    assert.ok(html.includes("(0.6375, 0.3625)"));
    assert.ok(html.includes('<img src="media/table.png"'));
  }
});

test("collapsed tables preserve inline code, formulas and escaped cell pipes", () => {
  const html = render('| 値 | 説明 | | --- | --- | | $x_1$ | `a\\|b` と a\\|b |');
  assert.ok(html.includes("<table>"));
  assert.ok(html.includes('class="katex"'));
  assert.ok(html.includes("<code>a|b</code>"));
  assert.ok(html.includes("と a|b"));
});

test("valid tables, ambiguous prose and code examples are not unfolded", () => {
  for (const input of [
    "| A | B |\n| --- | --- |\n| 1 | 2 |",
    "| A | B | | prose | text | | 1 | 2 |",
    "| A | B | | --- | --- | | 1 | 2 | 3 |",
    "```md\n| A | B | | --- | --- | | 1 | 2 |\n```",
    "`| A | B | | --- | --- | | 1 | 2 |`",
  ]) assert.equal(normalizeMarkdown(input), input);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeMarkdown } from "../src/lib/normalizeMarkdown.ts";

function render(content) {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkMath],
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

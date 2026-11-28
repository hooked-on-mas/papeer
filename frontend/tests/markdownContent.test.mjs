import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, MarkdownContent;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)),
    logLevel: "error", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  ({ MarkdownContent } = await server.ssrLoadModule("/src/components/ui/MarkdownContent.tsx"));
});
after(async () => { await server?.close(); });

test("shared Markdown renders GFM and math without accepting unsafe links", () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: "~~done~~\n\n$x^2$\n\n[safe](https://example.com) [unsafe](javascript:alert) [network](//example.com) [file](file:///private.txt)",
  }));
  assert.match(html, /<del>done<\/del>/);
  assert.match(html, /class="katex"/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /href="(?:javascript:|\/\/|file:)/);
});

test("host resource components receive relative images without desktop URL conversion", () => {
  const received = [];
  renderToStaticMarkup(createElement(MarkdownContent, { content: "![memo](media/figure.png)", components: {
    img: ({ src }) => { received.push(src); return createElement("span", null, "host image"); },
  } }));
  assert.deepEqual(received, ["media/figure.png"]);
});

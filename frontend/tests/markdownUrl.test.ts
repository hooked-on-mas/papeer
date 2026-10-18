import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { CITATION_URL, citationLink, markdownUrlTransform, mediaRequestPath } from "../src/lib/markdownUrl.ts";

const ID = "0123456789abcdef0123456789abcdef";
const MEDIA = `file:///C:/Users/me/AppData/Local/Papeer/papers/${ID}/media/fig1.png`;
const SIDECAR = `/api/papers/${ID}/media/fig1.png`;

function render(content: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, { urlTransform: markdownUrlTransform, children: content }));
}

test("citation links and the usual web links are kept", () => {
  assert.equal(markdownUrlTransform("papeer://abc123/3", "href"), "papeer://abc123/3");
  assert.equal(markdownUrlTransform(`paperdesk://${ID}/12`, "href"), `paperdesk://${ID}/12`);
  assert.equal(markdownUrlTransform("https://arxiv.org/abs/1234.5678", "href"), "https://arxiv.org/abs/1234.5678");
  assert.equal(markdownUrlTransform("media/fig1.png", "src"), "media/fig1.png");
});

test("only the papeer://<id>/<page> form passes as a citation", () => {
  for (const url of ["papeer:javascript:alert(1)", "papeer:\\\\evil\\x", "paperdesk:file:///C:/x", "PAPEER://abc/3",
    "papeer://abc/3/../../x", "papeer://abc/three", "papeer://abc/3?x=1", "papeer://a b/3", "papeer:///3"]) {
    assert.equal(markdownUrlTransform(url, "href"), "", url);
    assert.equal(markdownUrlTransform(url, "src"), "", url);
  }
  assert.ok(!render("[x](papeer:javascript:alert(1))").includes("javascript"));
});

test("file: links, and links to another host without a scheme, are refused", () => {
  for (const url of ["file:///C:/Windows/System32/calc.exe", "FILE:///C:/Windows/System32/calc.exe",
    "file://server/share/x.pdf", "javascript:alert(1)", "C:/Windows/calc.exe", "\\\\server\\share\\x.pdf",
    "//server/share/x.pdf", "/\\server/share/x.pdf"]) {
    assert.equal(markdownUrlTransform(url, "href"), "", url);
    assert.equal(markdownUrlTransform(url, "src"), "", url);
  }
  assert.equal(markdownUrlTransform(MEDIA, "href"), "");
  for (const md of ["[開く](file:///C:/Windows/System32/calc.exe)", "<file:///C:/Windows/calc.exe>",
    "[x][r]\n\n[r]: file:///C:/Windows/calc.exe"]) {
    assert.ok(!/href="[^"]*file:/i.test(render(md)), md);
  }
});

test("a media image becomes its sidecar path, and no other file: image is loaded", () => {
  assert.equal(markdownUrlTransform(MEDIA, "src"), SIDECAR);
  assert.equal(markdownUrlTransform(MEDIA.replace("file:", "FILE:"), "src"), SIDECAR);
  for (const url of ["file:///C:/Users/me/Pictures/secret.png", "file:///C:/papers/not-an-id/media/x.png",
    `file:///C:/secret.png?papers/${ID}/media/a.png`, `file:///C:/x/papers/${ID}/media/..`,
    `file:///C:/x/papers/${ID}/media/%2e%2e`, `file:///C:/x/papers/${ID}/media/..%5C..%5Csecret.png`]) {
    assert.equal(markdownUrlTransform(url, "src"), "", url);
  }
  assert.equal(markdownUrlTransform(MEDIA, "srcSet"), "");
  const html = render(`![図1](${MEDIA})`);
  assert.ok(html.includes(`src="${SIDECAR}"`) && !html.includes("file:"), html);
});

test("only media paths are requested from the sidecar", () => {
  assert.equal(mediaRequestPath(SIDECAR, null), SIDECAR);
  assert.equal(mediaRequestPath("media/ink-capture-abc.png", ID), `/api/papers/${ID}/media/ink-capture-abc.png`);
  assert.equal(mediaRequestPath("media/fig1.png", null), null);
  for (const src of ["media/../settings", "media/a.png?x", "/api/settings", `/api/papers/${ID}/media/../../settings`,
    `/api/papers/${ID}/note`, "https://example.com/a.png", ""]) {
    assert.equal(mediaRequestPath(src, ID), null, src);
  }
});

test("a citation link written by the app is one the memo keeps and opens", () => {
  const link = citationLink(ID, 12);
  assert.equal(link, `[p.12](papeer://${ID}/12)`);
  const url = link.slice(link.indexOf("(") + 1, -1);
  assert.match(url, CITATION_URL);
  assert.equal(markdownUrlTransform(url, "href"), url);
});

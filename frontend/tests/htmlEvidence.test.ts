import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { itemCapabilities, kindCapabilities, tabAvailable, type ItemCapabilities } from "../src/lib/itemKinds.ts";
import { DOCUMENT_URL, documentCitation, markdownUrlTransform } from "../src/lib/markdownUrl.ts";
import { paperData } from "./support/paperData.ts";

const OWNER = "0123456789abcdef0123456789abcdef";
const DOCUMENT = "fedcba9876543210fedcba9876543210";
const LINK = `papeer://${OWNER}/attachment/${DOCUMENT}`;

const FLAGS = (caps: ItemCapabilities) => Object.entries(caps).filter(([, value]) => typeof value === "boolean") as [string, boolean][];

function render(content: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, { urlTransform: markdownUrlTransform, children: content }));
}

// --- Chat for a notebook that holds an HTML document ---

test("an independent notebook can be asked about once it holds an HTML document, and only that changes", () => {
  const notebook = kindCapabilities("notebook");
  assert.equal(notebook.chat, false);
  for (const count of [undefined, null, 0, -1]) {
    assert.equal(itemCapabilities(paperData({ id: "n", kind: "notebook", html_document_count: count as number | undefined })), notebook);
  }
  const asked = itemCapabilities(paperData({ id: "n", kind: "notebook", html_document_count: 2 }));
  assert.equal(asked.chat, true);
  const changed = FLAGS(asked).filter(([name, value]) => notebook[name as keyof ItemCapabilities] !== value).map(([name]) => name);
  assert.deepEqual(changed, ["chat"]);
  // The text-dependent features that need pages stay off: its text is the document's, not OCR.
  for (const name of ["summary", "ocr", "fullTextSearch", "organize", "translate", "citationMap"]) {
    assert.equal(asked[name as keyof ItemCapabilities], false, name);
  }
  assert.equal(itemCapabilities(paperData({ id: "n", kind: "notebook", html_document_count: 5 })), asked, "one object for what a render reads");
});

test("the tab of the chat shows for such a notebook, the summary's does not", () => {
  const asked = itemCapabilities({ kind: "notebook", html_document_count: 1 });
  assert.deepEqual(["reader", "summary", "chat", "notes", "sticky-notes", "references"].filter((tab) => tabAvailable(asked, tab)),
    ["reader", "chat", "notes", "sticky-notes"]);
});

test("a held notebook, an unknown kind and a PDF are not changed by a count of documents", () => {
  assert.equal(itemCapabilities(paperData({ id: "n", kind: "notebook", parent_id: "p", html_document_count: 3 })).chat, false);
  assert.equal(itemCapabilities({ kind: "whiteboard", html_document_count: 3 }).chat, false);
  assert.equal(itemCapabilities(paperData({ id: "p", html_document_count: 0 })), kindCapabilities("pdf"));
  assert.equal(itemCapabilities(paperData({ id: "p", html_document_count: 4 })), kindCapabilities("pdf"));
  // A row of a test or a cache that has no count is what it was.
  assert.equal(itemCapabilities({ kind: "notebook" }), kindCapabilities("notebook"));
  assert.equal(itemCapabilities(undefined), kindCapabilities("pdf"));
});

// --- Citations of a document ---

test("only papeer://<owner>/attachment/<document> with 32 lowercase hex characters each is a document link", () => {
  assert.equal(markdownUrlTransform(LINK, "href"), LINK);
  assert.deepEqual(documentCitation(LINK), { owner: OWNER, document: DOCUMENT });
  assert.ok(DOCUMENT_URL.test(LINK));
  for (const url of [
    `papeer://${OWNER}/attachment/${DOCUMENT.slice(1)}`, `papeer://${OWNER}/attachment/${DOCUMENT}0`,
    `papeer://${OWNER.toUpperCase()}/attachment/${DOCUMENT}`, `papeer://${OWNER}/attachment/${DOCUMENT.toUpperCase()}`,
    `papeer://${OWNER}/attachment/${DOCUMENT}/x`, `papeer://${OWNER}/attachment/${DOCUMENT}?x=1`, `papeer://${OWNER}/attachment/${DOCUMENT}#x`,
    `papeer://${OWNER}/attachment/`, `papeer://${OWNER}/attachments/${DOCUMENT}`, `papeer://${OWNER}/attachment/${"g".repeat(32)}`,
    `paperdesk://${OWNER}/attachment/${DOCUMENT}`, `PAPEER://${OWNER}/attachment/${DOCUMENT}`, `papeer://abc/attachment/def`,
    `papeer://${OWNER}/attachment/../${DOCUMENT}`, `papeer:///attachment/${DOCUMENT}`,
  ]) {
    assert.equal(markdownUrlTransform(url, "href"), "", url);
    assert.equal(documentCitation(url), null, url);
  }
  assert.equal(documentCitation(`https://example.com/${OWNER}/attachment/${DOCUMENT}`), null);
});

test("the link of a document is kept in Markdown and a malformed or foreign one is dropped", () => {
  assert.ok(render(`[資料「図解」](${LINK})`).includes(`href="${LINK}"`));
  const refused = render(`[資料](papeer://${OWNER}/attachment/${DOCUMENT}x) [別](papeer:javascript:alert(1))`);
  assert.ok(!refused.includes("papeer:") && !refused.includes("javascript"));
  // A page citation keeps its own form.
  assert.ok(render(`[p.2](papeer://${OWNER}/2)`).includes(`href="papeer://${OWNER}/2"`));
});

// Renders the reader to HTML once, the way the app does on each update, to catch crashes in its
// render code (an endless recursion, a hook used wrongly…) that the unit tests of its pure parts
// cannot see. Vite compiles the TSX as in the app; the browser APIs the modules touch when they
// load are stubbed, and react-pdf, which needs a DOM, is replaced by tests/support/reactPdfStub.mjs.
// Effects don't run on the server, so this checks the first render only, not measured layouts.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));

const events = new EventTarget();
const storage = new Map();
Object.assign(globalThis, {
  window: globalThis,
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  location: new URL("http://localhost/"),
});

let server;
let modules;

before(async () => {
  server = await createServer({
    configFile: false,
    root: path(".."),
    logLevel: "error",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, watch: null },
    resolve: {
      alias: [
        { find: /^react-pdf\/.*\.css$/, replacement: path("./support/reactPdfStub.mjs") },
        { find: /^react-pdf$/, replacement: path("./support/reactPdfStub.mjs") },
        { find: "@", replacement: path("../src") },
      ],
    },
  });
  const load = (id) => server.ssrLoadModule(id);
  modules = {
    React: await import("react"),
    server: await import("react-dom/server"),
    query: await import("@tanstack/react-query"),
    Reader: (await load("/src/features/reader/Reader.tsx")).Reader,
    PdfPane: (await load("/src/features/reader/PdfPane.tsx")).PdfPane,
    useStore: (await load("/src/store/index.ts")).useStore,
    useInkPanes: (await load("/src/features/reader/useInkEditor.ts")).useInkPanes,
  };
});

after(async () => {
  await server?.close();
});

const reading = {
  page_count: 3, source_page_count: 3, empty_pages: [], completed_pages: [1], preview: null, in_progress: false,
  report: { skipped_pages: [2] }, translated_pages: {}, page_versions: {}, last_page: 1,
  has_translated: false, has_article: false, has_interleaved: false, original_mtime: 0,
};

/** Renders `element` with the store's state set as given; server rendering reads the store's initial state. */
function render(element, state) {
  const { React, server: { renderToString }, query: { QueryClient, QueryClientProvider }, useStore } = modules;
  Object.assign(useStore.getInitialState(), { activePaperId: "p1", currentPage: 1, focusMode: false, inkBarOpen: false, ...state });
  const client = new QueryClient();
  client.setQueryData(["reading", "p1"], reading);
  try {
    return renderToString(React.createElement(QueryClientProvider, { client }, element));
  } finally {
    // Its timers would keep the test process alive.
    client.clear();
  }
}

test("the reader renders a paper with its toolbar and both panes", () => {
  const html = render(modules.React.createElement(modules.Reader));
  assert.match(html, /id="page-input"/);
  assert.match(html, /aria-label="その他の表示・操作"/);
  assert.match(html, /aria-label="原文"/);
  assert.match(html, /data-ink-toolbar-slot/);
});

test("the reader renders in focus mode with the writing toolbar open", () => {
  const html = render(modules.React.createElement(modules.Reader), { focusMode: true, focusPanel: "chat", inkBarOpen: true });
  assert.match(html, /aria-label="集中表示を終了"/);
});

test("a pane renders its writing toolbar in place when there is no shared slot", () => {
  // Panes say that they have a page to write on from an effect, which the server doesn't run.
  Object.assign(modules.useInkPanes.getInitialState(), { active: "original", hosts: { original: true, translated: false } });
  const html = render(modules.React.createElement(modules.PdfPane, {
    url: "/original.pdf", pageNumber: 1, zoom: 1, inkPage: { paperId: "p1", page: 1 }, caption: "原文",
  }), { inkBarOpen: true });
  assert.match(html, /aria-label="PDFの書き込み"/);
  assert.match(html, /aria-label="書き込みツールを閉じる"/);
});

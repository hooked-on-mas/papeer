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
    ReaderArea: (await load("/src/app/ReaderArea.tsx")).ReaderArea,
    ReaderTab: (await load("/src/app/ReaderArea.tsx")).ReaderTab,
    Tabs: (await load("/src/components/ui/tabs.tsx")).Tabs,
    lazyPanes: await load("/src/app/lazyPanes.tsx"),
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

/**
 * Renders `element` with the store's state, and the writing panes' (`inkPanes`), set as given. Server
 * rendering reads a store's initial state, which is put back afterwards so that no test sees another's.
 */
function render(element, state, inkPanes = {}) {
  const { React, server: { renderToString }, query: { QueryClient, QueryClientProvider }, useStore, useInkPanes } = modules;
  const saved = [[useStore.getInitialState(), { ...useStore.getInitialState() }], [useInkPanes.getInitialState(), { ...useInkPanes.getInitialState() }]];
  Object.assign(useStore.getInitialState(), { activePaperId: "p1", currentPage: 1, focusMode: false, inkBarOpen: false, ...state });
  Object.assign(useInkPanes.getInitialState(), inkPanes);
  const client = new QueryClient();
  client.setQueryData(["reading", "p1"], reading);
  try {
    return renderToString(React.createElement(QueryClientProvider, { client }, element));
  } finally {
    // Its timers would keep the test process alive.
    client.clear();
    for (const [target, values] of saved) {
      for (const key of Object.keys(target)) if (!(key in values)) delete target[key];
      Object.assign(target, values);
    }
  }
}

// Panes say that they have a page to write on from an effect, which the server doesn't run.
const writableOriginal = { active: "original", hosts: { original: true, translated: false } };

test("the reader renders a paper with its toolbar and both panes", () => {
  const html = render(modules.React.createElement(modules.Reader));
  assert.match(html, /id="page-input"/);
  assert.match(html, /aria-label="その他の表示・操作"/);
  assert.match(html, /aria-label="原文"/);
  assert.match(html, /data-ink-toolbar-slot/);
});

test("the reader renders in focus mode with the writing toolbar open, which waits for its shared slot", () => {
  const html = render(modules.React.createElement(modules.Reader), { focusMode: true, sidePanel: "chat", inkBarOpen: true }, writableOriginal);
  assert.match(html, /aria-label="集中表示を終了"/);
  assert.match(html, /data-ink-toolbar-slot/);
  // The slot is set from a ref after the first render; until then the pane shows no toolbar rather than
  // one of its own that would jump into the slot a moment later.
  assert.doesNotMatch(html, /aria-label="PDFの書き込み"/);
});

test("a pane renders its writing toolbar in place when there is no shared slot", () => {
  const html = render(modules.React.createElement(modules.PdfPane, {
    url: "/original.pdf", pageNumber: 1, zoom: 1, inkPage: { paperId: "p1", page: 1 }, caption: "原文",
  }), { inkBarOpen: true }, writableOriginal);
  assert.match(html, /aria-label="PDFの書き込み"/);
  assert.match(html, /aria-label="書き込みツールを閉じる"/);
});

test("the store's state set for one render is not left for the next", () => {
  render(modules.React.createElement(modules.Reader), { focusMode: true, sidePanel: "chat", inkBarOpen: true }, writableOriginal);
  assert.equal(modules.useStore.getInitialState().sidePanel, null);
  assert.equal(modules.useStore.getInitialState().focusMode, false);
  assert.equal(modules.useInkPanes.getInitialState().hosts.original, false);
});

test("the reader renders with the chat open beside it in the normal view", async () => {
  const { React, ReaderArea, lazyPanes } = modules;
  const state = { activeTab: "reader", sidePanel: "chat" };
  // The first render starts loading the chat's code and shows the pane's loading state meanwhile.
  const loading = render(React.createElement(ReaderArea), state);
  assert.match(loading, /data-side-panel="chat"/);
  assert.match(loading, /aria-label="チャット（右パネル）"/);
  assert.match(loading, /id="page-input"/);
  lazyPanes.ChatPane.preload();
  await server.ssrLoadModule("/src/features/chat/ChatPane.tsx");
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Once loaded, the chat itself renders in the panel.
  const html = render(React.createElement(ReaderArea), state);
  assert.match(html, /data-side-panel="chat"/);
  assert.doesNotMatch(html, /読み込み中…|表示できませんでした/);
  assert.match(html, /<textarea[^>]*placeholder="例：従来手法と比べた改善点と、実験の限界は？"/);
  assert.match(html, /id="page-input"/);
});

test("the side panel is not rendered while another tab is shown, so that its pane never mounts twice", () => {
  const html = render(modules.React.createElement(modules.ReaderArea), { activeTab: "chat", sidePanel: "chat" });
  assert.doesNotMatch(html, /data-side-panel/);
  // Its room stays, empty, so that the reader keeps its size while hidden.
  assert.match(html, /id="side-panel"/);
  // The reader itself stays, hidden by the tab panel.
  assert.match(html, /id="page-input"/);
});

test("the reader tab stays laid out, invisible and inert, while another tab is shown", () => {
  const { React, Tabs, ReaderTab } = modules;
  const inTabs = (activeTab) => render(React.createElement(Tabs, { value: activeTab }, React.createElement(ReaderTab)), { activeTab });
  const hidden = inTabs("notes");
  // Not display: none, which would lose the panes' scroll positions and size.
  assert.doesNotMatch(hidden, /<div[^>]*role="tabpanel"[^>]*\shidden=""/);
  assert.match(hidden, /<div[^>]*role="tabpanel"[^>]*\sinert=""/);
  assert.match(hidden, /data-slot="tabs-content" class="[^"]*\binvisible absolute inset-0\b/);
  assert.match(hidden, /id="page-input"/);

  const shown = inTabs("reader");
  assert.doesNotMatch(shown, /<div[^>]*role="tabpanel"[^>]*\s(inert|hidden)=""/);
  assert.doesNotMatch(shown, /\binvisible\b/);
});

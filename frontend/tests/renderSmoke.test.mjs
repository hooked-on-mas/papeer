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
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
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
    SelectionToolbarView: (await load("/src/features/reader/SelectionToolbar.tsx")).SelectionToolbarView,
    StickyNotesTab: (await load("/src/features/reader/StickyNotesTab.tsx")).StickyNotesTab,
    glossaryEditor: await load("/src/features/reader/GlossaryEditor.tsx"),
    LibrarySidebar: (await load("/src/features/library/LibrarySidebar.tsx")).LibrarySidebar,
    useDragOver: (await load("/src/features/library/LibrarySidebar.tsx")).useDragOver,
    useMenuRow: (await load("/src/features/library/LibrarySidebar.tsx")).useMenuRow,
    useTreeFocus: (await load("/src/features/library/treeFocus.ts")).useTreeFocus,
    usePaperSelection: (await load("/src/features/library/selectionStore.ts")).usePaperSelection,
    useBulkProgress: (await load("/src/app/bulkState.ts")).useBulkProgress,
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
 * Renders `element` with the store's state, and the writing panes' (`inkPanes`), set as given, and
 * `queries` ([key, data] pairs) in the query cache besides the paper's reading. Server rendering reads
 * a store's initial state, which is put back afterwards so that no test sees another's.
 */
function render(element, state, inkPanes = {}, queries = []) {
  const { React, server: { renderToString }, query: { QueryClient, QueryClientProvider }, useStore, useInkPanes } = modules;
  const saved = [[useStore.getInitialState(), { ...useStore.getInitialState() }], [useInkPanes.getInitialState(), { ...useInkPanes.getInitialState() }]];
  Object.assign(useStore.getInitialState(), { activePaperId: "p1", currentPage: 1, focusMode: false, inkBarOpen: false, ...state });
  Object.assign(useInkPanes.getInitialState(), inkPanes);
  const client = new QueryClient();
  client.setQueryData(["reading", "p1"], reading);
  for (const [key, data] of queries) client.setQueryData(key, data);
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

test("the toolbar over a selection offers the highlight colours, 説明, メモへ and 付箋", () => {
  const { React, SelectionToolbarView } = modules;
  const handlers = { onColor() {}, onExplain() {}, onQuote() {}, onSticky() {} };
  const html = render(React.createElement(SelectionToolbarView, { mode: "selection", color: "yellow", ...handlers }));
  assert.match(html, /role="toolbar" aria-label="選択した文章"/);
  for (const label of ["黄", "緑", "青", "ピンク", "紫"]) assert.match(html, new RegExp(`aria-label="ハイライト：${label}"`));
  assert.match(html, />説明</);
  assert.match(html, />メモへ</);
  assert.match(html, />付箋</);
  assert.doesNotMatch(html, /ハイライトを削除/);
  // Over a highlight: its colour is shown pressed, and it can be deleted.
  const over = render(React.createElement(SelectionToolbarView, { mode: "highlight", color: "blue", onDelete() {}, ...handlers }));
  assert.match(over, /aria-label="ハイライト"/);
  assert.match(over, /aria-label="色を青にする"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="色を青にする"/);
  assert.match(over, /aria-label="ハイライトを削除"/);
});

test("the sticky-notes tab lists a highlight by its colour and offers to write the paper's notes to its memo", () => {
  const { React, StickyNotesTab } = modules;
  const note = { id: 1, paper_id: "p1", paper_title: "Alpha", page: 2, side: "original", quote: "q", label: "重要", note: "memo",
    anchor_x: 0, anchor_y: 0.5, created_at: "", kind: "note", color: "", rects: [] };
  const highlight = { ...note, id: 2, page: 1, quote: "the energy term", label: "", note: "", kind: "highlight", color: "green",
    rects: [[0.1, 0.2, 0.5, 0.02]] };
  const html = render(React.createElement(StickyNotesTab), {}, {}, [[["sticky-notes", "all"], [note, highlight]]]);
  assert.match(html, /ハイライト（緑）/);
  assert.match(html, /<mark[^>]*>the energy term<\/mark>/);
  assert.match(html, /メモに書き出す/);
  assert.match(html, /aria-label="付箋・ハイライトで絞り込み"/);
});

test("the translation dialog's glossary shows the saved glossary until it is edited", () => {
  const { React, glossaryEditor: { GlossaryEditor, useGlossaryEditor } } = modules;
  function Glossary() {
    const editor = useGlossaryEditor("p1");
    assert.equal(editor.dirty, false);
    return React.createElement(GlossaryEditor, { editor, transferKey: "p1-true", busy: false, generating: false,
      canGenerate: true, onGenerate: () => {}, onPending: () => {} });
  }
  const html = render(React.createElement(Glossary), {}, {}, [[["glossary"], [{ source: "observer", target: "オブザーバ" }]]]);
  assert.match(html, /全論文共通の専門用語辞書（(<!-- -->)?1(<!-- -->)?件）/);
  assert.match(html, /value="observer"/);
  assert.match(html, /value="オブザーバ"/);
  assert.match(html, /AIで未登録の専門用語を確認/);
});

const libraryPapers = [
  { id: "p1", title: "Attention Is All You Need", collection_name: "ML / NLP", pages: 10, translated_count: 4, tags: ["重要"], read_status: "読書中" },
  { id: "p2", title: "Deep Residual Learning", collection_name: "ML", pages: 12, translated_count: 0 },
  { id: "p3", title: "Unfiled Paper", collection_name: "", pages: 3, translated_count: 3 },
];
const libraryQueries = [
  [["papers", "list", "", 0], libraryPapers],
  [["collections"], ["ML", "ML / NLP", "Empty"]],
];
const libraryState = { selectedFolder: null, expandedCollections: null, librarySearch: "", sortOrder: 0 };

test("the library renders its folder tree, with the open paper and its translation's progress", () => {
  const html = render(modules.React.createElement(modules.LibrarySidebar), {
    ...libraryState,
    activeJobs: [
      { job_id: "t1", paper_id: "p1", kind: "translate", status: "running" },
      { job_id: "a1", paper_id: "p2", kind: "article", status: "running" },
    ],
  }, {}, libraryQueries);
  // Folders, each with its count including subfolders, and 未分類 last.
  const folders = [...html.matchAll(/data-tree-key="folder:([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(folders, ["Empty", "ML", "ML / NLP", ""]);
  assert.match(html, /<span class="flex-1 truncate">ML<\/span><span[^>]*>2<\/span>/);
  assert.match(html, /id="paper-row-p1"[^>]*class="[^"]*bg-accent /);
  assert.doesNotMatch(html, /id="paper-row-p2"[^>]*class="[^"]*bg-accent /);
  // The paper being translated shows its progress; the one with another job, 「AI処理中」.
  assert.match(html, /role="progressbar" aria-label="訳文を保存済みのページ"[^>]*aria-valuenow="4"/);
  assert.match(html, /· AI処理中/);
  assert.match(html, />3(<!-- -->)? 件の論文</);
});

/** The opening tag of the element whose attributes match `pattern`. */
function openingTag(html, pattern) {
  const tag = html.match(new RegExp(`<[a-z]+\\s[^>]*${pattern}[^>]*>`))?.[0];
  assert.ok(tag, `no tag with ${pattern}`);
  return tag;
}

test("the library tree is a tree of treeitems for assistive technology, and one row takes the Tab key", () => {
  const { React, LibrarySidebar, useTreeFocus } = modules;
  // Set by an effect in the app, which the server doesn't run; it reads the store's initial state.
  const initial = useTreeFocus.getInitialState();
  const saved = initial.tabStop;
  initial.tabStop = "paper:p2";
  let html;
  try {
    html = render(React.createElement(LibrarySidebar), libraryState, {}, libraryQueries);
  } finally {
    initial.tabStop = saved;
  }
  assert.match(html, /<div role="tree" aria-label="ライブラリ" aria-multiselectable="true" class="py-1">/);
  const ml = openingTag(html, 'data-tree-key="folder:ML"');
  assert.match(ml, /role="treeitem"/);
  assert.match(ml, /aria-level="1"/);
  assert.match(ml, /aria-expanded="true"/);
  assert.match(ml, /aria-selected="false"/);
  assert.match(ml, /aria-label="ML（2件）"/);
  // The rows are flat, not nested in groups (a long library renders only the rows in view): each says
  // its level and its place among its siblings — Empty, ML and 未分類; NLP and p2 in ML.
  assert.doesNotMatch(html, /role="group"|aria-owns/);
  assert.match(ml, /aria-setsize="3"/);
  assert.match(ml, /aria-posinset="2"/);
  const nlp = openingTag(html, 'data-tree-key="folder:ML / NLP"');
  assert.match(nlp, /aria-level="2"/);
  assert.match(nlp, /aria-setsize="2"/);
  assert.match(nlp, /aria-posinset="1"/);
  assert.match(openingTag(html, 'id="paper-row-p2"'), /aria-posinset="2"/);
  assert.match(openingTag(html, 'data-tree-key="folder:"'), /aria-posinset="3"/);
  // A folder with nothing in it is neither open nor closed.
  const empty = openingTag(html, 'data-tree-key="folder:Empty"');
  assert.doesNotMatch(empty, /aria-expanded/);
  // Titles give a subfolder's full path, but not a top folder's name again.
  assert.doesNotMatch(ml, /title=/);
  assert.match(openingTag(html, 'data-tree-key="folder:ML / NLP"'), /title="ML \/ NLP"/);
  assert.match(openingTag(html, 'data-tree-key="folder:"'), /title="フォルダー未指定のPDF"/);

  const open = openingTag(html, 'id="paper-row-p1"');
  assert.match(open, /role="treeitem"/);
  assert.match(open, /aria-level="3"/);
  assert.match(open, /aria-setsize="1"/);
  assert.match(open, /aria-posinset="1"/);
  assert.match(open, /aria-selected="true"/);
  assert.doesNotMatch(open, /aria-roledescription|aria-pressed/);
  // Roving tabindex: only the row that takes the Tab key is in the Tab order, and no button in a row is.
  assert.match(openingTag(html, 'id="paper-row-p2"'), /tabindex="0"/);
  assert.match(open, /tabindex="-1"/);
  assert.match(ml, /tabindex="-1"/);
  const tree = html.slice(html.indexOf('<div role="tree"'));
  assert.equal(tree.match(/tabindex="0"/g)?.length, 1);
  // Buttons are in the Tab order unless taken out: the folders' ▸, the tags.
  const buttons = tree.match(/<button[^>]*>/g) ?? [];
  assert.ok(buttons.length >= 5);
  for (const button of buttons) assert.match(button, /tabindex="-1"/);
  assert.match(openingTag(tree, 'title="重要で絞り込み"'), /tabindex="-1"/);
  // The rows show a ring when focused from the keyboard.
  assert.match(open, /focus-visible:outline-2/);
  assert.match(ml, /focus-visible:outline-ring/);
});

test("the library shows the papers selected together apart from the open one, and how many", () => {
  const { React, LibrarySidebar, usePaperSelection } = modules;
  // Selected with Ctrl or Shift in the app; the server reads the store's initial state.
  const initial = usePaperSelection.getInitialState();
  const saved = { ...initial };
  Object.assign(initial, { ids: new Set(["p2", "p3"]), anchor: "paper:p2" });
  let html;
  try {
    html = render(React.createElement(LibrarySidebar), { ...libraryState, selectedFolder: null }, {}, libraryQueries);
  } finally {
    Object.assign(initial, saved);
  }
  assert.match(html, /<div role="tree" aria-label="ライブラリ" aria-multiselectable="true" class="py-1">/);
  for (const id of ["p2", "p3"]) {
    const row = openingTag(html, `id="paper-row-${id}"`);
    assert.match(row, /aria-selected="true"/);
    assert.match(row, /class="[^"]*\bbg-accent\b/);
  }
  // The open paper, not among them, is not selected but keeps its mark.
  const open = openingTag(html, 'id="paper-row-p1"');
  assert.match(open, /aria-selected="false"/);
  assert.doesNotMatch(open, /\bbg-accent\b/);
  assert.match(open, /\bborder-primary\b/);
  assert.match(open, /aria-current="true"/);
  assert.doesNotMatch(openingTag(html, 'id="paper-row-p2"'), /aria-current/);
  // Folders are not selected with papers.
  for (const tag of html.match(/<div[^>]*data-tree-key="folder:[^"]*"[^>]*>/g) ?? []) assert.match(tag, /aria-selected="false"/);
  assert.match(html, /· (<!-- -->)?2(<!-- -->)? 件を選択中/);
  assert.match(html, /title="複数選択を解除します（一覧で Esc）"/);
  // Put back for the next render.
  assert.equal(usePaperSelection.getInitialState().ids, null);
});

test("without papers selected together, the open paper is the selected row and nothing is counted", () => {
  const html = render(modules.React.createElement(modules.LibrarySidebar), libraryState, {}, libraryQueries);
  assert.match(openingTag(html, 'id="paper-row-p1"'), /aria-selected="true"/);
  assert.match(openingTag(html, 'id="paper-row-p2"'), /aria-selected="false"/);
  assert.doesNotMatch(html, /件を選択中/);
});

test("while an action on several papers runs, the library shows its progress with a button that stops it", () => {
  const { React, LibrarySidebar, useBulkProgress } = modules;
  const initial = useBulkProgress.getInitialState();
  const saved = initial.progress;
  initial.progress = { label: "「ML」へ移動中", ran: 2, total: 5, stopping: false };
  let html;
  try {
    html = render(React.createElement(LibrarySidebar), libraryState, {}, libraryQueries);
  } finally {
    initial.progress = saved;
  }
  // React separates the text's parts with comments.
  assert.ok(html.replaceAll("<!-- -->", "").includes("「ML」へ移動中…（3/5）"));
  assert.match(html, /<button[^>]*title="送信中の 1 件が終わったところで止めます。残りは処理しません。"[^>]*>中止<\/button>/);
});

test("a long library renders only the rows in view, placed in a list as tall as all of them, and the row that takes the Tab key", () => {
  const { React, LibrarySidebar, useTreeFocus } = modules;
  const many = Array.from({ length: 400 }, (_, i) => ({ id: `m${i}`, title: `Paper ${i}`, collection_name: "Many", pages: 1, translated_count: 0 }));
  const initial = useTreeFocus.getInitialState();
  const saved = initial.tabStop;
  // The last paper, far below the rows in view, takes the Tab key: it is rendered all the same.
  initial.tabStop = "paper:m399";
  let html;
  try {
    html = render(React.createElement(LibrarySidebar), libraryState, {}, [
      [["papers", "list", "", 0], many], [["collections"], ["Many"]],
    ]);
  } finally {
    initial.tabStop = saved;
  }
  const tree = openingTag(html, 'role="tree"');
  assert.match(tree, /class="relative"/);
  // 4 px of padding, Many (30), 400 papers (46 each), 未分類 (30), 4 px: rows not measured yet are estimated.
  assert.match(tree, /style="height:18468px;overflow-anchor:none"/);
  const rendered = [...html.matchAll(/data-tree-key="([^"]+)"/g)].map((m) => m[1]);
  // The rows in the first 800 px (the height taken before the list is measured) and 10 more, then the pinned one.
  assert.ok(rendered.length > 15 && rendered.length < 40, `${rendered.length} rows rendered`);
  assert.deepEqual(rendered.slice(0, 3), ["folder:Many", "paper:m0", "paper:m1"]);
  assert.equal(rendered.at(-1), "paper:m399");
  assert.ok(!rendered.includes("paper:m200"));
  assert.ok(!rendered.includes("folder:"));
  // Each row still says where it is in the whole tree.
  const last = openingTag(html, 'id="paper-row-m399"');
  assert.match(last, /aria-setsize="400"/);
  assert.match(last, /aria-posinset="400"/);
  assert.match(last, /aria-level="2"/);
  assert.match(last, /tabindex="0"/);
  assert.match(openingTag(html, 'data-tree-key="folder:Many"'), /aria-setsize="2"/);
  // Each row is placed at its offset: after the padding, Many and 399 papers.
  assert.match(openingTag(html, 'data-index="400"'), /translateY\(18388px\)/);
  assert.match(html, />400(<!-- -->)? 件の論文</);
});

/** A library of `count` papers in the folder Many, and 未分類: count + 2 rows. */
const manyPapers = (count) => [
  [["papers", "list", "", 0], Array.from({ length: count }, (_, i) => ({ id: `m${i}`, title: `Paper ${i}`, collection_name: "Many", pages: 1, translated_count: 0 }))],
  [["collections"], ["Many"]],
];

/** Renders the library with the initial state of `stores` ([store, values] pairs) set, and puts them back. */
function renderLibrary(queries, stores = []) {
  const saved = stores.map(([store]) => [store, { ...store.getInitialState() }]);
  for (const [store, values] of stores) Object.assign(store.getInitialState(), values);
  try {
    return render(modules.React.createElement(modules.LibrarySidebar), libraryState, {}, queries);
  } finally {
    for (const [store, values] of saved) Object.assign(store.getInitialState(), values);
  }
}

const renderedRows = (html) => [...html.matchAll(/data-tree-key="([^"]+)"/g)].map((m) => m[1]);

test("the library renders every row up to 199 rows, and from 200 only the rows in view", () => {
  const below = renderLibrary(manyPapers(197));
  assert.match(openingTag(below, 'role="tree"'), /class="py-1"/);
  assert.equal(renderedRows(below).length, 199);
  const at = renderLibrary(manyPapers(198));
  assert.match(openingTag(at, 'role="tree"'), /class="relative"/);
  assert.ok(renderedRows(at).length < 40);
  // The same rows on top, placed at the same height as in the page's flow (after the 4 px of padding).
  assert.deepEqual(renderedRows(at).slice(0, 3), renderedRows(below).slice(0, 3));
  assert.match(openingTag(at, 'data-index="0"'), /translateY\(4px\)/);
});

test("a long library keeps rendering, out of view, the rows with the focus, asked to take it, with a menu open, and dragged", () => {
  const { useTreeFocus, useMenuRow, useDragOver } = modules;
  const plain = renderedRows(renderLibrary(manyPapers(400)));
  for (const key of ["paper:m250", "paper:m300", "paper:m350", "paper:m380", "folder:"]) assert.ok(!plain.includes(key), key);
  const html = renderLibrary(manyPapers(400), [
    [useTreeFocus, { focused: "paper:m300", pending: { key: "paper:m350", until: Date.now() + 3000 } }],
    [useMenuRow, { key: "paper:m250" }],
    [useDragOver, { active: "m380" }],
  ]);
  const rows = renderedRows(html);
  for (const key of ["paper:m250", "paper:m300", "paper:m350", "paper:m380"]) assert.ok(rows.includes(key), key);
  // While a paper is dragged, every folder, which a drag with the keyboard moves between.
  assert.ok(rows.includes("folder:"));
  // In the order of the tree.
  assert.deepEqual(rows.slice(-5), ["paper:m250", "paper:m300", "paper:m350", "paper:m380", "folder:"]);
  // Put back for the next render.
  assert.equal(useMenuRow.getInitialState().key, null);
  assert.equal(useDragOver.getInitialState().active, null);
});

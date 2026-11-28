// Extraction -> HTTP -> TypeScript -> static render bridge (run by the Python route test; not a *.test.* file).
// stdin: { runId, selector, list: { status, body }, preview: { status, body } } -- the real route responses.
// The real desktop driver validates them, the real preview controller projects them, and the real
// NotebookPreviewPages renders the result. Nothing here reads a Library or writes anything.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));

globalThis.window = { __PAPEER_PORT: 4321, __PAPEER_TOKEN: 'bridge-token' };
globalThis.addEventListener = () => undefined; globalThis.removeEventListener = () => undefined;
globalThis.localStorage = { length: 0, key: () => null, getItem: () => null };
const requests = [];
const fetcher = async (url, init) => {
  const path = new URL(String(url)).pathname, body = JSON.parse(init.body);
  requests.push({ path, keys: Object.keys(body).sort() });
  const reply = path.endsWith('/notebook-preview') ? input.preview : path.endsWith('/notebooks') ? input.list : null;
  assert.ok(reply, `unexpected path ${path}`);
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
};

const root = fileURLToPath(new URL('../..', import.meta.url));
const server = await createServer({ configFile: false, root, logLevel: 'error', appType: 'custom', resolve: { alias: [{ find: '@', replacement: `${root}src` }] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
try {
  const { createDesktopBootstrapHostDriver } = await server.ssrLoadModule('/src/adapters/desktop/bootstrapHostDriver.ts');
  const { createPreviewController } = await server.ssrLoadModule('/src/features/bootstrap/legacy/notebookPreviewModel.ts');
  const { NotebookPreviewPages } = await server.ssrLoadModule('/src/features/bootstrap/legacy/NativeNotebookPreview.tsx');
  const facade = createDesktopBootstrapHostDriver(fetcher).getNativePreparation();
  const controller = createPreviewController(facade, input.runId);
  await controller.loadList();
  assert.equal(controller.getSnapshot().list.kind, 'ok');
  await controller.loadNote(input.selector);
  const view = controller.getSnapshot().notes[input.selector];
  assert.equal(view?.kind, 'ok', JSON.stringify(view?.kind === 'blocked' ? view : { kind: view?.kind }));
  const html = renderToStaticMarkup(createElement(NotebookPreviewPages, { document: view.document }));
  const count = pattern => (html.match(pattern) ?? []).length;
  const result = {
    selectors: controller.getSnapshot().list.selectors,
    pages: view.document.pages.length,
    pageLabels: [...html.matchAll(/aria-label="(ページ \d+)"/g)].map(match => match[1]),
    inkElements: count(/data-ink-id="/g), bookmarkElements: count(/data-sticky-id="/g), highlightElements: count(/data-highlight-id="/g),
    inkRows: view.inkRows, bookmarkRows: view.bookmarkRows,
    annotationKinds: view.document.pages.map(page => page.annotations.map(annotation => annotation.kind)),
    requests,
  };
  controller.dispose();
  process.stdout.write(JSON.stringify(result));
} finally { await server.close(); }

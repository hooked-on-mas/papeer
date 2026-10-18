// pdf.js's legacy build is the one the app loads (vite.config.ts pdfjsLegacy): react-pdf's imports of
// `pdfjs-dist` and of its viewer module, and the worker PdfDocument.tsx names. The modern build needs JavaScript
// that macOS's WKWebView and Linux's WebKitGTK may not have yet, and would show no PDF there.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));

let server;

before(async () => {
  server = await createServer({
    configFile: path("../vite.config.ts"),
    logLevel: "error",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
});

after(async () => {
  await server?.close();
});

/** Where the app's Vite config takes `id` when react-pdf imports it. */
async function resolvedFromReactPdf(id) {
  const importer = fs.realpathSync(path("../node_modules/react-pdf/dist/index.js"));
  const resolved = await server.pluginContainer.resolveId(id, importer, { ssr: true });
  assert.ok(resolved, id);
  // Without the ?v= of the optimized dependencies.
  return resolved.id.replaceAll("\\", "/").replace(/\?.*$/, "");
}

test("react-pdf gets pdf.js's legacy build", async () => {
  assert.match(await resolvedFromReactPdf("pdfjs-dist"), /\/pdfjs-dist\/legacy\/build\/pdf\.mjs$/);
  assert.match(await resolvedFromReactPdf("pdfjs-dist/web/pdf_viewer.mjs"), /\/pdfjs-dist\/legacy\/web\/pdf_viewer\.mjs$/);
  // Other files of the package are left alone (the types, for one).
  assert.doesNotMatch(await resolvedFromReactPdf("pdfjs-dist/package.json"), /legacy/);
});

test("the worker is the legacy build of the same release", () => {
  const pane = fs.readFileSync(path("../src/features/reader/PdfDocument.tsx"), "utf8");
  const workers = [...pane.matchAll(/from "(pdfjs-dist\/[^"]*worker[^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(workers, ["pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"]);
});

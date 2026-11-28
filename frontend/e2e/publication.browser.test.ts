/** Verify diagrams after excluding ELK and updating the indirect math dependency. No sidecar or AI. */
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { test } from "node:test";
import { build, preview } from "vite";
import { chromium } from "playwright-core";

test("Dagre and math render while ELK is excluded with a useful error", { timeout: 60_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "papeer-publication-"));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  await build({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    build: { outDir: output, emptyOutDir: true, target: "esnext",
      rolldownOptions: { input: path.join(frontend, "e2e/fixtures/publication.html") } } });
  const server = await preview({ root: frontend, configFile: path.join(frontend, "vite.config.ts"),
    logLevel: "error", build: { outDir: output }, preview: { host: "127.0.0.1", port: 0, strictPort: false } });
  t.after(() => new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve())));
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requested: string[] = [];
  page.on("request", request => requested.push(request.url()));
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/publication.html`);
  await page.waitForFunction(() => "publicationResult" in window);
  const result = await page.evaluate(() => (window as unknown as {
    publicationResult: { svg: string; math: string; elkError: string };
  }).publicationResult);
  assert.match(result.svg, /Original/);
  assert.match(result.svg, /Translation/);
  assert.match(result.math, /katex/);
  assert.match(result.elkError, /ELK.*dagre/);
  assert.ok(requested.every(url => !url.includes("elkjs")), "no EPL implementation is fetched");
});

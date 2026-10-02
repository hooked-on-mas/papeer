/** Actual reference navigation with fake API responses; never touches the user's library or network. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import type { CitationGraph } from "../src/features/references/graph.ts";

const graph: CitationGraph = {
  nodes: [
    { id: "a", paper_id: "a", title: "Learning robust control policies", year: "2024", url: "" },
    { id: "b", paper_id: "b", title: "Planning in uncertain environments", year: "2020", url: "" },
    { id: "c", paper_id: "c", title: "A survey of learning and control", year: "2025", url: "" },
    { id: "ref:x", paper_id: null, title: "Neural representations for control", year: "2021", url: "https://doi.org/10.1234/example" },
  ],
  edges: [{ source: "a", target: "b" }, { source: "c", target: "a" }, { source: "a", target: "ref:x" }],
  references: [
    { id: "a:0", source: "a", target: "b", raw: "A. Smith, Planning in uncertain environments, 2020. doi:10.1234/planning.", page: 8, label: "1", title: "Planning in uncertain environments", doi: "10.1234/planning", arxiv_id: "", year: "2020", match: "identifier", url: "https://doi.org/10.1234/planning" },
    { id: "a:1", source: "a", target: "ref:x", raw: "B. Doe, Neural representations for control, 2021. doi:10.1234/example.", page: 9, label: "2", title: "Neural representations for control", doi: "10.1234/example", arxiv_id: "", year: "2021", match: "unresolved", url: "https://doi.org/10.1234/example" },
    { id: "c:0", source: "c", target: "a", raw: "C. Jones, Learning robust control policies, 2024.", page: 12, label: "1", title: "Learning robust control policies", doi: "", arxiv_id: "", year: "2024", match: "title", url: "https://scholar.google.com/scholar?q=control" },
  ], warnings: [],
};

test("reference graph supports following, returning, source-page jumps, external links and refresh errors", { timeout: 120_000 }, async (t) => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  let fail = false, requests = 0;
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" } }); return;
    }
    assert.equal(new URL(route.request().url()).pathname, "/api/citations");
    requests++;
    await route.fulfill({ status: fail ? 500 : 200, json: fail ? { detail: "読み取り失敗" } : graph, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/references.html`);
  await page.getByRole("button", { name: "参考文献 2", exact: true }).waitFor();
  assert.equal(await page.locator("article").count(), 2);
  await page.locator("svg").getByRole("button", { name: "Planning in uncertain environments", exact: true }).click();
  await page.getByRole("button", { name: "この文献からたどる", exact: true }).first().click();
  await page.getByRole("button", { name: "参考文献 0", exact: true }).waitFor();
  await page.getByRole("button", { name: "この文献を引用 1", exact: true }).click();
  assert.equal(await page.locator("article").count(), 1);
  await page.getByRole("button", { name: "戻る", exact: true }).click();
  await page.getByRole("button", { name: "参考文献 2", exact: true }).click();
  await page.getByLabel("参考文献を検索").fill("Neural");
  assert.equal(await page.locator("article").count(), 1);
  await page.getByLabel("参考文献を検索").fill("");
  await page.getByLabel("未登録も表示").uncheck();
  assert.equal(await page.locator("svg").getByRole("button", { name: "Neural representations for control", exact: true }).count(), 0);
  await page.getByLabel("未登録も表示").check();
  await page.locator("svg").getByRole("button", { name: "Neural representations for control", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "外部で探す", exact: true }).waitFor();
  // Capture the requested browser URL without visiting an external service.
  await page.evaluate(() => { window.open = ((url: string) => { document.body.dataset.externalUrl = url; return null; }) as typeof window.open; });
  await page.getByRole("button", { name: "外部で探す", exact: true }).click();
  assert.equal(await page.locator("body").getAttribute("data-external-url"), "https://doi.org/10.1234/example");
  await fs.mkdir(path.resolve(frontend, "../tmp"), { recursive: true });
  await page.screenshot({ path: path.resolve(frontend, "../tmp/references-network.png") });
  await page.setViewportSize({ width: 900, height: 800 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole("button", { name: "引用元 p.9", exact: true }).click();
  assert.equal(await page.getByTestId("navigation").textContent(), "a:reader:9");
  await page.getByRole("button", { name: "PDFを読む", exact: true }).last().click();
  assert.equal(await page.getByTestId("navigation").textContent(), "b:reader:1");
  fail = true;
  await page.getByRole("button", { name: "更新", exact: true }).click();
  await page.getByRole("alert").waitFor();
  fail = false;
  await page.getByRole("button", { name: "再試行", exact: true }).click();
  await page.getByRole("heading", { name: "参考文献・引用ネットワーク" }).waitFor();
  assert.ok(requests >= 3);
  assert.deepEqual(errors, []);
});

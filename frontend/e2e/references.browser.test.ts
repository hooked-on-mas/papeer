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
    { id: "a:0", research_key: "key-a:0", source: "a", target: "b", raw: "A. Smith, Planning in uncertain environments, 2020. doi:10.1234/planning.", page: 8, label: "1", title: "Planning in uncertain environments", doi: "10.1234/planning", arxiv_id: "", year: "2020", match: "identifier", url: "https://doi.org/10.1234/planning" },
    { id: "a:1", research_key: "key-a:1", source: "a", target: "ref:x", raw: "B. Doe, Neural representations for control, 2021. doi:10.1234/example.", page: 9, label: "2", title: "Neural representations for control", doi: "10.1234/example", arxiv_id: "", year: "2021", match: "unresolved", url: "https://doi.org/10.1234/example" },
    { id: "c:0", research_key: "key-c:0", source: "c", target: "a", raw: "C. Jones, Learning robust control policies, 2024.", page: 12, label: "1", title: "Learning robust control policies", doi: "", arxiv_id: "", year: "2024", match: "title", url: "https://scholar.google.com/scholar?q=control" },
  ], warnings: [],
};

test("reference graph supports following, returning, source-page jumps, external links and refresh errors", { timeout: 120_000 }, async (t) => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
  page.setDefaultTimeout(15_000);
  let fail = false, requests = 0;
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" } }); return;
    }
    const pathname = new URL(route.request().url()).pathname;
    if (pathname !== "/api/citations") {
      const json = pathname === "/api/research-capabilities" ? { web_search: false }
        : pathname === "/api/collections" ? [] : { id: pathname.split("/")[3], collection_name: "", has_article: false };
      await route.fulfill({ json, headers: { "Access-Control-Allow-Origin": "*" } }); return;
    }
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
  await page.locator("article").getByRole("button", { name: "Learning robust control policies", exact: true }).click();
  await page.getByRole("button", { name: "この論文での引用箇所 p.8", exact: true }).waitFor();
  await page.getByRole("button", { name: "一覧に戻る", exact: true }).click();
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
  await page.getByText("書誌情報・引用元", { exact: true }).click();
  // Capture the requested browser URL without visiting an external service.
  await page.evaluate(() => { window.open = ((url: string) => { document.body.dataset.externalUrl = url; return null; }) as typeof window.open; });
  await page.getByRole("button", { name: "DOIを開く", exact: true }).click();
  assert.equal(await page.locator("body").getAttribute("data-external-url"), "https://doi.org/10.1234/example");
  await fs.mkdir(path.resolve(frontend, "../tmp"), { recursive: true });
  await page.screenshot({ path: path.resolve(frontend, "../tmp/references-network.png") });
  await page.setViewportSize({ width: 900, height: 800 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole("button", { name: "引用元 p.9", exact: true }).click();
  assert.equal(await page.getByTestId("navigation").textContent(), "a:reader:9");
  await page.getByRole("button", { name: "一覧に戻る", exact: true }).click();
  await page.locator("article").getByRole("button", { name: "Planning in uncertain environments", exact: true }).click();
  await page.getByRole("button", { name: "PDFを読む", exact: true }).click();
  assert.equal(await page.getByTestId("navigation").textContent(), "b:reader:1");
  fail = true;
  await page.getByRole("button", { name: "更新", exact: true }).click();
  await page.getByRole("alert").waitFor();
  fail = false;
  await page.getByRole("button", { name: "再試行", exact: true }).click();
  await page.getByRole("heading", { name: "参考文献", exact: true }).waitFor();
  assert.ok(requests >= 3);
  assert.deepEqual(errors, []);
});

test("reference list has one action per row and restores position after viewing details at narrow and wide panel sizes", { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.setDefaultTimeout(15_000);
  const longGraph = structuredClone(graph);
  longGraph.references = Array.from({ length: 30 }, (_, i) => ({ ...graph.references[1], id: `a:${i}`,
    label: String(i + 1), research_key: `key-${i}`, raw: `Reference ${i + 1}`, page: i + 1 }));
  const requests: Record<string, unknown>[] = [];
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const pathname = new URL(route.request().url()).pathname;
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (route.request().method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (route.request().method() === "POST") {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ json: { job_id: "reference-details-test" }, headers }); return;
    }
    const json = pathname === "/api/citations" ? longGraph : pathname === "/api/research-capabilities" ? { web_search: true }
      : pathname === "/api/collections" ? [] : { id: pathname.split("/")[3], collection_name: "", has_article: false };
    await route.fulfill({ json, headers });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/references.html`);
  const action = page.locator("article").last().getByRole("button", { name: "Neural representations for control", exact: true });
  for (const width of [360, 1000, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    // Simulate a narrow reader side panel even in a wide desktop window.
    await page.locator("#root").evaluate((el, w) => { el.style.width = w === 1440 ? "380px" : "100%"; }, width);
    if (width !== 1000) {
      assert.equal(await page.getByLabel("引用関係の図").isVisible(), false);
      await page.getByRole("button", { name: "引用関係", exact: true }).click();
      assert.equal(await page.getByLabel("引用関係の図").isVisible(), true);
      await page.getByRole("button", { name: "引用関係", exact: true }).click();
    }
    assert.equal(await page.locator("article").last().getByRole("button").count(), 1);
    for (let attempt = 0; attempt < 2; attempt++) {
      await action.scrollIntoViewIfNeeded();
      const listTop = await action.evaluate(el => el.closest("article")!.parentElement!.scrollTop);
      await action.click();
      const research = page.getByRole("button", { name: "内容・入手先をWebで調べる", exact: true });
      await research.waitFor();
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll("button")].find(b => b.textContent?.includes("内容・入手先をWebで調べる"));
        const rect = button?.getBoundingClientRect();
        return rect && rect.top >= 0 && rect.bottom <= window.innerHeight;
      }, undefined, { timeout: 2000 });
      assert.equal(await page.getByRole("button", { name: "手元のPDFを選ぶ", exact: true }).count(), 0);
      assert.equal(await page.getByLabel("参考文献を検索").isVisible(), false);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      if (attempt === 1) {
        await page.getByRole("button", { name: "パネルを開き直す", exact: true }).click();
        await research.waitFor();
      }
      await page.getByRole("button", { name: "一覧に戻る", exact: true }).click();
      assert.equal(await action.evaluate(el => el.closest("article")!.parentElement!.scrollTop), listTop);
      assert.equal(await action.evaluate(el => el === document.activeElement), true);
    }
    await fs.mkdir(path.resolve(frontend, "../tmp"), { recursive: true });
    await page.screenshot({ path: path.resolve(frontend, `../tmp/reference-details-${width}.png`) });
    await action.click();
    await page.screenshot({ path: path.resolve(frontend, `../tmp/reference-selected-${width}.png`) });
    await page.getByRole("button", { name: "一覧に戻る", exact: true }).click();
  }
  await action.click();
  const submitted = page.waitForResponse(response => response.request().method() === "POST");
  await page.getByRole("button", { name: "内容・入手先をWebで調べる", exact: true }).click();
  await submitted;
  assert.equal(requests[0]?.reference_id, "a:29");
});

test("related papers explain common references and stay linked to the similarity graph and reading actions", { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15_000);
  const network = structuredClone(graph);
  network.edges.push({ source: "c", target: "b" }, { source: "c", target: "ref:x" });
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const pathname = new URL(route.request().url()).pathname;
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (route.request().method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    const json = pathname === "/api/citations" ? network : pathname === "/api/research-capabilities" ? { web_search: false }
      : pathname === "/api/collections" ? [] : { id: pathname.split("/")[3], collection_name: "", has_article: false };
    await route.fulfill({ json, headers });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/references.html`);
  await page.getByLabel("文献の並び順").selectOption("newest");
  assert.equal(await page.locator("article").first().getByRole("button").getAttribute("aria-label"), "Neural representations for control");
  await page.getByRole("button", { name: "関連する論文 3", exact: true }).click();
  await page.getByLabel("文献の並び順").selectOption("original");
  assert.equal(await page.locator("article").first().getByRole("button").getAttribute("aria-label"), "A survey of learning and control");
  await page.getByLabel("グラフの種類").selectOption("similarity");
  assert.equal(await page.getByLabel("ネットワークの範囲").isDisabled(), true);
  assert.equal(await page.locator("svg line[marker-end]").count(), 0);
  assert.equal(await page.getByText("AI収集中", { exact: true }).count(), 0);
  await fs.mkdir(path.resolve(frontend, "../tmp"), { recursive: true });
  await page.screenshot({ path: path.resolve(frontend, "../tmp/reference-similarity.png") });
  await page.locator("article").getByRole("button", { name: "A survey of learning and control", exact: true }).click();
  await page.getByLabel("選択した文献の詳細").getByText("共通の参考文献 2件", { exact: true }).waitFor();
  await page.getByRole("button", { name: "PDFを読む", exact: true }).click();
  assert.equal(await page.getByTestId("navigation").textContent(), "c:reader:1");
});

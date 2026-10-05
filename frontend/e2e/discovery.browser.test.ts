import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium, type WebSocketRoute } from "playwright-core";
import { localMap } from "../src/features/references/mapGraph.ts";
import type { CitationGraph } from "../src/features/references/graph.ts";
const source = "a".repeat(32);
const graph: CitationGraph = { nodes: [{ id: source, paper_id: source, title: "Current paper", year: "2024", url: "" }, { id: "ref:first", paper_id: null, title: "First discovery paper", year: "2020", url: "" }], edges: [{ source, target: "ref:first" }], references: [], warnings: [] };

test("external discovery starts once in StrictMode, preserves partial results, cancels on leaving and retries", { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error", cacheDir: path.resolve(frontend, "../tmp/vite-discovery-browser"), server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  t.after(() => { if (errors.length) console.error(errors); });
  page.on("console", msg => { if (msg.type() === "error") console.error(msg.text()); });
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\/events/, s => { socket = s; });
  let current = localMap(graph, source);
  const posts: { path: string; body: unknown }[] = [], cancels: string[] = [];
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname.endsWith("/cancel")) { cancels.push(url.pathname); await route.fulfill({ json: {}, headers }); return; }
    if (request.method() === "POST") { posts.push({ path: url.pathname, body: request.postDataJSON() }); await route.fulfill({ json: { job_id: `map-${posts.length}` }, headers }); return; }
    const json = url.pathname === "/api/citations" ? graph : url.pathname.endsWith("/discovery") ? current
      : url.pathname === "/api/research-capabilities" ? { paper_discovery_enabled: true, reference_research_enabled: false, reference_lookup: true }
      : url.pathname === "/api/jobs" || url.pathname.endsWith("/reference-research") || url.pathname === "/api/collections" ? [] : { id: source, has_article: false, collection_name: "" };
    await route.fulfill({ json, headers });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/discovery.html`);
  await page.getByText("外部情報を取得中 · 保存済みの結果を表示", { exact: true }).waitFor();
  assert.equal(posts.length, 1);
  const timings = page.getByLabel("論文マップの構築時間");
  await page.locator("summary", { hasText: "取得範囲" }).click();
  await timings.locator("summary").click();
  await timings.locator('[data-layout-count="1"]').waitFor(); // StrictMode must not double-count one committed layout.
  await timings.locator("summary").click();
  const camera = page.getByLabel("論文の関係図");
  await page.getByLabel("論文の関係図").focus(); await page.keyboard.press("ArrowRight");
  const transform = await camera.getAttribute("data-camera");
  const extra = { ...current.nodes[1], id: "ref:second", title: "Second discovery paper" };
  current = { ...current, nodes: [...current.nodes, extra], edges: [...current.edges, { source, target: extra.id, kind: "citation", provenance: "Semantic Scholar" }] };
  await page.locator("article").getByRole("button", { name: extra.title, exact: true }).waitFor();
  assert.equal(await camera.getAttribute("data-camera"), transform);
  const cancelled = page.waitForResponse(r => r.url().endsWith("/cancel"));
  await page.getByRole("button", { name: "タブを切り替える", exact: true }).click();
  await cancelled;
  assert.equal(cancels.length, 1);
  socket!.send(JSON.stringify({ type: "job.finished", kind: "paper-discovery", job_id: "map-1", paper_id: source, status: "cancelled", running: false, cancelled: true, message: "", error: null, result: null }));
  const restarted = page.waitForResponse(r => r.request().method() === "POST");
  await page.getByRole("button", { name: "タブを切り替える", exact: true }).click();
  await page.getByText("外部情報を取得中 · 保存済みの結果を表示", { exact: true }).waitFor();
  await restarted;
  assert.equal(posts.length, 2);
  current = { ...current, stale: false, checked_at: new Date().toISOString(), warnings: ["取得制限：取得済みの文献は保持しました。"],
    timing: { id: "fixed-timing", started_at: new Date().toISOString(), finished_at: new Date().toISOString(), status: "partial", total_ms: 34000, other_ms: 1000,
      steps: [{ key: "/fetch", parent: "", label: "直接の参考文献の取得", elapsed_ms: 19000, total_ms: 33000, count: 1, errors: 0, canceled: 0 },
        { key: "/fetch/http", parent: "/fetch", label: "Semantic Scholar：通信・応答受信", elapsed_ms: 14000, total_ms: 14000, count: 4, errors: 0, canceled: 0 }] } };
  socket!.send(JSON.stringify({ type: "job.finished", kind: "paper-discovery", job_id: "map-2", paper_id: source, status: "succeeded", running: false, cancelled: false, message: "", error: null, result: current }));
  await page.getByRole("button", { name: "再取得", exact: true }).waitFor({ state: "visible" });
  await page.getByText("一部の情報を取得できませんでした · 詳細", { exact: true }).waitFor();
  assert.equal(await page.locator("article").count(), 2);
  assert.equal(await camera.getAttribute("data-camera"), transform);
  await page.locator("summary", { hasText: "取得範囲" }).click();
  await timings.getByText("構築時間の内訳 · 34.00 秒（一部取得）", { exact: true }).waitFor();
  await timings.locator("summary").click();
  await timings.getByText("Semantic Scholar：通信・応答受信", { exact: true }).waitFor();
  assert.match(await timings.innerText(), /14.00 秒\s+4/);
  for (const width of process.env.PAPEER_DESKTOP_ONLY ? [1280, 1600] : [360, 900, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "150%"; });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.ok(await timings.evaluate(element => element.scrollWidth <= element.clientWidth));
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
  await timings.locator("summary").click();
  const requested = page.waitForResponse(r => r.request().method() === "POST");
  await page.getByRole("button", { name: "再取得", exact: true }).click(); await requested;
  assert.equal(posts.length, 3);
  assert.deepEqual(posts[2].body, { origin: source, force: true });
  assert.deepEqual(errors, []);
});

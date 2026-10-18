/** Fixed API responses, with real map rendering and navigation. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import type { CitationGraph } from "../src/features/references/graph.ts";
import { localMap } from "../src/features/references/mapGraph.ts";

const graph: CitationGraph = {
  nodes: [{ id: "a", paper_id: "a", title: "Current research paper", year: "2024", url: "" }, { id: "b", paper_id: "b", title: "Planning in uncertain environments", year: "2020", url: "" },
    ...Array.from({ length: 75 }, (_, i) => ({ id: `ref:${i}`, paper_id: null, title: `External research paper ${i}`, year: "2021", url: "https://doi.org/10.1234/example" })),
    { id: "shared:1", paper_id: null, title: "Common foundation of planning", year: "1990", url: "" },
    { id: "shared:2", paper_id: null, title: "Common foundation of uncertainty", year: "1995", url: "" },
    ...Array.from({ length: 18 }, (_, i) => ({ id: `shared:${i + 3}`, paper_id: null, title: `Shared research foundation ${i + 3}`, year: "2000", url: "" }))],
  edges: [{ source: "a", target: "b" }, ...Array.from({ length: 75 }, (_, i) => ({ source: "a", target: `ref:${i}` })),
    { source: "b", target: "shared:1" }, { source: "ref:0", target: "shared:1" },
    { source: "b", target: "shared:2" }, { source: "ref:1", target: "shared:2" }, { source: "ref:0", target: "ref:1" },
    ...Array.from({ length: 18 }, (_, i) => [{ source: `ref:${i * 2 + 2}`, target: `shared:${i + 3}` },
      { source: `ref:${i * 2 + 3}`, target: `shared:${i + 3}` }]).flat()],
  references: [{ id: "a:0", research_key: "key-a:0", source: "a", target: "b", raw: "A. Smith, Planning in uncertain environments, 2020.", page: 8, label: "1", title: "Planning in uncertain environments", doi: "10.1234/planning", arxiv_id: "", year: "2020", match: "identifier", url: "https://doi.org/10.1234/planning", provenance: [{ provider: "Semantic Scholar", checked_at: "", page: null, label: "" }, { provider: "PDF", page: 8, label: "1", checked_at: "" }] },
    ...Array.from({ length: 75 }, (_, i) => ({ id: `a:${i + 1}`, research_key: `key-${i}`, source: "a", target: `ref:${i}`, raw: `External research paper ${i}, 2021.`, page: 9, label: String(i + 2), title: `External research paper ${i}`, doi: `10.1234/external${i}`, arxiv_id: "", year: "2021", match: "unresolved" as const, url: `https://doi.org/10.1234/external${i}` }))], warnings: [],
};
const widths = process.env.PAPEER_DESKTOP_ONLY ? [1280, 1600] : [360, 900, 1280];

test("map restores history and reading state; 360/900/1280px with 150% text keep list position", { timeout: 180_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error", cacheDir: path.resolve(frontend, "../tmp/vite-paper-map-browser"), server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  t.after(async () => { if (errors.length) console.error(errors); });
  page.on("console", msg => { if (msg.type() === "error") console.error(msg.text()); });
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000);
  let requests = 0;
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (route.request().method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    requests++;
    const url = new URL(route.request().url());
    const map = localMap(graph, url.searchParams.get("origin") || "a"); map.stale = false;
    const json = url.pathname.endsWith("/discovery/groups") ? { origin: map.origin, groups: [], connection: "codex:test" } : url.pathname === "/api/citations" ? graph : url.pathname.endsWith("/discovery") ? map
      : url.pathname === "/api/research-capabilities" ? { paper_discovery_enabled: false, reference_research_enabled: false, reference_lookup: true }
      : url.pathname.endsWith("/reference-research") || url.pathname === "/api/collections" ? [] : { id: url.pathname.split("/")[3], collection_name: "", has_article: false };
    await route.fulfill({ json, headers });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/references.html`);
  const canvas = page.getByLabel("論文の関係図"); await canvas.waitFor();
  const zoomIn = page.getByRole("button", { name: "関係図を拡大", exact: true });
  const zoomOut = page.getByRole("button", { name: "関係図を縮小", exact: true });
  for (let step = 0; step < 40 && await zoomIn.isEnabled(); step++) await zoomIn.click();
  assert.equal(await zoomIn.isDisabled(), true);
  assert.equal(await page.getByLabel("関係図の倍率").textContent(), "300%");
  for (let step = 0; step < 40 && await zoomOut.isEnabled(); step++) await zoomOut.click();
  assert.equal(await zoomOut.isDisabled(), true);
  assert.equal(await page.getByLabel("関係図の倍率").textContent(), "1%");
  assert.equal(await canvas.locator("[data-node-id]").count(), 30);
  await page.getByLabel("図の表示件数").selectOption("60");
  assert.equal(await canvas.locator('line[data-target="shared:1"]').count(), 2);
  assert.equal(await canvas.locator('line[data-source="a"][data-target="shared:1"]').count(), 0);
  assert.equal(await canvas.locator('line[data-source="ref:0"][data-target="ref:1"][marker-end]').count(), 1);
  await fs.mkdir(path.resolve(frontend, "../tmp"), { recursive: true });
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "150%"; });
    await page.getByRole("button", { name: "全体を表示", exact: true }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: path.resolve(frontend, `../tmp/citation-network-${width}.png`) });
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
  await page.getByLabel("表示する論文").selectOption("related");
  assert.equal(await canvas.locator('line[data-target="shared:1"]').count(), 2);
  await page.getByLabel("表示する論文").selectOption("references");
  await page.getByRole("button", { name: "全体を表示", exact: true }).click();
  assert.equal(await page.locator("article").count(), 76);
  assert.equal(await canvas.locator("[data-node-id]").count(), 60);
  assert.equal(await canvas.locator('line[data-kind="citation"]:not([marker-end])').count(), 0);
  await page.getByRole("button", { name: "関係図の配置を整える", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="論文の関係図"]')?.getAttribute("data-layout-ready") === "true");
  const movable = canvas.locator('[data-node-id="b"]');
  const originalPosition = await movable.getAttribute("transform");
  const hit = (await movable.locator("circle").last().boundingBox())!;
  await page.mouse.move(hit.x + hit.width / 2, hit.y + hit.height / 2);
  await page.mouse.down(); await page.mouse.move(hit.x + hit.width / 2 + 35, hit.y + hit.height / 2 + 20, { steps: 5 }); await page.mouse.up();
  assert.notEqual(await movable.getAttribute("transform"), originalPosition);
  const movedPosition = await movable.getAttribute("transform");
  await page.getByRole("button", { name: "全体を表示", exact: true }).click();
  assert.equal(await movable.getAttribute("transform"), movedPosition);
  await page.getByRole("button", { name: "関係図の配置を整える", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="論文の関係図"]')?.getAttribute("data-layout-ready") === "true");
  assert.equal(await movable.getAttribute("transform"), originalPosition);
  const transform = canvas.locator(":scope > g[transform]");
  const before = await transform.getAttribute("transform");
  await canvas.focus(); await page.keyboard.press("ArrowRight");
  assert.notEqual(await transform.getAttribute("transform"), before);
  const camera = await transform.getAttribute("transform");
  const action = page.locator("article").getByRole("button", { name: "Planning in uncertain environments", exact: true });
  const count = requests; await action.hover(); assert.equal(requests, count);
  await action.click();
  const detail = page.getByLabel("選択した文献の詳細"); await detail.waitFor();
  assert.equal(await detail.getByRole("button", { name: "情報取得の設定を開く", exact: true }).count(), 0);
  assert.equal(await detail.getByRole("button", { name: "内容・入手先を取得", exact: true }).count(), 0);
  await detail.focus(); await page.keyboard.press("Escape");
  await detail.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-current") === "true");
  assert.equal(await action.evaluate(el => el === document.activeElement), true);
  await action.click(); await detail.waitFor();
  assert.equal(await page.getByLabel("文献一覧", { exact: true }).isVisible(), true);
  await detail.getByText("書誌情報・取得元・引用元", { exact: true }).click();
  await detail.getByText("取得元：Semantic Scholar · PDF", { exact: true }).waitFor();
  await detail.getByRole("button", { name: "引用元を確認する p.8 [1]", exact: true }).click();
  assert.equal(await page.getByTestId("navigation").textContent(), "a:reader:8");
  await page.getByRole("button", { name: "元の論文のマップへ戻る", exact: true }).click();
  await detail.waitFor();
  await detail.getByRole("button", { name: "この論文を中心に見る", exact: true }).click();
  await page.getByText("起点：Planning in uncertain environments", { exact: true }).waitFor();
  await page.getByRole("button", { name: "戻る", exact: true }).click();
  await detail.waitFor(); assert.equal(await transform.getAttribute("transform"), camera);
  await detail.getByRole("button", { name: "論文を開く", exact: true }).click();
  assert.equal(await page.getByTestId("navigation").textContent(), "b:reader:1");
  await page.getByRole("button", { name: "元の論文のマップへ戻る", exact: true }).click();
  await detail.waitFor(); assert.equal(await transform.getAttribute("transform"), camera);
  await detail.getByRole("button", { name: "一覧に戻る", exact: true }).click();
  await page.getByLabel("登録状態").selectOption("external"); assert.equal(await page.locator("article").count(), 75);
  await page.getByLabel("文献の並び順").selectOption("newest");
  const search = page.getByLabel("論文を検索");
  await search.fill("  10.1234/external74  "); assert.equal(await page.locator("article").count(), 1);
  await search.press("Escape");
  assert.equal(await search.inputValue(), "");
  assert.equal(await search.evaluate(el => el === document.activeElement), true);
  assert.equal(await page.getByLabel("登録状態").inputValue(), "external");
  assert.equal(await page.getByLabel("文献の並び順").inputValue(), "newest");
  assert.equal(await page.locator("article").count(), 75);
  await search.fill("10.1234/external74");
  await page.locator("article").getByRole("button", { name: "External research paper 74", exact: true }).click();
  assert.equal(await canvas.locator('[data-node-id="ref:74"]').count(), 1);
  await detail.getByRole("button", { name: "この論文を中心に見る", exact: true }).click();
  await page.getByText("起点：External research paper 74", { exact: true }).waitFor();
  await page.getByRole("button", { name: "戻る", exact: true }).click();
  assert.equal(await page.getByLabel("論文を検索").inputValue(), "10.1234/external74");
  await detail.getByRole("button", { name: "一覧に戻る", exact: true }).click();
  await page.getByLabel("論文を検索").fill(""); await page.getByLabel("登録状態").selectOption("all");
  await page.setViewportSize({ width: 1280, height: 600 });
  await action.click(); await detail.waitFor();
  await detail.getByText("書誌情報・取得元・引用元", { exact: true }).click();
  await detail.evaluate(el => { el.scrollTop = el.scrollHeight; });
  assert.ok(await detail.evaluate(el => el.scrollTop) > 0);
  await page.locator("article").getByRole("button", { name: "External research paper 0", exact: true }).click();
  assert.equal(await detail.evaluate(el => el.scrollTop), 0);
  assert.equal(await detail.evaluate(el => el === document.activeElement), true);
  await detail.press("Escape"); await detail.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await fs.mkdir(path.resolve(frontend, "../tmp"), { recursive: true });
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "150%"; });
    const last = page.locator("article").getByRole("button", { name: "External research paper 74", exact: true });
    await last.scrollIntoViewIfNeeded();
    const list = page.getByLabel("文献一覧", { exact: true });
    const position = await list.evaluate(el => el.scrollTop);
    await last.focus(); await page.keyboard.press("Enter"); await detail.waitFor();
    assert.equal(await list.isVisible(), width >= 900);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: path.resolve(frontend, `../tmp/paper-map-${width}.png`) });
    await page.getByRole("button", { name: "パネルを開き直す", exact: true }).click(); await detail.waitFor();
    await detail.getByRole("button", { name: "一覧に戻る", exact: true }).click();
    assert.equal(await list.evaluate(el => el.scrollTop), position);
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-current") === "true");
    assert.equal(await last.evaluate(el => el === document.activeElement), true);
  }
  assert.deepEqual(errors, []);
});

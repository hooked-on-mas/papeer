/** Measure layout on an exported real map with the browser's performance clock. No live API calls. */
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import type { MapResult } from "../src/features/references/mapGraph.ts";

const [mapFile, reportFile] = process.argv.slice(2);
if (!mapFile || !reportFile) throw new Error("Usage: node e2e/profilePaperMap.ts map.json report.json");
const map: MapResult = JSON.parse(await fs.readFile(mapFile, "utf8"));
map.nodes = map.nodes.map(n => ({ ...n, external_citations: n.external_citations ?? null, external_id: n.external_id ?? "" }));
map.stale = false;
const frontend = path.resolve(import.meta.dirname, "..");
const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
  cacheDir: path.resolve(frontend, "../tmp/vite-map-timing"), server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
await server.listen();
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(20_000); page.setDefaultNavigationTimeout(60_000);
  await page.routeWebSocket(/\/ws\/events/, () => {});
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (route.request().method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (route.request().method() !== "GET") throw new Error("The profile must not start research jobs");
    const url = new URL(route.request().url());
    const json = url.pathname === "/api/citations" ? { nodes: [], edges: [], references: [], warnings: [] }
      : url.pathname.endsWith("/discovery") ? map
      : url.pathname.endsWith("/discovery/groups") ? { origin: map.origin, groups: [], connection: "codex:test" }
      : url.pathname === "/api/research-capabilities" ? { paper_discovery_enabled: false, reference_research_enabled: false, reference_lookup: true }
      : url.pathname === "/api/jobs" || url.pathname.endsWith("/reference-research") || url.pathname === "/api/collections" ? [] : {};
    await route.fulfill({ json, headers });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/discovery.html`);
  const canvas = page.getByLabel("論文の関係図");
  await canvas.locator(`[data-node-id="${map.origin}"]`).waitFor();
  const timings = page.getByLabel("論文マップの構築時間");
  await timings.locator("summary").click();
  const row = timings.locator("[data-layout-ms]");
  await row.waitFor();
  const initialMs = Number(await row.getAttribute("data-layout-ms"));
  const initialCount = Number(await row.getAttribute("data-layout-count"));
  const samples: number[] = [];
  let previous = initialMs;
  for (let i = 0; i < 5; i++) {
    await page.getByRole("button", { name: "全体を表示", exact: true }).click();
    await page.waitForFunction(count => document.querySelector("[data-layout-count]")?.getAttribute("data-layout-count") === String(count), initialCount + i + 1);
    const total = Number(await row.getAttribute("data-layout-ms"));
    samples.push(total - previous); previous = total;
  }
  const result = { browser: "Edge headless", viewport: "1280x900", map_nodes: map.nodes.length, map_edges: map.edges.length,
    displayed_nodes: await canvas.locator("[data-node-id]").count(), displayed_edges: await canvas.locator("line[data-kind]").count(),
    groups: await canvas.locator("[data-map-group]").count(),
    initial_layout_ms: initialMs, initial_layout_count: initialCount, relayout_samples_ms: samples,
    scope: "mapPositions computation only; excludes API, HTML rendering and development server startup" };
  const report = JSON.parse(await fs.readFile(reportFile, "utf8"));
  report.frontend_layout = result;
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await timings.locator("summary").click();
  for (const width of [1280, 900, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByLabel("図の表示件数").selectOption("auto");
    await page.getByRole("button", { name: "全体を表示", exact: true }).click();
    await page.screenshot({ path: path.join(path.dirname(reportFile), `grouped-map-${width}.png`) });
    const collisions = await canvas.locator("[data-node-circle]").evaluateAll(circles => {
      const boxes = circles.map(circle => circle.getBoundingClientRect());
      let overlaps = 0, gap = Infinity;
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const distance = Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y + a.height / 2 - b.y - b.height / 2) - (a.width + b.width) / 2;
        if (distance < -.5) overlaps++;
        gap = Math.min(gap, distance);
      }
      return { overlaps, minimum_screen_gap: gap };
    });
    console.log(JSON.stringify({ width, displayed: await canvas.locator("[data-node-id]").count(), ...collisions }));
  }
} finally { await browser.close(); await server.close(); }

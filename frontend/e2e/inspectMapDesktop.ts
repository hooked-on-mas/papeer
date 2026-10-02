/** Render a saved real map and cached descriptions without any external requests or model calls. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import { chromium, type WebSocketRoute } from "playwright-core";
import type { MapResult } from "../src/features/references/mapGraph.ts";

const [mapFile, groupsFile, outputDirectory] = process.argv.slice(2);
if (!mapFile || !groupsFile || !outputDirectory) throw new Error("Usage: node e2e/inspectMapDesktop.ts map.json groups.json output-directory");
const map: MapResult = JSON.parse(await fs.readFile(mapFile, "utf8")); map.stale = false;
const explanations = JSON.parse(await fs.readFile(groupsFile, "utf8"));
const frontend = path.resolve(import.meta.dirname, "..");
await fs.mkdir(outputDirectory, { recursive: true });
const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
  cacheDir: path.resolve(frontend, "../tmp/vite-desktop-map-inspection"), server: { host: "127.0.0.1", port: 0, hmr: false } });
await server.listen();
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage(); page.setDefaultTimeout(20_000); page.setDefaultNavigationTimeout(60_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let socket: WebSocketRoute | undefined;
  let current = map;
  const progressive = !!process.env.PAPEER_MAP_PROGRESSIVE;
  await page.routeWebSocket(/\/ws\/events/, connection => { socket = connection; });
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (route.request().method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    assert.equal(route.request().method(), "GET", "inspection must never start live work");
    const pathname = new URL(route.request().url()).pathname;
    const json = pathname === "/api/citations" ? { nodes: [], edges: [], references: [], warnings: [] }
      : pathname.endsWith("/discovery/groups") ? explanations : pathname.endsWith("/discovery") ? current
      : pathname === "/api/research-capabilities" ? { paper_discovery_enabled: false, reference_research_enabled: false, reference_lookup: true }
      : pathname.endsWith("/reference-research") || pathname === "/api/jobs" || pathname === "/api/collections" ? []
      : { id: map.origin, title: map.nodes.find(n => n.id === map.origin)?.title, collection_name: "", has_article: false };
    await route.fulfill({ json, headers });
  });
  const reports: unknown[] = [];
  for (const [width, height, font] of [[1280, 900, 100], [1600, 1000, 100], [1280, 1000, 150]]) {
    current = progressive ? { ...map, nodes: map.nodes.map(n => ({ ...n, external_citations: null, local_citations: 0 })),
      edges: map.edges.filter(e => e.source === map.origin || e.target === map.origin) } : map;
    await page.setViewportSize({ width, height });
    await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/discovery.html?paper=${map.origin}`);
    await page.evaluate(font => { document.documentElement.style.fontSize = `${font}%`; }, font);
    if (process.env.PAPEER_MAP_LIMIT) await page.getByLabel("図の表示件数").selectOption(process.env.PAPEER_MAP_LIMIT);
    const canvas = page.getByLabel("論文の関係図"); await canvas.locator("[data-node-id]").first().waitFor();
    if (progressive) {
      await page.waitForFunction(() => document.querySelectorAll("[data-node-id]").length >= 20);
      const before = await canvas.locator("[data-node-id]").evaluateAll(elements => elements.map(el => el.getAttribute("transform")));
      current = map;
      const updated = page.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname.endsWith("/discovery"));
      socket!.send(JSON.stringify({ type: "job.finished", job_id: "inspection-progress", kind: "paper-discovery", paper_id: map.origin,
        status: "succeeded", running: false, cancelled: false, message: "", error: null, result: map }));
      await updated;
      await canvas.locator("[data-map-group]").first().waitFor();
      await page.waitForFunction(before => JSON.stringify([...document.querySelectorAll("[data-node-id]")].map(el => el.getAttribute("transform"))) !== JSON.stringify(before), before);
    } else await page.getByRole("button", { name: "全体を表示", exact: true }).click();
    try { await canvas.locator(':scope[data-layout-ready="true"]').waitFor(); } catch (error) {
      await page.screenshot({ path: path.join(outputDirectory, `${width}-${font}-layout-failure.png`) });
      console.log(await canvas.evaluate(el => ({ camera: el.getAttribute("data-camera"), issues: el.getAttribute("data-layout-issues"),
        bounds: el.getBoundingClientRect().toJSON(), groups: [...el.querySelectorAll("[data-map-group] path")].map(p => p.getBoundingClientRect().toJSON()) })));
      throw error;
    }
    const stem = `${width}-${font}`;
    await page.screenshot({ path: path.join(outputDirectory, `${stem}-map.png`) });
    if (font === 100) await page.getByTestId("map-network").screenshot({ path: path.join(outputDirectory, `${stem}-network.png`) });
    const circles = await canvas.locator("[data-node-circle]").evaluateAll(elements => elements.map(el => {
      const r = el.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, radius: r.width / 2 };
    }));
    for (let i = 0; i < circles.length; i++) for (let j = i + 1; j < circles.length; j++) {
      const a = circles[i], b = circles[j];
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.radius + b.radius + 1, `${stem}: node circles overlap (${i}, ${j})`);
    }
    const groupBounds = await canvas.locator("[data-map-group] path").evaluateAll(paths => paths.map(p => {
      const r = p.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
    }));
    const overlaps: number[][] = [];
    for (let i = 0; i < groupBounds.length; i++) for (let j = i + 1; j < groupBounds.length; j++) {
      const a = groupBounds[i], b = groupBounds[j];
      if (a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y) overlaps.push([i, j]);
    }
    assert.deepEqual(overlaps, [], `${stem}: community regions must not overlap`);
    const names = await canvas.locator("[data-group-name]").evaluateAll(elements => elements.map(el => {
      const label = el.querySelector("text")!, r = label.getBoundingClientRect();
      const outline = [...document.querySelectorAll<SVGGElement>("[data-map-group]")].find(g => g.dataset.mapGroup === el.getAttribute("data-group-name"))!.querySelector("path")!;
      const point = new DOMPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2).matrixTransform(outline.getScreenCTM()!.inverse());
      const overlapsNode = [...document.querySelectorAll("[data-node-circle]")].some(node => {
        const c = node.getBoundingClientRect(), x = (c.left + c.right) / 2, y = (c.top + c.bottom) / 2;
        return Math.hypot(x - Math.max(r.left, Math.min(r.right, x)), y - Math.max(r.top, Math.min(r.bottom, y))) < c.width / 2 - 1;
      });
      return { text: label.textContent!, inside: outline.isPointInFill(point), overlapsNode };
    }));
    assert.equal(names.length, groupBounds.length, "every community shows its name");
    for (const name of names) assert.ok(name.inside, `${stem}: group name must be inside its colored region: ${name.text}`);
    for (const name of names) assert.ok(!name.overlapsNode, `${stem}: group name must not cover a node: ${name.text}`);
    for (const name of await page.getByLabel("グループの一覧").locator("button").evaluateAll(buttons => buttons.map(b => b.getAttribute("title")!))) {
      assert.ok(names.some(n => n.text.replace(/\s/g, "").includes(name.replace(/\s/g, ""))), `full group name must remain readable: ${name}`);
    }
    const labels = await canvas.locator("[data-node-label], [data-group-label]").evaluateAll(elements => elements.map(el => {
      const r = el.getBoundingClientRect(); return { text: el.textContent, x: r.x, y: r.y, right: r.right, bottom: r.bottom };
    }));
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i], b = labels[j];
      assert.ok(a.x >= b.right || a.right <= b.x || a.y >= b.bottom || a.bottom <= b.y, `${stem}: labels overlap: ${a.text}, ${b.text}`);
    }
    const circle = canvas.locator(`[data-node-id]:not([data-node-id="${map.origin}"]) [data-node-circle]`).last();
    await circle.hover();
    const preview = page.getByLabel("論文の下見");
    const previewBox = (await preview.boundingBox())!, canvasBox = (await canvas.boundingBox())!;
    assert.ok(previewBox.y >= canvasBox.y + canvasBox.height, "preview must be outside the graph");
    assert.equal(await canvas.locator("title").count(), 0, "no second native tooltip");
    await page.screenshot({ path: path.join(outputDirectory, `${stem}-hover.png`) });
    if (font === 100) await page.getByTestId("map-network").screenshot({ path: path.join(outputDirectory, `${stem}-network-hover.png`) });
    await page.mouse.move(0, 0);
    const groups = page.getByLabel("論文のまとまり"); await groups.locator("summary").first().click();
    try { await page.waitForFunction(() => {
      const canvas = document.querySelector('[aria-label="論文の関係図"]')!.getBoundingClientRect();
      return [...document.querySelectorAll("[data-node-circle]")].every(node => {
        const r = node.getBoundingClientRect(); return r.top >= canvas.top && r.bottom <= canvas.bottom && r.left >= canvas.left && r.right <= canvas.right;
      });
    }); } catch (error) {
      await page.screenshot({ path: path.join(outputDirectory, `${stem}-failure.png`) });
      console.log(await canvas.evaluate(el => ({ canvas: el.getBoundingClientRect().toJSON(), camera: el.getAttribute("data-camera"),
        nodes: [...el.querySelectorAll("[data-node-circle]")].map(n => n.getBoundingClientRect().toJSON()) })));
      throw error;
    }
    if (font === 150) await page.getByLabel("論文マップ", { exact: true }).evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight; });
    await page.screenshot({ path: path.join(outputDirectory, `${stem}-explanations.png`) });
    reports.push({ width, height, font, displayed: await canvas.locator("[data-node-id]").count(), groups: groupBounds.length, group_overlaps: overlaps.length });
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(outputDirectory, "report.json"), JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports));
} finally { await browser.close(); await server.close(); }

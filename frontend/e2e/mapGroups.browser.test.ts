/** Fixed model responses: graph remains usable before, after and without group explanations. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium, type WebSocketRoute } from "playwright-core";
import type { CitationGraph } from "../src/features/references/graph.ts";
import { localMap } from "../src/features/references/mapGraph.ts";
import type { MapGroupResult } from "../src/api/jobTypes.ts";

test("grouping waits for discovery, retains completed evidence during refresh, and uses partial results after failure", { timeout: 120_000 }, async t => {
  const root = "a".repeat(32), ids = ["a", "b", "c", "d", "e", "f"].map(id => `ref:${id}`);
  const graph: CitationGraph = {
    nodes: [{ id: root, paper_id: root, title: "Current paper", year: "2024", url: "" },
      ...ids.map((id, i) => ({ id, paper_id: null, title: `Research ${i + 1}`, year: "2020", url: "" }))],
    edges: [...ids.map(target => ({ source: root, target })),
      { source: ids[0], target: ids[1] }, { source: ids[1], target: ids[2] }, { source: ids[0], target: ids[2] },
      { source: ids[3], target: ids[4] }, { source: ids[4], target: ids[5] }, { source: ids[3], target: ids[5] }],
    references: [], warnings: [],
  };
  let current = localMap(graph, root);
  let saved: MapGroupResult = { origin: root, groups: [], connection: "claude-code:information-model" };
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    cacheDir: path.resolve(frontend, "../tmp/vite-settled-groups-browser"), server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(20_000); page.setDefaultNavigationTimeout(60_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\/events/, s => { socket = s; });
  let discoveryPosts = 0;
  const groupPosts: { groups: string[][]; force: boolean }[] = [];
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname.endsWith("/cancel")) { await route.fulfill({ json: {}, headers }); return; }
    if (request.method() === "POST") {
      const job_id = url.pathname.endsWith("/discovery/groups")
        ? (groupPosts.push(request.postDataJSON()), `groups-${groupPosts.length}`) : `discovery-${++discoveryPosts}`;
      await route.fulfill({ json: { job_id }, headers }); return;
    }
    const json = url.pathname.endsWith("/discovery/groups") ? saved : url.pathname.endsWith("/discovery") ? current
      : url.pathname === "/api/citations" ? graph
      : url.pathname === "/api/research-capabilities" ? { paper_discovery_enabled: true, reference_research_enabled: true, reference_lookup: true }
      : url.pathname === "/api/jobs" || url.pathname.endsWith("/reference-research") || url.pathname === "/api/collections" ? [] : {};
    await route.fulfill({ json, headers });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/discovery.html`);
  const canvas = page.getByLabel("論文の関係図"); await canvas.waitFor();
  await page.getByText("外部情報を取得中 · 保存済みの結果を表示", { exact: true }).waitFor();
  // Wait for a progress poll, longer than the AI debounce, while usable citation data is already visible.
  await page.waitForResponse(r => r.request().method() === "GET" && r.url().endsWith(`/discovery?origin=${root}`));
  assert.equal(await canvas.locator("[data-node-id]").count(), 7);
  assert.equal(await canvas.locator("[data-map-group]").count(), 0);
  assert.equal(groupPosts.length, 0);
  await page.getByText("グループ化は情報取得後に行います", { exact: true }).waitFor();
  current = { ...current, stale: false, checked_at: new Date().toISOString() };
  const firstExplanation = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/discovery/groups"));
  socket!.send(JSON.stringify({ type: "job.finished", job_id: "discovery-1", paper_id: root, kind: "paper-discovery",
    status: "succeeded", running: false, cancelled: false, message: "", error: null, result: current }));
  await firstExplanation;
  assert.equal(groupPosts[0].groups.length, 2);
  assert.equal(await canvas.locator("[data-map-group]").count(), 2);
  saved = { ...saved, groups: groupPosts[0].groups.map((members, i) => ({ key: `key-${i}`, members, name: `Completed ${i}`,
    description: "Completed evidence", evidence: [members[0]], provider: "claude-code", model: "information-model",
    created_at: new Date().toISOString(), elapsed_ms: 10, stale: false })) };
  socket!.send(JSON.stringify({ type: "job.finished", job_id: "groups-1", paper_id: root, kind: "paper-map-groups",
    status: "succeeded", running: false, cancelled: false, message: "", error: null, result: saved }));
  await page.getByLabel("グループの一覧").getByRole("button", { name: /Completed 0/ }).waitFor();
  const refresh = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/discovery"));
  await page.getByRole("button", { name: "再取得", exact: true }).click(); await refresh;
  // This unfinished graph would remove the second community if it were used for grouping.
  current = { ...current, stale: true, checked_at: "", edges: [
    ...ids.map(target => ({ source: root, target, kind: "citation" as const, provenance: "library" })),
    ...ids.slice(0, 3).flatMap((source, i) => ids.slice(i + 1, 3).map(target => ({ source, target, kind: "citation" as const, provenance: "library" }))),
  ] };
  await page.waitForResponse(r => r.request().method() === "GET" && r.url().endsWith(`/discovery?origin=${root}`));
  assert.equal(await canvas.locator("[data-map-group]").count(), 2);
  assert.equal(groupPosts.length, 1);
  socket!.send(JSON.stringify({ type: "job.finished", job_id: "discovery-2", paper_id: root, kind: "paper-discovery",
    status: "failed", running: false, cancelled: false, message: "", error: "取得制限", result: null }));
  await page.getByLabel("論文のまとまり").locator("summary").filter({ hasText: "1グループ" }).waitFor();
  assert.equal(await canvas.locator("[data-map-group]").count(), 1);
  assert.equal(groupPosts.length, 1); // The remaining group's unchanged explanation is reusable.
  assert.equal(await page.getByText("グループ化は情報取得後に行います", { exact: true }).count(), 0);
  assert.equal(discoveryPosts, 2);
  assert.deepEqual(errors, []);
});

test("citation communities explain with the information model, preserve camera, reuse cache and cancel", { timeout: 120_000 }, async t => {
  const root = "a".repeat(32);
  const ids = ["a", "b", "c", "d", "e", "f"].map(id => "ref:" + id);
  const graph: CitationGraph = { nodes: [{ id: root, paper_id: root, title: "Current paper", year: "2024", url: "" },
    ...ids.map((id, i) => ({ id, paper_id: null, title: `Research ${i + 1}`, year: "2020", url: "" }))],
    edges: [...ids.map(target => ({ source: root, target })), { source: ids[0], target: ids[1] }, { source: ids[1], target: ids[2] }, { source: ids[0], target: ids[2] },
      { source: ids[3], target: ids[4] }, { source: ids[4], target: ids[5] }, { source: ids[3], target: ids[5] }], references: [], warnings: [] };
  const map = localMap(graph, root); map.stale = false;
  map.nodes.forEach((n, i) => { n.external_citations = i === 3 ? 10000 : i === 2 ? 0 : null; n.local_citations = 80000; });
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error", cacheDir: path.resolve(frontend, "../tmp/vite-map-groups-browser"), server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(20_000); page.setDefaultNavigationTimeout(60_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\/events/, s => { socket = s; });
  let saved: MapGroupResult = { origin: root, groups: [], connection: "claude-code:information-model" };
  const posts: { groups: string[][]; force: boolean }[] = [], cancels: string[] = [];
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname.endsWith("/cancel")) { cancels.push(url.pathname); await route.fulfill({ json: {}, headers }); return; }
    if (request.method() === "POST") { assert.ok(url.pathname.endsWith("/discovery/groups")); posts.push(request.postDataJSON()); await route.fulfill({ json: { job_id: `groups-${posts.length}` }, headers }); return; }
    const json = url.pathname.endsWith("/discovery/groups") ? saved : url.pathname.endsWith("/discovery") ? map
      : url.pathname === "/api/citations" ? graph
      : url.pathname === "/api/research-capabilities" ? { paper_discovery_enabled: false, reference_research_enabled: true, reference_lookup: true }
      : url.pathname === "/api/jobs" || url.pathname.endsWith("/reference-research") || url.pathname === "/api/collections" ? [] : {};
    await route.fulfill({ json, headers });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/discovery.html`);
  const canvas = page.getByLabel("論文の関係図"); await canvas.waitFor();
  const groups = page.getByLabel("論文のまとまり"); await groups.locator("summary").first().click();
  await page.getByText("情報取得用のモデルで説明しています…", { exact: true }).waitFor();
  assert.equal(posts.length, 1); assert.equal(posts[0].groups.length, 2);
  assert.equal(await groups.getByText(/起点との確認済み関係: 直接引用 3論文/).count(), 2);
  const high = Number(await canvas.locator('[data-citations="10000"]').getAttribute("r"));
  const zero = Number(await canvas.locator('[data-citations="0"]').getAttribute("r"));
  const unknown = Number(await canvas.locator(`[data-node-id]:not([data-node-id="${root}"]) [data-node-circle][data-citations="unknown"]`).first().getAttribute("r"));
  assert.ok(high > zero); assert.equal(unknown, zero);
  await canvas.focus(); await page.keyboard.press("ArrowRight");
  const camera = await canvas.getAttribute("data-camera");
  const positions = await canvas.locator("[data-node-id]").evaluateAll(nodes => nodes.map(n => n.getAttribute("transform")));
  const names = ["ロボットの経路計画", "複数機体の協調制御"];
  saved = { ...saved, groups: posts[0].groups.map((members, i) => ({ key: `key-${i}`, members, name: names[i], description: `所属論文のタイトルから${names[i]}を扱うグループと推測できます。`, evidence: [members[0]], provider: "claude-code", model: "information-model", created_at: new Date().toISOString(), elapsed_ms: 1234, stale: false })) };
  socket!.send(JSON.stringify({ type: "job.finished", job_id: "groups-1", paper_id: root, kind: "paper-map-groups", status: "succeeded", running: false, cancelled: false, message: "", error: null, result: saved }));
  await groups.getByRole("button", { name: `${names[0]}を拡大（3論文）` }).waitFor();
  for (const name of names) {
    assert.ok((await canvas.locator("[data-group-label]").allTextContents()).some(text => text.replace(/\s/g, "").includes(name)), "the full group name is visible inside the diagram");
  }
  assert.equal(await canvas.getAttribute("data-camera"), camera);
  assert.deepEqual(await canvas.locator("[data-node-id]").evaluateAll(nodes => nodes.map(n => n.getAttribute("transform"))), positions);
  assert.equal(posts.length, 1);
  await groups.getByRole("button", { name: `${names[0]}を拡大（3論文）` }).focus(); await page.keyboard.press("Enter");
  assert.notEqual(await canvas.getAttribute("data-camera"), camera); assert.equal(posts.length, 1);
  await groups.getByText("説明の根拠 · AI生成", { exact: true }).first().click();
  await groups.getByText(/情報取得用: claude-code \/ information-model/).first().waitFor();
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.evaluate(() => { document.documentElement.style.fontSize = "150%"; document.documentElement.dataset.theme = "dark"; });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await groups.getByRole("button", { name: `${names[0]}を拡大（3論文）` }).waitFor();
  await page.screenshot({ path: path.resolve(frontend, "../tmp/map-groups-explanations-dark-desktop.png") });
  await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; document.documentElement.dataset.theme = "light"; });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByRole("button", { name: "タブを切り替える" }).click();
  await page.getByRole("button", { name: "タブを切り替える" }).click();
  await canvas.waitFor(); await groups.locator("summary").first().click();
  await groups.getByRole("button", { name: `${names[0]}を拡大（3論文）` }).waitFor();
  const request = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/groups"));
  await groups.getByRole("button", { name: "説明を更新", exact: true }).click(); await request;
  assert.equal(posts.length, 2); assert.equal(posts[1].force, true);
  socket!.send(JSON.stringify({ type: "job.finished", job_id: "groups-2", paper_id: root, kind: "paper-map-groups", status: "failed", running: false, cancelled: false, message: "", error: "モデルに接続できません", result: null }));
  await groups.getByText("モデルに接続できません", { exact: true }).waitFor();
  assert.ok(await groups.getByRole("button", { name: `${names[0]}を拡大（3論文）` }).isVisible());
  const retry = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/groups"));
  await groups.getByRole("button", { name: "説明を再試行", exact: true }).click(); await retry;
  const cancelled = page.waitForResponse(r => r.url().endsWith("/cancel"));
  await page.getByRole("button", { name: "タブを切り替える" }).click(); await cancelled;
  assert.equal(cancels.length, 1);
  assert.deepEqual(errors, []);
});

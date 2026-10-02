import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { localMap } from "../src/features/references/mapGraph.ts";
import type { CitationGraph } from "../src/features/references/graph.ts";

test("Semantic Scholar counts and optional session key are shown and submitted", { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    cacheDir: path.resolve(frontend, "../tmp/vite-semantic-scholar"),
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const source = "a".repeat(32);
  const graph: CitationGraph = { nodes: [{ id: source, paper_id: source, title: "Current paper", year: "2024", url: "" }],
    edges: [], references: [], warnings: [] };
  const mapped = localMap(graph, source);
  mapped.stale = false;
  mapped.warnings = ["DOIのない参考文献の外部照合を20件で区切りました。",
    "Semantic Scholarの書誌情報が不十分な候補14件は、PDFの参考文献と照合できないため除外しました。"];
  mapped.nodes[0].external_id = "https://www.semanticscholar.org/paper/" + "b".repeat(40);
  mapped.nodes[0].external_citations = 42;
  let settings: Record<string, unknown> = { provider: "codex", model: "gpt-5.6-sol", reasoning_effort: "", timeout_seconds: 900,
    translation_concurrency: 0, paper_metadata_ai_enabled: false, paper_discovery_enabled: false,
    paper_metadata_provider: "", paper_metadata_model: "", provider_options: {}, api_key: "",
    semantic_scholar_api_key: "", unknown_keys: [] };
  const submitted: Record<string, unknown>[] = [];
  await page.routeWebSocket(/\/ws\/events/, () => {});
  await page.route(address => address.pathname.startsWith("/api/"), async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (request.method() === "PUT") {
      const body = request.postDataJSON(); submitted.push(body); settings = { ...settings, ...body };
      await route.fulfill({ json: { status: "saved" }, headers }); return;
    }
    const json = pathname === "/api/settings" ? settings : pathname === "/api/citations" ? graph
      : pathname.endsWith("/discovery") ? mapped
      : pathname === "/api/research-capabilities" ? { paper_discovery_enabled: false, reference_research_enabled: false, reference_lookup: true }
      : pathname === "/api/providers" ? [{ id: "codex", label: "Codex", description: "", kind: "cli", fields: [], needs_api_key: false, needs_login: false }]
      : pathname.endsWith("/models") ? [{ id: "gpt-5.6-sol", name: "Default" }]
      : pathname.endsWith("/efforts") || pathname === "/api/jobs" || pathname === "/api/collections" || pathname.endsWith("/reference-research") ? []
      : { id: source, has_article: false, collection_name: "" };
    await route.fulfill({ json, headers });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/research.html`);
  await page.getByLabel("関係図の凡例").getByText(/Semantic Scholar/).waitFor();
  await page.getByText("探索範囲・照合結果 · 詳細", { exact: true }).waitFor();
  assert.equal(await page.getByText("一部の情報を取得できませんでした · 詳細", { exact: true }).count(), 0);
  mapped.warnings.push("Semantic Scholarの参考文献を一部取得できませんでした：参考文献の一覧がサービスの応答にありません。保存済みの情報を使用します。");
  await page.getByRole("button", { name: "再取得", exact: true }).click();
  await page.getByText("一部の情報を取得できませんでした · 詳細", { exact: true }).waitFor();
  const failures = page.getByText("一部の情報を取得できませんでした · 詳細", { exact: true }).locator("..");
  assert.equal((await failures.textContent())!.includes("20件"), false);
  assert.equal((await failures.textContent())!.includes("14件"), false);
  await page.getByRole("button", { name: "設定タブ", exact: true }).click();
  const key = page.getByLabel("Semantic Scholar APIキー", { exact: true });
  await key.fill("browser-test-key");
  assert.equal(await key.getAttribute("type"), "password");
  const saved = page.waitForResponse(r => r.request().method() === "PUT" && r.url().endsWith("/api/settings"));
  await page.getByRole("button", { name: "設定を保存", exact: true }).click(); await saved;
  assert.equal(submitted[0].semantic_scholar_api_key, "browser-test-key");
  await page.getByRole("button", { name: "設定タブ", exact: true }).click();
  assert.equal(await key.inputValue(), "browser-test-key");
  assert.deepEqual(errors, []);
});

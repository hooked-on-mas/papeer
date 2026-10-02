/** Browser checks use a fake library, sources and event stream; no external AI or PDF requests. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium, type WebSocketRoute } from "playwright-core";
import type { CitationGraph } from "../src/features/references/graph.ts";
import type { ResearchRecord } from "../src/features/references/researchHooks.ts";

const source = "a".repeat(32), target = "b".repeat(32), key = "c".repeat(32);
const record: ResearchRecord = {
  key, raw: "A. Smith, Robust control of systems, 2020. doi:10.1234/abc.", title: "Robust control of systems",
  doi: "10.1234/abc", arxiv_id: "", summary: "抄録では不確実性を扱う制御法を検証しています [Web 1](https://publisher.example/paper)。",
  basis: "abstract", sources: [{ title: "出版社の抄録", url: "https://publisher.example/paper" }],
  pdfs: [{ title: "著者の公開PDF", version: "著者最終稿", url: "https://repository.example/paper.pdf" }],
  checked_at: "2026-10-02T00:00:00Z", paper_id: null, has_summary: false, needs_ocr: false, version: "", summary_error: "",
};
const graph: CitationGraph = {
  nodes: [{ id: source, paper_id: source, title: "Current research paper", year: "2024", url: "" },
          { id: "ref:unknown", paper_id: null, title: record.title, year: "2020", url: "https://doi.org/10.1234/abc" }],
  edges: [{ source, target: "ref:unknown" }], warnings: [],
  references: [{ id: `${source}:0`, source, target: "ref:unknown", research_key: key, raw: record.raw,
    label: "1", page: 8, title: record.title, doi: record.doi, arxiv_id: "", year: "2020", match: "unresolved", url: "https://doi.org/10.1234/abc" }],
};

test("research, PDF and summary import, return, comparison and chat Web switch work together", { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  const errors: string[] = []; page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  let events: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\/events/, socket => { events = socket; });
  let current: ResearchRecord | null = null;
  let currentGraph = structuredClone(graph);
  const messages: object[] = [];
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const paper = (id: string) => ({ id, title: id === source ? "Current research paper" : record.title,
    collection_name: "輪講", pages: 8, status: "imported", has_article: id === target && current?.has_summary, has_translation: false });
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (request.method() === "POST") {
      posts.push({ url: pathname, body: request.postDataJSON() });
      await route.fulfill({ json: { job_id: `job-${posts.length}` }, headers }); return;
    }
    let json: unknown;
    if (pathname === "/api/citations") json = currentGraph;
    else if (pathname === "/api/jobs") json = [];
    else if (pathname === "/api/research-capabilities") json = { web_search: true };
    else if (pathname === "/api/collections") json = ["輪講", "関連文献"];
    else if (pathname.endsWith("/reference-research")) json = current ? [current] : [];
    else if (pathname.endsWith("/messages")) json = messages;
    else if (pathname === "/api/papers") json = current?.paper_id ? [paper(source), paper(target)] : [paper(source)];
    else if (/^\/api\/papers\/[a-f0-9]{32}$/.test(pathname)) json = paper(pathname.split("/")[3]);
    else throw new Error(`Unexpected request: ${pathname}`);
    await route.fulfill({ json, headers });
  });
  const finished = (kind: string, result: unknown, count = posts.length) => {
    assert.ok(events);
    events.send(JSON.stringify({ type: "job.finished", job_id: `job-${count}`, paper_id: source, kind,
      status: "succeeded", running: false, cancelled: false, message: "", error: null, result }));
  };
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/research.html`);
  await page.locator("article").getByRole("button", { name: record.title, exact: true }).click();
  await page.getByRole("button", { name: "内容・入手先をWebで調べる", exact: true }).click();
  await page.getByRole("button", { name: "中止", exact: true }).waitFor();
  assert.equal(posts[0].body.reference_id, `${source}:0`);
  current = structuredClone(record);
  finished("reference-research", current);
  await page.getByText("抄録に基づく概要 · 本文は未確認", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("保存先").inputValue(), "輪講");
  await page.getByLabel("保存先").selectOption("関連文献");
  await page.getByLabel("取り込み後にサマリーを作成（AIの利用枠を使用）").check();
  await page.getByRole("button", { name: "PDF取り込み・サマリー作成", exact: true }).click();
  await page.getByRole("button", { name: "中止", exact: true }).waitFor();
  assert.equal(posts[1].body.create_summary, true);
  assert.equal(posts[1].body.pdf_index, 0);
  assert.equal(posts[1].body.collection, "関連文献");
  current = { ...current, paper_id: target, has_summary: true, version: "著者最終稿" };
  currentGraph = { ...graph, nodes: [graph.nodes[0], { ...graph.nodes[1], id: target, paper_id: target }],
    references: [{ ...graph.references[0], target, match: "manual" }], edges: [{ source, target }] };
  finished("reference-import", { record: current, added: true });
  await page.getByRole("button", { name: "サマリーを見る", exact: true }).waitFor();
  assert.equal(await page.getByTestId("navigation").textContent(), `${source}:references`);
  await fs.mkdir(path.resolve(frontend, "../tmp"), { recursive: true });
  await page.screenshot({ path: path.resolve(frontend, "../tmp/reference-research.png") });
  await page.getByRole("button", { name: "サマリーを見る", exact: true }).click();
  await page.getByText("サマリー本文", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("navigation").textContent(), `${target}:summary`);
  await page.getByRole("button", { name: "元の論文の参考文献へ戻る", exact: true }).click();
  await page.getByRole("button", { name: "サマリーを見る", exact: true }).waitFor();
  await page.getByRole("button", { name: "元の論文と比較する", exact: true }).click();
  const input = page.getByRole("textbox").first();
  await input.waitFor();
  await page.getByRole("switch", { name: "Web検索", exact: true }).waitFor();
  assert.equal(await page.getByLabel("参照範囲").inputValue(), "selected");
  assert.equal(await page.getByRole("switch", { name: "Web検索" }).getAttribute("aria-checked"), "false");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("textarea")?.disabled === true);
  assert.equal(posts[2].body.web_search, false);
  assert.deepEqual(posts[2].body.research_keys, [key]);
  assert.deepEqual(posts[2].body.paper_ids, [source, target]);
  const metadata = { web_search: false, sources: [], records: [current], attached_keys: [key] };
  messages.push({ role: "user", content: "比較して", research: metadata }, { role: "assistant", content: "本文と抄録を比較しました。", research: metadata });
  finished("ask", { answer: "本文と抄録を比較しました。", usage: null });
  await page.getByText("回答 · 論文＋添付資料", { exact: true }).waitFor();
  await page.getByRole("switch", { name: "Web検索" }).click();
  await input.fill("最新の関連文献を調べて");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("textarea")?.disabled === true);
  assert.equal(posts[3].body.web_search, true);
  const webMetadata = { web_search: true, sources: record.sources, records: [current], attached_keys: [] };
  messages.push({ role: "user", content: "Webで調べて", research: webMetadata },
    { role: "assistant", content: "関連文献 [Web 1](https://publisher.example/paper)。", research: webMetadata });
  finished("ask", { answer: "関連文献", usage: null });
  await page.getByText("回答 · Web検索あり", { exact: true }).waitFor();
  await page.getByRole("switch", { name: "Web検索" }).click();
  assert.equal(await page.getByText("回答 · Web検索あり", { exact: true }).count(), 1);
  await page.getByText(`Webの出典 · ${record.sources.length}件`, { exact: true }).click();
  await page.screenshot({ path: path.resolve(frontend, "../tmp/chat-web-search.png") });
  await page.setViewportSize({ width: 640, height: 800 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.deepEqual(errors, []);
});

test("automatic research fills five slots, refills on completion, cancels all on OFF and retries multiple failures", { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.setDefaultTimeout(15_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let events: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\/events/, socket => { events = socket; });
  const keys = [key, ...Array.from({ length: 7 }, (_, i) => String(i + 1).repeat(32))];
  const records = [structuredClone(record)];
  const network = structuredClone(graph);
  network.nodes = [graph.nodes[0], ...keys.map((_, i) => ({ ...graph.nodes[1], id: `ref:${i}`, title: `Reference ${i}` }))];
  network.references = keys.map((item, i) => ({ ...graph.references[0], id: `${source}:${i}`, target: `ref:${i}`, research_key: item, title: `Reference ${i}` }));
  network.references.push({ ...network.references[1], id: `${source}:8` });
  network.edges = [...new Set(network.references.map(ref => ref.target))].map(target => ({ source, target }));
  const posts: { id: string; reference: string }[] = [];
  const cancelled: string[] = [];
  const postWaiters: (() => void)[] = [], cancelWaiters: (() => void)[] = [];
  const waitForPosts = (count: number) => new Promise<void>(resolve => {
    const check = () => { if (posts.length >= count) resolve(); };
    postWaiters.push(check); check();
  });
  const waitForCancels = (count: number) => new Promise<void>(resolve => {
    const check = () => { if (cancelled.length >= count) resolve(); };
    cancelWaiters.push(check); check();
  });
  let firstStarted!: () => void, releaseFirst!: () => void;
  const firstRequest = new Promise<void>(resolve => { firstStarted = resolve; });
  const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
  t.after(() => releaseFirst());
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (pathname.endsWith("/cancel")) {
      cancelled.push(pathname.split("/")[3]); cancelWaiters.forEach(check => check());
      await route.fulfill({ json: {}, headers }); return;
    }
    if (request.method() === "POST") {
      assert.equal(pathname, `/api/papers/${source}/reference-research`);
      const id = `auto-${posts.length + 1}`;
      posts.push({ id, reference: request.postDataJSON().reference_id });
      postWaiters.forEach(check => check());
      if (posts.length === 1) { firstStarted(); await firstResponse; }
      await route.fulfill({ json: { job_id: id }, headers }); return;
    }
    const json = pathname === "/api/citations" ? network : pathname === "/api/research-capabilities" ? { web_search: true }
      : pathname.endsWith("/reference-research") ? records : pathname === "/api/jobs" || pathname === "/api/collections" || pathname.endsWith("/messages") ? []
      : pathname === "/api/papers" ? [] : { id: source, collection_name: "", has_article: false };
    await route.fulfill({ json, headers });
  });
  const url = `${server.resolvedUrls!.local[0]}e2e/fixtures/research.html`;
  await page.goto(url);
  const checkbox = page.getByRole("checkbox", { name: "AIで情報収集", exact: true });
  await checkbox.waitFor();
  assert.equal(await checkbox.isChecked(), false);
  await page.locator("article").first().waitFor();
  assert.equal(posts.length, 0);
  const finished = (index: number, status: "succeeded" | "cancelled" | "failed") => {
    assert.ok(events);
    const ref = network.references.find(ref => ref.id === posts[index].reference)!;
    const result = status === "succeeded" ? { ...record, key: ref.research_key, title: ref.title } : null;
    if (result) records.push(result);
    events.send(JSON.stringify({ type: "job.finished", job_id: posts[index].id, paper_id: source, kind: "reference-research",
      status, running: false, cancelled: status === "cancelled", message: "", error: status === "failed" ? "接続エラー" : null, result }));
  };
  await checkbox.check(); await firstRequest; await waitForPosts(5);
  await page.getByText("5件を同時に収集中", { exact: true }).waitFor();
  assert.equal(posts.length, 5);
  // The duplicate of reference 1 has the same research key; either row identifies the same work.
  assert.ok([`${source}:1`, `${source}:8`].includes(posts[0].reference));
  assert.equal(new Set(posts.map(post => network.references.find(ref => ref.id === post.reference)!.research_key)).size, 5);
  await page.getByRole("button", { name: "チャットタブ", exact: true }).click();
  await page.getByRole("button", { name: "参考文献タブ", exact: true }).click();
  await page.getByText("取得済み 1 / 8", { exact: true }).waitFor();
  assert.equal(posts.length, 5);
  finished(2, "succeeded"); await waitForPosts(6);
  await page.getByText("取得済み 2 / 8", { exact: true }).waitFor();
  assert.equal(posts.length, 6);
  // OFF must also cancel when the start response has not arrived yet.
  await checkbox.uncheck(); releaseFirst(); await waitForCancels(5);
  assert.deepEqual(new Set(cancelled), new Set([0, 1, 3, 4, 5].map(i => posts[i].id)));
  for (const i of [0, 1, 3, 4, 5]) finished(i, "cancelled");
  await page.getByText("収集を中止しています…", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(posts.length, 6);
  await checkbox.check(); await waitForPosts(11);
  await page.getByText("5件を同時に収集中", { exact: true }).waitFor();
  assert.equal(posts.length, 11);
  finished(6, "failed"); finished(7, "failed");
  for (const i of [10, 8, 9]) finished(i, "succeeded");
  await page.getByRole("button", { name: "収集を再開", exact: true }).waitFor();
  await page.getByText("取得済み 5 / 8", { exact: true }).waitFor();
  assert.equal(posts.length, 11);
  await page.getByRole("button", { name: "収集を再開", exact: true }).click(); await waitForPosts(14);
  assert.deepEqual(new Set(posts.slice(11).map(post => post.reference)), new Set([posts[6].reference, posts[7].reference, `${source}:7`]));
  for (const i of [13, 11, 12]) finished(i, "succeeded");
  await page.getByText("この論文の参考文献は取得済みです。", { exact: true }).waitFor();
  assert.equal(posts.length, 14);
  await page.reload();
  await page.getByText("この論文の参考文献は取得済みです。", { exact: true }).waitFor();
  assert.equal(await checkbox.isChecked(), true);
  assert.equal(posts.length, 14);
  await fs.mkdir(path.resolve(frontend, "../tmp"), { recursive: true });
  await page.screenshot({ path: path.resolve(frontend, "../tmp/reference-auto-research.png") });
  assert.deepEqual(errors, []);
});

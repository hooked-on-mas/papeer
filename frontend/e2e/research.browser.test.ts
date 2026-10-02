/** Browser checks use a fake library, sources and event stream; no external AI or PDF requests. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium, type WebSocketRoute } from "playwright-core";
import { localMap } from "../src/features/references/mapGraph.ts";
import type { CitationGraph } from "../src/features/references/graph.ts";
import type { ResearchRecord } from "../src/features/references/researchHooks.ts";

const source = "a".repeat(32), target = "b".repeat(32), key = "c".repeat(32);
const record: ResearchRecord = {
  key, raw: "A. Smith, Robust control of systems, 2020. doi:10.1234/abc.", title: "Robust control of systems",
  first_author: "A. Smith", publication_year: "2020", venue: "Control Journal", abstract: "Verified abstract. " + "The method is evaluated with robust benchmarks. ".repeat(100) + "END OF ABSTRACT", diagnostics: ["Semantic Scholarの情報を取得できませんでした：HTTP 429"], lookup_version: 1,
  doi: "10.1234/abc", arxiv_id: "", summary: "抄録では不確実性を扱う制御法を検証しています [Web 1](https://publisher.example/paper)。",
  basis: "abstract", sources: [{ title: "出版社の抄録", url: "https://publisher.example/paper" }],
  pdfs: [{ title: "著者の公開PDF", version: "著者最終稿", url: "https://repository.example/paper.pdf" }],
  checked_at: "2026-10-02T00:00:00Z", paper_id: null, has_summary: false, needs_ocr: false, version: "", summary_error: "", last_failure: null,
};
const frozenMap = (graph: CitationGraph) => ({ ...localMap(graph, source), stale: false });
const graph: CitationGraph = {
  nodes: [{ id: source, paper_id: source, title: "Current research paper", year: "2024", url: "" },
          { id: "ref:unknown", paper_id: null, title: record.title, year: "2020", url: "https://doi.org/10.1234/abc" }],
  edges: [{ source, target: "ref:unknown" }], warnings: [],
  references: [{ id: `${source}:0`, source, target: "ref:unknown", research_key: key, raw: record.raw,
    label: "1", page: 8, title: record.title, doi: record.doi, arxiv_id: "", year: "2020", match: "unresolved", url: "https://doi.org/10.1234/abc" }],
};

test("identity rejection persists, continues other references and clears after an explicit retry", { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    cacheDir: path.resolve(frontend, "../tmp/vite-research-identity"),
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let events: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\/events/, socket => { events = socket; });
  const network = structuredClone(graph);
  network.references = Array.from({ length: 6 }, (_, i) => ({ ...graph.references[0],
    id: `${source}:${i}`, target: `ref:${i}`, research_key: String(i + 1).repeat(32), title: `Reference ${i}` }));
  network.nodes = [graph.nodes[0], ...network.references.map(ref => ({ ...graph.nodes[1], id: ref.target, title: ref.title }))];
  network.edges = network.references.map(ref => ({ source, target: ref.target }));
  const records: ResearchRecord[] = [];
  const posts: { id: string; reference: string }[] = [];
  const waiters: (() => void)[] = [];
  const waitForPosts = (count: number) => new Promise<void>(resolve => {
    const check = () => { if (posts.length >= count) resolve(); }; waiters.push(check); check();
  });
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (request.method() === "POST") {
      assert.equal(pathname, `/api/papers/${source}/reference-research`);
      const id = `identity-${posts.length + 1}`;
      posts.push({ id, reference: request.postDataJSON().reference_id }); waiters.forEach(check => check());
      await route.fulfill({ json: { job_id: id }, headers }); return;
    }
    const json = pathname === "/api/citations" ? network : pathname.endsWith("/discovery") ? frozenMap(network)
      : pathname.endsWith("/reference-research") ? records
      : pathname === "/api/research-capabilities" ? { reference_research_enabled: true, reference_lookup: true }
      : pathname === "/api/jobs" || pathname === "/api/collections" || pathname.endsWith("/messages") ? []
      : { id: source, title: "Current research paper", collection_name: "", has_article: false };
    await route.fulfill({ json, headers });
  });
  const finish = (index: number, rejected = false) => {
    assert.ok(events);
    const ref = network.references.find(ref => ref.id === posts[index].reference)!;
    const result: ResearchRecord = { ...record, key: ref.research_key, title: ref.title };
    if (rejected) Object.assign(result, { summary: "", abstract: "", sources: [], pdfs: [], basis: "unresolved", lookup_version: 0,
      last_failure: { kind: "identity_mismatch", title: ref.title, returned_title: "Another publication",
        expected_doi: record.doi, returned_doi: "10.1234/another", expected_arxiv_id: "", returned_arxiv_id: "",
        checked_at: record.checked_at, sources: [{ title: "Rejected result source", url: "https://rejected.example/article" }],
        message: `参考文献：${ref.title}\n検索結果が別の文献の識別子を示しています。\n元：${record.doi}\n結果：10.1234/another` } });
    const previous = records.findIndex(item => item.key === result.key);
    if (previous >= 0) records.splice(previous, 1, result); else records.push(result);
    events.send(JSON.stringify({ type: "job.finished", job_id: posts[index].id, paper_id: source, kind: "reference-research",
      status: rejected ? "failed" : "succeeded", running: false, cancelled: false, message: "",
      error: result.last_failure?.message ?? null, result: rejected ? null : result }));
  };
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/research.html`);
  await waitForPosts(5);
  finish(0, true); await waitForPosts(6);
  for (let i = 1; i < 6; i++) finish(i);
  await page.getByText("取得済み 5 / 6", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "収集を再開", exact: true }).count(), 0);
  await page.reload(); // Only persisted records remain; do not automatically retry the rejection.
  const summary = page.getByText("文献の照合を確認してください · 1件", { exact: true });
  await summary.click();
  const rejectedTitle = records.find(item => item.last_failure)!.title;
  await page.locator("details").filter({ has: summary }).getByRole("button", { name: rejectedTitle, exact: true }).click();
  const notice = page.getByLabel("最後の文献照合エラー");
  await notice.getByText("食い違った情報と確認先", { exact: true }).click();
  await notice.getByText("10.1234/another", { exact: true }).waitFor();
  assert.equal(await notice.getByText(record.doi, { exact: true }).count(), 1);
  assert.equal(await page.getByRole("link", { name: "DOI", exact: true }).getAttribute("href"), "https://doi.org/10.1234/abc");
  assert.equal(await page.getByRole("button", { name: "PDFを取り込む", exact: true }).count(), 0);
  assert.equal(await page.getByText("この論文の概要", { exact: true }).count(), 0);
  assert.equal(posts.length, 6);
  for (const width of [1280, 900, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = window.innerWidth === 360 ? "24px" : "16px"; });
    await notice.scrollIntoViewIfNeeded();
    const bounds = (await notice.boundingBox())!;
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    assert.equal(await notice.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
  }
  await fs.mkdir(path.resolve(frontend, "../tmp"), { recursive: true });
  await page.setViewportSize({ width: 360, height: 2400 });
  await notice.scrollIntoViewIfNeeded();
  await notice.screenshot({ path: path.resolve(frontend, "../tmp/research-identity-360.png") });
  await page.getByRole("button", { name: "情報を再取得", exact: true }).click();
  await waitForPosts(7);
  assert.equal(posts[6].reference, posts[0].reference);
  finish(6);
  await notice.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.documentElement.style.fontSize = "16px"; });
  assert.equal(await page.locator("article").getByRole("button", { name: rejectedTitle, exact: true }).getAttribute("aria-current"), "true");
  assert.deepEqual(errors, []);
});

test("five reference lookups leave summary, chat and translation available and refill beside an answer", { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    cacheDir: path.resolve(frontend, "../tmp/vite-reference-concurrency"), resolve: { dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(60_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let events: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\/events/, socket => { events = socket; });
  const network = structuredClone(graph);
  network.references = Array.from({ length: 7 }, (_, i) => ({ ...graph.references[0],
    id: `${source}:${i}`, research_key: String(i + 1).repeat(32), target: `ref:${i}`, title: `Reference ${i}` }));
  network.nodes = [graph.nodes[0], ...network.references.map(ref => ({ ...graph.nodes[1], id: ref.target, title: ref.title }))];
  network.edges = network.references.map(ref => ({ source, target: ref.target }));
  const records: ResearchRecord[] = [];
  const posts: { id: string; path: string; body: Record<string, unknown> }[] = [];
  const waiters: (() => void)[] = [];
  const waitForPosts = (count: number) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Expected ${count} requests, received ${posts.length}: ${errors.join("; ")}`)), 15_000);
    const check = () => { if (posts.length >= count) { clearTimeout(timer); resolve(); } };
    waiters.push(check); check();
  });
  let hasSummary = false;
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (request.method() === "POST") {
      const post = { id: `parallel-${posts.length}`, path: pathname, body: request.postDataJSON() ?? {} };
      posts.push(post);
      await route.fulfill({ json: { job_id: post.id }, headers });
      waiters.forEach(check => check()); return;
    }
    const paper = { id: source, title: "Current research paper", collection_name: "", pages: 8,
      status: "imported", has_article: hasSummary, has_translation: false };
    const json = pathname.endsWith("/discovery") ? frozenMap(network) : pathname.endsWith("/discovery") ? frozenMap(network) : pathname === "/api/citations" ? network
      : pathname === "/api/research-capabilities" ? { web_search: true, reference_research_enabled: true, reference_lookup: true }
      : pathname.endsWith("/reference-research") ? records
      : pathname.endsWith("/reading") ? { has_article: hasSummary, has_translated: false, source_page_count: 8, page_count: 8, completed_pages: [], required_pages: [], ocr_pages: [] }
      : pathname.endsWith("/article") ? { content: "並行して作成したサマリー" }
      : pathname === "/api/papers" ? [paper]
      : pathname === `/api/papers/${source}` ? paper : [];
    await route.fulfill({ json, headers });
  });
  const finish = (id: string, kind: string, result: unknown) => {
    assert.ok(events);
    events.send(JSON.stringify({ type: "job.finished", job_id: id, paper_id: source, kind,
      status: "succeeded", running: false, cancelled: false, message: "", error: null, result }));
  };
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/research.html?parallel`);
  await waitForPosts(5);
  assert.equal(posts.filter(post => post.path.endsWith("/reference-research")).length, 5);
  assert.equal(await page.getByRole("button", { name: "翻訳する…", exact: true }).isEnabled(), true);
  await page.getByRole("button", { name: "その他", exact: true }).click();
  assert.equal(await page.getByRole("menuitem", { name: "サマリー（解説）を作成" }).isEnabled(), true);
  assert.equal(await page.getByRole("menuitem", { name: "ライブラリから削除" }).isEnabled(), false);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "サマリータブ", exact: true }).click();
  await page.getByRole("button", { name: "サマリーを作成", exact: true }).first().click();
  await waitForPosts(6);
  assert.equal(posts[5].path, `/api/papers/${source}/article`);
  await page.getByRole("button", { name: "作成中…", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "作成中…", exact: true }).isEnabled(), false);
  hasSummary = true;
  finish(posts[5].id, "article", { content: "並行して作成したサマリー" });
  await page.getByText("並行して作成したサマリー", { exact: true }).waitFor();
  await page.getByRole("button", { name: "チャットタブ", exact: true }).click();
  await page.locator("textarea").fill("手法を説明してください");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await waitForPosts(7);
  assert.equal(posts[6].path, `/api/papers/${source}/ask`);
  await page.getByRole("button", { name: "論文マップタブ", exact: true }).click();
  const completed = { ...record, key: network.references[0].research_key };
  records.push(completed);
  finish(posts[0].id, "reference-research", completed);
  await waitForPosts(8);
  assert.equal(posts[7].path, `/api/papers/${source}/reference-research`);
  assert.equal(posts.filter(post => post.path.endsWith("/reference-research")).length, 6);
  assert.deepEqual(errors, []);
});

test("research, PDF and summary import, return, comparison and chat Web switch work together", { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error", cacheDir: path.resolve(frontend, "../tmp/vite-research-browser"),
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(60_000);
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
    else if (pathname.endsWith("/discovery")) json = frozenMap(currentGraph);
    else if (pathname === "/api/jobs") json = [];
    else if (pathname === "/api/research-capabilities") json = { web_search: true, reference_research_enabled: true, reference_lookup: true, reference_web_search: false };
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
  await page.getByRole("button", { name: "中止", exact: true }).waitFor();
  assert.equal(posts[0].body.reference_id, `${source}:0`);
  current = structuredClone(record);
  finished("reference-research", current);
  await page.getByText("抄録に基づく概要 · 本文は未確認", { exact: true }).waitFor();
  // Detail content has its own bounded scroll region, including long abstracts and logs.
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.locator("#root").evaluate(el => { el.style.width = "380px"; });
  const detail = page.getByLabel("選択した文献の詳細");
  const detailBounds = (await detail.boundingBox())!;
  assert.ok(detailBounds.y + detailBounds.height <= 800, "the detail panel must fit the workspace height");
  await page.mouse.move(detailBounds.x + detailBounds.width / 2, detailBounds.y + detailBounds.height / 2);
  await page.mouse.wheel(0, 300);
  await page.waitForFunction(() => (document.querySelector('[aria-label="選択した文献の詳細"]')?.scrollTop ?? 0) > 0);
  await detail.evaluate(el => { el.scrollTop = 0; });
  assert.equal(await page.getByLabel("論文の関係図").isVisible(), true);
  assert.equal(await page.getByText(/Semantic Scholarの情報を取得できませんでした/).isVisible(), false);
  await page.getByText("抄録（原文）", { exact: true }).click();
  const expandedBounds = (await detail.boundingBox())!;
  await page.mouse.move(expandedBounds.x + expandedBounds.width / 2, expandedBounds.y + expandedBounds.height / 2);
  await page.mouse.wheel(0, 10000);
  await page.waitForFunction(() => {
    const el = document.querySelector('[aria-label="選択した文献の詳細"]')!;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
  });
  await page.getByRole("button", { name: "この論文を中心に見る", exact: true }).waitFor();
  assert.ok(await detail.evaluate(el => el.scrollHeight > el.clientHeight && el.scrollTop > 0));
  assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight));
  await page.getByText("取得状況・詳細", { exact: true }).click();
  await page.getByText(/Semantic Scholarの情報を取得できませんでした/).waitFor();
  await page.getByText("取得状況・詳細", { exact: true }).click();
  await detail.evaluate(el => { el.scrollTop = 0; });
  await fs.mkdir(path.resolve(frontend, "../tmp"), { recursive: true });
  await page.screenshot({ path: path.resolve(frontend, "../tmp/reference-content-narrow.png") });
  await page.locator("#root").evaluate(el => { el.style.width = "100%"; });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const wideBounds = (await detail.boundingBox())!;
  assert.ok(wideBounds.y + wideBounds.height <= 1000);
  await page.mouse.move(wideBounds.x + wideBounds.width / 2, wideBounds.y + 100);
  await page.mouse.wheel(0, 300);
  await page.waitForFunction(() => (document.querySelector('[aria-label="選択した文献の詳細"]')?.scrollTop ?? 0) > 0);
  assert.ok(await page.getByLabel("論文の関係図").locator("line").evaluateAll(lines => lines.every(line => getComputedStyle(line).animationName === "none")));
  await page.getByText("取り込み設定", { exact: true }).click();
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
  await page.getByRole("button", { name: "元の論文のマップへ戻る", exact: true }).click();
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
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error", cacheDir: path.resolve(frontend, "../tmp/vite-research-browser"),
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.setDefaultTimeout(15_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let events: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\/events/, socket => { events = socket; });
  const keys = [key, ...Array.from({ length: 7 }, (_, i) => String(i + 1).repeat(32))];
  const records: ResearchRecord[] = [structuredClone(record), { ...record, key: keys[2], basis: "unresolved", sources: [], pdfs: [],
    summary: "ウェブ検索が禁止されているため、提示された文献の書誌情報と内容を確認できませんでした。" }];
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
  let settings = { provider: "api", model: "", provider_options: {}, paper_discovery_enabled: false, paper_metadata_ai_enabled: false,
    paper_metadata_provider: "codex", paper_metadata_model: "lookup-model" };
  await page.addInitScript(() => localStorage.setItem("papeer-auto-reference-research", JSON.stringify({ state: { enabled: true }, version: 0 })));
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (pathname === "/api/settings" && request.method() === "PUT") {
      settings = { ...settings, ...request.postDataJSON() };
      await route.fulfill({ json: { status: "saved" }, headers }); return;
    }
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
    const json = pathname === "/api/settings" ? settings : pathname === "/api/providers" ? []
      : pathname.startsWith("/api/providers/") ? [] : pathname === "/api/usage/limits" ? null
      : pathname.endsWith("/discovery") ? frozenMap(network) : pathname === "/api/citations" ? network : pathname === "/api/research-capabilities" ? {
        web_search: false, reference_research_enabled: settings.paper_metadata_ai_enabled, reference_lookup: true, reference_web_search: false }
      : pathname.endsWith("/reference-research") ? records : pathname === "/api/jobs" || pathname === "/api/collections" || pathname.endsWith("/messages") ? []
      : pathname === "/api/papers" ? [] : { id: source, collection_name: "", has_article: false };
    await route.fulfill({ json, headers });
  });
  const url = `${server.resolvedUrls!.local[0]}e2e/fixtures/research.html`;
  await page.goto(url);
  await page.getByText("AIによる情報取得はOFFです", { exact: true }).waitFor();
  assert.equal(await page.getByRole("checkbox", { name: "AIで情報収集", exact: true }).count(), 0);
  const setInformation = async (enabled: boolean) => {
    await page.getByRole("button", { name: "設定タブ", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("input")].some(input => input.value === "lookup-model"));
    await page.getByRole("checkbox", { name: "論文情報の取得にAIを使う", exact: true }).setChecked(enabled);
    await page.getByRole("button", { name: "設定を保存", exact: true }).click();
    await page.getByRole("region", { name: "情報取得の設定" }).waitFor({ state: "hidden" });
    assert.equal(settings.paper_metadata_ai_enabled, enabled);
    assert.equal(settings.paper_metadata_provider, "codex");
    assert.equal(settings.paper_metadata_model, "lookup-model");
  };
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
  await page.locator("article").getByRole("button", { name: "Reference 1", exact: true }).first().click();
  assert.equal(await page.getByRole("button", { name: "内容・入手先を取得", exact: true }).isDisabled(), true);
  await page.getByRole("link", { name: "Google Scholar", exact: true }).waitFor();
  await page.getByRole("link", { name: "DOI", exact: true }).waitFor();
  await page.getByRole("button", { name: "一覧に戻る", exact: true }).click();
  await setInformation(true); await firstRequest; await waitForPosts(5);
  await page.getByText("5件を同時に収集中", { exact: true }).waitFor();
  assert.equal(posts.length, 5);
  // The duplicate of reference 1 has the same research key; either row identifies the same work.
  assert.ok([`${source}:1`, `${source}:8`].includes(posts[0].reference));
  assert.equal(new Set(posts.map(post => network.references.find(ref => ref.id === post.reference)!.research_key)).size, 5);
  await page.getByRole("button", { name: "チャットタブ", exact: true }).click();
  await page.getByRole("button", { name: "論文マップタブ", exact: true }).click();
  await page.getByText("取得済み 1 / 8", { exact: true }).waitFor();
  assert.equal(posts.length, 5);
  finished(2, "succeeded"); await waitForPosts(6);
  await page.getByText("取得済み 2 / 8", { exact: true }).waitFor();
  assert.equal(posts.length, 6);
  // OFF must also cancel when the start response has not arrived yet.
  await page.getByRole("button", { name: "チャットタブ", exact: true }).click();
  await setInformation(false); releaseFirst(); await waitForCancels(5);
  assert.deepEqual(new Set(cancelled), new Set([0, 1, 3, 4, 5].map(i => posts[i].id)));
  for (const i of [0, 1, 3, 4, 5]) finished(i, "cancelled");
  await page.getByRole("button", { name: "論文マップタブ", exact: true }).click();
  await page.getByText("収集を中止しています…", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(posts.length, 6);
  await setInformation(true); await waitForPosts(11);
  await page.getByText("5件を同時に収集中", { exact: true }).waitFor();
  assert.equal(posts.length, 11);
  finished(6, "failed"); finished(7, "failed");
  for (const i of [10, 8, 9]) finished(i, "succeeded");
  await page.getByRole("button", { name: "収集を再開", exact: true }).waitFor();
  await page.getByText("取得済み 5 / 8", { exact: true }).waitFor();
  assert.equal(posts.length, 11);
  await setInformation(false);
  await setInformation(true); await waitForPosts(14);
  assert.deepEqual(new Set(posts.slice(11).map(post => post.reference)), new Set([posts[6].reference, posts[7].reference, `${source}:7`]));
  for (const i of [13, 11, 12]) finished(i, "succeeded");
  await page.getByText("取得済み 8 / 8", { exact: true }).waitFor();
  assert.equal(posts.length, 14);
  await page.reload();
  await page.getByText("取得済み 8 / 8", { exact: true }).waitFor();
  assert.equal(await page.getByRole("checkbox", { name: "AIで情報収集", exact: true }).count(), 0);
  assert.equal(posts.length, 14);
  await fs.mkdir(path.resolve(frontend, "../tmp"), { recursive: true });
  await page.screenshot({ path: path.resolve(frontend, "../tmp/reference-auto-research.png") });
  assert.deepEqual(errors, []);
});
test("a paper without a public PDF opens Google Scholar instead of its publisher", { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error", cacheDir: path.resolve(frontend, "../tmp/vite-research-browser"),
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000);
  await page.routeWebSocket(/\/ws\/events/, () => {});
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const pathname = new URL(route.request().url()).pathname;
    assert.equal(route.request().method(), "GET");
    const json = pathname.endsWith("/discovery") ? frozenMap(graph) : pathname === "/api/citations" ? graph
      : pathname === "/api/research-capabilities" ? { reference_research_enabled: false, reference_lookup: true }
      : pathname.endsWith("/reference-research") ? [{ ...record, pdfs: [] }]
      : pathname === "/api/jobs" || pathname === "/api/collections" ? []
      : { id: source, collection_name: "", has_article: false };
    await route.fulfill({ json, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/research.html`);
  await page.locator("article").getByRole("button", { name: record.title, exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "公開元を開く", exact: true }).count(), 0);
  await page.evaluate(() => { window.open = ((url: string) => { document.body.dataset.externalUrl = url; return null; }) as typeof window.open; });
  await page.getByRole("button", { name: "Google Scholarで開く", exact: true }).click();
  const opened = new URL((await page.locator("body").getAttribute("data-external-url"))!);
  assert.equal(opened.origin, "https://scholar.google.com");
  assert.equal(opened.searchParams.get("q"), record.title);
});

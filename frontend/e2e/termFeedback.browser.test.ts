/** Read-time corrections, preview selection, trusted evidence and remembering without real AI calls. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium, type WebSocketRoute } from "playwright-core";

test("reading feedback previews replacements and remembers the selected scope", { timeout: 90_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let events: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\/events/, socket => { events = socket; });
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (request.method() === "POST") posts.push({ path: pathname, body: request.postDataJSON() });
    const json = pathname.endsWith("/term-replacement-preview") ? { key: "a".repeat(64), changes: [1, 2].map(i => ({
      id: `p${i}`, pages: [i], source: `The learned policy is evaluated in experiment ${i}.`, text: "ポリシーを評価する。", after: "方策を評価する。",
    })) } : pathname.endsWith("/term-research") ? { job_id: "lookup" }
      : pathname.endsWith("/term-replacement") ? { job_id: "replace" }
      : pathname.endsWith("/reading") ? { page_count: 2, report: null }
      : pathname.endsWith("/effective-glossary") ? [{ source: "policy", target: "ポリシー" }]
      : pathname.includes("glossary-domains") ? { domains: [] }
      : pathname.includes("glossary") || pathname.includes("paragraphs") || pathname === "/api/jobs" ? []
      : { id: "driving", title: "Driving Policy", pages: 2 };
    await route.fulfill({ json, headers });
  });
  const finish = (id: string, kind: string, result: unknown) => {
    assert.ok(events);
    events.send(JSON.stringify({ type: "job.finished", job_id: id, paper_id: "driving", kind,
      status: "succeeded", running: false, cancelled: false, message: "", result, error: null }));
  };
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/termFeedback.html`);
  assert.equal(await page.getByLabel("置換前の訳語").inputValue(), "ポリシー");
  await page.getByLabel("修正する原語").waitFor();
  assert.equal(await page.getByLabel("修正する原語").inputValue(), "policy");
  await page.getByRole("button", { name: "Webで日本語の用例を調べる", exact: true }).click();
  await page.getByText("処理中…", { exact: true }).waitFor();
  finish("lookup", "term-research", { candidates: [{ target: "方策", explanation: "学習する方策の意味で使われています。", sources: [
    { title: "大学の講義資料", url: "https://rl.example.ac.jp/lecture.pdf", quote: "方策に従い行動を選ぶ。" },
  ] }] });
  await page.getByRole("button", { name: "この訳語を入力", exact: true }).click();
  assert.equal(await page.getByLabel("置換後の訳語").inputValue(), "方策");
  await page.getByLabel("訳語の保存範囲").selectOption("shared");
  await page.getByRole("button", { name: "置換箇所を確認", exact: true }).click();
  await page.getByText("2段落が該当します。", { exact: false }).waitFor();
  assert.equal(await page.getByText("変更後：方策を評価する。", { exact: true }).count(), 2);
  await page.getByRole("checkbox").nth(1).uncheck();
  await fs.mkdir(path.resolve(frontend, "../tmp"), { recursive: true });
  await page.screenshot({ path: path.resolve(frontend, "../tmp/term-feedback-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  assert.ok(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth));
  await page.screenshot({ path: path.resolve(frontend, "../tmp/term-feedback-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "1段落を置換してPDFに反映", exact: true }).click();
  await page.getByText("処理中…", { exact: true }).waitFor();
  assert.deepEqual(posts[posts.length - 1]?.body, { source: "policy", before: "ポリシー", target: "方策",
    expected_key: "a".repeat(64), selected_ids: ["p1"], remember: "shared" });
  finish("replace", "term-replace", { changed: 1, remember: "shared" });
  await page.getByText("1段落の訳語を置き換えました。", { exact: false }).waitFor();
  assert.equal(await page.getByRole("checkbox").count(), 0);
  assert.deepEqual(errors, []);
});

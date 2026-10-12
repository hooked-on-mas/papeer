/** node --test e2e/summaryScope.browser.test.ts; AI requests are intercepted locally. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

test("summary always offers scope choices, requires them for long documents, and cancels without a job", { timeout: 60_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const jobs: { paper: string; body: unknown }[] = [];
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    const paper = url.pathname.split("/")[3];
    let body: unknown;
    if (url.pathname.endsWith("/summary-plan")) {
      body = { page_count: paper === "short" ? 29 : 186, requires_selection: paper !== "short",
        chapters: paper === "no-outline" ? [] : [
          { title: "第1章 Introduction", depth: 0, start_page: 1, end_page: 4 },
          { title: "第2章 Methods", depth: 0, start_page: 5, end_page: 12 },
          { title: "実験条件", depth: 1, start_page: 8, end_page: 12 },
          { title: "第3章 Results", depth: 0, start_page: 13, end_page: 186 },
        ] };
    } else if (url.pathname.endsWith("/article") && request.method() === "POST") {
      jobs.push({ paper, body: request.postDataJSON() });
      body = { job_id: `summary-${jobs.length}` };
    } else if (url.pathname === `/api/papers/${paper}`) {
      body = { id: paper, title: "Summary test", pages: paper === "short" ? 29 : 186, has_article: paper === "existing" };
    } else { await route.abort(); return; }
    await route.fulfill({ json: body, headers });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/summaryScope.html`);
  const open = () => page.getByRole("button", { name: "長い資料を要約", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const submit = page.getByRole("button", { name: "選択範囲で作成する", exact: true });
  await open();
  await dialog.waitFor();
  assert.equal(await submit.isDisabled(), true);
  assert.equal(jobs.length, 0);
  await page.getByRole("checkbox", { name: /第2章 Methods/ }).check();
  await page.getByRole("checkbox", { name: /実験条件/ }).check();
  await page.getByText("対象：8 / 186ページ", { exact: true }).waitFor();
  if (process.env.PAPEER_UI_SCREENSHOT) await page.screenshot({ path: process.env.PAPEER_UI_SCREENSHOT });
  await submit.click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(jobs, [{ paper: "long", body: { pages: "5,6,7,8,9,10,11,12" } }]);

  await open();
  await dialog.waitFor();
  assert.equal(await submit.isDisabled(), true, "previous opening does not pre-authorize a scope");
  await page.getByLabel("サマリーの対象", { exact: true }).selectOption("all");
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(jobs.length, 1);

  await open();
  await page.getByLabel("サマリーの対象", { exact: true }).selectOption("all");
  await page.getByText("対象：186 / 186ページ", { exact: true }).waitFor();
  await page.getByRole("button", { name: "全文で作成する", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(jobs[1], { paper: "long", body: { full_document: true } });

  await page.getByRole("button", { name: "目次のない資料を要約", exact: true }).click();
  await page.getByText("PDFに目次が見つかりません。", { exact: false }).waitFor();
  await page.getByLabel("ページ番号", { exact: false }).fill("187");
  assert.equal(await submit.isDisabled(), true);
  await page.getByLabel("ページ番号", { exact: false }).fill("3-5, 8");
  await submit.click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(jobs[2], { paper: "no-outline", body: { pages: "3,4,5,8" } });

  await page.getByRole("button", { name: "既存サマリーを再作成", exact: true }).click();
  await page.getByRole("checkbox", { name: /第2章 Methods/ }).check();
  await submit.click();
  await page.getByRole("heading", { name: "サマリーを再作成", exact: true }).waitFor();
  assert.equal(jobs.length, 3);
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(jobs.length, 3);

  await page.getByRole("button", { name: "短い資料を要約", exact: true }).click();
  await dialog.waitFor();
  assert.equal(jobs.length, 3);
  assert.equal(await page.getByLabel("サマリーの対象", { exact: true }).inputValue(), "all");
  await page.getByLabel("サマリーの対象", { exact: true }).selectOption("custom");
  await page.getByLabel("ページ番号", { exact: false }).fill("2-4");
  await submit.click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(jobs[3], { paper: "short", body: { pages: "2,3,4" } });

  await page.getByRole("button", { name: "短い資料を要約", exact: true }).click();
  await page.getByRole("button", { name: "全文で作成する", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(jobs[4], { paper: "short", body: { full_document: true } });
  assert.deepEqual(errors, []);
});

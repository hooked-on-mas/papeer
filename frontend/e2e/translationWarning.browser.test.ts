/** node --test e2e/translationWarning.browser.test.ts; never contacts a real sidecar. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

test("translation waits for its warning data and announces writing newly affected by glossary edits", { timeout: 60_000 }, async t => {
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
  let releasePlan!: () => void, releaseInk!: () => void;
  const planGate = new Promise<void>(resolve => { releasePlan = resolve; });
  const inkGate = new Promise<void>(resolve => { releaseInk = resolve; });
  t.after(() => { releasePlan(); releaseInk(); });
  let markPlanRequested!: () => void, markInkRequested!: () => void;
  const planRequested = new Promise<void>(resolve => { markPlanRequested = resolve; });
  const inkRequested = new Promise<void>(resolve => { markInkRequested = resolve; });
  let saved = false, translations = 0;
  let terms = [{ source: "adaptive", target: "適応" }];
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS" };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    let body: unknown;
    if (url.pathname.endsWith("/translation-plan")) {
      markPlanRequested();
      await planGate;
      body = { model: "test-model", selected_pages: [1, 2], reusable_pages: saved ? [2] : [1, 2],
        pending_pages: saved ? [1] : [], retranslated_pages: saved ? [1] : [], previous_models: [], needs_ai: saved };
    } else if (url.pathname.endsWith("/ink-pages")) {
      markInkRequested();
      await inkGate;
      body = [{ side: "translated", page: 1, count: 1 }];
    } else if (url.pathname === "/api/glossary") {
      if (request.method() === "PUT") {
        terms = request.postDataJSON().terms;
        saved = true;
      }
      body = terms;
    } else if (url.pathname.endsWith("/glossary-domains")) {
      body = { available: [], domains: [], known_domains: [], new_domain: null, chosen_by: "user", stale: false, split_at: 100 };
    } else if (url.pathname.endsWith("/glossary")) {
      body = { terms: [], dismissed: [] };
    } else if (url.pathname.endsWith("/reading")) {
      body = { source_page_count: 2, page_count: 2, preview: { complete: true, target_pages: [1, 2] } };
    } else if (url.pathname === "/api/settings") {
      body = { provider: "", model: "test-model", reasoning_effort: "" };
    } else if (url.pathname.endsWith("/translate")) {
      translations++;
      body = { job_id: "test-translation" };
    } else if (url.pathname === "/api/providers") {
      body = [];
    } else {
      await route.abort();
      return;
    }
    await route.fulfill({ json: body, headers });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/translationWarning.html`);
  await page.getByRole("button", { name: "翻訳対象を確認中…" }).waitFor();
  await Promise.all([planRequested, inkRequested]);
  assert.equal(await page.getByRole("button", { name: "翻訳対象を確認中…" }).isDisabled(), true);
  releasePlan();
  await page.getByText("指定ページはすべて保存済みの訳文を使えます。", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: "翻訳対象を確認中…" }).isDisabled(), true);
  releaseInk();
  await page.getByRole("button", { name: "保存済みの訳文でPDFを作り直す" }).waitFor();
  await page.locator("details").filter({ has: page.getByLabel("訳語 1", { exact: true }) }).locator(":scope > summary").click();
  await page.getByLabel("訳語 1", { exact: true }).fill("適応的");
  await page.getByRole("button", { name: /^(翻訳を開始|用語を確認せずに翻訳)$/ }).click();
  await page.getByText("訳語を保存しました。", { exact: false }).waitFor();
  await page.getByText("注意：再翻訳の対象となる日本語訳のうち、1ページに書き込みがあります。", { exact: false }).waitFor();
  assert.equal(translations, 0, "saving a glossary must leave a new writing warning visible before translation starts");
  await page.getByRole("button", { name: /^(翻訳を開始|用語を確認せずに翻訳)$/ }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(translations, 1);
  assert.deepEqual(errors, []);
});

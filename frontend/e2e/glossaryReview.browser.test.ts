/** Real dialog interaction with isolated fake API responses; never connects to the user's sidecar. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

test("glossary review is opt-in, paper-only, and dictionary management supports undo", { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const requests: { path: string; method: string; body: any }[] = [];
  let local = { terms: [] as { source: string; target: string }[], dismissed: [] as string[] };
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*" } }); return;
    }
    const body = request.postDataJSON(); requests.push({ path: url.pathname, method: request.method(), body });
    let answer: unknown = {};
    if (url.pathname === "/api/papers/driving/glossary") {
      if (request.method() === "PUT") local = { terms: body.terms, dismissed: body.dismissed };
      answer = local;
    } else if (url.pathname.endsWith("/translate")) answer = { job_id: "translation" };
    else if (url.pathname.endsWith("/glossary-domains")) answer = { domains: ["ロボティクス・建設機械"], new_domain: "自動車の自動運転",
      chosen_by: "ai", available: ["ロボティクス・建設機械"], known_domains: ["ロボティクス・建設機械"], stale: false,
      scope_stale: false, scope_terms: [{ source: "trajectory", target: "軌道", domain: "ロボティクス・建設機械" }], selection_key: "checked" };
    else if (url.pathname.endsWith("/translation-plan")) answer = { model: "test", selected_pages: [1], reusable_pages: [],
      pending_pages: [1], retranslated_pages: [], previous_models: [], needs_ai: true };
    else if (url.pathname.endsWith("/glossary")) answer = [];
    else if (url.pathname.endsWith("/effective-glossary") || url.pathname.endsWith("/paragraphs")) answer = [];
    else { await route.abort(); throw new Error(`Unexpected API request: ${request.method()} ${url.pathname}`); }
    await route.fulfill({ json: answer, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/glossaryReview.html`);
  await page.getByRole("checkbox", { name: "motion primitive", exact: true }).waitFor();
  assert.equal(await page.getByRole("checkbox", { name: "motion primitive", exact: true }).isChecked(), false);
  assert.equal(await page.getByRole("checkbox", { name: "driving policy", exact: true }).isChecked(), false);
  assert.equal(await page.getByRole("button", { name: "辞書を保存", exact: true }).isVisible(), false);
  await page.getByText("原文の使われ方", { exact: true }).first().click();
  assert.equal(await page.getByText("The planner chooses a motion primitive.", { exact: true }).isVisible(), true);

  // Management is tucked away; a bulk move can be reviewed and undone before any write occurs.
  await page.getByText("共用辞書を管理（2件）", { exact: true }).click();
  await page.getByRole("checkbox", { name: "slopeを移動対象に選択", exact: true }).check();
  await page.getByLabel("まとめて移動する分野").selectOption("共通");
  await page.getByRole("button", { name: "移動", exact: true }).click();
  assert.equal(await page.getByLabel("分野 1", { exact: true }).inputValue(), "共通");
  await page.getByRole("button", { name: "直前の編集を戻す", exact: true }).click();
  assert.equal(await page.getByLabel("分野 1", { exact: true }).inputValue(), "ロボティクス・建設機械");
  // Undo restores the original content; no shared dictionary edit should need saving.
  await page.getByRole("checkbox", { name: "motion primitive", exact: true }).check();
  await page.getByLabel("motion primitiveの推奨訳").fill("基本動作");
  await page.getByText("共用辞書を管理（2件）", { exact: true }).click();
  await page.getByRole("dialog").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: path.resolve(frontend, "../tmp/glossary-review.png"), fullPage: true });
  await page.getByRole("button", { name: "翻訳を開始", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.deepEqual(local, { terms: [{ source: "motion primitive", target: "基本動作" }], dismissed: ["driving policy"] });
  assert.equal(requests.some(r => r.path === "/api/glossary" && r.method === "PUT"), false);
  assert.equal(requests.some(r => r.path.includes("/glossary/split")), false);
  assert.equal(requests.filter(r => r.path.endsWith("/translate")).length, 1);
  assert.deepEqual(errors, []);
});

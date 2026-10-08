/** Real dialog interaction with isolated fake API responses; never connects to the user's sidecar. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium, type Page } from "playwright-core";
import type { Term } from "../src/features/reader/translationStart.ts";

async function openDictionary(page: Page) {
  await openAdvanced(page);
  const link = page.getByRole("button", { name: /^共用辞書を管理/ });
  if (!await link.isVisible()) await page.getByText("使う分野を変更", { exact: true }).click();
  await link.click();
}
async function openPaperTerms(page: Page) {
  await page.getByRole("button", { name: /^← この論文の訳語に戻る/ }).click();
  await openAdvanced(page);
}
async function openAdvanced(page: Page) {
  const summary = page.getByText("訳語の一覧・辞書を管理（詳細設定）", { exact: true });
  if (!await summary.evaluate(el => el.parentElement!.hasAttribute("open"))) await summary.click();
}
async function showInherited(page: Page) {
  const summary = page.getByText(/^辞書から使う訳語を確認（/);
  if (!await summary.evaluate(el => el.parentElement!.hasAttribute("open"))) await summary.click();
}

test("translation starts directly with a stale dictionary and pending candidates", { timeout: 90_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const writes: { path: string; body: unknown }[] = [];
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (request.method() !== "GET") writes.push({ path: url.pathname, body: request.postDataJSON() });
    await route.fulfill({ json: url.pathname.endsWith("/translate") ? { job_id: "translation" } : {}, headers });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/glossaryReview.html?stale`);
  await page.getByRole("button", { name: "翻訳する…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "日本語に翻訳", exact: true });
  const start = dialog.getByRole("button", { name: "翻訳を開始", exact: true });
  await start.waitFor();
  assert.equal(await start.isEnabled(), true);
  assert.equal(await dialog.getByRole("tablist").count(), 0);
  assert.equal(await dialog.getByRole("button", { name: "AIで訳語候補を抽出", exact: true }).isVisible(), false);
  assert.equal(await dialog.getByRole("region", { name: "この論文に使う訳語", exact: true }).isVisible(), false);
  const scope = dialog.getByLabel("翻訳するページ", { exact: true });
  await scope.selectOption("custom");
  assert.equal(await start.isDisabled(), true);
  await scope.selectOption("all");
  for (const width of [360, 1000]) {
    await page.setViewportSize({ width, height: 640 });
    assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth));
    const box = (await start.boundingBox())!;
    assert.ok(box.y >= 0 && box.y + box.height <= 640, "start stays visible on small screens");
  }
  assert.equal(writes.length, 0, "opening translation must not start dictionary AI jobs or save candidates");
  await dialog.getByRole("button", { name: "訳語の修正", exact: true }).click();
  await page.getByText("訳語の一覧・辞書を管理（詳細設定）", { exact: true }).click();
  await page.getByRole("checkbox", { name: "motion primitive", exact: true }).waitFor();
  await page.getByRole("button", { name: "翻訳に戻る", exact: true }).click();
  await start.click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(writes.map(write => write.path), ["/api/papers/driving/translate"]);
  assert.deepEqual(writes[0].body, { pages: "" });
  assert.deepEqual(errors, []);
});

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
  let shared = [{ source: "slope", target: "法面", domain: "ロボティクス・建設機械" },
    { source: "trajectory", target: "軌道", domain: "ロボティクス・建設機械" }];
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
    } else if (url.pathname === "/api/glossary") {
      if (request.method() === "PUT") shared = body.terms;
      answer = shared;
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
  await page.getByRole("button", { name: /^(翻訳する…|翻訳 \/ 再開…)$/ }).click();
  await page.getByRole("dialog", { name: "日本語に翻訳", exact: true }).waitFor();
  assert.equal(await page.getByRole("tablist").count(), 0, "translation starts with page selection, without dictionary tabs");
  assert.equal(await page.getByRole("checkbox", { name: "motion primitive", exact: true }).isVisible(), false, "pending candidates must not interrupt translation");
  await page.screenshot({ path: path.resolve(frontend, "../tmp/translation-simple.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "訳語の修正", exact: true }).click();
  await page.getByText("訳語の一覧・辞書を管理（詳細設定）", { exact: true }).click();
  await page.getByRole("checkbox", { name: "motion primitive", exact: true }).waitFor();
  assert.equal(await page.getByRole("tablist").count(), 0);
  assert.equal(await page.getByRole("button", { name: "trajectoryをこの論文だけ変更", exact: true }).isVisible(), false);
  await page.getByText("AIに訳語を提案してもらう（任意）", { exact: true }).click();
  assert.equal(await page.getByRole("checkbox", { name: "motion primitive", exact: true }).isChecked(), false);
  assert.equal(await page.getByRole("checkbox", { name: "driving policy", exact: true }).isChecked(), false);
  assert.equal(await page.getByRole("button", { name: "AIで訳語候補を抽出", exact: true }).isDisabled(), true, "a fresh extraction must not replace candidates being reviewed");
  assert.equal(await page.getByRole("button", { name: "辞書を保存", exact: true }).isVisible(), false);
  await page.getByText("原文の使われ方", { exact: true }).first().click();
  assert.equal(await page.getByText("The planner chooses a motion primitive.", { exact: true }).isVisible(), true);

  // Inherited terms and field settings stay hidden until requested.
  await showInherited(page);
  const appliedList = page.getByRole("region", { name: "この論文に使う訳語", exact: true });
  assert.match(await appliedList.innerText(), /trajectory/);
  assert.match(await appliedList.innerText(), /軌道/);
  assert.match(await appliedList.innerText(), /辞書・ロボティクス・建設機械/);
  assert.doesNotMatch(await appliedList.innerText(), /法面/);
  assert.equal(await page.getByText("選択中の分野辞書：共通、ロボティクス・建設機械", { exact: true }).isVisible(), true);
  await page.getByText("使う分野を変更", { exact: true }).click();
  assert.equal(await page.getByText("ロボティクス・建設機械（登録2語・適用1語）", { exact: true }).isVisible(), true);
  await openDictionary(page);
  assert.equal(await page.getByRole("button", { name: "翻訳を開始", exact: true }).count(), 0);
  await page.screenshot({ path: path.resolve(frontend, "../tmp/glossary-management.png"), fullPage: true, animations: "disabled" });
  for (const width of [360, 1000]) {
    await page.setViewportSize({ width, height: 700 });
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"]')!;
      const rect = dialog.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    });
    assert.ok(await page.getByRole("dialog").evaluate(el => el.scrollWidth <= el.clientWidth), "dictionary must fit a narrow window");
    const save = (await page.getByRole("button", { name: "辞書を保存", exact: true }).boundingBox())!;
    assert.ok(save.y >= 0 && save.y + save.height <= 700, "saving must remain on screen");
  }
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.getByRole("checkbox", { name: "slopeを移動対象に選択", exact: true }).check();
  await page.getByLabel("まとめて移動する分野").selectOption("共通");
  await page.getByRole("button", { name: "移動", exact: true }).click();
  assert.equal(await page.getByLabel("分野 1", { exact: true }).inputValue(), "共通");
  await page.getByRole("button", { name: "直前の編集を戻す", exact: true }).click();
  assert.equal(await page.getByLabel("分野 1", { exact: true }).inputValue(), "ロボティクス・建設機械");
  // Undo restores the original content; no shared dictionary edit should need saving.
  await openPaperTerms(page);
  await page.getByRole("checkbox", { name: "motion primitive", exact: true }).check();
  await page.getByLabel("motion primitiveの推奨訳").fill("基本動作");
  await openDictionary(page);
  await page.getByLabel("辞書を検索").fill("  trajectory  ");
  await openPaperTerms(page);
  assert.equal(await page.getByLabel("motion primitiveの推奨訳").inputValue(), "基本動作");
  await openDictionary(page);
  assert.equal(await page.getByLabel("辞書を検索").inputValue(), "  trajectory  ");
  await openPaperTerms(page);
  await page.getByRole("dialog").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: path.resolve(frontend, "../tmp/glossary-review.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "この論文の訳語を保存", exact: true }).click();
  await page.getByText("この論文の訳語を保存しました。次の翻訳から反映します。", { exact: true }).waitFor();
  assert.deepEqual(local, { terms: [{ source: "motion primitive", target: "基本動作" }], dismissed: ["driving policy"] });
  assert.equal(requests.filter(r => r.path.endsWith("/translate")).length, 0);
  await page.getByRole("button", { name: "翻訳に戻る", exact: true }).click();
  await page.getByRole("button", { name: "翻訳を開始", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.deepEqual(local, { terms: [{ source: "motion primitive", target: "基本動作" }], dismissed: ["driving policy"] });
  assert.equal(requests.some(r => r.path === "/api/glossary" && r.method === "PUT"), false);
  assert.equal(requests.some(r => r.path.includes("/glossary/split")), false);
  assert.equal(requests.filter(r => r.path.endsWith("/translate")).length, 1);
  // Dictionary management lives under the header's secondary menu.
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/glossaryReview.html?noDraft`);
  await page.getByRole("button", { name: "その他", exact: true }).click();
  await page.getByRole("menuitem", { name: "訳語・辞書", exact: true }).click();
  await page.getByRole("dialog", { name: "訳語の修正", exact: true }).waitFor();
  await openAdvanced(page);
  await openDictionary(page);
  await page.getByLabel("訳語 2", { exact: true }).fill("走行軌道");
  await page.getByRole("button", { name: "辞書を保存", exact: true }).click();
  await page.getByText("辞書を保存しました。各論文の次の翻訳から反映します。", { exact: true }).waitFor();
  assert.equal(shared[1].target, "走行軌道");
  assert.equal(requests.filter(r => r.path.endsWith("/translate")).length, 1);
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
});

test("paper terms show their origin, support local overrides, and require an explicit dictionary save for reuse", { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const requests: { path: string; method: string }[] = [];
  let local = { terms: [{ source: "control", target: "制御入力" }], dismissed: [] as string[] };
  let shared: Term[] = [{ source: "slope", target: "法面", domain: "ロボティクス・建設機械" },
    { source: "trajectory", target: "軌道", domain: "ロボティクス・建設機械" }, { source: "control", target: "制御" },
    { source: "cell", target: "細胞", domain: "生物" }, { source: "cell", target: "セル", domain: "電池" }];
  const initialShared = structuredClone(shared);
  let scopeStale = false;
  let chosenDomains = ["ロボティクス・建設機械", "電池"];
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    requests.push({ path: url.pathname, method: request.method() });
    let answer: unknown;
    if (url.pathname === "/api/papers/driving/glossary") {
      if (request.method() === "PUT") {
        const body = request.postDataJSON(); local = { terms: body.terms, dismissed: body.dismissed };
      }
      answer = local;
    } else if (url.pathname === "/api/glossary") {
      if (request.method() === "PUT") { shared = request.postDataJSON().terms; scopeStale = true; }
      answer = shared;
    } else if (url.pathname.endsWith("/glossary-domains")) {
      if (request.method() === "PUT") chosenDomains = request.postDataJSON().domains;
      answer = { domains: chosenDomains, new_domain: null, chosen_by: "user",
        available: ["ロボティクス・建設機械", "生物", "電池"], known_domains: ["ロボティクス・建設機械", "生物", "電池"],
        stale: false, scope_stale: scopeStale, scope_terms: [initialShared[1], initialShared[4]], selection_key: "checked" };
    } else if (url.pathname.endsWith("/translation-plan")) {
      answer = { model: "test", selected_pages: [1], reusable_pages: [], pending_pages: [1], retranslated_pages: [], previous_models: [], needs_ai: true };
    } else if (url.pathname.endsWith("/effective-glossary") || url.pathname.endsWith("/paragraphs")) answer = [];
    else { await route.abort(); throw new Error(`Unexpected request: ${request.method()} ${url.pathname}`); }
    await route.fulfill({ json: answer, headers });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/glossaryReview.html?provenance`);
  await page.getByRole("button", { name: "その他", exact: true }).click();
  await page.getByRole("menuitem", { name: "訳語・辞書", exact: true }).click();
  await page.getByRole("dialog", { name: "訳語の修正", exact: true }).waitFor();
  await openAdvanced(page);
  const paperTerms = page.getByRole("region", { name: "この論文に使う訳語", exact: true });
  assert.doesNotMatch(await paperTerms.innerText(), /辞書・電池/);
  assert.equal(await page.getByLabel("controlの指定訳").inputValue(), "制御入力");
  assert.equal(await page.getByText("選択中の分野辞書：共通、ロボティクス・建設機械、電池", { exact: true }).isVisible(), true);
  assert.equal(await page.getByText("使う分野を変更", { exact: true }).isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "AIで訳語候補を抽出", exact: true }).isVisible(), false);
  assert.equal(await page.getByRole("button", { name: "AIで適用する訳語を選び直す", exact: true }).isVisible(), false);
  assert.equal(requests.some(r => r.method !== "GET"), false);
  await page.getByText("使う分野を変更", { exact: true }).click();
  const battery = page.getByRole("checkbox", { name: /^電池（/ });
  await Promise.all([page.waitForResponse(r => r.url().endsWith("/glossary-domains") && r.request().method() === "PUT"), battery.click()]);
  await page.getByText("選択中の分野辞書：共通、ロボティクス・建設機械", { exact: true }).waitFor();
  assert.equal(await battery.isChecked(), false);
  assert.equal(requests.filter(r => r.path.endsWith("/glossary-domains") && r.method === "PUT").length, 1);
  await Promise.all([page.waitForResponse(r => r.url().endsWith("/glossary-domains") && r.request().method() === "PUT"), battery.click()]);
  await page.getByText("選択中の分野辞書：共通、ロボティクス・建設機械、電池", { exact: true }).waitFor();
  assert.equal(requests.some(r => r.path.endsWith("/glossary/select")), false);
  await page.getByText("使う分野を変更", { exact: true }).click();
  await page.screenshot({ path: path.resolve(frontend, "../tmp/terms-simple.png"), fullPage: true, animations: "disabled" });
  for (const width of [360, 1000]) {
    await page.setViewportSize({ width, height: 640 });
    const dialog = page.getByRole("dialog", { name: "訳語の修正", exact: true });
    assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth));
    const save = (await page.getByRole("button", { name: "この論文の訳語を保存", exact: true }).boundingBox())!;
    assert.ok(save.y >= 0 && save.y + save.height <= 640, `paper terms save stays visible on small screens (${width}: ${JSON.stringify(save)})`);
  }
  await page.setViewportSize({ width: 1000, height: 800 });
  await showInherited(page);
  assert.equal(await page.getByRole("region", { name: "電池の訳語", exact: true }).isVisible(), true);
  assert.equal(await page.getByRole("heading", { name: "電池（1件）", exact: true }).isVisible(), true);
  assert.match(await paperTerms.innerText(), /辞書・電池/);
  assert.match(await paperTerms.innerText(), /辞書・ロボティクス・建設機械/);
  assert.match(await paperTerms.innerText(), /辞書の訳：制御（共通）/);
  assert.doesNotMatch(await paperTerms.innerText(), /細胞|法面/);

  await page.getByRole("button", { name: "trajectoryをこの論文だけ変更", exact: true }).click();
  const target = page.getByLabel("trajectoryの指定訳", { exact: true });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "trajectoryの指定訳");
  await target.fill("走行軌道");
  assert.match(await paperTerms.innerText(), /辞書の訳：軌道/);
  await openDictionary(page);
  assert.equal(await page.getByLabel("訳語 2", { exact: true }).inputValue(), "軌道");
  await openPaperTerms(page);
  assert.equal(await target.inputValue(), "走行軌道");
  await page.screenshot({ path: path.resolve(frontend, "../tmp/glossary-paper-origin.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "この論文の訳語を保存", exact: true }).click();
  await page.getByText("この論文の訳語を保存しました。次の翻訳から反映します。", { exact: true }).waitFor();
  assert.deepEqual(local.terms, [{ source: "control", target: "制御入力" }, { source: "trajectory", target: "走行軌道" }]);
  assert.deepEqual(shared, initialShared);

  // Registering an override that already has a dictionary entry shows the existing translation for comparison.
  const trajectoryRow = target.locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
  await trajectoryRow.getByText("ほかの論文でも使いたいとき", { exact: true }).click();
  await trajectoryRow.getByRole("button", { name: "ほかの論文でも使う", exact: true }).click();
  await page.getByText(/「trajectory」は分野「ロボティクス・建設機械」に登録済みです/).waitFor();
  assert.equal(await page.getByLabel("辞書を検索").inputValue(), "trajectory");
  assert.equal(await page.getByLabel("訳語 2", { exact: true }).inputValue(), "軌道");
  await openPaperTerms(page);
  await page.getByRole("button", { name: "trajectoryの論文限定指定を解除", exact: true }).click();
  await showInherited(page);
  await page.getByRole("button", { name: "trajectoryをこの論文だけ変更", exact: true }).waitFor();
  await page.getByRole("button", { name: "この論文の訳語を保存", exact: true }).click();
  await page.getByText("この論文の訳語を保存しました。次の翻訳から反映します。", { exact: true }).waitFor();
  assert.deepEqual(local.terms, [{ source: "control", target: "制御入力" }]);

  await page.getByRole("button", { name: "訳語を追加", exact: true }).click();
  const source = page.getByLabel("この論文の原語 2", { exact: true });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "この論文の原語 2");
  await source.fill("planning horizon");
  await page.getByLabel("planning horizonの指定訳", { exact: true }).fill("予測区間");
  await page.getByRole("button", { name: "この論文の訳語を保存", exact: true }).click();
  await page.getByText("この論文の訳語を保存しました。次の翻訳から反映します。", { exact: true }).waitFor();
  assert.deepEqual(shared, initialShared);
  const planningRow = page.getByLabel("planning horizonの指定訳").locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
  await planningRow.getByText("ほかの論文でも使いたいとき", { exact: true }).click();
  await planningRow.getByRole("button", { name: "ほかの論文でも使う", exact: true }).click();
  await page.getByText(/使う分野「ロボティクス・建設機械」の追加候補に入れました/).waitFor();
  assert.equal(await page.getByLabel("分野 6", { exact: true }).inputValue(), "ロボティクス・建設機械");
  assert.deepEqual(shared, initialShared, "staging a reusable term must not write the dictionary");
  await page.getByRole("button", { name: "辞書を保存", exact: true }).click();
  await page.getByText("辞書を保存しました。各論文の次の翻訳から反映します。", { exact: true }).waitFor();
  assert.deepEqual(shared[5], { source: "planning horizon", target: "予測区間", domain: "ロボティクス・建設機械" });
  assert.equal(requests.filter(r => r.method === "PUT" && r.path === "/api/glossary").length, 1);
  assert.equal(requests.some(r => r.path.endsWith("/translate") || r.path.endsWith("/glossary/select")), false, "dictionary management must not start translation or applicability jobs");
  assert.deepEqual(errors, []);
});

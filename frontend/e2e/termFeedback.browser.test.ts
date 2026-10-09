/** Read-time corrections: the term card, the automatic preview, trusted evidence and remembering without real AI calls. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createServer } from "vite";
import { chromium, type WebSocketRoute } from "playwright-core";

const CARD = { source: "policy", current: "ポリシー", count: 42, missing: 3, variants: [{ text: "ポリシィ", count: 3 }],
  dictionary: [{ target: "政策", domain: "経済" }], candidates: [], source_candidates: [] };
const NO_CARD = { source: "", current: "", count: 0, missing: 0, variants: [], dictionary: [], candidates: [], source_candidates: [] };

/** The real UI against a stand-in API: `card` answers term-card, the other routes serve a two-paragraph preview. */
async function open(t: TestContext, query: string, card: unknown, slowFirst = false) {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let events: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\/events/, socket => { events = socket; });
  let replacements = 0;  // Each apply is a job of its own; a finished job is handled once.
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (request.method() === "POST") posts.push({ path: pathname, body: request.postDataJSON() });
    const body = request.method() === "POST" ? request.postDataJSON() : {};
    const answer = pathname.endsWith("/term-card") ? (typeof card === "function" ? (card as (body: Record<string, unknown>) => unknown)(body) : card) : null;
    if (answer && typeof answer === "object" && "failure" in answer) {
      await route.fulfill({ status: 500, json: { detail: answer.failure }, headers });
      return;
    }
    // A slow answer to the first target typed, which must not be applied once the target has changed.
    if (pathname.endsWith("/term-replacement-preview") && body.target === "方策" && slowFirst) await new Promise(resolve => setTimeout(resolve, 1500));
    const json = pathname.endsWith("/term-card") ? answer
      : pathname.endsWith("/term-replacement-preview") ? { key: "a".repeat(64), changes: [1, 2].map(i => ({
        id: `p${i}`, pages: [i], source: `The learned policy is evaluated in experiment ${i}.`, text: "ポリシーを評価する。", after: `${body.target}を評価する。`,
      })) } : pathname.endsWith("/term-research") ? { job_id: "lookup" }
      : pathname.endsWith("/term-replacement") ? { job_id: `replace${++replacements}` }
      : pathname.endsWith("/reading") ? { page_count: 2, report: null }
      : pathname.includes("glossary-domains") ? { domains: [] }
      : pathname.includes("glossary") || pathname.includes("paragraphs") || pathname === "/api/jobs" ? []
      : { id: "driving", title: "Driving Policy", pages: 2 };
    await route.fulfill({ json, headers });
  });
  const finish = (id: string, kind: string, result: unknown, status = "succeeded", error: string | null = null) => {
    assert.ok(events);
    events.send(JSON.stringify({ type: "job.finished", job_id: id, paper_id: "driving", kind,
      status, running: false, cancelled: status === "cancelled", message: "", result, error }));
  };
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/termFeedback.html${query}`);
  return { page, posts, finish, errors, frontend };
}

test("a term card names the translation in use and previews the change by itself", { timeout: 90_000 }, async t => {
  const { page, posts, finish, errors, frontend } = await open(t, "", CARD);
  await page.getByText("policy → ポリシー（42段落）", { exact: true }).waitFor();
  await page.getByText("ポリシィ 3段落", { exact: true }).waitFor();
  await page.getByText("が見当たらないのは3段落です。", { exact: false }).waitFor();
  // Found by the system: no input for the source or the current translation until 変更 is pressed.
  assert.equal(await page.getByLabel("修正する原語").count(), 0);
  assert.equal(await page.getByLabel("置換前の訳語").count(), 0);
  await page.getByRole("button", { name: "Webで日本語の用例を調べる", exact: true }).click();
  await page.getByText("処理中…", { exact: true }).waitFor();
  finish("lookup", "term-research", { candidates: [{ target: "方策", explanation: "学習する方策の意味で使われています。", sources: [
    { title: "大学の講義資料", url: "https://rl.example.ac.jp/lecture.pdf", quote: "方策に従い行動を選ぶ。" },
  ] }] });
  await page.getByRole("button", { name: "この訳語を入力", exact: true }).click();
  assert.equal(await page.getByLabel("置換後の訳語").inputValue(), "方策");
  // No 確認 button: the preview appears once the input has settled.
  assert.equal(await page.getByRole("button", { name: "置換箇所を確認", exact: true }).count(), 0);
  await page.getByText("2段落が該当します。", { exact: false }).waitFor();
  assert.equal(await page.getByText("変更後：方策を評価する。", { exact: true }).count(), 2);
  assert.equal(await page.getByLabel("訳語の保存範囲").count(), 0);
  await page.getByLabel("他の論文でもこの訳語を優先する").check();
  await page.getByText("辞書に「policy」の訳が既にあります：政策（経済）。", { exact: false }).waitFor();
  assert.ok(await page.getByText("同じ原語の辞書の訳は置き換わります", { exact: false }).count());
  assert.ok(await page.getByText("部分一致", { exact: false }).count());
  await page.getByRole("checkbox", { name: "p.1 の段落を置換する" }).uncheck();
  assert.ok(await page.getByRole("group", { name: "訳語カード" }).count());
  assert.ok(await page.getByRole("group", { name: "置換の確認" }).count());
  await fs.mkdir(path.resolve(frontend, "../tmp"), { recursive: true });
  await page.screenshot({ path: path.resolve(frontend, "../tmp/term-feedback-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  assert.ok(await page.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth));
  await page.screenshot({ path: path.resolve(frontend, "../tmp/term-feedback-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "1段落を置換してPDFに反映", exact: true }).click();
  await page.getByText("処理中…", { exact: true }).waitFor();
  assert.deepEqual(posts[posts.length - 1]?.body, { source: "policy", before: "ポリシー", target: "方策",
    expected_key: "a".repeat(64), selected_ids: ["p2"], remember: "shared" });
  finish("replace1", "term-replace", { changed: 1, remember: "shared" });
  await page.getByText("1段落の訳語を置き換えました。", { exact: false }).waitFor();
  assert.equal(await page.getByRole("checkbox").count(), 0);
  assert.deepEqual(errors, []);
});

test("a variant becomes the wording to replace and the paper keeps the choice by default", { timeout: 90_000 }, async t => {
  const { page, posts, errors } = await open(t, "", CARD);
  await page.getByRole("button", { name: "ポリシィ 3段落" }).click();
  // The wording to replace is chosen and the translation in use is the new one: the preview needs no typing.
  assert.equal(await page.getByLabel("置換後の訳語").inputValue(), "ポリシー");
  await page.getByText("2段落が該当します。", { exact: false }).waitFor();
  assert.deepEqual(posts.filter(p => p.path.endsWith("/term-replacement-preview")).pop()?.body,
    { source: "policy", before: "ポリシィ", target: "ポリシー" });
  // Unselecting takes the filled translation away again.
  await page.getByRole("button", { name: "ポリシィ 3段落" }).click();
  assert.equal(await page.getByLabel("置換後の訳語").inputValue(), "");
  await page.getByRole("button", { name: "ポリシィ 3段落" }).click();
  await page.getByLabel("置換後の訳語").fill("方策");
  await page.getByText("2段落が該当します。", { exact: false }).waitFor();
  assert.deepEqual(posts.filter(p => p.path.endsWith("/term-replacement-preview")).pop()?.body,
    { source: "policy", before: "ポリシィ", target: "方策" });
  await page.getByRole("button", { name: "2段落を置換してPDFに反映", exact: true }).click();
  await page.getByText("処理中…", { exact: true }).waitFor();
  assert.equal(posts[posts.length - 1]?.body.remember, "paper");
  assert.deepEqual(errors, []);
});

test("without a match the old inputs stay and several matches are chosen from a list", { timeout: 90_000 }, async t => {
  const manual = await open(t, "?side=original&text=reward", { ...NO_CARD, source: "reward" });
  await manual.page.getByLabel("修正する原語").waitFor();
  assert.equal(await manual.page.getByLabel("修正する原語").inputValue(), "reward");
  await manual.page.getByLabel("置換前の訳語").fill("報酬");
  await manual.page.getByLabel("置換後の訳語").fill("リワード");
  await manual.page.getByText("2段落が該当します。", { exact: false }).waitFor();
  assert.deepEqual(manual.errors, []);

  // The candidates carry counts only; the card of the one picked is asked for by its source.
  const several = await open(t, "?side=translated&text=ネットワーク", (body: Record<string, unknown>) => body.side === "original"
    ? { ...CARD, source: "net", current: "ネットワーク", count: 2, missing: 1, variants: [{ text: "ネット", count: 1 }] }
    : { ...NO_CARD, candidates: [
      { ...CARD, source: "network", current: "ネットワーク", count: 8, missing: 0, variants: [] },
      { ...CARD, source: "net", current: "ネットワーク", count: 2, missing: 0, variants: [] }] });
  // Until one is picked there is nothing to type into.
  await several.page.getByRole("button", { name: "net → ネットワーク（2段落）" }).waitFor();
  assert.equal(await several.page.getByLabel("修正する原語").count(), 0);
  await several.page.getByRole("button", { name: "net → ネットワーク（2段落）" }).click();
  await several.page.getByText("net → ネットワーク（2段落）", { exact: true }).waitFor();
  await several.page.getByText("ネット 1段落", { exact: true }).waitFor();
  assert.deepEqual(several.posts.filter(p => p.path.endsWith("/term-card")).pop()?.body, { text: "net", side: "original" });
  assert.equal(await several.page.getByLabel("修正する原語").count(), 0);
  assert.deepEqual(several.errors, []);
});

test("a failed or stopped apply keeps the preview and says why, so it can be tried again", { timeout: 90_000 }, async t => {
  const { page, posts, finish, errors } = await open(t, "", CARD);
  await page.getByRole("button", { name: "訳を変える", exact: true }).click();
  await page.getByLabel("置換後の訳語").fill("方策");
  await page.getByText("2段落が該当します。", { exact: false }).waitFor();
  const apply = page.getByRole("button", { name: "2段落を置換してPDFに反映", exact: true });
  await apply.click();
  await page.getByText("処理中…", { exact: true }).waitFor();
  finish("replace1", "term-replace", null, "failed", "PDF生成に失敗したページがあります。");
  await page.getByRole("alert").filter({ hasText: "PDF生成に失敗したページがあります。" }).waitFor();
  // Nothing was lost: the preview and the button are still there.
  await apply.waitFor();
  assert.equal(await page.getByText("変更後：方策を評価する。", { exact: true }).count(), 2);
  await apply.click();
  assert.equal(await page.getByRole("alert").count(), 0);
  finish("replace2", "term-replace", null, "cancelled", "中止しました。");
  await page.getByRole("alert").filter({ hasText: "中止しました。" }).waitFor();
  await apply.click();
  assert.equal(posts.filter(p => p.path.endsWith("/term-replacement")).length, 3);
  assert.deepEqual(errors, []);
});

test("after an apply the card shows the new translation and the next change starts from it", { timeout: 90_000 }, async t => {
  let applied = false;
  const { page, posts, finish, errors } = await open(t, "", () => applied ? { ...CARD, current: "方策", count: 45, missing: 0, variants: [] } : CARD);
  await page.getByRole("button", { name: "訳を変える", exact: true }).click();
  await page.getByLabel("置換後の訳語").fill("方策");
  await page.getByText("2段落が該当します。", { exact: false }).waitFor();
  await page.getByRole("button", { name: "2段落を置換してPDFに反映", exact: true }).click();
  await page.getByText("処理中…", { exact: true }).waitFor();
  applied = true;
  finish("replace1", "term-replace", { changed: 2, remember: "paper" });
  await page.getByText("policy → 方策（45段落）", { exact: true }).waitFor();
  await page.getByText("2段落の訳語を置き換えました。", { exact: false }).waitFor();
  assert.deepEqual(posts.filter(p => p.path.endsWith("/term-card")).pop()?.body, { text: "policy", side: "original" });
  // A further change is previewed from the translation now in use, not the old one.
  await page.getByRole("button", { name: "訳を変える", exact: true }).click();
  await page.getByLabel("置換後の訳語").fill("戦略");
  await page.getByText("2段落が該当します。", { exact: false }).waitFor();
  assert.deepEqual(posts.filter(p => p.path.endsWith("/term-replacement-preview")).pop()?.body,
    { source: "policy", before: "方策", target: "戦略" });
  assert.deepEqual(errors, []);
});

test("a variant keeps the new translation the user already typed", { timeout: 90_000 }, async t => {
  const { page, errors } = await open(t, "", CARD);
  await page.getByRole("button", { name: "訳を変える", exact: true }).click();
  await page.getByLabel("置換後の訳語").fill("方策");
  await page.getByRole("button", { name: "ポリシィ 3段落" }).click();
  assert.equal(await page.getByLabel("置換後の訳語").inputValue(), "方策");
  await page.getByRole("button", { name: "ポリシィ 3段落" }).click();
  assert.equal(await page.getByLabel("置換後の訳語").inputValue(), "方策");
  assert.deepEqual(errors, []);
});

test("a failed card shows why, keeps the inputs and can be asked again", { timeout: 90_000 }, async t => {
  let failing = true;
  const { page, errors } = await open(t, "", () => failing ? { failure: "訳文を読めません" } : CARD);
  await page.getByRole("alert").filter({ hasText: "訳語カードを取得できませんでした。" }).waitFor();
  assert.equal(await page.getByLabel("修正する原語").inputValue(), "");
  assert.equal(await page.getByLabel("置換前の訳語").inputValue(), "");
  failing = false;
  await page.getByRole("button", { name: "再試行", exact: true }).click();
  await page.getByText("policy → ポリシー（42段落）", { exact: true }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.deepEqual(errors.filter(message => !message.includes("500")), []);
});

test("a blank selection asks nothing and offers the inputs, an unregistered translation offers original wording", { timeout: 90_000 }, async t => {
  const blank = await open(t, "?side=original&text=%20%20", NO_CARD);
  await blank.page.getByLabel("修正する原語").waitFor();
  assert.equal(await blank.page.getByText("訳語を調べています…", { exact: true }).count(), 0);
  assert.equal(blank.posts.filter(p => p.path.endsWith("/term-card")).length, 0);
  assert.deepEqual(blank.errors, []);

  const unknown = await open(t, "?side=translated&text=政策", { ...NO_CARD, current: "政策", count: 4,
    source_candidates: [{ text: "policy", count: 4 }, { text: "learned policy", count: 3 }] });
  assert.equal(await unknown.page.getByLabel("置換前の訳語").inputValue(), "政策");
  await unknown.page.getByRole("button", { name: "policy 4段落" }).click();
  assert.equal(await unknown.page.getByLabel("修正する原語").inputValue(), "policy");
  await unknown.page.getByLabel("置換後の訳語").fill("方策");
  await unknown.page.getByText("2段落が該当します。", { exact: false }).waitFor();
  assert.deepEqual(unknown.posts.filter(p => p.path.endsWith("/term-replacement-preview")).pop()?.body,
    { source: "policy", before: "政策", target: "方策" });
  assert.deepEqual(unknown.errors, []);
});

test("a late preview of an old target is never shown or applied", { timeout: 90_000 }, async t => {
  const { page, posts, errors } = await open(t, "", CARD, true);
  await page.getByRole("button", { name: "訳を変える", exact: true }).click();
  await page.getByLabel("置換後の訳語").fill("方策");
  // The preview of 方策 is asked for after the delay and answered slowly; the target changes meanwhile.
  await page.waitForTimeout(800);
  await page.getByLabel("置換後の訳語").fill("戦略");
  assert.equal(await page.getByRole("button", { name: /段落を置換してPDFに反映/ }).count(), 0);
  await page.getByText("変更後：戦略を評価する。", { exact: true }).first().waitFor();
  await page.waitForTimeout(2000);
  assert.equal(await page.getByText("変更後：方策を評価する。", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "2段落を置換してPDFに反映", exact: true }).click();
  assert.equal(posts[posts.length - 1]?.body.target, "戦略");
  assert.deepEqual(errors, []);
});

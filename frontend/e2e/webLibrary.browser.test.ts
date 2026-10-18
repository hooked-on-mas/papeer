/** Static Web Library on desktop/mobile. All Google requests are intercepted; no real account/data. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

test("Web Library reads PDF, memo, HTML and chat privately on desktop and mobile", { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ cacheDir: path.resolve(frontend, "../output/web-library/vite-" + randomUUID()), configFile: path.join(frontend, "vite.web.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  t.after(() => { if (errors.length) console.error("Web page errors:", errors); });
  const identity = "a".repeat(32);
  const pdf = fs.readFileSync(path.resolve(frontend, "../tests/fixtures/sample.pdf"));
  const blobs: Record<string, Buffer> = {
    pdf,
    memo: Buffer.from("# 読書メモ\n\n翻訳を読んだときの考察。\n\n- 実験条件を再確認\n- 数式の仮定を整理"),
    html: Buffer.from('<h1>関連資料</h1><script>parent.document.title="INJECTED"</script><img src="https://blocked.invalid/image">'),
    db: Buffer.from(JSON.stringify({ bookmarks: [{ paper_id: identity, page: 1, side: "original", note: "重要な付箋" }],
      messages: [{ paper_id: identity, role: "user", content: "この手法の特徴は？" },
        { paper_id: identity, role: "assistant", content: "実験条件による比較が特徴です。" }] })),
  };
  const file = (id: string, mime: string) => ({ id, mime, size: blobs[id].length,
    sha256: createHash("sha256").update(blobs[id]).digest("hex") });
  const manifest = { version: 1, revision: "test", updated_at: "2026-10-18T06:00:00Z",
    items: [{ id: identity, title: "Adaptive Control — 論文と読書ノート", kind: "pdf", collection_name: "制御工学 / 安定性" }],
    attachments: [{ id: "memo", owner_id: identity, title: "読書メモ", format: "md" },
      { id: "html", owner_id: identity, title: "関連資料", format: "html" }],
    files: { [`web/${identity}/original-annotated.pdf`]: file("pdf", "application/pdf"),
      [`papers/${identity}/attachments/memo.md`]: file("memo", "text/markdown"),
      [`papers/${identity}/attachments/html.html`]: file("html", "text/html"),
      "library-data.json": file("db", "application/json") } };
  await page.route("https://accounts.google.com/gsi/client", route => route.fulfill({ contentType: "text/javascript", body:
    'window.google={accounts:{oauth2:{initTokenClient:opts=>({requestAccessToken:()=>opts.callback({access_token:"test-token",expires_in:3600})})}}};' }));
  await page.route("https://www.googleapis.com/**", async route => {
    const request = route.request();
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    assert.equal(request.headers().authorization, "Bearer test-token");
    const url = new URL(request.url());
    const id = url.pathname.split("/").pop()!;
    if (id === "files") await route.fulfill({ json: { files: [{ id: "library", name: "papeer-library.json", modifiedTime: manifest.updated_at }] }, headers });
    else if (id === "library") await route.fulfill({ json: manifest, headers });
    else await route.fulfill({ body: blobs[id], headers });
  });
  const forbidden: string[] = [];
  page.on("request", req => { if (req.url().includes("blocked.invalid") || req.url().includes("127.0.0.1:8000")) forbidden.push(req.url()); });
  await page.goto(process.env.PAPEER_WEB_TEST_URL || server.resolvedUrls!.local[0]);
  const screenshots = path.resolve(frontend, "../output/web-library");
  fs.mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, "welcome.png"), fullPage: true });
  await page.getByRole("button", { name: "Googleでログインして開く →" }).click();
  await page.locator(".react-pdf__Page canvas").waitFor();
  assert.equal(await page.locator("[data-workspace-header]").evaluate(element => getComputedStyle(element).display), "flex");
  assert.equal(await page.locator("[data-workspace-sidebar] img").evaluate(element => element.getBoundingClientRect().width), 32);
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true);
  await page.screenshot({ path: path.join(screenshots, "desktop.png"), fullPage: true });
  const libraryAside = page.getByRole("complementary", { name: "ライブラリ一覧", exact: true });
  const leftGrip = page.locator('.workspace > [data-slot="resizable-panel-group"] > [data-slot="resizable-handle"]');
  const leftHandle = (await leftGrip.boundingBox())!;
  await page.mouse.move(leftHandle.x + leftHandle.width / 2, leftHandle.y + 100);
  await page.mouse.down(); await page.mouse.move(leftHandle.x + 30, leftHandle.y + 100, { steps: 8 }); await page.mouse.up();
  const leftWidth = (await libraryAside.boundingBox())!.width;
  assert.ok(leftWidth > 300, "library should resize like desktop");
  await page.getByRole("button", { name: "左パネルを閉じる", exact: true }).click();
  await page.getByRole("button", { name: "ライブラリを表示", exact: true }).click();
  assert.ok(Math.abs((await libraryAside.boundingBox())!.width - leftWidth) < 3);
  // The desktop's actual dock component keeps the PDF visible beside a saved memo.
  await page.getByLabel("表示倍率").selectOption("0.75");
  await page.getByRole("button", { name: "右パネルを選択" }).click();
  await page.getByRole("menuitemcheckbox", { name: "メモを右に表示", exact: true }).click();
  const right = page.getByRole("complementary", { name: "メモ（右パネル）" });
  await right.getByRole("heading", { name: "読書メモ", exact: true }).waitFor();
  await page.locator(".react-pdf__Page canvas").waitFor();
  assert.equal(await page.getByLabel("表示倍率").inputValue(), "0.75");
  assert.equal(await right.locator("textarea").count(), 0);
  const beforeWidth = (await right.boundingBox())!.width;
  const grip = page.locator('[data-reader-dock] [data-slot="resizable-handle"]');
  const handle = (await grip.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down(); await page.mouse.move(handle.x - 50, handle.y + handle.height / 2, { steps: 10 }); await page.mouse.up();
  const resizedWidth = (await right.boundingBox())!.width;
  assert.ok(resizedWidth > beforeWidth + 25, "right pane should resize like desktop");
  await page.screenshot({ path: path.join(screenshots, "desktop-panels.png"), fullPage: true });
  await right.getByRole("button", { name: "右パネルを閉じる", exact: true }).click();
  await page.getByRole("button", { name: "右パネルを選択" }).click();
  await page.getByRole("menuitemcheckbox", { name: "メモを右に表示", exact: true }).click();
  await right.waitFor();
  assert.ok(Math.abs((await right.boundingBox())!.width - resizedWidth) < 3, "right pane width survives closing");
  await page.getByRole("tab", { name: "チャット", exact: true }).click();
  assert.equal(await right.count(), 0, "right pane content must not be mounted twice under a full tab");
  await page.getByRole("tab", { name: "本文", exact: true }).click(); await right.waitFor();
  await right.getByRole("button", { name: "右パネルを閉じる", exact: true }).click();
  const tree = page.getByRole("tree", { name: "ライブラリ", exact: true });
  const paperRow = tree.getByRole("treeitem").filter({ hasText: "Adaptive Control" });
  await paperRow.getByRole("button", { name: "持ち物を開く", exact: true }).click();
  await tree.getByRole("treeitem", { name: "読書メモ", exact: true }).click();
  await page.getByRole("heading", { name: "読書メモ", exact: true }).waitFor();
  await page.getByRole("tab", { name: "本文", exact: true }).click();
  assert.equal(await page.getByLabel("表示倍率").inputValue(), "0.75", "choosing a memo must keep the PDF reading state");
  assert.match(await page.getByLabel("表示する資料").locator("option:checked").textContent() ?? "", /原文/);
  await page.getByLabel("表示する資料").selectOption({ label: "読書メモ" });
  await page.getByRole("heading", { name: "読書メモ" }).waitFor();
  await page.getByRole("tab", { name: "付箋", exact: true }).click();
  await page.getByText("重要な付箋", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "チャット", exact: true }).click();
  await page.getByText("実験条件による比較が特徴です。", { exact: true }).waitFor();
  await page.getByLabel("表示する資料").selectOption({ label: "関連資料" });
  await page.frameLocator("iframe").getByRole("heading", { name: "関連資料" }).waitFor();
  assert.equal(await page.title(), "Papeer — Web Library");
  assert.deepEqual(forbidden, []);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("表示する資料").selectOption({ label: "原文・ノート（手書き入り）" });
  await page.locator(".react-pdf__Page canvas").waitFor();
  await page.getByRole("button", { name: "右パネルを選択" }).click();
  await page.getByRole("menuitemcheckbox", { name: "メモを右に表示", exact: true }).click();
  await right.getByRole("heading", { name: "読書メモ", exact: true }).waitFor();
  const phonePanel = (await right.boundingBox())!;
  const phonePdf = (await page.getByRole("region", { name: "原文", exact: true }).boundingBox())!;
  assert.ok(phonePanel.y > phonePdf.y, "phone dock should stack while preserving PDF and memo");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(screenshots, "mobile-panels.png"), fullPage: true });
  await right.getByRole("button", { name: "右パネルを閉じる", exact: true }).click();

  await page.getByLabel("表示する資料").selectOption({ label: "読書メモ" });
  await page.getByRole("heading", { name: "読書メモ" }).waitFor();
  await page.screenshot({ path: path.join(screenshots, "mobile.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole("button", { name: "ライブラリ", exact: true }).click();
  await page.getByRole("tree", { name: "ライブラリ", exact: true }).getByRole("treeitem").filter({ hasText: "Adaptive Control" }).click();
  await page.getByLabel("表示する資料").selectOption({ label: "読書メモ" });
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await page.getByRole("button", { name: "Googleでログインして開く →" }).waitFor();
  assert.equal(await page.getByLabel("表示する資料").count(), 0);
  assert.deepEqual(errors, []);
});

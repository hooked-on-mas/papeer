/** iPhone-sized real WebKit/Chromium rendering. Google and Drive contain only synthetic fixtures. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium, webkit, devices } from "playwright-core";

for (const engine of ["webkit", "chromium"] as const) {
  test(`iPhone reading, full-width PDF, controls, ink and rotation (${engine})`, { timeout: 150_000 }, async t => {
    const frontend = path.resolve(import.meta.dirname, "..");
    const output = path.resolve(frontend, "../output/iphone-review", engine);
    fs.mkdirSync(output, { recursive: true });
    const server = await createServer({ cacheDir: path.join(output, "vite-" + randomUUID()),
      configFile: path.join(frontend, "vite.web.config.ts"), logLevel: "error",
      server: { host: "127.0.0.1", port: 0, hmr: false } });
    await server.listen(); t.after(() => server.close());
    const browser = engine === "webkit" ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: "msedge", headless: true });
    // A worker can bypass network routes, sending a mock token to the real API.
    // PWA installation/cache behavior is exercised separately by webPwa.browser.test.ts.
    const context = await browser.newContext({ ...devices["iPhone 13"], serviceWorkers: "block", viewport: { width: 390, height: 664 },
      // Chromium cannot emulate WebKit's device-specific UA behavior, but does exercise real touch.
      userAgent: engine === "webkit" ? devices["iPhone 13"].userAgent : undefined });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    t.after(async () => {
      await page.screenshot({ path: path.join(output, "final.png") }).catch(() => {});
      if (errors.length) console.error(errors);
      await browser.close();
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    // Cover the installed-app branch without pretending that Windows runs an iOS home-screen app.
    if (engine === "webkit") await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
    const paper = "a".repeat(32);
    const blobs: Record<string, Buffer> = {
      pdf: fs.readFileSync(path.resolve(frontend, "../tests/fixtures/sample.pdf")),
      ink: Buffer.from(JSON.stringify({ version: 1, pages: {}, applied: [] })),
      memo: Buffer.from("# iPhone読書メモ\n\n保存されたメモもiPhoneから確認できます。"),
      reading: Buffer.from(JSON.stringify({ version: 1, items: { [paper]: { pageCount: 2, translatedPages: {
        "1": { artifactPath: `papers/${paper}/translated.pdf`, page: 1 },
        "2": { artifactPath: `papers/${paper}/translated.pdf`, page: 2 },
      } } } })),
      db: Buffer.from(JSON.stringify({ messages: [{ paper_id: paper, role: "assistant", content: "保存されたチャットです。" }], bookmarks: [] })),
    };
    const file = (id: string, mime: string) => ({ id, mime, size: blobs[id].length, sha256: createHash("sha256").update(blobs[id]).digest("hex") });
    const manifest = { version: 1, revision: "iphone", updated_at: "2026-10-19T00:00:00Z", folder_id: "folder",
      items: [{ id: paper, title: "iPhoneでも長い論文タイトルを表示してPDFを読む", collection_name: "調査 / テスト" }],
      attachments: [{ id: "memo", owner_id: paper, title: "iPhone読書メモ", format: "md" }],
      files: { [`papers/${paper}/original.pdf`]: file("pdf", "application/pdf"), [`papers/${paper}/translated.pdf`]: file("pdf", "application/pdf"),
        [`papers/${paper}/attachments/memo.md`]: file("memo", "text/markdown"),
        "web-annotations.json": file("ink", "application/json"), "web-reading.json": file("reading", "application/json"), "library-data.json": file("db", "application/json") } };
    let uploads = 0;
    await page.route("https://accounts.google.com/gsi/client", route => route.fulfill({ contentType: "text/javascript", body:
      'window.google={accounts:{oauth2:{initTokenClient:opts=>({requestAccessToken:()=>opts.callback({access_token:"iphone-test-token",expires_in:3600})})}}};' }));
    await page.route("https://www.googleapis.com/**", async route => {
      const request = route.request(), url = new URL(request.url());
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
      assert.equal(request.headers().authorization, "Bearer iphone-test-token");
      if (request.method() === "POST") { uploads++; await route.fulfill({ json: { id: `event-${uploads}` }, headers }); return; }
      const id = url.pathname.split("/").pop()!;
      if (id === "files") await route.fulfill({ json: { files: url.searchParams.get("q")?.includes("ink-v1") ? []
        : [{ id: "library", name: "papeer-library.json", modifiedTime: manifest.updated_at }] }, headers });
      else if (id === "library") await route.fulfill({ json: manifest, headers });
      else { assert.ok(blobs[id], id); await route.fulfill({ body: blobs[id], headers }); }
    });
    await page.goto(process.env.PAPEER_WEB_TEST_URL || server.resolvedUrls!.local[0]);
    await page.getByRole("button", { name: "Googleでログインして開く →" }).tap();
    const original = page.getByRole("region", { name: "原文", exact: true });
    const ready = async () => {
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await original.locator("canvas").waitFor();
      await page.waitForFunction(() => {
        const pen = document.querySelector<HTMLButtonElement>('.ink-tools button[title="ペン"]');
        const pdf = document.querySelector(".pdf"), canvas = pdf?.querySelector("canvas");
        const zoom = Number(document.querySelector<HTMLSelectElement>('[aria-label="表示倍率"]')?.value ?? 1);
        return pen && !pen.disabled && canvas && getComputedStyle(canvas).display !== "none"
          && Math.abs(canvas.getBoundingClientRect().width - Math.floor(pdf!.getBoundingClientRect().width * zoom)) < 1
          && !!document.querySelector('[data-testid="web-ink"]');
      });
    };
    await ready();
    const fits = async (width: number) => {
      await ready();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true);
      assert.ok((await original.boundingBox())!.width >= width - 4, "phone PDF uses the full available width");
      assert.ok((await page.locator(".web-document-header").boundingBox())!.height <= 60, "account controls do not add another header row");
      assert.ok((await page.getByLabel("本文の表示操作").boundingBox())!.height <= 52, "phone reading controls stay on one row");
      for (const name of ["次のページ", "集中表示", "ペン", "文字メモ"]) {
        const box = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
        assert.ok(box.width >= 44 && box.height >= 44, `${name} has a usable touch target`);
      }
    };
    for (const [width, height] of [[320, 480], [375, 667], [390, 664], [430, 760]]) {
      await page.setViewportSize({ width, height }); await fits(width);
    }
    await page.setViewportSize({ width: 390, height: 664 }); await fits(390);
    if (engine === "webkit") assert.equal(await page.locator(".pwa-install").count(), 0);
    await page.screenshot({ path: path.join(output, "portrait.png") });
    await page.getByRole("button", { name: "次のページ", exact: true }).tap();
    await original.locator('[data-page-number="2"] canvas').waitFor();
    await page.getByRole("button", { name: "前のページ", exact: true }).tap();
    await ready();
    await page.getByRole("button", { name: "ライブラリ", exact: true }).tap();
    const search = page.getByLabel("ライブラリを検索");
    await search.fill("iPhone");
    assert.ok(Number(await search.evaluate(element => parseFloat(getComputedStyle(element).fontSize))) >= 16);
    await page.getByRole("treeitem").filter({ hasText: "iPhoneでも長い" }).tap();
    assert.equal(await page.getByRole("complementary", { name: "ライブラリ一覧", exact: true }).count(), 0);
    await page.getByLabel("表示する資料").selectOption({ label: "日本語訳" });
    const translated = page.getByRole("region", { name: "日本語訳", exact: true });
    await translated.locator("canvas").waitFor();
    await page.getByRole("button", { name: "集中表示", exact: true }).tap();
    assert.ok((await translated.boundingBox())!.height > 500);
    const ink = page.getByTestId("web-ink");
    assert.equal(await ink.evaluate(element => getComputedStyle(element).touchAction), "pinch-zoom");
    const before = await page.locator("[data-ink-id]").count();
    let area = (await ink.boundingBox())!;
    // A finger is for scrolling by default, even while the pen tool is selected.
    await page.touchscreen.tap(area.x + 100, area.y + 100);
    assert.equal(await page.locator("[data-ink-id]").count(), before);
    await translated.evaluate(element => { element.scrollTop = 0; });
    await page.getByLabel("書き込み設定", { exact: true }).tap();
    await page.getByLabel("指でも書く", { exact: true }).check();
    await page.getByLabel("書き込み設定", { exact: true }).tap();
    area = (await ink.boundingBox())!;
    await page.touchscreen.tap(area.x + 100, area.y + 100);
    await page.waitForFunction(() => document.querySelectorAll("[data-ink-id]").length === 1);
    await page.getByRole("status").filter({ hasText: "Driveに保存済み" }).waitFor();
    await page.getByRole("button", { name: "文字メモ", exact: true }).tap();
    assert.equal(await page.getByRole("button", { name: "文字メモ", exact: true }).getAttribute("aria-pressed"), "true");
    area = (await ink.boundingBox())!;
    await page.touchscreen.tap(area.x + 120, area.y + 140);
    const memo = page.getByLabel("PDFに追加するメモ");
    await memo.fill("iPhoneからの追記");
    assert.ok(await memo.evaluate(element => parseFloat(getComputedStyle(element).fontSize)) >= 16);
    // Shortened viewport models the space remaining above a keyboard (not an actual iOS keyboard).
    await page.setViewportSize({ width: 390, height: 360 });
    await page.getByRole("button", { name: "メモを保存", exact: true }).tap();
    await page.getByRole("status").filter({ hasText: "Driveに保存済み" }).waitFor();
    assert.equal(await page.locator("[data-ink-id]").count(), 2);
    await page.setViewportSize({ width: 390, height: 664 });
    await page.getByLabel("書き込み設定", { exact: true }).tap();
    await page.getByRole("button", { name: "元に戻す", exact: true }).tap();
    assert.equal(await page.locator("[data-ink-id]").count(), 1);
    await page.getByRole("button", { name: "やり直す", exact: true }).tap();
    await page.getByRole("button", { name: "書き込みを同期・再試行", exact: true }).tap();
    assert.equal(await page.locator("[data-ink-id]").count(), 2);
    await page.getByLabel("書き込み設定", { exact: true }).tap();
    await page.screenshot({ path: path.join(output, "focus-writing.png") });
    await page.getByRole("button", { name: "集中表示を終了", exact: true }).tap();
    await page.getByLabel("表示設定", { exact: true }).tap();
    await page.getByLabel("本文の表示方法").selectOption("split");
    await page.getByLabel("表示設定", { exact: true }).tap();
    await original.locator("canvas").waitFor(); await translated.locator("canvas").waitFor();
    assert.ok((await translated.boundingBox())!.y > (await original.boundingBox())!.y, "phone paired view stacks vertically");
    await page.getByLabel("表示設定", { exact: true }).tap();
    await page.getByLabel("本文の表示方法").selectOption("single");
    await page.getByLabel("表示倍率").selectOption("1.5");
    await page.getByLabel("表示設定", { exact: true }).tap();
    await translated.locator("canvas").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "zoom scrolls inside the PDF pane");
    await page.setViewportSize({ width: 844, height: 390 });
    await translated.locator("canvas").waitFor();
    await page.getByLabel("表示設定", { exact: true }).tap();
    await page.getByLabel("表示倍率").selectOption("1");
    await page.getByLabel("表示設定", { exact: true }).tap();
    await page.waitForFunction(() => {
      const canvas = document.querySelector("canvas"), pdf = document.querySelector(".pdf");
      return canvas && pdf && Math.abs(canvas.getBoundingClientRect().width - Math.floor(pdf.getBoundingClientRect().width)) < 1;
    });
    assert.ok((await translated.boundingBox())!.width >= 840);
    await page.screenshot({ path: path.join(output, "landscape.png") });
    await page.setViewportSize({ width: 390, height: 664 });
    await page.getByRole("tab", { name: "メモ", exact: true }).tap();
    await page.getByRole("heading", { name: "iPhone読書メモ", exact: true }).waitFor();
    if (engine === "chromium") {
      // Keep the direct CDP gesture separate from Playwright's touchscreen tap sequence.
      await page.getByRole("tab", { name: "本文", exact: true }).tap();
      await page.getByRole("button", { name: "集中表示", exact: true }).tap();
      await page.getByLabel("表示設定", { exact: true }).tap();
      await page.getByLabel("表示倍率").selectOption("1.5");
      await page.getByLabel("表示設定", { exact: true }).tap();
      await page.getByLabel("書き込み設定", { exact: true }).tap();
      await page.getByLabel("指でも書く", { exact: true }).uncheck();
      await page.getByLabel("書き込み設定", { exact: true }).tap();
      await page.getByRole("button", { name: "ペン", exact: true }).tap();
      await translated.locator("canvas").waitFor();
      await page.waitForFunction(() => document.querySelector(".web-pdf-pane")!.scrollHeight > document.querySelector(".web-pdf-pane")!.clientHeight + 100);
      await translated.evaluate(element => { element.scrollTop = 0; });
      area = (await ink.boundingBox())!;
      const drawn = await page.locator("[data-ink-id]").count();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: area.x + 100, y: area.y + 250 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: area.x + 100, y: area.y + 100 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      assert.ok(await translated.evaluate(element => element.scrollTop) > 80, "finger swipe scrolls the PDF");
      assert.equal(await page.locator("[data-ink-id]").count(), drawn, "scrolling must not draw a line");
      await page.getByRole("button", { name: "集中表示を終了", exact: true }).click();
    }
    await page.getByRole("button", { name: "Google接続メニュー", exact: true }).click();
    await page.getByRole("menuitem", { name: "ログアウト", exact: true }).click();
    await page.getByRole("heading", { name: "論文を選んで、読み始めよう" }).waitFor();
    assert.ok(uploads >= 2);
    assert.deepEqual(errors, []);
  });
}

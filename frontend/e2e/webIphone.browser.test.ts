/** iPhone-sized real WebKit/Chromium rendering. Google and Drive contain only synthetic fixtures. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
    const japanese = spawnSync("uv", ["run", "python", "-c", `import sys, pymupdf
pdf = pymupdf.open()
for number in [1, 2]:
 page = pdf.new_page(width=600, height=840)
 page.insert_text((32, 45), "日本語訳を読みやすく表示する", fontname="japan", fontsize=22)
 for line in range(18):
  page.insert_text((32, 90 + line * 30), f"翻訳された論文の本文です。第{number}ページ。", fontname="japan", fontsize=15)
sys.stdout.buffer.write(pdf.tobytes())`], { cwd: path.resolve(frontend, ".."), maxBuffer: 8 * 1024 * 1024 });
    assert.equal(japanese.status, 0, japanese.stderr.toString());
    const blobs: Record<string, Buffer> = {
      jp: japanese.stdout,
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
      files: { [`papers/${paper}/original.pdf`]: file("pdf", "application/pdf"), [`papers/${paper}/translated.pdf`]: file("jp", "application/pdf"),
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
        : [{ id: "library", name: "papeer-library.json", modifiedTime: manifest.updated_at },
          { id: "second-library", name: "papeer-library.json", modifiedTime: manifest.updated_at }] }, headers });
      else if (id === "library" || id === "second-library") await route.fulfill({ json: manifest, headers });
      else { assert.ok(blobs[id], id); await route.fulfill({ body: blobs[id], headers }); }
    });
    await page.goto(process.env.PAPEER_WEB_TEST_URL || server.resolvedUrls!.local[0]);
    await page.getByRole("button", { name: "Googleでログインして開く →" }).tap();
    const original = page.getByRole("region", { name: "原文", exact: true });
    const translated = page.getByRole("region", { name: "日本語訳", exact: true });
    const ink = page.getByTestId("web-ink");
    const ready = async (region = translated) => {
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await region.locator("canvas").waitFor();
      await page.waitForFunction(() => {
        const pdf = document.querySelector(".pdf"), canvas = pdf?.querySelector("canvas");
        const zoom = Number(document.querySelector<HTMLSelectElement>('[aria-label="表示倍率"]')?.value ?? 1);
        return canvas && getComputedStyle(canvas).display !== "none"
          && Math.abs(canvas.getBoundingClientRect().width - Math.floor(pdf!.getBoundingClientRect().width * zoom)) < 1
          && !!document.querySelector('[data-testid="web-ink"]');
      });
    };
    const menu = page.getByLabel("読書メニュー", { exact: true });
    const openMenu = async () => { if (!await menu.evaluate(element => (element.parentElement as HTMLDetailsElement).open)) await menu.tap(); };
    const closeMenu = async () => { if (await menu.evaluate(element => (element.parentElement as HTMLDetailsElement).open)) await menu.tap(); };
    const writing = async (enabled: boolean) => {
      await openMenu();
      await page.getByRole("button", { name: enabled ? "書き込みを開始" : "書き込みを終了", exact: true }).tap();
    };
    const fits = async (width: number, height: number, region = translated) => {
      await ready(region);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true);
      const bounds = (await region.boundingBox())!;
      assert.ok(bounds.width >= width - 4, "PDF uses the full phone width");
      assert.ok(bounds.y <= 52 && bounds.height >= height - 90, `PDF height ${bounds.height} at ${width}x${height}; reading opens without choosing focus mode`);
      assert.equal(await page.getByLabel("表示する資料").count(), 0, "no raw file selector on phones");
      assert.equal(await page.locator(".ink-tools").count(), 0, "writing tools are opt-in");
      assert.equal(await page.locator(".web-document-header").isVisible(), false);
      assert.equal(await page.locator(".site-footer").isVisible(), false);
      assert.ok((await page.getByLabel("本文の表示操作").boundingBox())!.height <= 50);
      for (const name of ["次のページ", "ライブラリ"]) {
        const box = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
        assert.ok(box.width >= 44 && box.height >= 44, `${name} has a usable touch target`);
      }
    };
    await ready();
    assert.equal(await page.getByText("保存ライブラリ", { exact: false }).isVisible(), false);
    await openMenu();
    assert.equal(await page.getByLabel("保存ライブラリ").locator("option").count(), 2);
    await closeMenu();
    assert.match(await translated.locator(".react-pdf__Page").textContent() ?? "", /日本語訳を読みやすく表示する/);
    assert.equal(await original.count(), 0, "saved Japanese translation opens without file selection");
    for (const [width, height] of [[320, 480], [375, 667], [390, 664], [430, 760]]) {
      await page.setViewportSize({ width, height }); await fits(width, height);
    }
    await page.setViewportSize({ width: 390, height: 664 }); await fits(390, 664);
    await page.screenshot({ path: path.join(output, "portrait.png") });
    await page.getByRole("button", { name: "原文を表示", exact: true }).tap();
    await fits(390, 664, original);
    assert.match(await original.locator(".react-pdf__Page").textContent() ?? "", /Adaptive Control/);
    await page.screenshot({ path: path.join(output, "original.png") });
    await page.getByRole("button", { name: "日本語訳を表示", exact: true }).tap();
    await ready();
    await page.getByRole("button", { name: "次のページ", exact: true }).tap();
    await translated.locator('[data-page-number="2"] canvas').waitFor();
    await page.getByRole("button", { name: "前のページ", exact: true }).tap();
    await ready();
    await page.getByRole("button", { name: "ライブラリ", exact: true }).tap();
    const search = page.getByLabel("ライブラリを検索");
    await search.fill("iPhone");
    assert.ok(Number(await search.evaluate(element => parseFloat(getComputedStyle(element).fontSize))) >= 16);
    await page.getByRole("treeitem").filter({ hasText: "iPhoneでも長い" }).tap();
    assert.equal(await page.getByRole("complementary", { name: "ライブラリ一覧", exact: true }).count(), 0);
    await ready();
    assert.equal(await ink.evaluate(element => getComputedStyle(element).touchAction), "auto");
    assert.equal(await ink.evaluate(element => getComputedStyle(element).pointerEvents), "none");
    let area = (await ink.boundingBox())!;
    await page.touchscreen.tap(area.x + 100, area.y + 100);
    assert.equal(await page.locator("[data-ink-id]").count(), 0);
    await writing(true);
    await page.getByRole("button", { name: "ペン", exact: true }).waitFor();
    assert.equal(await ink.evaluate(element => getComputedStyle(element).touchAction), "pinch-zoom");
    await page.getByLabel("書き込み設定", { exact: true }).tap();
    await page.getByLabel("指でも書く", { exact: true }).check();
    await page.getByLabel("書き込み設定", { exact: true }).tap();
    area = (await ink.boundingBox())!;
    await page.touchscreen.tap(area.x + 100, area.y + 100);
    await page.waitForFunction(() => document.querySelectorAll("[data-ink-id]").length === 1);
    await page.getByRole("status").filter({ hasText: "Driveに保存済み" }).waitFor();
    await page.getByRole("button", { name: "文字メモ", exact: true }).tap();
    area = (await ink.boundingBox())!;
    await page.touchscreen.tap(area.x + 120, area.y + 140);
    const memo = page.getByLabel("PDFに追加するメモ");
    await memo.fill("iPhoneからの追記");
    assert.ok(await memo.evaluate(element => parseFloat(getComputedStyle(element).fontSize)) >= 16);
    await page.setViewportSize({ width: 390, height: 360 });
    await page.getByRole("button", { name: "メモを保存", exact: true }).tap();
    await page.getByRole("status").filter({ hasText: "Driveに保存済み" }).waitFor();
    assert.equal(await page.locator("[data-ink-id]").count(), 2);
    await page.setViewportSize({ width: 390, height: 664 });
    await page.getByLabel("書き込み設定", { exact: true }).tap();
    await page.getByRole("button", { name: "元に戻す", exact: true }).tap();
    assert.equal(await page.locator("[data-ink-id]").count(), 1);
    await page.getByRole("button", { name: "やり直す", exact: true }).tap();
    await page.getByLabel("書き込み設定", { exact: true }).tap();
    await page.screenshot({ path: path.join(output, "focus-writing.png") });
    await writing(false);
    await fits(390, 664);
    assert.equal(await page.locator("[data-ink-id]").count(), 2, "reading mode keeps the saved annotations visible");
    await openMenu();
    assert.ok(await page.getByRole("link", { name: "PDF本体を保存", exact: true }).getAttribute("href"));
    await page.getByLabel("本文の表示方法").selectOption("split");
    await closeMenu();
    await original.locator("canvas").waitFor(); await translated.locator("canvas").waitFor();
    assert.ok((await translated.boundingBox())!.y > (await original.boundingBox())!.y);
    await openMenu();
    await page.getByLabel("本文の表示方法").selectOption("single");
    await page.getByLabel("表示倍率").selectOption("1.5");
    await closeMenu();
    await translated.locator("canvas").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 844, height: 390 });
    await openMenu(); await page.getByLabel("表示倍率").selectOption("1"); await closeMenu();
    await fits(844, 390);
    await page.screenshot({ path: path.join(output, "landscape.png") });
    await page.setViewportSize({ width: 390, height: 664 });
    await openMenu();
    await page.getByRole("button", { name: "メモを開く", exact: true }).tap();
    await page.getByRole("heading", { name: "iPhone読書メモ", exact: true }).waitFor();
    await page.getByRole("tab", { name: "本文", exact: true }).tap();
    await fits(390, 664);
    if (engine === "chromium") {
      await writing(true);
      await page.getByLabel("書き込み設定", { exact: true }).tap();
      await page.getByLabel("指でも書く", { exact: true }).uncheck();
      await page.getByLabel("書き込み設定", { exact: true }).tap();
      await page.getByRole("button", { name: "ペン", exact: true }).tap();
      await openMenu(); await page.getByLabel("表示倍率").selectOption("1.5"); await closeMenu();
      await ready();
      await translated.evaluate(element => { element.scrollTop = 0; });
      area = (await ink.boundingBox())!;
      const drawn = await page.locator("[data-ink-id]").count();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: area.x + 100, y: area.y + 250 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: area.x + 100, y: area.y + 100 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      assert.ok(await translated.evaluate(element => element.scrollTop) > 80);
      assert.equal(await page.locator("[data-ink-id]").count(), drawn);
    }
    await menu.click();
    await page.getByRole("button", { name: "Google接続メニュー", exact: true }).click();
    await page.getByRole("menuitem", { name: "ログアウト", exact: true }).click();
    await page.getByRole("heading", { name: "論文を選んで、読み始めよう" }).waitFor();
    assert.ok(uploads >= 2);
    assert.deepEqual(errors, []);
  });
}

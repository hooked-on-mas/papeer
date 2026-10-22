/** The same dimensions must behave alike with touch, mouse and different browser UAs. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium, webkit } from "playwright-core";

for (const variant of ["mouse", "touch", "webkit"] as const) {
  test(`reader adapts to available space and preserves editing (${variant})`, { timeout: 120_000 }, async t => {
    const frontend = path.resolve(import.meta.dirname, "..");
    const output = path.resolve(frontend, "../output/pwa/responsive", variant);
    fs.mkdirSync(output, { recursive: true });
    const server = await createServer({ cacheDir: path.join(output, "vite-" + randomUUID()),
      configFile: path.join(frontend, "vite.web.config.ts"), logLevel: "error", server: { host: "127.0.0.1", port: 0, hmr: false } });
    await server.listen(); t.after(() => server.close());
    const browser = variant === "webkit" ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext({ viewport: { width: 834, height: 1194 }, hasTouch: variant !== "mouse",
      userAgent: variant === "touch" ? "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36" : undefined,
      serviceWorkers: "block" });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
      await page.screenshot({ path: path.join(output, "final.png") }).catch(() => {});
      if (errors.length) console.error(errors);
      await browser.close();
    });
    const paper = "a".repeat(32);
    // A chart/report followed by a landscape table exercises fitting across page shapes.
    const pdf = fs.readFileSync(path.resolve(frontend, "../tests/fixtures/reader-mixed-orientation.pdf"));
    const reading = Buffer.from(JSON.stringify({ version: 1, items: { [paper]: { pageCount: 2, translatedPages: {
      "1": { artifactPath: `papers/${paper}/translated.pdf`, page: 1 }, "2": { artifactPath: `papers/${paper}/translated.pdf`, page: 2 },
    } } } }));
    const blobs: Record<string, Buffer> = { original: pdf, translated: pdf, reading };
    const file = (id: string) => ({ id, size: blobs[id].length, mime: id === "reading" ? "application/json" : "application/pdf",
      sha256: createHash("sha256").update(blobs[id]).digest("hex") });
    const manifest = { version: 1, revision: "responsive", updated_at: "2026-10-22T00:00:00Z", folder_id: "folder",
      items: [{ id: paper, title: "画面の広さに合わせて読む資料" }], attachments: [], files: {
        [`papers/${paper}/original.pdf`]: file("original"), [`papers/${paper}/translated.pdf`]: file("translated"), "web-reading.json": file("reading"),
      } };
    await context.route("https://accounts.google.com/gsi/client", route => route.fulfill({ contentType: "text/javascript", body:
      'window.google={accounts:{oauth2:{initTokenClient:opts=>({requestAccessToken:()=>opts.callback({access_token:"responsive-test",expires_in:3600})})}}};' }));
    await context.route("https://www.googleapis.com/**", async route => {
      const req = route.request(), url = new URL(req.url());
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
      if (req.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
      assert.equal(req.headers().authorization, "Bearer responsive-test");
      if (req.method() === "POST") { await route.fulfill({ json: { id: "saved-operation" }, headers }); return; }
      const id = url.pathname.split("/").pop()!;
      if (id === "files") await route.fulfill({ json: { files: url.searchParams.get("q")?.includes("ink-v1") ? []
        : [{ id: "library", name: "papeer-library.json", modifiedTime: manifest.updated_at }] }, headers });
      else if (id === "library") await route.fulfill({ json: manifest, headers });
      else { assert.ok(blobs[id], id); await route.fulfill({ body: blobs[id], headers }); }
    });
    await page.goto(process.env.PAPEER_WEB_TEST_URL || server.resolvedUrls!.local[0]);
    await page.getByRole("button", { name: "Googleでログインして開く →", exact: true }).click();
    const reader = page.locator(".web-document-reader");
    const translated = page.getByRole("region", { name: "日本語訳", exact: true });
    const original = page.getByRole("region", { name: "原文", exact: true });
    const mode = page.getByLabel("本文の表示方法");
    const layout = async (value: string) => page.waitForFunction(expected => document.querySelector(".web-document-reader")?.getAttribute("data-layout") === expected, value);
    const ready = async () => {
      await translated.locator('[data-page-number="2"] canvas').waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('.ink-tools button')].some(button => button.title === "ペン" && !button.disabled));
    };
    await mode.waitFor();
    assert.equal(await mode.inputValue(), "auto");
    await layout("single");
    assert.equal(await page.locator(".web-document-header").isVisible(), true);
    assert.equal((await page.locator(".web-document-header .header-actions").innerText()).trim(), "", "authenticated account controls do not show Google login text above the reader");
    assert.equal(await page.locator(".local-library-notice").count(), 0);
    assert.equal(await page.getByRole("toolbar", { name: "PDFの書き込みツール" }).isVisible(), true);
    await page.setViewportSize({ width: 560, height: 900 });
    await original.locator("canvas").waitFor();
    assert.equal(await translated.count(), 0, "resizing preserves the initially displayed language too");
    await page.setViewportSize({ width: 834, height: 1194 });
    await page.getByRole("button", { name: "日本語訳を表示", exact: true }).click();
    await page.getByRole("button", { name: "次のページ", exact: true }).click();
    await ready();
    await translated.getByRole("button", { name: "ペン", exact: true }).click();
    const ink = translated.getByTestId("web-ink"); const box = (await ink.boundingBox())!;
    await page.mouse.move(box.x + 100, box.y + 100); await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + 120, { steps: 4 }); await page.mouse.up();
    await translated.locator("[data-ink-id]").waitFor();
    await page.setViewportSize({ width: 1194, height: 834 });
    await layout("split"); await ready();
    await original.locator('[data-page-number="2"] canvas').waitFor();
    assert.equal(await page.getByLabel("ページ番号").inputValue(), "2");
    assert.equal(await translated.locator("[data-ink-id]").count(), 1);
    assert.ok((await translated.boundingBox())!.x > (await original.boundingBox())!.x);
    await page.screenshot({ path: path.join(output, "wide-paired.png") });
    // Changing the space occupied by the library also changes the reader's layout.
    await page.setViewportSize({ width: 1201, height: 834 }); await layout("split");
    await page.getByRole("button", { name: "ライブラリ", exact: true }).click(); await layout("single");
    await page.getByRole("button", { name: "ライブラリ", exact: true }).click(); await layout("split");
    // The toolbar follows its own available width even when the browser stays wide.
    await page.locator(".web-reader-main").evaluate(element => { element.style.maxWidth = "660px"; });
    await layout("single");
    const menu = page.getByLabel("読書メニュー", { exact: true }); await menu.waitFor();
    assert.equal(await page.getByRole("button", { name: "書き込みを終了", exact: true }).isVisible(), true);
    await menu.click(); await mode.waitFor(); await menu.click();
    await page.locator(".web-reader-main").evaluate(element => { element.style.maxWidth = ""; });
    await layout("split");
    await mode.selectOption("single"); await layout("single");
    await page.setViewportSize({ width: 834, height: 1194 }); await layout("single");
    await page.setViewportSize({ width: 1194, height: 834 });
    assert.equal(await mode.inputValue(), "single"); await layout("single");
    await mode.selectOption("auto"); await layout("split");
    await page.setViewportSize({ width: 1024, height: 1366 }); await layout("single"); await ready();
    await page.screenshot({ path: path.join(output, "tall-single.png") });
    assert.equal(await translated.locator("[data-ink-id]").count(), 1);
    // Keyboard/focus changes do not replace an in-progress memo editor.
    await translated.getByRole("button", { name: "文字メモ", exact: true }).click();
    await translated.getByTestId("web-ink").click({ position: { x: 120, y: 150 } });
    const memo = page.getByLabel("PDFに追加するメモ"); await memo.fill("回転しても残る下書き");
    await page.setViewportSize({ width: 1194, height: 834 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await reader.getAttribute("data-layout"), "single");
    assert.equal(await memo.inputValue(), "回転しても残る下書き");
    await memo.blur(); await layout("split");
    assert.equal(await memo.inputValue(), "回転しても残る下書き");
    await page.getByRole("button", { name: "キャンセル", exact: true }).click();
    await page.setViewportSize({ width: 560, height: 900 }); await layout("single"); await ready();
    assert.equal(await page.getByRole("button", { name: "書き込みを終了", exact: true }).isVisible(), true);
    assert.equal(await page.getByRole("toolbar", { name: "PDFの書き込みツール" }).isVisible(), true);
    assert.equal(await translated.locator("[data-ink-id]").count(), 1);
    await page.screenshot({ path: path.join(output, "narrow-writing.png") });
    await page.getByRole("button", { name: "書き込みを終了", exact: true }).click();
    await page.setViewportSize({ width: 1194, height: 834 }); await layout("split");
    assert.equal(await page.getByRole("toolbar", { name: "PDFの書き込みツール" }).count(), 0, "reading mode survives widening the window");
    await page.getByRole("button", { name: "書き込みを開始", exact: true }).click();
    await page.setViewportSize({ width: 834, height: 1194 }); await layout("single"); await ready();
    await page.reload();
    await ready();
    assert.equal(await page.getByRole("toolbar", { name: "PDFの書き込みツール" }).isVisible(), true);
    assert.equal(await translated.locator("[data-ink-id]").count(), 1);
    await mode.selectOption("single"); await layout("single");
    const zoom = page.getByLabel("表示倍率", { exact: true });
    await zoom.selectOption("page");
    const fits = async (portrait: boolean) => {
      await page.waitForFunction(expectPortrait => {
        const pane = document.querySelector('.web-pdf-pane'), canvas = pane?.querySelector('canvas');
        if (!pane || !canvas) return false;
        const overlay = pane.querySelector('[data-testid="web-ink"]');
        if (!overlay) return false;
        const p = pane.getBoundingClientRect(), c = canvas.getBoundingClientRect(), o = overlay.getBoundingClientRect();
        return (c.height > c.width) === expectPortrait && c.width > 100 && c.height > 100
          && c.left >= p.left - 1 && c.right <= p.right + 1 && c.bottom <= p.bottom - 1
          && Math.abs(c.width - o.width) < 2 && Math.abs(c.height - o.height) < 2;
      }, portrait);
      const canvas = (await translated.locator("canvas").boundingBox())!, overlay = (await translated.getByTestId("web-ink").boundingBox())!;
      assert.ok(Math.abs(canvas.width - overlay.width) < 2 && Math.abs(canvas.height - overlay.height) < 2, "fitting keeps ink aligned with the PDF");
    };
    await fits(false);
    await page.setViewportSize({ width: 1194, height: 740 }); await fits(false);
    await page.getByRole("button", { name: "前のページ", exact: true }).click(); await fits(true);
    await page.getByRole("button", { name: "書き込みを終了", exact: true }).click(); await fits(true);
    await page.reload(); await zoom.waitFor(); assert.equal(await zoom.inputValue(), "page"); await fits(true);
    const fitted = (await translated.locator("canvas").boundingBox())!;
    const at = { x: fitted.x + fitted.width * .5, y: fitted.y + fitted.height * .35 };
    await translated.locator("canvas").evaluate((canvas, point) => {
      for (const [type, scale] of [["gesturestart", 1], ["gesturechange", 4], ["gestureend", 4]] as const) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { scale, clientX: point.x, clientY: point.y }); canvas.dispatchEvent(event);
      }
    }, at);
    await page.waitForFunction(() => {
      const pane = document.querySelector('.web-pdf-pane'), canvas = pane?.querySelector('canvas'), ink = pane?.querySelector('[data-testid="web-ink"]');
      return !!canvas && !!ink && !document.querySelector('.pdf-fit-page') && canvas.getBoundingClientRect().width > pane!.clientWidth;
    });
    const enlarged = (await translated.locator("canvas").boundingBox())!;
    assert.ok(Math.abs(enlarged.x + enlarged.width * .5 - at.x) < 3, "pinching a centered fitted page keeps the horizontal anchor");
    assert.ok(Math.abs(enlarged.y + enlarged.height * .35 - at.y) < 3, "pinching keeps the vertical anchor too");
    await zoom.selectOption("1.25");
    await page.waitForFunction(() => {
      const pane = document.querySelector('.web-pdf-pane'), canvas = pane?.querySelector('canvas');
      return !!pane && !!canvas && canvas.getBoundingClientRect().width > pane.getBoundingClientRect().width * 1.2;
    });
    assert.equal(await translated.locator(".pdf-fit-page").count(), 0, "custom zoom leaves page fitting");
    await page.setViewportSize({ width: 768, height: 900 });
    await menu.waitFor();
    assert.ok((await page.locator(".web-reader-tools").boundingBox())!.height <= 50, "controls use their menu before wrapping into another row");
    for (const control of await page.locator('.web-page-navigation > button, .web-page-navigation > input').all()) {
      assert.ok((await control.boundingBox())!.height >= 44, "page navigation retains its touch target height");
    }
    assert.deepEqual(errors, []);
  });
}

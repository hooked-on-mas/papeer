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
    const output = path.resolve(process.env.PAPEER_SCREENSHOT_DIR || path.resolve(frontend, "../output/iphone-review"), engine);
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
    const capture = async (name: string) => page.screenshot({ path: path.join(output, name + ".png"), scale: "css" });
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
      items: [{ id: paper, title: "iPhoneでも長い論文タイトルを表示してPDFを読む — 日本語訳・原文と手書きメモを確認するための資料", collection_name: "調査 / テスト" }],
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
    const appUrl = process.env.PAPEER_WEB_TEST_URL || server.resolvedUrls!.local[0];
    if (engine === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(appUrl).origin });
    else await page.addInitScript(() => {
      // WebKit on Windows cannot grant/read the OS clipboard. Verify the copy API
      // payload here; Chromium below exercises a real headless clipboard round trip.
      let copied = "";
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (value: string) => { copied = value; }, readText: async () => copied } });
    });
    await page.goto(appUrl);
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
      assert.ok(bounds.y <= 80 && bounds.height >= height - 118, `PDF height ${bounds.height} at ${width}x${height}; reading opens without choosing focus mode`);
      const title = page.getByRole("heading", { name: manifest.items[0].title, exact: true });
      assert.equal(await title.isVisible(), true);
      assert.equal(await title.getAttribute("title"), manifest.items[0].title);
      assert.equal((await title.boundingBox())!.height, 28, "long titles stay in a compact single line");
      assert.equal(await title.evaluate(element => getComputedStyle(element).textOverflow), "ellipsis");
      if (width <= 430) assert.ok(await title.evaluate(element => element.scrollWidth > element.clientWidth), "long titles truncate rather than reducing PDF height");
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
    const copySelection = async (mouse = false) => {
      const selected = await page.evaluate(() => getSelection()?.toString() ?? "");
      assert.ok(selected.trim());
      const copy = page.getByRole("button", { name: "選択した文字をコピー", exact: true });
      if (mouse) await copy.click(); else await copy.tap();
      await page.getByText("コピーしました", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), selected);
      await page.getByRole("button", { name: "文字選択を解除", exact: true }).click();
      assert.equal(await page.evaluate(() => getSelection()?.toString() ?? ""), "");
    };
    const selectText = async (region = translated, quote = "日本語訳を読みやすく表示する") => {
      const span = region.locator(".textLayer span").filter({ hasText: quote }).first();
      await span.waitFor();
      const box = (await span.boundingBox())!;
      await page.mouse.move(box.x + 1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
      const selected = await page.evaluate(() => getSelection()?.toString() ?? "");
      assert.ok(selected.length > 0 && quote.includes(selected), "PDF text can be selected by dragging");
      await capture("text-selection-css");
      await copySelection();
    };
    const longSelect = async (region = translated, quote = "日本語訳を読みやすく表示する", extend = false) => {
      await region.evaluate(element => element.scrollTo(0, 0));
      const span = region.locator(".textLayer span").filter({ hasText: quote }).first();
      const box = (await span.boundingBox())!;
      const point = { x: box.x + 3, y: box.y + box.height / 2 };
      const target = await page.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y)!, point);
      assert.equal(await target.evaluate((element, at) => {
        const event = new Event("touchstart", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", { value: [{ identifier: 79, clientX: at.x, clientY: at.y }] });
        return !element.dispatchEvent(event);
      }, point), false, "a single finger is not cancelled, preserving native long-press selection");
      assert.deepEqual(await region.evaluate(element => [".react-pdf__Page", "canvas", ".textLayer", ".textLayer span"]
        .map(selector => getComputedStyle(element.querySelector(selector)!).webkitUserSelect)), ["none", "none", "none", "text"],
      "only PDF text runs are selectable, so iOS cannot select the whole page");
      // iOS selects the enclosing block when its long-press misses a glyph.
      await region.evaluate(element => getSelection()!.selectAllChildren(element.querySelector(".react-pdf__Page")!));
      await page.waitForFunction(text => { const value = getSelection()?.toString() ?? ""; return !!value.trim() && text.includes(value); }, quote);
      await page.getByRole("toolbar", { name: "選択した文字の操作", exact: true }).waitFor();
      const selected = await page.evaluate(() => getSelection()?.toString() ?? "");
      assert.ok(selected.trim() && quote.includes(selected), "long-press selects real PDF text without setting a selection in the test");
      if (extend) {
        await target.evaluate((element, at) => {
          const event = new Event("touchmove", { bubbles: true, cancelable: true });
          Object.defineProperty(event, "touches", { value: [{ identifier: 79, clientX: at.x, clientY: at.y }] });
          element.dispatchEvent(event);
        }, { x: Math.min(box.x + box.width - 3, 370), y: point.y });
        assert.ok((await page.evaluate(() => getSelection()?.toString() ?? "")).length > selected.length, "dragging after long-press extends the selection");
      }
      await target.evaluate(element => {
        const event = new Event("touchend", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", { value: [] }); element.dispatchEvent(event);
      });
      await capture("long-press-selection-css");
      await copySelection(); await target.dispose();
    };
    await selectText();
    await longSelect(undefined, undefined, true);
    assert.equal(await page.getByText("保存ライブラリ", { exact: false }).isVisible(), false);
    await openMenu();
    assert.equal(await page.getByLabel("保存ライブラリ").locator("option").count(), 2);
    assert.equal(await page.getByLabel("保存ライブラリ").evaluate(select => {
      const range = document.createRange(); range.selectNodeContents(select.closest("label")!.firstChild!);
      return range.getClientRects().length;
    }), 1, "the library label stays on one line instead of one character per row");
    await closeMenu();
    assert.match(await translated.locator(".react-pdf__Page").textContent() ?? "", /日本語訳を読みやすく表示する/);
    assert.equal(await original.count(), 0, "saved Japanese translation opens without file selection");
    for (const [width, height] of [[320, 480], [375, 667], [390, 664], [430, 760]]) {
      await page.setViewportSize({ width, height }); await fits(width, height);
      await capture(`${width}x${height}-japanese`);
      if (width === 320) {
        await openMenu();
        const popup = (await page.locator(".web-display-options > div").boundingBox())!;
        assert.ok(popup.y + popup.height <= height, "the menu fits below the title on short screens");
        await capture("320-menu"); await closeMenu();
      }
    }
    await page.setViewportSize({ width: 390, height: 664 }); await fits(390, 664);
    await page.screenshot({ path: path.join(output, "portrait.png") });
    await capture("portrait-css");
    await openMenu(); await capture("menu-css"); await closeMenu();
    await page.getByRole("button", { name: "原文を表示", exact: true }).tap();
    await fits(390, 664, original);
    assert.match(await original.locator(".react-pdf__Page").textContent() ?? "", /Adaptive Control/);
    await page.screenshot({ path: path.join(output, "original.png") });
    await capture("original-css");
    await selectText(original, "Abstract");
    await longSelect(original, "Abstract");
    await page.getByRole("button", { name: "本文を拡大", exact: true }).tap();
    assert.equal(await page.getByLabel("表示倍率").inputValue(), "1.5");
    await ready(original); await capture("original-150-css");
    await longSelect(original, "Abstract");
    await page.getByRole("button", { name: "幅に合わせる", exact: true }).tap();
    await page.getByRole("button", { name: "日本語訳を表示", exact: true }).tap();
    await ready();
    // WebKit's automation has no multi-touch input API. Exercise its actual TouchEvent
    // listeners with cancelable events; real two-finger input is covered by Chromium below.
    const headerBeforePinch = (await page.getByLabel("本文の表示操作").boundingBox())!;
    const syntheticPinch = await translated.locator(".web-pdf-surface").evaluate(surface => {
      const bounds = surface.getBoundingClientRect(), x = bounds.left + 190, y = bounds.top + 220;
      const send = (type: string, half: number) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", { value: type === "touchend" || type === "touchcancel" ? []
          : [{ identifier: 1, clientX: x - half, clientY: y }, { identifier: 2, clientX: x + half, clientY: y }] });
        return !surface.dispatchEvent(event);
      };
      const start = send("touchstart", 50), move = send("touchmove", 100);
      const preview = getComputedStyle(surface).transform;
      const end = send("touchend", 0);
      return { start, move, end, preview };
    });
    assert.ok(syntheticPinch.start && syntheticPinch.move && syntheticPinch.end, "PDF pinch cancels viewport zoom");
    assert.match(syntheticPinch.preview, /^matrix\(2,/);
    await ready();
    assert.equal(await page.getByLabel("表示倍率").inputValue(), "2");
    const headerAfterPinch = (await page.getByLabel("本文の表示操作").boundingBox())!;
    assert.deepEqual(headerAfterPinch, headerBeforePinch, "pinch leaves the header in place at its original size");
    const anchoredScroll = await translated.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }));
    assert.ok(anchoredScroll.left >= 180 && anchoredScroll.top >= 210, "the document stays anchored under the pinch midpoint");
    await page.getByRole("button", { name: "原文を表示", exact: true }).tap();
    await ready(original);
    assert.equal(await page.getByLabel("表示倍率").inputValue(), "2", "language switching keeps the zoom");
    assert.deepEqual(await page.getByLabel("本文の表示操作").boundingBox(), headerBeforePinch);
    await capture("pinch-original-css");
    await page.getByRole("button", { name: "日本語訳を表示", exact: true }).tap();
    await ready(); await capture("pinch-japanese-css");
    await longSelect();
    assert.equal(await page.getByLabel("表示倍率").inputValue(), "2");
    await translated.locator(".web-pdf-surface").evaluate(surface => {
      for (const type of ["touchstart", "touchmove", "touchcancel"]) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", { value: [{ identifier: 1, clientX: 100, clientY: 250 },
          { identifier: 2, clientX: type === "touchmove" ? 300 : 200, clientY: 250 }] });
        surface.dispatchEvent(event);
      }
    });
    assert.equal(await translated.locator(".web-pdf-surface").evaluate(surface => surface.style.transform), "", "interrupted pinch clears its preview");
    assert.equal(await page.getByLabel("表示倍率").inputValue(), "2", "cancelled pinch keeps the previous zoom");
    await page.getByRole("button", { name: "幅に合わせる", exact: true }).tap(); await ready();
    // iOS sends gesturestart BEFORE the second touchstart. Its GestureEvent target
    // can be the PDF viewport/common ancestor, rather than the canvas or ink surface.
    const safariPinch = await translated.evaluate(pane => {
      const surface = pane.querySelector<HTMLElement>(".web-pdf-surface")!;
      const bounds = pane.getBoundingClientRect(), x = bounds.left + 150, y = bounds.top + 150;
      const touch = (type: string, half: number) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : half === 0
          ? [{ identifier: 1, clientX: x, clientY: y }]
          : [{ identifier: 1, clientX: x - half, clientY: y }, { identifier: 2, clientX: x + half, clientY: y }] });
        return !pane.dispatchEvent(event);
      };
      const gesture = (type: string, scale: number) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { scale: { value: scale }, clientX: { value: x }, clientY: { value: y } });
        // Model a common-ancestor target outside the surface. The first finger owns the PDF gesture.
        return !document.body.dispatchEvent(event);
      };
      touch("touchstart", 0);
      const safariStart = gesture("gesturestart", 1);
      const start = touch("touchstart", 50);
      const safariMove = gesture("gesturechange", 2);
      const preview = getComputedStyle(surface).transform;
      const move = touch("touchmove", 100);
      const safariEnd = gesture("gestureend", 2);
      const end = touch("touchend", 0);
      return { safariStart, start, safariMove, move, safariEnd, end, preview };
    });
    assert.ok(safariPinch.safariStart && safariPinch.safariMove && safariPinch.safariEnd, "Safari gesture notifications cancel native viewport zoom before touchstart #2");
    assert.ok(safariPinch.start && safariPinch.move && safariPinch.end, "a pinch starting on the PDF viewport/whitespace is handled");
    assert.match(safariPinch.preview, /^matrix\(2,/);
    await ready();
    assert.equal(await page.getByLabel("表示倍率").inputValue(), "2");
    assert.deepEqual(await page.getByLabel("本文の表示操作").boundingBox(), headerBeforePinch);
    await capture("safari-viewport-pinch-css");
    await page.getByRole("button", { name: "幅に合わせる", exact: true }).tap(); await ready();
    const safariOnly = await translated.evaluate(pane => {
      const bounds = pane.getBoundingClientRect();
      return ["gesturestart", "gesturechange", "gestureend"].map((type, index) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { scale: { value: index ? 1.75 : 1 }, clientX: { value: bounds.left + 150 }, clientY: { value: bounds.top + 150 } });
        return !document.body.dispatchEvent(event);
      });
    });
    assert.ok(safariOnly.every(Boolean), "Safari gesture-only input is handled on the viewport");
    await ready();
    assert.equal(await page.getByLabel("表示倍率").inputValue(), "1.75");
    await page.getByRole("button", { name: "幅に合わせる", exact: true }).tap(); await ready();
    assert.equal(await page.evaluate(() => document.body.dispatchEvent(new Event("gesturestart", { bubbles: true, cancelable: true }))), true,
      "gestures outside the PDF are not intercepted after its fingers lift");
    await page.getByRole("button", { name: "次のページ", exact: true }).tap();
    await translated.locator('[data-page-number="2"] canvas').waitFor();
    await page.getByRole("button", { name: "前のページ", exact: true }).tap();
    await ready();
    await page.getByRole("button", { name: "ライブラリ", exact: true }).tap();
    const search = page.getByLabel("ライブラリを検索");
    await search.fill("iPhone");
    await capture("library-css");
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
    await longSelect();
    assert.equal(await page.locator("[data-ink-id]").count(), 0, "finger long-press selects text through the pen overlay without drawing");
    await page.getByLabel("書き込み設定", { exact: true }).tap();
    await capture("ink-settings-css");
    const colorBox = (await page.getByLabel("書き込みの色").boundingBox())!;
    assert.ok(colorBox.width >= 44 && colorBox.height >= 44, "color control is a full swatch, not a clipped hex string");
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
    await capture("memo-input-css");
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
    await capture("landscape-css");
    await openMenu(); await capture("landscape-menu-css"); await closeMenu();
    await page.setViewportSize({ width: 390, height: 664 });
    await openMenu();
    await page.getByRole("button", { name: "メモを開く", exact: true }).tap();
    await page.getByRole("heading", { name: "iPhone読書メモ", exact: true }).waitFor();
    await capture("saved-memo-css");
    await page.getByRole("tab", { name: "本文", exact: true }).tap();
    await fits(390, 664);
    await page.emulateMedia({ colorScheme: "dark" });
    const contrast = await page.getByRole("button", { name: "ライブラリ", exact: true }).evaluate(async element => {
      getComputedStyle(element).color; // Flush the new media style before observing transitions.
      await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
      const context = document.createElement("canvas").getContext("2d")!;
      const luminance = (color: string) => {
        context.fillStyle = color; context.fillRect(0, 0, 1, 1);
        const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
          const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
        });
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      const foreground = luminance(getComputedStyle(element).color);
      const background = luminance(getComputedStyle(element.closest(".web-reader-tools")!).backgroundColor);
      return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    });
    await capture("dark-css");
    assert.ok(contrast >= 4.5, `library icon foreground contrast in dark mode: ${contrast}`);
    await page.emulateMedia({ colorScheme: "light" });
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
      // Playwright's touch IDs are separate from CDP's. Use mouse clicks after CDP input.
      if (!await menu.evaluate(element => (element.parentElement as HTMLDetailsElement).open)) await menu.click();
      await page.getByRole("button", { name: "書き込みを終了", exact: true }).click();
      await page.getByRole("button", { name: "幅に合わせる", exact: true }).click(); await ready();
      await translated.evaluate(element => element.scrollTo(0, 0));
      const header = (await page.getByLabel("本文の表示操作").boundingBox())!;
      const viewportScale = await page.evaluate(() => visualViewport!.scale);
      const start = (await translated.boundingBox())!;
      const centerX = start.x + 190, centerY = start.y + 200;
      const points = (half: number) => [{ id: 1, x: centerX - half, y: centerY }, { id: 2, x: centerX + half, y: centerY }];
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(50) });
      for (const half of [60, 75, 90, 100]) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(half) });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await ready();
      assert.equal(await page.getByLabel("表示倍率").inputValue(), "2", "real two-finger input enlarges the PDF");
      assert.equal(await page.evaluate(() => visualViewport!.scale), viewportScale, "real pinch does not enlarge the viewport");
      assert.deepEqual(await page.getByLabel("本文の表示操作").boundingBox(), header);
      await page.getByRole("button", { name: "原文を表示", exact: true }).click(); await ready(original);
      assert.equal(await page.getByLabel("表示倍率").inputValue(), "2");
      await capture("native-pinch-language-css");
      await page.getByRole("button", { name: "日本語訳を表示", exact: true }).click(); await ready();
      await translated.evaluate(element => element.scrollTo(0, 0));
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, x: centerX, y: centerY + 100 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 1, x: centerX, y: centerY - 50 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      assert.ok(await translated.evaluate(element => element.scrollTop) > 80, "one finger still scrolls the enlarged PDF");
      assert.deepEqual(await page.getByLabel("本文の表示操作").boundingBox(), header);
      await menu.click(); await page.getByRole("button", { name: "書き込みを開始", exact: true }).click();
      await page.getByRole("button", { name: "ペン", exact: true }).click();
      await page.getByLabel("書き込み設定", { exact: true }).click();
      await page.getByLabel("指でも書く", { exact: true }).check();
      await page.getByLabel("書き込み設定", { exact: true }).click();
      const beforeWritingPinch = await page.locator("[data-ink-id]").count();
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(50) });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(75) });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await ready();
      assert.equal(await page.getByLabel("表示倍率").inputValue(), "3");
      assert.equal(await page.locator("[data-ink-id]").count(), beforeWritingPinch, "pinching in finger-writing mode adds no accidental ink");
      assert.equal(await page.evaluate(() => visualViewport!.scale), viewportScale);
      await capture("native-pinch-writing-css");
      await menu.click(); await page.getByRole("button", { name: "書き込みを終了", exact: true }).click();
      await page.getByRole("button", { name: "幅に合わせる", exact: true }).click(); await ready();
      await translated.evaluate(element => element.scrollTo(0, 0));
      const title = (await translated.locator(".textLayer span").filter({ hasText: "日本語訳を読みやすく表示する" }).first().boundingBox())!;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 17, x: title.x + 3, y: title.y + title.height / 2 }] });
      await page.waitForFunction(() => !!getSelection()?.toString().trim());
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await capture("native-long-press-css");
      await copySelection(true);
    }
    await menu.click();
    await page.getByRole("button", { name: "Google接続メニュー", exact: true }).click();
    await page.getByRole("menuitem", { name: "ログアウト", exact: true }).click();
    await page.getByRole("heading", { name: "論文を選んで、読み始めよう" }).waitFor();
    assert.ok(uploads >= 2);
    assert.deepEqual(errors, []);
  });
}

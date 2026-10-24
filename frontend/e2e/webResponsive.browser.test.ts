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
    blobs.db = Buffer.from(JSON.stringify({ bookmarks: [{ paper_id: paper, page: 1, note: "iPadの付箋" }],
      messages: [{ paper_id: paper, role: "assistant", content: "保存された回答 $x^2$" }] }));
    blobs.memo = Buffer.from("# 比較しながら読むメモ\n\n読んでいる位置を保ったまま資料とメモを見比べる。\n");
    blobs.summary = Buffer.from(String.raw`# 数式を含むサマリー

インライン $x^2$ と \(y_i\) を表示する。

\[
\frac{a}{b} + \sum_{i=1}^{n} x_i
\]

$$
E = mc^2
$$
`);
    const file = (id: string) => ({ id, size: blobs[id].length, mime: id === "reading" ? "application/json" : "application/pdf",
      sha256: createHash("sha256").update(blobs[id]).digest("hex") });
    const manifest = { version: 1, revision: "responsive", updated_at: "2026-10-22T00:00:00Z", folder_id: "folder",
      items: [{ id: paper, title: "画面の広さに合わせて読む資料" }],
      attachments: [{ id: "memo", owner_id: paper, title: "読書メモ", format: "md" }], files: {
        [`papers/${paper}/original.pdf`]: file("original"), [`papers/${paper}/translated.pdf`]: file("translated"), "web-reading.json": file("reading"),
        [`papers/${paper}/attachments/memo.md`]: { ...file("memo"), mime: "text/markdown" },
        [`papers/${paper}/article.md`]: { ...file("summary"), mime: "text/markdown" },
        "library-data.json": { ...file("db"), mime: "application/json" },
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
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.web-pdf-pane')].every(pane => {
        const canvas = pane.querySelector('canvas'), pen = [...pane.querySelectorAll<HTMLButtonElement>('.ink-tools button')].find(button => button.title === "ペン");
        const style = getComputedStyle(pane), width = pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const zoom = Number(document.querySelector<HTMLSelectElement>('[aria-label="表示倍率"]')?.value ?? 1);
        return !!canvas && !!pen && !pen.disabled && !!pane.querySelector('[data-testid="web-ink"]')
          && Math.abs(canvas.getBoundingClientRect().width - Math.floor(width * zoom)) < 1;
      }));
    };
    await mode.waitFor();
    assert.equal(await mode.inputValue(), "single");
    assert.deepEqual(await mode.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)), ["single", "split"]);
    await layout("single");
    assert.equal(await page.locator(".web-document-header").isVisible(), true);
    assert.equal((await page.locator(".web-document-header .header-actions").innerText()).trim(), "", "authenticated account controls do not show Google login text above the reader");
    assert.equal(await page.locator(".local-library-notice").count(), 0);
    assert.equal(await page.getByRole("toolbar", { name: "PDFの書き込みツール" }).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "右パネルを選択", exact: true }).count(), 0);
    assert.equal(await page.getByLabel("書き込み設定", { exact: true }).count(), 0);
    await page.getByLabel("ペンの太さ").selectOption("0.006");
    await page.getByLabel("書き込みの色").fill("#0066ff");
    assert.equal(await page.getByLabel("ペンの太さ").inputValue(), "0.006");
    for (const name of ["本文", "サマリー", "チャット", "メモ", "付箋"]) {
      assert.equal(await page.getByRole("tab", { name, exact: true }).isVisible(), true);
    }
    await page.getByRole("tab", { name: "サマリー", exact: true }).click();
    await page.locator(".prose .katex").nth(3).waitFor();
    assert.equal(await page.locator(".prose .katex-display").count(), 2);
    assert.equal(await page.locator(".katex-error").count(), 0);
    assert.equal(await page.getByRole("button", { name: "サマリーを右に表示", exact: true }).count(), 0);
    await page.screenshot({ path: path.join(output, "tablet-summary-math.png") });
    await page.getByRole("tab", { name: "メモ", exact: true }).click();
    await page.getByRole("heading", { name: "比較しながら読むメモ", exact: true }).waitFor();
    await page.getByRole("tab", { name: "チャット", exact: true }).click();
    await page.locator(".reading-data .katex").waitFor();
    await page.getByRole("tab", { name: "付箋", exact: true }).click();
    await page.getByText("iPadの付箋", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "本文", exact: true }).click();
    const beforeFocus = (await original.boundingBox())!;
    await page.getByRole("button", { name: "集中表示", exact: true }).click();
    assert.equal(await page.locator(".web-reader-title-row h1").innerText(), "画面の広さに合わせて読む資料");
    assert.equal(await page.locator(".web-document-navigation").isVisible(), false);
    assert.equal(await page.locator(".web-document-header").isVisible(), false);
    assert.ok((await original.boundingBox())!.height > beforeFocus.height);
    await page.screenshot({ path: path.join(output, "tablet-focus.png") });
    await page.getByRole("button", { name: "集中表示を終了", exact: true }).click();
    assert.equal(await page.getByRole("tab", { name: "本文", exact: true }).isVisible(), true);
    await page.getByRole("button", { name: "集中表示", exact: true }).click();
    await page.getByLabel("読書メニュー", { exact: true }).click();
    await page.getByRole("button", { name: "サマリーを開く", exact: true }).click();
    await page.locator(".prose .katex").nth(3).waitFor();
    assert.equal(await page.getByRole("tab", { name: "サマリー", exact: true }).isVisible(), true);
    await page.getByRole("tab", { name: "本文", exact: true }).click();
    await page.getByRole("button", { name: "集中表示", exact: true }).click();
    await page.getByRole("button", { name: "ライブラリ", exact: true }).click();
    await page.locator(".web-sidebar-overlay").waitFor();
    await page.getByRole("button", { name: "ライブラリを閉じる", exact: true }).click();
    await page.setViewportSize({ width: 560, height: 900 });
    await original.locator("canvas").waitFor();
    assert.equal(await page.getByLabel("書き込み設定", { exact: true }).isVisible(), true,
      "compact viewports keep settings reachable even when the PDF pane exceeds 440px");
    assert.ok((await page.getByRole("toolbar", { name: "PDFの書き込みツール" }).boundingBox())!.height <= 50,
      "inline tablet settings do not expand compact phone toolbars into multiple rows");
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
    await layout("single");
    await mode.selectOption("split");
    await layout("split"); await ready();
    await original.locator('[data-page-number="2"] canvas').waitFor();
    assert.equal(await page.getByLabel("ページ番号").inputValue(), "2");
    assert.equal(await translated.locator("[data-ink-id]").count(), 1);
    assert.ok((await translated.boundingBox())!.x > (await original.boundingBox())!.x);
    await page.screenshot({ path: path.join(output, "wide-paired.png") });
    // A selected layout survives changes to the space occupied by the library.
    await page.setViewportSize({ width: 1201, height: 834 }); await layout("split");
    await page.getByRole("button", { name: "ライブラリ", exact: true }).click(); await layout("split");
    await page.getByRole("button", { name: "ライブラリ", exact: true }).click(); await layout("split");
    // The toolbar follows its own available width even when the browser stays wide.
    await page.locator(".web-reader-main").evaluate(element => { element.style.maxWidth = "660px"; });
    await layout("split");
    const menu = page.getByLabel("読書メニュー", { exact: true }); await menu.waitFor();
    assert.equal(await page.getByRole("button", { name: "書き込みを終了", exact: true }).isVisible(), true);
    await menu.click(); await mode.waitFor(); await menu.click();
    await page.locator(".web-reader-main").evaluate(element => { element.style.maxWidth = ""; });
    await layout("split");
    await mode.selectOption("single"); await layout("single");
    await page.setViewportSize({ width: 834, height: 1194 }); await layout("single");
    await page.setViewportSize({ width: 1194, height: 834 });
    assert.equal(await mode.inputValue(), "single"); await layout("single");
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
    await memo.blur(); await mode.selectOption("split"); await layout("split");
    assert.equal(await memo.inputValue(), "回転しても残る下書き");
    await page.getByRole("button", { name: "キャンセル", exact: true }).click();
    await mode.selectOption("single"); await layout("single");
    await page.setViewportSize({ width: 560, height: 900 }); await layout("single"); await ready();
    assert.equal(await page.getByRole("button", { name: "書き込みを終了", exact: true }).isVisible(), true);
    assert.equal(await page.getByRole("toolbar", { name: "PDFの書き込みツール" }).isVisible(), true);
    assert.equal(await translated.locator("[data-ink-id]").count(), 1);
    await page.screenshot({ path: path.join(output, "narrow-writing.png") });
    await page.getByRole("button", { name: "書き込みを終了", exact: true }).click();
    await page.setViewportSize({ width: 1194, height: 834 }); await layout("single");
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
    // Production can show an offline-preparation notice, leaving a smaller fitted
    // page. Choose the gesture scale from its actual size, not a fixed multiplier.
    const at = { x: fitted.x + fitted.width * .5, y: fitted.y + fitted.height * .35,
      scale: (await translated.boundingBox())!.width * 1.75 / fitted.width };
    await translated.locator("canvas").evaluate((canvas, point) => {
      for (const [type, scale] of [["gesturestart", 1], ["gesturechange", point.scale], ["gestureend", point.scale]] as const) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { scale, clientX: point.x, clientY: point.y }); canvas.dispatchEvent(event);
      }
    }, at);
    await page.waitForFunction(() => {
      const pane = document.querySelector('.web-pdf-pane'), canvas = pane?.querySelector('canvas'), ink = pane?.querySelector('[data-testid="web-ink"]');
      return !!canvas && !!ink && !document.querySelector('.pdf-fit-page') && canvas.getBoundingClientRect().width > pane!.clientWidth;
    });
    const enlarged = (await translated.locator("canvas").boundingBox())!;
    // PDF canvas dimensions are integer pixels. Allow one source pixel of
    // rounding at this magnification, while catching a lost centering margin.
    const tolerance = Math.max(3, at.scale);
    assert.ok(Math.abs(enlarged.x + enlarged.width * .5 - at.x) < tolerance, `pinching a centered fitted page keeps the horizontal anchor: ${JSON.stringify({ fitted, enlarged, at })}`);
    assert.ok(Math.abs(enlarged.y + enlarged.height * .35 - at.y) < tolerance, `pinching keeps the vertical anchor too: ${JSON.stringify({ fitted, enlarged, at })}`);
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
    // A low window uses the same compact controls regardless of its width/UA.
    await page.setViewportSize({ width: 1366, height: 400 });
    await page.getByRole("button", { name: "書き込みを開始", exact: true }).click();
    await menu.click(); await mode.selectOption("split"); await menu.click();
    await layout("split");
    await original.getByTestId("web-ink").waitFor(); await translated.getByTestId("web-ink").waitFor();
    assert.equal(await page.locator(".web-document-header").isVisible(), false);
    assert.ok((await original.locator("canvas").boundingBox())!.y - (await page.locator(".workspace").boundingBox())!.y < 160,
      "short windows leave room for the PDF while retaining pane captions");
    assert.equal(await original.locator(".asset-heading").isVisible(), true);
    assert.match(await original.locator(".asset-heading").innerText(), /原文/);
    assert.equal(await translated.locator(".asset-heading").isVisible(), true);
    await page.getByRole("button", { name: "ライブラリ", exact: true }).click();
    const sidebar = page.locator(".web-sidebar-overlay"); await sidebar.waitFor();
    assert.ok((await sidebar.boundingBox())!.width < 400, "the library overlays a short wide reader instead of squeezing it");
    assert.equal(await page.getByRole("button", { name: "ライブラリを閉じる", exact: true }).isVisible(), true);
    await page.getByRole("button", { name: "ライブラリを閉じる", exact: true }).click();
    await menu.click(); await mode.selectOption("single"); await menu.click(); await layout("single");
    // Opening/closing notes keeps the top passage and the horizontal reading point.
    await page.setViewportSize({ width: 1366, height: 768 });
    await zoom.selectOption("2");
    const settled = async () => page.waitForFunction(() => {
      const pane = document.querySelector('.web-pdf-pane'), canvas = pane?.querySelector('canvas'), ink = pane?.querySelector('[data-testid="web-ink"]');
      return !!pane && !!canvas && !!ink && Math.abs(canvas.getBoundingClientRect().width - (pane.clientWidth - 4) * 2) < 3;
    });
    await settled();
    await translated.evaluate(pane => {
      const surface = pane.querySelector<HTMLElement>(".web-pdf-surface")!;
      pane.scrollTop = surface.offsetTop + surface.offsetHeight * .25;
      pane.scrollLeft = surface.offsetLeft + surface.offsetWidth * .65 - pane.clientWidth / 2;
    });
    const readingPoint = () => translated.evaluate(pane => {
      const frame = pane.getBoundingClientRect(), surface = pane.querySelector(".web-pdf-surface")!.getBoundingClientRect();
      return { y: (frame.top - surface.top) / surface.height, x: (frame.left + pane.clientWidth / 2 - surface.left) / surface.width };
    });
    const beforeNotes = await readingPoint();
    await page.getByRole("button", { name: "右パネルを選択", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "メモを右に表示", exact: true }).click();
    await page.getByRole("complementary", { name: "メモ（右パネル）" }).waitFor(); await settled();
    const besideNotes = await readingPoint();
    assert.ok(Math.abs(beforeNotes.y - besideNotes.y) < .005 && Math.abs(beforeNotes.x - besideNotes.x) < .005, "opening notes preserves the reading passage");
    await page.getByRole("button", { name: "右パネルを閉じる", exact: true }).click(); await settled();
    const afterNotes = await readingPoint();
    assert.ok(Math.abs(beforeNotes.y - afterNotes.y) < .005 && Math.abs(beforeNotes.x - afterNotes.x) < .005, "closing notes restores the passage too");
    await page.getByRole("button", { name: "右パネルを選択", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "メモを右に表示", exact: true }).click();
    const notesPanel = page.getByRole("complementary", { name: "メモ（右パネル）" }); await notesPanel.waitFor();
    await page.setViewportSize({ width: 834, height: 1194 });
    await notesPanel.waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("button", { name: "右パネルを選択", exact: true }).count(), 0);
    await page.getByRole("tab", { name: "メモ", exact: true }).click();
    await page.getByRole("heading", { name: "比較しながら読むメモ", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "メモを右に表示", exact: true }).count(), 0);
    await page.getByRole("tab", { name: "本文", exact: true }).click();
    await page.setViewportSize({ width: 1366, height: 768 }); await notesPanel.waitFor();
    await page.getByRole("button", { name: "右パネルを閉じる", exact: true }).click();
    // A saved-library banner and a short viewport leave less space below menus.
    // Test real settings and dismissals, including the tap that must not add ink.
    await page.setViewportSize({ width: 393, height: 360 });
    const menuBounds = async (selector: string) => page.waitForFunction(selector => {
      const panel = document.querySelector<HTMLElement>(selector)!;
      const reader = document.querySelector(".web-document-reader")!.getBoundingClientRect();
      const rect = panel.getBoundingClientRect();
      return !!panel.style.maxHeight && rect.height > 0 && rect.bottom <= Math.min(reader.bottom, innerHeight) - 7;
    }, selector);
    await menu.click(); await menuBounds(".web-display-options[open] > div");
    const account = page.getByRole("button", { name: "Google接続メニュー", exact: true });
    await account.scrollIntoViewIfNeeded(); await account.click();
    await page.getByRole("menuitem", { name: "再ログイン", exact: true }).waitFor();
    assert.equal(await page.locator(".web-display-options").getAttribute("open"), "", "portalled account actions remain reachable inside the reader menu");
    await page.keyboard.press("Escape");
    await page.getByRole("menuitem", { name: "再ログイン", exact: true }).waitFor({ state: "hidden" });
    if (!await page.locator(".web-display-options[open]").count()) await menu.click();
    await zoom.scrollIntoViewIfNeeded(); await zoom.focus(); await zoom.selectOption("1.25");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".web-display-options[open]").count(), 0);
    assert.equal(await menu.evaluate(element => document.activeElement === element), true);
    const inkMenu = translated.getByLabel("書き込み設定", { exact: true });
    await inkMenu.click(); await menuBounds(".ink-options[open] > div");
    const finger = translated.getByRole("checkbox", { name: "指でも書く" });
    await finger.scrollIntoViewIfNeeded(); await finger.check(); assert.equal(await finger.isChecked(), true);
    await page.setViewportSize({ width: 393, height: 300 });
    await menuBounds(".ink-options[open] > div");
    const lastAction = translated.locator(".ink-history-menu").getByRole("button", { name: "書き込みを同期・再試行", exact: true });
    await lastAction.scrollIntoViewIfNeeded();
    const actionBox = (await lastAction.boundingBox())!, popup = (await translated.locator('.ink-options > div').boundingBox())!;
    assert.ok(actionBox.y >= popup.y && actionBox.y + actionBox.height <= popup.y + popup.height,
      "the last menu action fits fully inside the scrollable popup, including in a short pane");
    const tools = (await translated.locator('.ink-tools').boundingBox())!;
    const paneBox = (await translated.boundingBox())!;
    assert.ok(tools.x >= paneBox.x && tools.x + tools.width <= paneBox.x + paneBox.width + 1, "panning the enlarged PDF keeps its toolbar in view");
    const beforeDismiss = await translated.locator("[data-ink-id]").count();
    await page.mouse.click(15, 285);
    assert.equal(await translated.locator(".ink-options[open]").count(), 0);
    assert.equal(await translated.locator("[data-ink-id]").count(), beforeDismiss, "dismissing over the PDF does not draw a dot");
    await inkMenu.click(); await menuBounds(".ink-options[open] > div");
    await page.keyboard.press("Escape");
    assert.equal(await translated.locator(".ink-options[open]").count(), 0);
    await page.screenshot({ path: path.join(output, "short-reader-after-menu-operations.png") });
    // First visit chooses a concrete default; old saved auto preferences migrate too.
    await page.setViewportSize({ width: 1194, height: 834 });
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("papeer-reading:document:")) localStorage.removeItem(key);
    });
    await page.reload(); await mode.waitFor(); await layout("split");
    assert.equal(await mode.inputValue(), "split");
    await page.setViewportSize({ width: 834, height: 1194 }); await layout("split");
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("papeer-reading:document:")) {
        const place = JSON.parse(localStorage.getItem(key)!); place.mode = "auto"; localStorage.setItem(key, JSON.stringify(place));
      }
    });
    await page.reload(); await mode.waitFor(); await layout("single");
    assert.equal(await mode.inputValue(), "single");
    assert.deepEqual(errors, []);
  });
}

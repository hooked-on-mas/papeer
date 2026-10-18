/** Real Python PC snapshot → browser drawing → Drive transport → real Python import → browser. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium, type Page } from "playwright-core";
import type { Manifest } from "../src/web/drive.ts";
import type { Operation } from "../src/web/annotations.ts";

test("PC translation and ink survive Web pen, highlight, memo, offline retry, reload and PC import", { timeout: 180_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const root = path.resolve(frontend, "..");
  const directory = path.join(root, "output/web-library", "test-" + randomUUID());
  const fixture = (command: string) => {
    const result = spawnSync("uv", ["run", "python", "frontend/e2e/web_fixture.py", command, directory],
      { cwd: root, encoding: "utf8", env: { ...process.env, PYTHONPATH: root } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as { paper: string; strokes: number };
  };
  const { paper } = fixture("prepare");
  let manifest: Manifest;
  const blobs = new Map<string, Buffer>();
  const readSnapshot = (stage: string) => {
    manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
    for (const [relative, file] of Object.entries(manifest.files)) blobs.set(file.id, fs.readFileSync(path.join(directory, "snapshot-" + stage, relative)));
  };
  readSnapshot("prepare");
  const originalPdf = Buffer.from(blobs.get(manifest!.files[`papers/${paper}/translated.pdf`].id)!);
  const operations = new Map<string, Operation>();
  let failSave = false;
  const server = await createServer({ configFile: path.join(frontend, "vite.web.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const webUrl = process.env.PAPEER_WEB_TEST_URL || server.resolvedUrls!.local[0];
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, hasTouch: true });
  const errors: string[] = [], forbidden: string[] = [];
  context.on("page", page => {
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", req => { if (/127\.0\.0\.1:8000|api\.openai\.com|chatgpt\.com/.test(req.url())) forbidden.push(req.url()); });
  });
  await context.route("https://accounts.google.com/gsi/client", route => route.fulfill({ contentType: "text/javascript", body:
    'window.google={accounts:{oauth2:{initTokenClient:opts=>({requestAccessToken:()=>opts.callback({access_token:"test-token",expires_in:3600})})}}};' }));
  await context.route("https://www.googleapis.com/**", async route => {
    const req = route.request(), url = new URL(req.url());
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
    if (req.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    assert.equal(req.headers().authorization, "Bearer test-token");
    if (req.method() === "POST") {
      assert.ok(url.pathname.startsWith("/upload/drive/v3/files"));
      if (failSave) { await route.fulfill({ status: 503, headers }); return; }
      const boundary = req.headers()["content-type"].split("boundary=")[1];
      const parts = req.postData()!.split("--" + boundary);
      const metadata = JSON.parse(parts[1].split("\r\n\r\n")[1].trim());
      const op: Operation = JSON.parse(parts[2].split("\r\n\r\n")[1].trim());
      assert.deepEqual(metadata.parents, ["folder"]);
      assert.equal(metadata.properties.library, "library");
      assert.equal(op.side, "translated");
      operations.set(op.id, op);
      await route.fulfill({ json: { id: "event-" + op.id }, headers }); return;
    }
    const id = url.pathname.split("/").pop()!;
    if (id === "files") await route.fulfill({ json: { files: url.searchParams.get("q")?.includes("ink-v1")
      ? [...operations.values()].map(op => ({ id: "event-" + op.id, name: `ink-${op.id}.json`, size: String(Buffer.byteLength(JSON.stringify(op))) }))
      : [{ id: "library", name: "papeer-library.json", modifiedTime: manifest.updated_at }] }, headers });
    else if (id === "library") await route.fulfill({ json: manifest, headers });
    else if (id.startsWith("event-")) await route.fulfill({ json: operations.get(id.slice(6)), headers });
    else { assert.ok(blobs.has(id), id); await route.fulfill({ body: blobs.get(id), headers }); }
  });
  const page = await context.newPage();
  const open = async (p: Page) => {
    await p.goto(webUrl);
    await p.getByRole("button", { name: "Googleでログインして開く →" }).click();
    await p.getByLabel("表示する資料").selectOption({ label: "日本語訳" });
    await p.getByRole("region", { name: "原文", exact: true }).locator("canvas").waitFor();
    await p.getByRole("region", { name: "日本語訳", exact: true }).locator("canvas").waitFor();
    await p.getByRole("button", { name: "次のページ", exact: true }).click();
    await p.getByRole("region", { name: "原文", exact: true }).locator('[data-page-number="2"] canvas').waitFor();
    await p.getByRole("region", { name: "日本語訳", exact: true }).locator('[data-page-number="2"] canvas').waitFor();
    await p.getByRole("button", { name: "前のページ", exact: true }).click();
    await p.getByRole("region", { name: "原文", exact: true }).locator('[data-page-number="1"] canvas').waitFor();
    await p.screenshot({ path: path.join(directory, "paired-reading.png") });
    await p.getByLabel("本文の表示方法").selectOption("single");
    await p.getByRole("button", { name: "ペン", exact: true }).waitFor({ state: "visible" });
    await p.waitForFunction(() => !(document.querySelector('.ink-tools button[aria-pressed]') as HTMLButtonElement)?.disabled);
  };
  const count = (p: Page) => p.locator("[data-ink-id]").count();
  const saved = (p: Page) => p.getByRole("status").filter({ hasText: "Driveに保存済み" }).waitFor();
  const draw = async (p: Page, tool: string, y: number) => {
    await p.getByRole("button", { name: tool, exact: true }).click();
    const svg = p.getByTestId("web-ink"); await svg.scrollIntoViewIfNeeded();
    const b = (await svg.boundingBox())!;
    await p.mouse.move(b.x + b.width * .25, b.y + b.height * y);
    await p.mouse.down(); await p.mouse.move(b.x + b.width * .45, b.y + b.height * (y + .02), { steps: 8 }); await p.mouse.up();
  };
  await open(page);
  assert.equal(await count(page), 1); // PC's blue ink is visible on the raw Japanese translation.
  assert.equal(await page.getByText("Codex", { exact: false }).count(), 0);
  assert.ok((await page.locator(".react-pdf__Page").textContent())?.includes("PCで翻訳したPDF"));
  await draw(page, "ペン", .3); await saved(page); assert.equal(await count(page), 2);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click(); await saved(page); assert.equal(await count(page), 1);
  await page.getByRole("button", { name: "やり直す", exact: true }).click(); await saved(page); assert.equal(await count(page), 2);
  await draw(page, "蛍光ペン", .4); await saved(page); assert.equal(await count(page), 3);
  await page.getByRole("button", { name: "文字メモ", exact: true }).click();
  await page.getByTestId("web-ink").click({ position: { x: 90, y: 150 } });
  await page.getByLabel("PDFに追加するメモ").fill("iPadからの読書メモ");
  await page.getByRole("button", { name: "メモを保存", exact: true }).click(); await saved(page);
  assert.equal(await count(page), 4);
  assert.equal(await page.getByTestId("web-ink").getByText("iPadからの読書メモ").count(), 1);
  failSave = true;
  await draw(page, "ペン", .5);
  await page.getByRole("alert").filter({ hasText: "端末内の下書き" }).waitFor();
  assert.equal(await count(page), 5);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("papeer-ink:library:")).length), 1);
  // Reload during outage: the durable draft must be visible and retryable.
  await open(page);
  await page.getByRole("alert").filter({ hasText: "端末内の下書き" }).waitFor(); assert.equal(await count(page), 5);
  failSave = false;
  await page.getByRole("button", { name: "書き込みを同期・再試行" }).click(); await saved(page);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("papeer-ink:library:")).length), 0);
  // Separate tab sees the same Drive-backed edits, and cannot overwrite the first tab's additions.
  const second = await context.newPage(); await open(second); assert.equal(await count(second), 5);
  await draw(second, "ペン", .6); await saved(second); assert.equal(await count(second), 6);
  await page.getByRole("button", { name: "書き込みを同期・再試行" }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-ink-id]").length === 6);
  // Tablet layout and an actual Chromium pen pointer (Pencil uses Pointer Events too).
  await page.setViewportSize({ width: 1024, height: 1366 });
  await page.getByRole("button", { name: "ペン", exact: true }).click();
  await page.getByTestId("web-ink").scrollIntoViewIfNeeded();
  const box = (await page.getByTestId("web-ink").boundingBox())!;
  const cdp = await context.newCDPSession(page);
  const x = box.x + box.width * .3, y = box.y + box.height * .7;
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, pointerType: "pen" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 80, y: y + 10, button: "left", buttons: 1, pointerType: "pen" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 80, y: y + 10, button: "left", clickCount: 1, pointerType: "pen" });
  await saved(page); assert.equal(await count(page), 7);
  // Web eraser leaves PC ink alone; undo restores the erased Web stroke under a new ID.
  await draw(page, "消しゴム", .3); await saved(page); assert.equal(await count(page), 6);
  assert.equal(await page.locator('[data-ink-id="pc-ink"]').count(), 1);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click(); await saved(page); assert.equal(await count(page), 7);
  await page.getByRole("button", { name: "ペン", exact: true }).click();
  const touchBox = (await page.getByTestId("web-ink").boundingBox())!;
  const touchAt = { x: touchBox.x + touchBox.width * .55, y: touchBox.y + touchBox.height * .65 };
  await page.touchscreen.tap(touchAt.x, touchAt.y); assert.equal(await count(page), 7);
  await page.getByRole("checkbox", { name: "指でも書く" }).check();
  await page.touchscreen.tap(touchAt.x, touchAt.y); await saved(page); assert.equal(await count(page), 8);
  await page.getByRole("button", { name: "元に戻す", exact: true }).click(); await saved(page); assert.equal(await count(page), 7);
  await page.screenshot({ path: path.join(directory, "tablet-writing.png"), fullPage: true });
  // Page-specific ink and the next page's different aspect ratio.
  await page.getByRole("button", { name: "次のページ" }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-ink-id]").length === 0);
  await page.getByRole("button", { name: "前のページ" }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-ink-id]").length === 7);
  fs.writeFileSync(path.join(directory, "operations.json"), JSON.stringify([...operations.values()]));
  assert.equal(fixture("import").strokes, 7);
  readSnapshot("import");
  assert.deepEqual(blobs.get(manifest!.files[`papers/${paper}/translated.pdf`].id), originalPdf);
  await page.getByRole("button", { name: "更新", exact: true }).click();
  await page.getByLabel("表示する資料").selectOption({ label: "日本語訳" });
  await page.getByLabel("本文の表示方法").selectOption("single");
  await page.waitForFunction(() => document.querySelectorAll("[data-ink-id]").length === 7);
  await saved(page); // Imported operations aren't drawn twice on top of PC ink.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(directory, "mobile-writing.png"), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
});

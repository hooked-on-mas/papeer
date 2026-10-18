/** Recovery paths use synthetic data and an intercepted OAuth popup/Drive API. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

function onePagePdf() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << >> /Contents 4 0 R >>", "<< /Length 0 >>\nstream\n\nendstream"];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test("Web recovers login, reads, scratch text and reading position without showing the wrong translation", { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ cacheDir: path.resolve(frontend, "../output/web-review/vite-" + randomUUID()),
    configFile: path.join(frontend, "vite.web.config.ts"), logLevel: "error", server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1366, height: 1024 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const paper = "a".repeat(32), other = "c".repeat(32);
  let failPdf = true, badMapping = false, anotherAccount = false, revision = 1, uploads = 0;
  let sdkFailure = true;
  const blobs: Record<string, Buffer> = { pdf: fs.readFileSync(path.resolve(frontend, "../tests/fixtures/sample.pdf")), one: onePagePdf() };
  const file = (id: string, mime = "application/pdf") => ({ id, mime, size: blobs[id].length, sha256: createHash("sha256").update(blobs[id]).digest("hex") });
  await page.route("https://accounts.google.com/gsi/client", async route => {
    if (sdkFailure) { sdkFailure = false; await route.abort(); return; }
    await route.fulfill({ contentType: "text/javascript", body:
      'window.__grants=[];window.google={accounts:{oauth2:{initTokenClient:opts=>({requestAccessToken:()=>{const grant=()=>opts.callback({access_token:"test-token",expires_in:3600});window.__grants.push(grant);if(!window.__holdGoogle)grant();}})}}};' });
  });
  await page.route("https://www.googleapis.com/**", async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    assert.equal(request.headers().authorization, "Bearer test-token");
    if (request.method() === "POST") { uploads++; await route.fulfill({ json: { id: "op" }, headers }); return; }
    const id = url.pathname.split("/").pop()!;
    if (id === "files") await route.fulfill({ json: { files: url.searchParams.get("q")?.includes("ink-v1") ? []
      : [{ id: anotherAccount ? "other-library" : "library", name: "papeer-library.json", modifiedTime: "2026-10-18T00:00:00Z" }] }, headers });
    else if (id === "library" || id === "other-library") {
      blobs.reading = Buffer.from(JSON.stringify({ version: 1, items: { [paper]: { pageCount: 2, translatedPages: {
        "1": { artifactPath: `papers/${paper}/translated.pdf`, page: 1 },
        "2": badMapping ? { artifactPath: `papers/${paper}/translated.pdf`, page: 99 } : null,
      } } } }));
      await route.fulfill({ json: { version: 1, revision: String(revision), updated_at: "2026-10-18T00:00:00Z", folder_id: "folder",
        items: [{ id: paper, title: anotherAccount ? "新しいアカウントの論文" : "復旧テストの論文" }, { id: other, title: "別の論文" }],
        attachments: [{ id: "short", owner_id: paper, format: "pdf", title: "短い添付" }], files: {
          [`papers/${paper}/original.pdf`]: file("pdf"), [`papers/${paper}/translated.pdf`]: file("one"),
          [`papers/${paper}/attachments/short.pdf`]: file("one"), [`papers/${other}/original.pdf`]: file("pdf"),
          "web-reading.json": file("reading", "application/json"),
        } }, headers });
    } else if (id === "pdf" && failPdf) await route.fulfill({ status: 503, headers });
    else await route.fulfill({ body: blobs[id], headers });
  });
  await page.goto(process.env.PAPEER_WEB_TEST_URL || server.resolvedUrls!.local[0]);
  await page.getByRole("button", { name: "ログインの準備を再試行", exact: true }).click();
  await page.waitForFunction(() => !!window.google);
  await page.evaluate(() => { (window as unknown as { __holdGoogle: boolean }).__holdGoogle = true; });
  await page.getByRole("button", { name: "Googleでログインして開く →" }).click();
  await page.getByRole("button", { name: "接続をキャンセル", exact: true }).click();
  await page.waitForFunction(() => !(document.querySelector('.welcome button') as HTMLButtonElement).disabled);
  await page.evaluate(() => { (window as unknown as { __grants: (() => void)[] }).__grants[0](); });
  assert.equal(await page.getByLabel("表示する資料").count(), 0);
  await page.evaluate(() => { (window as unknown as { __holdGoogle: boolean }).__holdGoogle = false; });
  await page.getByRole("button", { name: "Googleでログインして開く →" }).click();
  await page.getByRole("button", { name: "PDFを再試行", exact: true }).waitFor();
  failPdf = false;
  await page.getByRole("button", { name: "PDFを再試行", exact: true }).click();
  const original = page.getByRole("region", { name: "原文", exact: true });
  await original.locator("canvas").waitFor();
  await original.getByRole("button", { name: "文字メモ", exact: true }).click();
  await original.getByTestId("web-ink").click({ position: { x: 120, y: 150 } });
  await page.getByLabel("PDFに追加するメモ").fill("配置前の文字メモを残す");
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await original.locator('[data-page-number="2"] canvas').waitFor();
  await page.getByRole("button", { name: "前のページ", exact: true }).click();
  assert.equal(await page.getByLabel("PDFに追加するメモ").inputValue(), "配置前の文字メモを残す");
  await page.getByLabel("表示倍率").selectOption("0.75");
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await page.getByLabel("本文の表示方法").selectOption("single");
  assert.equal(await page.getByLabel("ページ番号").inputValue(), "2");
  await page.getByLabel("表示する資料").selectOption({ label: "日本語訳" });
  await page.getByText("この原文ページの日本語訳はまだ保存されていません。", { exact: true }).waitFor();
  assert.equal(await page.locator(".react-pdf__Page canvas").count(), 0, "missing translation must not fall back to a different PDF page");
  await page.getByLabel("表示する資料").selectOption({ label: "原文・ノート" });
  await original.locator('[data-page-number="2"] canvas').waitFor();
  const pdfUrl = await original.locator(".asset-heading a").getAttribute("href");
  await page.getByRole("button", { name: "再ログイン", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.banner[role="status"]'));
  await original.locator('[data-page-number="2"] canvas').waitFor();
  assert.notEqual(await original.locator(".asset-heading a").getAttribute("href"), pdfUrl, "reauthorization fetches protected PDFs with the new token");
  assert.equal(await page.getByLabel("ページ番号").inputValue(), "2");
  revision++;
  await page.getByRole("button", { name: "更新", exact: true }).click();
  await original.locator('[data-page-number="2"] canvas').waitFor();
  assert.equal(await page.getByLabel("表示倍率").inputValue(), "0.75");
  await page.getByLabel("表示する資料").selectOption({ label: "短い添付" });
  await page.locator('[data-page-number="1"] canvas').waitFor();
  assert.equal(await page.getByLabel("ページ番号").inputValue(), "1");
  await page.getByLabel("表示する資料").selectOption({ label: "原文・ノート" });
  await original.locator('[data-page-number="2"] canvas').waitFor();
  const tree = page.getByRole("tree", { name: "ライブラリ", exact: true });
  await tree.getByRole("treeitem", { name: "別の論文", exact: true }).click();
  await page.getByLabel("ページ番号").waitFor();
  await tree.getByRole("treeitem", { name: "復旧テストの論文", exact: true }).click();
  await original.locator('[data-page-number="2"] canvas').waitFor();
  await page.getByRole("button", { name: "前のページ", exact: true }).click();
  await page.getByLabel("PDFに追加するメモ").waitFor();
  await page.evaluate(() => {
    const target = window as unknown as { __restoreStorage: () => void };
    const original = Storage.prototype.setItem;
    target.__restoreStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key, value) { if (key.startsWith("papeer-text:")) throw new DOMException("quota", "QuotaExceededError"); original.call(this, key, value); };
  });
  await page.getByLabel("PDFに追加するメモ").fill("まだ保存できない文字メモ");
  await page.getByRole("alert").filter({ hasText: "文字メモを端末に保存できません" }).waitFor();
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  assert.equal(await page.getByLabel("ページ番号").inputValue(), "1");
  await page.evaluate(() => { (window as unknown as { __restoreStorage: () => void }).__restoreStorage(); });
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await page.getByRole("button", { name: "前のページ", exact: true }).click();
  assert.equal(await page.getByLabel("PDFに追加するメモ").inputValue(), "まだ保存できない文字メモ");
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("papeer-text:")).length), 0);
  assert.equal(uploads, 0, "scratch text is not uploaded before placement");
  await original.getByRole("button", { name: "ペン", exact: true }).click();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as unknown as { __restoreStorage: () => void }).__restoreStorage = () => { Storage.prototype.setItem = original; };
    Storage.prototype.setItem = function(key, value) { if (key.startsWith("papeer-ink:")) throw new DOMException("quota", "QuotaExceededError"); original.call(this, key, value); };
  });
  await original.getByTestId("web-ink").click({ position: { x: 100, y: 160 } });
  await page.getByRole("button", { name: "線を再保存", exact: true }).waitFor();
  assert.equal(uploads, 0, "a non-durable stroke is not sent or falsely marked saved");
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  assert.equal(await page.getByLabel("ページ番号").inputValue(), "1");
  assert.equal(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true }); dispatchEvent(event); return event.defaultPrevented;
  }), true);
  await page.evaluate(() => { (window as unknown as { __restoreStorage: () => void }).__restoreStorage(); });
  await page.getByRole("button", { name: "線を再保存", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 1);
  await page.getByRole("status").filter({ hasText: "Driveに保存済み" }).waitFor();
  assert.equal(uploads, 1);
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  badMapping = true; revision++;
  await page.getByRole("button", { name: "更新", exact: true }).click();
  await page.getByLabel("表示する資料").selectOption({ label: "日本語訳" });
  await page.getByRole("alert").filter({ hasText: "指定ページがありません" }).waitFor();
  assert.equal(await page.locator(".react-pdf__Page canvas").count(), 0);
  anotherAccount = true; failPdf = false;
  await page.getByRole("button", { name: "再ログイン", exact: true }).click();
  await page.getByRole("heading", { name: "新しいアカウントの論文", exact: true }).waitFor();
  assert.equal(await page.getByLabel("ページ番号").inputValue(), "1");
  assert.deepEqual(errors, []);
});

import { clickAccountAction } from "./webAccount.ts";
/** Built PWA + real IndexedDB, with synthetic Google auth and private PDF responses. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { chromium, webkit } from "playwright-core";

async function staticApp(t: TestContext) {
  const dist = path.resolve(import.meta.dirname, "../web-dist");
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
    ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const file = path.resolve(dist, decodeURIComponent(url.pathname.replace(/^\/papeer\//, "")) || "index.html");
    if (!url.pathname.startsWith("/papeer/") || !file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end(); return;
    }
    response.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
    response.setHeader("Cache-Control", "no-store"); response.end(fs.readFileSync(file));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return process.env.PAPEER_PWA_TEST_URL || `http://127.0.0.1:${address.port}/papeer/`;
}

test("downloaded PDFs reopen offline; missing versions, storage failures and logout are handled", { timeout: 120_000 }, async t => {
  const base = await staticApp(t);
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1366, height: 1024 } });
  await context.addInitScript(() => {
    if (sessionStorage.getItem("offline-test:report-online") === "1") {
      Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
    }
  });
  const page = await context.newPage(), cdp = await context.newCDPSession(page);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const paper = "a".repeat(32), missing = "b".repeat(32);
  const pdf = fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/sample.pdf"));
  const file = (id: string) => ({ id, size: pdf.length, sha256: createHash("sha256").update(pdf).digest("hex"), mime: "application/pdf" });
  let offline = false, offlineRequests = 0, revision = 1, uploads = 0;
  let holdSdk = false;
  let sdkRequested = () => {}, releaseSdk = () => {};
  const sdkBlocked = new Promise<void>(resolve => { sdkRequested = resolve; });
  const sdkReleased = new Promise<void>(resolve => { releaseSdk = resolve; });
  t.after(() => releaseSdk());
  let holdLibraryList = false, listRequested = () => {}, releaseList = () => {};
  const listBlocked = new Promise<void>(resolve => { listRequested = resolve; });
  const listReleased = new Promise<void>(resolve => { releaseList = resolve; });
  t.after(() => releaseList());
  await context.route("https://accounts.google.com/**", async route => {
    if (holdSdk) { sdkRequested(); await sdkReleased; }
    if (offline) await route.abort();
    else await route.fulfill({ contentType: "text/javascript", body:
      'window.google={accounts:{oauth2:{initTokenClient:opts=>({requestAccessToken:()=>opts.callback({access_token:"test-token",expires_in:3600})})}}};' });
  });
  await context.route("https://www.googleapis.com/**", async route => {
    if (offline) { offlineRequests++; await route.abort(); return; }
    const request = route.request(), url = new URL(request.url());
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (request.method() === "POST") { uploads++; await route.fulfill({ json: { id: "op" }, headers }); return; }
    const id = url.pathname.split("/").pop()!;
    if (id === "files" && !url.searchParams.get("q")?.includes("ink-v1") && holdLibraryList) {
      listRequested(); await listReleased;
    }
    if (id === "files") await route.fulfill({ json: { files: url.searchParams.get("q")?.includes("ink-v1") ? []
      : [{ id: "library", name: "papeer-library.json", modifiedTime: "2026-10-21T00:00:00Z" }] }, headers });
    else if (id === "library") await route.fulfill({ json: { version: 1, revision: String(revision), updated_at: "2026-10-21T00:00:00Z", folder_id: "folder",
      items: [{ id: paper, title: "保存した論文" }, { id: missing, title: "未取得の論文" }], attachments: [], files: {
        [`papers/${paper}/original.pdf`]: { ...file("pdf"), ...(revision === 2 ? { sha256: "c".repeat(64) } : {}) },
        [`papers/${missing}/original.pdf`]: file("missing"),
      } }, headers });
    else await route.fulfill({ body: pdf, headers });
  });
  const setOffline = async (value: boolean) => {
    offline = value;
    await context.setOffline(value);
    await cdp.send("Network.overrideNetworkState", { offline: value, latency: 0,
      downloadThroughput: value ? 0 : -1, uploadThroughput: value ? 0 : -1 });
  };
  const original = page.getByRole("region", { name: "原文", exact: true });
  const loginNotice = page.getByRole("status").filter({ hasText: "端末に保存した資料を表示しています" });
  const inlineLogin = loginNotice.getByRole("button", { name: "Googleでログイン", exact: true });
  await page.goto(base);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.getByRole("button", { name: "Googleでログインして開く →" }).click();
  await original.locator("canvas").waitFor();
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await original.locator('[data-page-number="2"] canvas').waitFor();
  // A connection attempt must never disable the escape route to local documents.
  holdLibraryList = true;
  await clickAccountAction(page, "再ログイン");
  await listBlocked;
  const localEntry = page.getByRole("button", { name: "ダウンロード済みのライブラリを開く", exact: true });
  assert.equal(await localEntry.isEnabled(), true);
  await localEntry.click();
  await original.locator('[data-page-number="2"] canvas').waitFor();
  const cancelledList = page.waitForResponse(response => response.url().includes("googleapis.com/drive/v3/files?") && response.url().includes("orderBy"));
  holdLibraryList = false; releaseList(); await cancelledList;
  assert.equal(await loginNotice.count(), 0, "an authenticated session does not show a Google login notice when opening a saved library");
  // A Wi-Fi connection can report online with no Internet. Even a stalled Google
  // SDK must not leave downloaded documents behind the login screen.
  holdSdk = true;
  await page.getByRole("status").filter({ hasText: "Driveに保存済み" }).waitFor();
  await page.evaluate(() => sessionStorage.setItem("offline-test:report-online", "1"));
  await setOffline(true);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.reload({ waitUntil: "domcontentloaded" });
  await sdkBlocked;
  await original.locator('[data-page-number="2"] canvas').waitFor();
  assert.equal(await page.evaluate(() => navigator.onLine), true);
  assert.equal(await page.getByRole("heading", { name: "論文を選んで、読み始めよう" }).count(), 0);
  assert.equal(offlineRequests, 0, "local startup must not try to authenticate or read Drive");
  await page.evaluate(() => sessionStorage.removeItem("offline-test:report-online"));
  holdSdk = false; releaseSdk();
  await setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await original.locator('[data-page-number="2"] canvas').waitFor();
  assert.equal(await page.getByLabel("ページ番号").inputValue(), "2");
  assert.equal(offlineRequests, 0, "offline restore must not require Google or Drive");
  // PDF.js lazily requests these; check they are available without an HTTP cache.
  assert.equal(await page.evaluate(async () => (await fetch("./pdfjs/cmaps/UniJIS-UTF16-H.bcmap")).ok), true);
  assert.equal(await page.evaluate(async () => (await fetch("./pdfjs/standard_fonts/LiberationSans-Regular.ttf")).ok), true);
  const tree = page.getByRole("tree", { name: "ライブラリ", exact: true });
  await tree.getByRole("treeitem", { name: "未取得の論文", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "この資料は端末に保存されていません" }).waitFor();
  await tree.getByRole("treeitem", { name: "保存した論文", exact: true }).click();
  await original.locator('[data-page-number="2"] canvas').waitFor();
  // Offline edits stay durable and are sent only after a new authenticated login.
  await original.getByRole("button", { name: "ペン", exact: true }).click();
  await original.getByTestId("web-ink").click({ position: { x: 110, y: 150 } });
  await page.waitForFunction(() => document.querySelectorAll("[data-ink-id]").length === 1);
  await page.reload({ waitUntil: "domcontentloaded" });
  await original.locator('[data-page-number="2"] canvas').waitFor();
  await page.waitForFunction(() => document.querySelectorAll("[data-ink-id]").length === 1);
  assert.equal(uploads, 0); assert.equal(offlineRequests, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await loginNotice.count(), 0, "the saved-library notice is hidden offline");
  await setOffline(false);
  await inlineLogin.waitFor();
  const dismissNotice = loginNotice.getByRole("button", { name: "保存済み資料の案内を閉じる", exact: true });
  const closeBox = (await dismissNotice.boundingBox())!;
  assert.ok(closeBox.width >= 44 && closeBox.height >= 44 && closeBox.x + closeBox.width <= 390);
  await dismissNotice.click();
  assert.equal(await loginNotice.count(), 0, "the close action dismisses the notice");
  await original.locator('[data-page-number="2"] canvas').waitFor();
  await setOffline(true);
  await setOffline(false);
  assert.equal(await loginNotice.count(), 0, "reconnecting does not reopen a dismissed notice");
  await page.reload({ waitUntil: "domcontentloaded" });
  await original.locator('[data-page-number="2"] canvas').waitFor();
  await inlineLogin.waitFor();
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('.local-library-notice button');
    return button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
  });
  const loginBox = (await inlineLogin.boundingBox())!;
  assert.ok(loginBox.height >= 44 && loginBox.x >= 0 && loginBox.x + loginBox.width <= 390);
  const screenshots = path.resolve(import.meta.dirname, "../../output/pwa"); fs.mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, "local-library-login-phone.png") });
  await inlineLogin.click();
  await original.locator('[data-page-number="2"] canvas').waitFor();
  await page.setViewportSize({ width: 1366, height: 1024 });
  await page.getByRole("status").filter({ hasText: "Driveに保存済み" }).waitFor();
  assert.equal(uploads, 1);
  await setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await original.locator('[data-page-number="2"] canvas').waitFor();
  await page.waitForFunction(() => document.querySelectorAll("[data-ink-id]").length === 1);
  await setOffline(false);
  await inlineLogin.click();
  await original.locator('[data-page-number="2"] canvas').waitFor();
  // A full device must still display online PDFs and report failed offline storage.
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "files") throw new DOMException("quota", "QuotaExceededError");
      return put.apply(this, args);
    };
  });
  await tree.getByRole("treeitem", { name: "未取得の論文", exact: true }).click();
  await original.locator("canvas").waitFor();
  await page.getByRole("alert").filter({ hasText: "資料を端末に保存できません" }).waitFor();
  await setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("alert").filter({ hasText: "この資料は端末に保存されていません" }).waitFor();
  // The same Drive file ID with a changed hash cannot reuse a previous PDF version.
  await setOffline(false);
  revision = 2;
  await inlineLogin.click();
  await tree.getByRole("treeitem", { name: "保存した論文", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "ファイルの内容が保存時と一致しません" }).waitFor();
  await setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("alert").filter({ hasText: "この資料は端末に保存されていません" }).waitFor();
  await page.getByRole("button", { name: "端末の保存を削除", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.banner[role="status"]'));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "論文を選んで、読み始めよう" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "ダウンロード済みのライブラリを開く", exact: true }).count(), 0);
  await page.getByText("このブラウザーには保存済みの資料がありません。", { exact: false }).waitFor();
  assert.deepEqual(errors, []);
});

test("WebKit reopens saved PDF bodies after restarting without Google", { timeout: 60_000 }, async t => {
  const base = await staticApp(t);
  const browser = await webkit.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1366, height: 1024 }, serviceWorkers: "block" });
  await context.addInitScript(() => {
    if (sessionStorage.getItem("offline-test:no-google")) Object.defineProperty(navigator, "onLine", { get: () => false });
  });
  const page = await context.newPage();
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const paper = "a".repeat(32);
  const pdf = fs.readFileSync(path.resolve(import.meta.dirname, "../../tests/fixtures/sample.pdf"));
  let offline = false, driveReads = 0;
  await context.route("https://accounts.google.com/**", route => offline ? route.abort() : route.fulfill({ contentType: "text/javascript", body:
    'window.google={accounts:{oauth2:{initTokenClient:opts=>({requestAccessToken:()=>opts.callback({access_token:"test-token",expires_in:3600})})}}};' }));
  await context.route("https://www.googleapis.com/**", async route => {
    if (offline) { driveReads++; await route.abort(); return; }
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
    if (route.request().method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    const url = new URL(route.request().url()), id = url.pathname.split("/").pop();
    if (id === "files") await route.fulfill({ json: { files: url.searchParams.get("q")?.includes("ink-v1") ? []
      : [{ id: "library", name: "papeer-library.json", modifiedTime: "2026-10-21T00:00:00Z" }] }, headers });
    else if (id === "library") await route.fulfill({ json: { version: 1, revision: "webkit", updated_at: "2026-10-21T00:00:00Z",
      items: [{ id: paper, title: "WebKitの保存済みPDF" }], attachments: [], files: {
        [`papers/${paper}/original.pdf`]: { id: "pdf", size: pdf.length, mime: "application/pdf", sha256: createHash("sha256").update(pdf).digest("hex") },
      } }, headers });
    else await route.fulfill({ body: pdf, headers });
  });
  await page.goto(base);
  await page.getByRole("button", { name: "Googleでログインして開く →" }).click();
  const original = page.getByRole("region", { name: "原文", exact: true });
  await original.locator("canvas").waitFor();
  await page.getByRole("status").filter({ hasText: "Driveに保存済み" }).waitFor();
  assert.equal(await page.getByRole("alert").filter({ hasText: "資料を端末に保存できません" }).count(), 0);
  await page.getByRole("button", { name: "次のページ", exact: true }).click();
  await original.locator('[data-page-number="2"] canvas').waitFor();
  offline = true;
  await page.evaluate(() => sessionStorage.setItem("offline-test:no-google", "1"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await original.locator('[data-page-number="2"] canvas').waitFor();
  assert.equal(await page.getByRole("heading", { name: "論文を選んで、読み始めよう" }).count(), 0);
  assert.equal(driveReads, 0);
  assert.deepEqual(errors, []);
});

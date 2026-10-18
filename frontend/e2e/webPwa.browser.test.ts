/** Built output at the real Pages subpath; no Google account or private documents. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("PWA installs at /papeer/, boots offline, excludes private data, and updates after closing", { timeout: 120_000 }, async t => {
  const dist = path.resolve(import.meta.dirname, "../web-dist");
  let nextVersion = false;
  const contentTypes: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
    ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/outside/" || url.pathname === "/papeer/private.json") {
      response.setHeader("Content-Type", "application/json"); response.end('{"private":true}'); return;
    }
    const name = decodeURIComponent(url.pathname.replace(/^\/papeer\//, "")) || "index.html";
    const file = path.resolve(dist, name);
    if (!url.pathname.startsWith("/papeer/") || !file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end(); return;
    }
    response.setHeader("Content-Type", contentTypes[path.extname(file)] || "application/octet-stream");
    let body = fs.readFileSync(file);
    if (name === "sw.js" && nextVersion) body = Buffer.from(body.toString().replace(/const VERSION = "([^"]+)"/, 'const VERSION = "$1-test-update"'));
    response.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/papeer/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "papeer-pwa-test-"));
  const context = await chromium.launchPersistentContext(profile, { channel: "msedge", headless: true });
  t.after(async () => { await context.close(); fs.rmSync(profile, { recursive: true, force: true }); });
  await context.addInitScript(() => {
    const original = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    let fail = true;
    Object.defineProperty(navigator.serviceWorker, "register", { value: (...args: Parameters<ServiceWorkerContainer["register"]>) => {
      if (fail) { fail = false; throw new DOMException("temporary policy failure", "SecurityError"); }
      return original(...args);
    } });
  });
  // Close Chromium's initial blank client, so update tests control every tab.
  for (const blank of context.pages()) await blank.close();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await context.route("https://accounts.google.com/**", route => route.abort());
  await context.route("https://www.googleapis.com/**", route => route.fulfill({ json: { private: "fixture-token" } }));
  await page.goto(base);
  await page.getByRole("heading", { name: "論文を選んで、読み始めよう" }).waitFor();
  const cacheFailure = page.getByRole("status").filter({ hasText: "オフライン起動の準備を完了できませんでした" });
  await cacheFailure.waitFor();
  await page.evaluate(() => dispatchEvent(new Event("online")));
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await cacheFailure.waitFor({ state: "hidden" });
  const cdp = await context.newCDPSession(page);
  const appManifest = await cdp.send("Page.getAppManifest");
  assert.deepEqual(appManifest.errors, []);
  const manifest = JSON.parse(appManifest.data!);
  for (const field of ["id", "scope", "start_url"]) assert.equal(new URL(manifest[field], base).href, base);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.icons.filter((icon: { purpose: string }) => icon.purpose === "any").length, 2);
  assert.deepEqual((await cdp.send("Page.getInstallabilityErrors")).installabilityErrors, []);
  for (const icon of [...manifest.icons.map((value: { src: string }) => value.src), "./apple-touch-icon.png"]) {
    assert.equal((await context.request.get(new URL(icon, base).href)).status(), 200);
  }
  // Synthetic install UI, including dismissal and a later prompt; no native dialog automation.
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, { prompt: async () => {}, userChoice: Promise.resolve({ outcome: "dismissed" }) });
    dispatchEvent(event);
  });
  await page.getByText("アプリとして使う", { exact: true }).click();
  await page.getByRole("button", { name: "Papeerをインストール" }).click();
  assert.equal(await page.getByRole("button", { name: "Papeerをインストール" }).count(), 0);
  // Requests with credentials, a query, an unlisted path or another origin must never enter the shell cache.
  await page.evaluate(async () => {
    await fetch("./private.json", { headers: { Authorization: "Bearer fixture-token" } });
    await fetch("./icon-192.png?token=fixture-token");
    await fetch("./icon-512.png", { headers: { Authorization: "Bearer fixture-token" } });
    await fetch("/outside/");
    await fetch("https://www.googleapis.com/drive/v3/files/private?alt=media", { headers: { Authorization: "Bearer fixture-token" } });
    localStorage.setItem("papeer-ink:fixture-draft", "unsent-draft-fixture");
  });
  const cachedUrls = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key =>
    (await (await caches.open(key)).keys()).map(request => request.url)))).flat());
  assert.ok(cachedUrls.length > 8);
  assert.ok(cachedUrls.every(url => url.startsWith(base) && !url.includes("?") && !url.includes("private")));
  assert.equal(cachedUrls.some(url => url.includes("google")), false);
  await context.setOffline(true);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  // Current Chromium's request-level emulation does not change navigator.onLine.
  await cdp.send("Network.overrideNetworkState", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "論文を選んで、読み始めよう" }).waitFor();
  await page.getByRole("status").filter({ hasText: "オフラインです" }).waitFor();
  assert.equal(await cacheFailure.count(), 0, "an offline launch with an active worker is already prepared");
  assert.equal(await page.getByRole("button", { name: "Googleでログインして開く →" }).isDisabled(), true);
  assert.equal(await page.evaluate(() => localStorage.getItem("papeer-ink:fixture-draft")), "unsent-draft-fixture");
  assert.equal(await page.evaluate(async () => { try { await fetch("./private.json"); return false; } catch { return true; } }), true);
  const output = path.resolve(import.meta.dirname, "../../output/pwa"); fs.mkdirSync(output, { recursive: true });
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.screenshot({ path: path.join(output, "offline-ipad.png") });
  await context.setOffline(false);
  await cdp.send("Network.overrideNetworkState", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  nextVersion = true;
  const updatedWorkerPromise = context.waitForEvent("serviceworker");
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
  const updatedWorker = await updatedWorkerPromise;
  await page.getByRole("status").filter({ hasText: "更新があります" }).waitFor();
  // A second client keeps the old version alive even after the original is closed.
  const second = await context.newPage(); await second.goto(base, { waitUntil: "domcontentloaded" });
  await second.getByRole("status").filter({ hasText: "更新があります" }).waitFor();
  await second.evaluate(() => { const draft = document.createElement("textarea"); draft.id = "unsaved-text"; draft.value = "in-progress"; document.body.append(draft); });
  await page.close();
  assert.equal(await second.locator("#unsaved-text").inputValue(), "in-progress");
  assert.equal(await second.evaluate(async () => (await caches.keys()).filter(key => key.startsWith("papeer-shell:")).length), 2);
  await second.close();
  // Allow activation to finish before reopening: an immediate new client can still
  // retain the previous controller, exactly as a user reopening too quickly can.
  await updatedWorker.evaluate(() => new Promise<void>(resolve => {
    const registration = (globalThis as unknown as { registration: ServiceWorkerRegistration }).registration;
    const check = () => {
      if (registration.active?.state === "activated") resolve();
      else setTimeout(check, 25);
    };
    check();
  }));
  const reopened = await context.newPage(); await reopened.goto(base, { waitUntil: "domcontentloaded" });
  await reopened.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const keys = (await caches.keys()).filter(key => key.startsWith("papeer-shell:"));
    return registration?.active?.state === "activated" && !registration.installing && !registration.waiting
      && keys.length === 1 && keys[0].endsWith("-test-update");
  });
  assert.equal(await reopened.evaluate(() => localStorage.getItem("papeer-ink:fixture-draft")), "unsent-draft-fixture");
  assert.deepEqual(errors, []);
});

test("Published PWA manifest, icons and offline shell", { skip: !process.env.PAPEER_PWA_TEST_URL, timeout: 90_000 }, async t => {
  const base = process.env.PAPEER_PWA_TEST_URL!;
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route("https://accounts.google.com/**", route => route.abort());
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const cdp = await context.newCDPSession(page);
  const result = await cdp.send("Page.getAppManifest");
  assert.deepEqual(result.errors, []);
  const manifest = JSON.parse(result.data!);
  assert.equal(new URL(manifest.scope, base).href, base);
  assert.equal(manifest.display, "standalone");
  for (const icon of manifest.icons) assert.equal((await context.request.get(new URL(icon.src, base).href)).status(), 200);
  await context.setOffline(true);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.overrideNetworkState", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "論文を選んで、読み始めよう" }).waitFor();
  await page.getByRole("status").filter({ hasText: "オフラインです" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Googleでログインして開く →" }).isDisabled(), true);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("Published PWA manifest, icons and offline shell", { timeout: 90_000 }, async t => {
  const base = process.env.PAPEER_PWA_TEST_URL;
  assert.ok(base, "PAPEER_PWA_TEST_URL is required for post-deployment checks");
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

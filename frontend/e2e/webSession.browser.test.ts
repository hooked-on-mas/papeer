/** Synthetic Google grants exercise tab restoration on desktop and phone-sized browsers. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium, webkit } from "playwright-core";
import { clickAccountAction } from "./webAccount.ts";

for (const engine of ["Edge", "WebKit"] as const) {
test(`${engine} restores valid tab sessions without Google prompts and retains offline recovery`, { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ cacheDir: path.resolve(frontend, "../output/web-session/vite-" + randomUUID()),
    configFile: path.join(frontend, "vite.web.config.ts"), logLevel: "error", server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === "Edge" ? await chromium.launch({ channel: "msedge", headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close());
  const paper = "a".repeat(32), key = "papeer-google-session:v1";
  const pdf = fs.readFileSync(path.resolve(frontend, "../tests/fixtures/sample.pdf"));
  const pdfFile = { id: "pdf", mime: "application/pdf", size: pdf.length, sha256: createHash("sha256").update(pdf).digest("hex") };
  for (const viewport of [{ width: 1366, height: 1024 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors: string[] = [], prompts: string[] = [];
    let sdkBlocked = false, rejectToken = false, driveRequests = 0, account = "first";
    page.on("pageerror", error => errors.push(error.message));
    await page.exposeFunction("recordGooglePrompt", (prompt: string) => {
      prompts.push(prompt);
      if (prompt === "select_account") account = "other";
      return `tab-test-token-${account}`;
    });
    await page.route("https://accounts.google.com/gsi/client", async route => {
      if (sdkBlocked) { await route.abort(); return; }
      await route.fulfill({ contentType: "text/javascript", body:
        'window.google={accounts:{oauth2:{initTokenClient:opts=>({requestAccessToken:async config=>{const token=await window.recordGooglePrompt(config.prompt);opts.callback({access_token:token,expires_in:3600});}})}}};' });
    });
    await page.route("https://www.googleapis.com/**", async route => {
      const request = route.request(), url = new URL(request.url());
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
      driveRequests++;
      const authorization = request.headers().authorization;
      assert.ok(authorization === "Bearer tab-test-token-first" || authorization === "Bearer tab-test-token-other");
      const otherAccount = authorization === "Bearer tab-test-token-other";
      if (rejectToken) { await route.fulfill({ status: 401, headers }); return; }
      const id = url.pathname.split("/").pop();
      if (id === "files") await route.fulfill({ json: { files: url.searchParams.get("q")?.includes("ink-v1") ? []
        : [{ id: otherAccount ? "other-library" : "library", name: "papeer-library.json", modifiedTime: "2026-10-24T00:00:00Z" }] }, headers });
      else if (id === "library" || id === "other-library") await route.fulfill({ json: {
        version: 1, revision: "test", updated_at: "2026-10-24T00:00:00Z", folder_id: "folder",
        items: [{ id: paper, title: otherAccount ? "切替後の論文" : "接続復元の論文" }], attachments: [], files: { [`papers/${paper}/original.pdf`]: pdfFile },
      }, headers });
      else await route.fulfill({ body: pdf, headers });
    });
    const ready = async () => {
      await page.waitForFunction(() => document.querySelector(".workspace")?.getAttribute("aria-busy") === "false");
      await page.locator(".react-pdf__Page canvas").waitFor();
      await page.waitForLoadState("networkidle");
    };
    const accountAction = async (name: string) => {
      if (!await page.getByRole("button", { name: "Google接続メニュー", exact: true }).isVisible()) {
        await page.getByLabel("読書メニュー", { exact: true }).click();
      }
      await clickAccountAction(page, name);
    };
    const inlineLogin = page.locator(".local-library-notice").getByRole("button", { name: "Googleでログイン", exact: true });
    await page.goto(process.env.PAPEER_WEB_TEST_URL || server.resolvedUrls!.local[0]);
    await page.getByRole("button", { name: "Googleでログインして開く →" }).click(); await ready();
    assert.deepEqual(prompts, [""]);
    const deadline = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!).expires as number, key);
    assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes("tab-test-token"))), false);
    // Even a failed Google SDK download must not prevent restoring a valid token.
    sdkBlocked = true;
    const beforeRestore = driveRequests;
    await page.reload(); await ready();
    assert.ok(driveRequests > beforeRestore);
    assert.deepEqual(prompts, [""]);
    assert.equal(await page.locator(".local-library-notice").count(), 0);
    assert.equal(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!).expires, key), deadline);
    sdkBlocked = false;
    await page.reload(); await ready();
    await page.waitForFunction(() => !!window.google);
    await accountAction("再ログイン"); await ready();
    await accountAction("アカウントを切り替える"); await ready();
    assert.deepEqual(prompts, ["", "", "select_account"]);
    await page.waitForFunction(() => document.querySelector(".document-title h1")?.textContent === "切替後の論文");
    // The next automatic restore must use the switched account, not its predecessor's cache.
    await page.reload(); await ready();
    assert.equal(await page.locator(".document-title h1").textContent(), "切替後の論文");
    assert.deepEqual(prompts, ["", "", "select_account"]);
    // An expired grant opens the cached reader without contacting Drive or popping up Google.
    await page.evaluate(key => {
      const saved = JSON.parse(sessionStorage.getItem(key)!); saved.expires = Date.now() - 1;
      sessionStorage.setItem(key, JSON.stringify(saved));
    }, key);
    const beforeExpiry = driveRequests;
    await page.reload(); await ready(); await inlineLogin.waitFor();
    assert.equal(driveRequests, beforeExpiry);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), key), null);
    await inlineLogin.click(); await ready();
    // Revoked grants are discarded, with the saved reader still available for reading.
    rejectToken = true;
    await page.reload(); await ready(); await inlineLogin.waitFor();
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), key), null);
    await page.getByRole("alert").filter({ hasText: "再度Googleでログイン" }).waitFor();
    rejectToken = false;
    await inlineLogin.click(); await ready();
    await accountAction("ログアウト");
    await page.getByRole("heading", { name: "論文を選んで、読み始めよう" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "ダウンロード済みのライブラリを開く", exact: true }).count(), 0);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), key), null);
    const beforeLogoutReload = driveRequests;
    await page.reload();
    await page.getByRole("button", { name: "Googleでログインして開く →" }).waitFor();
    assert.equal(driveRequests, beforeLogoutReload);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
}

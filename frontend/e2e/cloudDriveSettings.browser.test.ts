/** Users authorize their account without entering developer OAuth credentials. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

test("Drive settings offer one-button connection with no client ID or secret inputs", { timeout: 90_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const status = { supported: true, configured: true, setup_error: null as string | null, connected: false,
    connecting: false, auth_error: null, auto_upload: true, last_upload: null, error: null, folder_id: null };
  const requests: string[] = [];
  await page.route("http://127.0.0.1:8000/**", async route => {
    const request = route.request(); const pathname = new URL(request.url()).pathname;
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (pathname.endsWith("/connect")) {
      assert.equal(request.method(), "POST"); assert.equal(request.postData(), null);
      requests.push(pathname); status.connecting = true;
    } else if (request.method() === "DELETE") {
      status.connected = false; status.connecting = false;
    }
    await route.fulfill({ json: status, headers });
  });
  const url = server.resolvedUrls!.local[0] + "e2e/fixtures/cloudDriveSettings.html";
  await page.goto(url);
  const connect = page.getByRole("button", { name: "Googleに接続", exact: true });
  await connect.waitFor(); assert.equal(await connect.isEnabled(), true);
  assert.equal(await page.getByRole("textbox").count(), 0);
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  assert.equal(await page.getByText(/OAuth|クライアントID|シークレット/).count(), 0);
  await connect.click();
  await page.getByRole("status").filter({ hasText: "ブラウザーでGoogleへの接続" }).waitFor();
  assert.equal(await connect.isDisabled(), true); assert.equal(requests.length, 1);
  status.connecting = false; status.connected = true;
  await page.getByText("Google Driveに接続済み", { exact: false }).waitFor();
  await page.getByRole("button", { name: "接続解除", exact: true }).click();
  await connect.waitFor(); assert.equal(await connect.isEnabled(), true);
  const output = path.resolve(frontend, "../output/cloud-drive-settings"); fs.mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, "connect.png"), fullPage: true });
  status.configured = false; status.setup_error = "このビルドにはGoogle接続の設定が含まれていません。接続対応版に更新してください。";
  await page.reload();
  await page.getByRole("alert").filter({ hasText: "接続対応版に更新" }).waitFor();
  assert.equal(await connect.isDisabled(), true);
  assert.equal(await page.getByRole("textbox").count(), 0);
  assert.deepEqual(errors, []);
});

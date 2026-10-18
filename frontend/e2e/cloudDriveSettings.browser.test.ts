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
    connecting: false, can_reopen: false, auth_stage: null as string | null,
    auth_error: null as string | null, auth_error_code: null as string | null,
    auto_upload: true, last_upload: null, error: null, folder_id: null };
  const requests: string[] = [];
  await page.route("http://127.0.0.1:8000/**", async route => {
    const request = route.request(); const pathname = new URL(request.url()).pathname;
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (["/connect", "/reopen", "/cancel"].some(p => pathname.endsWith(p))) {
      assert.equal(request.method(), "POST"); assert.equal(request.postData(), null);
      requests.push(pathname);
      if (pathname.endsWith("/cancel")) {
        status.connecting = false; status.can_reopen = false; status.auth_stage = null;
      } else if (pathname.endsWith("/connect")) {
        status.connecting = true; status.can_reopen = true; status.auth_stage = "waiting";
        status.auth_error = null; status.auth_error_code = null;
      }
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
  const reopen = page.getByRole("button", { name: "認証画面をもう一度開く", exact: true });
  const cancel = page.getByRole("button", { name: "接続をキャンセル", exact: true });
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(b => b.textContent === "認証画面をもう一度開く")?.disabled);
  assert.equal(await reopen.isEnabled(), true); assert.equal(requests.length, 1);
  await reopen.click();
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(b => b.textContent === "接続をキャンセル")?.disabled);
  assert.equal(requests[requests.length - 1], "/api/cloud-drive/reopen");
  status.auth_stage = "exchanging"; status.can_reopen = false;
  await page.getByRole("status").filter({ hasText: "Googleの接続結果を確認" }).waitFor();
  assert.equal(await reopen.isDisabled(), true); assert.equal(await cancel.isEnabled(), true);
  await cancel.click();
  await connect.waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(b => b.textContent === "Googleに接続")?.disabled);
  assert.equal(requests[requests.length - 1], "/api/cloud-drive/cancel");
  await connect.click();
  await reopen.waitFor();
  status.connecting = false; status.can_reopen = false; status.auth_stage = null; status.connected = true;
  await page.getByText("Google Driveに接続済み", { exact: false }).waitFor();
  await page.getByRole("button", { name: "接続解除", exact: true }).click();
  await connect.waitFor(); assert.equal(await connect.isEnabled(), true);
  status.auth_error = "Googleの認証コードまたは更新トークンが無効です（invalid_grant）。もう一度接続してください。";
  status.auth_error_code = "invalid_grant";
  await page.reload();
  await page.getByRole("alert").filter({ hasText: "invalid_grant" }).waitFor();
  assert.equal(await connect.isEnabled(), true);
  const output = path.resolve(frontend, "../output/cloud-drive-settings"); fs.mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, "connect.png"), fullPage: true });
  status.auth_error = null; status.auth_error_code = null;
  status.configured = false; status.setup_error = "このビルドにはGoogle接続の設定が含まれていません。接続対応版に更新してください。";
  await page.reload();
  await page.getByRole("alert").filter({ hasText: "接続対応版に更新" }).waitFor();
  assert.equal(await connect.isDisabled(), true);
  assert.equal(await page.getByRole("textbox").count(), 0);
  assert.deepEqual(errors, []);
});

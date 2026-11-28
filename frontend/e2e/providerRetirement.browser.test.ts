/** Retired connections remain readable while users move each connection to a supported provider. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import type { ProviderSpec, SettingsData } from "../src/api/hooks.ts";
import type { ConnectionForm } from "../src/features/settings/ConnectionSection.tsx";

test("retired connections preserve saved options and can migrate without invoking the retired CLI", { timeout: 90_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const providers: ProviderSpec[] = [
    { id: "codex", label: "Codex", description: "", kind: "cli", needs_login: true, needs_api_key: false, login_service: "Codex", fields: [] },
    { id: "claude", label: "Claude Code", description: "", kind: "cli", needs_login: true, needs_api_key: false, login_service: "Claude", fields: [] },
    { id: "api", label: "API", description: "", kind: "http", needs_login: false, needs_api_key: true, login_service: "", fields: [] },
  ];
  for (const retired of ["antigravity", "gemini"]) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const providerRequests: string[] = [];
    const saved: ReturnType<ConnectionForm["values"]>[] = [];
    const settings: SettingsData = {
      provider: retired, model: "legacy-model", reasoning_effort: "high", timeout_seconds: 900,
      translation_concurrency: 0, paper_metadata_ai_enabled: true, paper_discovery_enabled: true,
      paper_metadata_provider: retired, paper_metadata_model: "legacy-lookup-model",
      provider_options: { [retired]: { cli_path: "C:/legacy/agy.exe", model: "legacy-model", reasoning_effort: "high" } },
      api_key: "", semantic_scholar_api_key: "", unknown_keys: [],
    };
    await page.route("http://127.0.0.1:8000/**", async route => {
      const request = route.request(); const pathname = new URL(request.url()).pathname;
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
      if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
      if (pathname === "/api/settings" && request.method() === "PUT") {
        saved.push(request.postDataJSON());
        await route.fulfill({ json: { status: "saved" }, headers }); return;
      }
      if (pathname.startsWith("/api/providers/")) providerRequests.push(pathname);
      const json = pathname === "/api/settings" ? settings : pathname === "/api/providers" ? providers
        : pathname.endsWith("/models") ? [{ id: "api-model", name: "API model" }]
        : pathname.endsWith("/efforts") ? [{ id: "", name: "既定値" }] : {};
      await route.fulfill({ json, headers });
    });
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/providerRetirement.html");
    const translationAlert = page.getByRole("alert").filter({ hasText: "以下からAI接続を選び直してください" });
    const informationAlert = page.getByRole("alert").filter({ hasText: "情報取得の接続先を選び直してください" });
    await translationAlert.waitFor(); await informationAlert.waitFor();
    assert.equal(await page.getByRole("radio").count(), 3);
    assert.equal(await page.getByRole("radio", { name: /Antigravity|Gemini/ }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "接続を確認", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "情報取得の接続を確認", exact: true }).isDisabled(), true);
    assert.equal(await page.getByTitle("モデル一覧を再取得").isDisabled(), true);
    assert.equal(await page.getByRole("combobox", { name: "情報取得の接続先" }).inputValue(), retired);

    await page.getByRole("checkbox", { name: "論文マップで外部の関連論文を自動取得する" }).uncheck();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "保存回数: 1" }).waitFor();
    assert.equal(saved[0].provider, retired);
    assert.equal(saved[0].model, "legacy-model");
    assert.equal(saved[0].reasoning_effort, "high");
    assert.equal(saved[0].provider_options[retired].reasoning_effort, "high");
    assert.equal(saved[0].provider_options[retired].cli_path, "C:/legacy/agy.exe");
    assert.equal(saved[0].paper_metadata_provider, retired);
    assert.equal(saved[0].paper_metadata_model, "legacy-lookup-model");

    await page.getByRole("radio", { name: "API", exact: true }).click();
    await translationAlert.waitFor({ state: "hidden" });
    assert.equal(await informationAlert.isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "接続を確認", exact: true }).isEnabled(), true);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "保存回数: 2" }).waitFor();
    assert.equal(saved[1].provider, "api");
    assert.equal(saved[1].paper_metadata_provider, retired);

    await page.getByRole("combobox", { name: "情報取得の接続先" }).selectOption("");
    await informationAlert.waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("button", { name: "情報取得の接続を確認", exact: true }).isEnabled(), true);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "保存回数: 3" }).waitFor();
    assert.equal(saved[2].provider, "api");
    assert.equal(saved[2].paper_metadata_provider, "");
    assert.deepEqual(saved[2].provider_options[retired], saved[0].provider_options[retired]);
    assert.deepEqual(providerRequests.filter(url => /\/(antigravity|gemini)\//.test(url)), []);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

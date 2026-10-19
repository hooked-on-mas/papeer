/** Integrity-valid but unparsable PDF -> usable download -> repaired PC snapshot. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium, webkit } from "playwright-core";

for (const engine of ["webkit", "chromium"] as const) test(`damaged PDF download and repaired snapshot (${engine})`, { timeout: 60_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ configFile: path.join(frontend, "vite.web.config.ts"), logLevel: "error",
    cacheDir: path.resolve(frontend, "../output/document-failures/vite-" + randomUUID()),
    server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === "webkit" ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: "msedge", headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: "block", viewport: { width: 1100, height: 850 } });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const valid = fs.readFileSync(path.resolve(frontend, "../tests/fixtures/sample.pdf"));
  const broken = Buffer.from("This is not a PDF, despite its correct snapshot hash.");
  let repaired = false;
  const paper = "a".repeat(32);
  await context.route("https://accounts.google.com/gsi/client", route => route.fulfill({ contentType: "text/javascript", body:
    'window.google={accounts:{oauth2:{initTokenClient:o=>({requestAccessToken:()=>o.callback({access_token:"document-fixture",expires_in:3600})})}}};' }));
  await context.route("https://www.googleapis.com/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204 }); return; }
    assert.equal(request.headers().authorization, "Bearer document-fixture");
    const id = url.pathname.split("/").pop();
    if (id === "files") await route.fulfill({ json: { files: url.searchParams.get("q")?.includes("ink-v1") ? [] : [{ id: "library", name: "papeer-library.json" }] } });
    else if (id === "library") {
      const bytes = repaired ? valid : broken;
      await route.fulfill({ json: { version: 1, revision: repaired ? "repaired" : "broken", updated_at: "2026-10-19", folder_id: "folder",
        items: [{ id: paper, title: "破損PDFの復旧" }], attachments: [], files: {
          [`papers/${paper}/original.pdf`]: { id: "document", size: bytes.length, mime: "application/pdf", sha256: createHash("sha256").update(bytes).digest("hex") },
        } } });
    } else { assert.equal(id, "document"); await route.fulfill({ body: repaired ? valid : broken, contentType: "application/pdf" }); }
  });
  await page.goto(server.resolvedUrls!.local[0]);
  await page.getByRole("button", { name: "Googleでログインして開く →" }).click();
  const pane = page.getByRole("region", { name: "原文", exact: true });
  await page.getByText("PDFを表示できません。ダウンロードしてご確認ください。", { exact: true }).waitFor();
  assert.equal(await pane.locator("canvas").count(), 0);
  const link = pane.getByRole("link", { name: "PDF本体を保存 ↓", exact: true });
  const oldUrl = await link.getAttribute("href"); assert.ok(oldUrl?.startsWith("blob:"));
  const downloading = page.waitForEvent("download"); await link.click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), "original.pdf");
  assert.deepEqual(fs.readFileSync((await download.path())!), broken);
  repaired = true; await page.getByRole("button", { name: "更新", exact: true }).click();
  await pane.locator("canvas").waitFor();
  await page.waitForFunction(() => document.querySelector('.textLayer')?.textContent?.includes("Adaptive Control"));
  assert.equal(await page.getByText("PDFを表示できません。ダウンロードしてご確認ください。", { exact: true }).count(), 0);
  assert.equal(await page.evaluate(async value => { try { await fetch(value!); return true; } catch { return false; } }, oldUrl), false, "replacement revokes the old protected Blob URL");
  assert.deepEqual(errors, []);
});

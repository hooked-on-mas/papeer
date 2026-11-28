import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

test("shared PC/Web writing controls isolate documents, retain target focus and survive pane removal and resizing", { timeout: 60_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    cacheDir: "node_modules/.vite-writing-toolbar", server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/writingToolbar.html`);
  for (const name of ["PC", "Web"]) {
    const reader = page.getByRole("region", { name, exact: true });
    await reader.getByRole("toolbar").waitFor();
    assert.equal(await reader.getByRole("toolbar").count(), 1);
    await reader.getByRole("button", { name: "Draw original", exact: true }).click();
    await reader.getByRole("button", { name: "Draw translated", exact: true }).click();
    const original = reader.locator('[data-pane="original"] output');
    const translated = reader.locator('[data-pane="translated"] output');
    await reader.getByRole("button", { name: "元に戻す", exact: true }).click();
    assert.equal(await original.textContent(), "1"); assert.equal(await translated.textContent(), "0");
    if (name === "PC") {
      await reader.getByRole("button", { name: "原文", exact: true }).focus();
      await page.keyboard.press("Enter");
      assert.equal(await reader.getByRole("button", { name: "原文", exact: true }).evaluate(element => document.activeElement === element), true);
    } else {
      const target = reader.getByLabel("書き込みの操作対象");
      await target.focus(); await target.selectOption("original");
      assert.equal(await target.evaluate(element => document.activeElement === element), true);
    }
    await reader.getByRole("button", { name: "元に戻す", exact: true }).click();
    assert.equal(await original.textContent(), "0");
    await reader.getByRole("button", { name: "Draw translated", exact: true }).click();
    await reader.getByRole("button", { name: "Toggle translation", exact: true }).click();
    assert.equal(await reader.getByRole("toolbar").count(), 1);
    assert.equal(await reader.getByRole("button", { name: "元に戻す", exact: true }).isDisabled(), true);
    await reader.getByRole("button", { name: "Toggle translation", exact: true }).click();
    await reader.getByRole("button", { name: "Draw translated", exact: true }).click();
    assert.equal(await reader.getByRole("toolbar").count(), 1);
    await reader.getByRole("button", { name: "Resize", exact: true }).click();
    await page.waitForFunction(readerName => document.querySelector(`section[aria-label="${readerName}"] [data-width]`)?.textContent === "320", name);
  }
  // The second provider's removals and selection never replace the first provider's toolbar.
  assert.equal(await page.getByRole("region", { name: "PC", exact: true }).getByRole("button", { name: "訳文", exact: true }).getAttribute("aria-pressed"), "true");
  assert.deepEqual(errors, []);
});

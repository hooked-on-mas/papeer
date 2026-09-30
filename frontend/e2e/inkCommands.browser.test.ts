/** Real editor and pointer capture, with an isolated mock ink API. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

test("Delete and Undo during a shape drag stay applied after pointer release", { timeout: 60_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route(url => url.pathname.startsWith("/api/"), route => route.fulfill({
    json: route.request().method() === "GET" ? { strokes: [] } : { status: "saved" },
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" },
  }));
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/inkCommands.html`);
  await page.locator('output[data-ready="true"]').waitFor();
  const box = (await page.locator("svg").boundingBox())!;
  const at = (x: number, y: number) => page.mouse.move(box.x + box.width * x, box.y + box.height * y);
  const ink = () => page.locator("output").textContent().then(value => JSON.parse(value!));
  for (const command of ["Delete", "Control+z"]) {
    await at(0.2, 0.3); await page.mouse.down(); await at(0.7, 0.3); await page.mouse.up();
    await page.waitForFunction(() => JSON.parse(document.querySelector("output")!.textContent!).length === 1);
    const saved = await ink();
    await at(0.7, 0.3); await page.mouse.down(); await at(0.6, 0.5);
    await page.keyboard.press(command);
    await page.mouse.up();
    await page.waitForFunction(() => JSON.parse(document.querySelector("output")!.textContent!).length === 0);
    assert.deepEqual(await ink(), [], `${command} must not be overwritten by the old gesture`);
    // Redo/Undo must recover the saved arrow, without recording the canceled drag.
    await page.keyboard.press(command === "Delete" ? "Control+z" : "Control+Shift+z");
    await page.waitForFunction(() => JSON.parse(document.querySelector("output")!.textContent!).length === 1);
    const restored = await ink();
    assert.deepEqual(restored, saved);
    await page.keyboard.press("Control+z");
    await page.waitForFunction(() => JSON.parse(document.querySelector("output")!.textContent!).length === 0);
  }
  assert.deepEqual(errors, []);
});

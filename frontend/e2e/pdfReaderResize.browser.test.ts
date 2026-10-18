/** Rendering and annotation readiness after tablet rotation / rapid resize. Synthetic Drive only. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

async function exerciseResize(t: TestContext, delayedRenderer = false) {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ cacheDir: path.resolve(frontend, "../output/pdf-reader-resize/vite-" + randomUUID()), configFile: path.join(frontend, "vite.web.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, hmr: false },
    // Model a completed old canvas whose success notification is already queued when resized.
    // The real renderer is covered by the first case; this makes callback reordering deterministic.
    plugins: delayedRenderer ? [{ name: "delayed-pdf-renderer", enforce: "pre", transform(_code, id) {
      if (!id.replace(/\\/g, "/").endsWith("/features/reader/PdfDocument.tsx")) return;
      return `import { createElement, useEffect } from "react";
        export function PdfDocument({ children, onLoadSuccess }) {
          useEffect(() => { onLoadSuccess?.({ numPages: 2 }); }, []);
          return children;
        }
        export function PdfPage({ width, pageNumber, onLoadSuccess, onRenderSuccess }) {
          useEffect(() => { onLoadSuccess?.({ getViewport: () => ({ width: 600, height: 800 }) }); }, []);
          useEffect(() => {
            const finish = () => onRenderSuccess?.();
            if (window.__papeerHoldRenders) {
              (window.__papeerRenderCallbacks ??= []).push({ width, finish });
            } else queueMicrotask(finish);
          }, [width, pageNumber]);
          return createElement("canvas", { width, height: width * 4 / 3, style: { display: "block", width } });
        }`;
    } }] : [] });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, hasTouch: true });
  const paper = "a".repeat(32);
  const blobs: Record<string, Buffer> = {
    pdf: fs.readFileSync(path.resolve(frontend, "../tests/fixtures/sample.pdf")),
    ink: Buffer.from(JSON.stringify({ version: 1, pages: {}, applied: [] })),
  };
  const file = (id: string, mime: string) => ({ id, mime, size: blobs[id].length,
    sha256: createHash("sha256").update(blobs[id]).digest("hex") });
  const manifest = { version: 1, revision: "resize", updated_at: "2026-10-18T00:00:00Z", folder_id: "folder",
    items: [{ id: paper, title: "Resize fixture" }], attachments: [], files: {
      [`papers/${paper}/original.pdf`]: file("pdf", "application/pdf"), "web-annotations.json": file("ink", "application/json"),
    } };
  let saved = 0;
  await page.route("https://accounts.google.com/gsi/client", route => route.fulfill({ contentType: "text/javascript", body:
    'window.google={accounts:{oauth2:{initTokenClient:opts=>({requestAccessToken:()=>opts.callback({access_token:"test-token",expires_in:3600})})}}};' }));
  await page.route("https://www.googleapis.com/**", async route => {
    const req = route.request(), url = new URL(req.url());
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
    if (req.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (req.method() === "POST") { saved++; await route.fulfill({ json: { id: "ink-op" }, headers }); return; }
    const id = url.pathname.split("/").pop()!;
    if (id === "files") await route.fulfill({ json: { files: url.searchParams.get("q")?.includes("ink-v1") ? []
      : [{ id: "library", name: "papeer-library.json", modifiedTime: manifest.updated_at }] }, headers });
    else if (id === "library") await route.fulfill({ json: manifest, headers });
    else await route.fulfill({ body: blobs[id], headers });
  });
  await page.goto(!delayedRenderer && process.env.PAPEER_WEB_TEST_URL || server.resolvedUrls!.local[0]);
  await page.getByRole("button", { name: "Googleでログインして開く →" }).click();
  const ready = async () => {
    await page.waitForFunction(() => {
      const pen = [...document.querySelectorAll<HTMLButtonElement>('.ink-tools button')].find(button => button.textContent === "ペン");
      return pen && !pen.disabled && document.querySelector('[data-testid="web-ink"]');
    }, undefined, { timeout: 10000 });
  };
  await ready();
  const cdp = await page.context().newCDPSession(page);
  if (!delayedRenderer) {
    const pane = (await page.getByRole("region", { name: "原文", exact: true }).boundingBox())!;
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pane.x + 100, y: pane.y + 120, button: "left", clickCount: 1, pointerType: "pen" });
  }
  // Resize while renders are outstanding, then require the final canvas AND ink editor to recover.
  for (let cycle = 0; cycle < (delayedRenderer ? 1 : 3); cycle++) {
    if (delayedRenderer) await page.evaluate(() => { (window as unknown as { __papeerHoldRenders: boolean }).__papeerHoldRenders = true; });
    for (const width of [1024, 1023, 1366, 800, 390, 1025, 1024]) await page.setViewportSize({ width, height: 1366 });
    if (delayedRenderer) {
      await page.waitForFunction(() => {
        const callbacks = (window as unknown as { __papeerRenderCallbacks?: { width: number }[] }).__papeerRenderCallbacks;
        const canvas = document.querySelector('canvas')!;
        return callbacks && callbacks.length > 1 && callbacks[callbacks.length - 1].width === canvas.width
          && canvas.width === Math.floor(document.querySelector('.pdf')!.getBoundingClientRect().width);
      });
      await page.evaluate(() => {
        const renderer = window as unknown as { __papeerHoldRenders: boolean; __papeerRenderCallbacks: { finish(): void }[] };
        renderer.__papeerHoldRenders = false;
        // Finish the latest canvas first, then flush obsolete callbacks after it, including old dimensions.
        for (const callback of renderer.__papeerRenderCallbacks.reverse()) callback.finish();
        renderer.__papeerRenderCallbacks = [];
      });
    }
    await ready();
    if (!delayedRenderer && cycle === 0) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 100, y: 200, button: "left", clickCount: 1, pointerType: "pen" });
      assert.equal(saved, 0, "rotation cancels an interrupted stroke without locking the next pen gesture");
    }
    await page.getByLabel("表示倍率").selectOption("2");
    await page.getByLabel("表示倍率").selectOption("0.75");
    await page.getByLabel("表示倍率").selectOption("1");
    await ready();
  }
  await page.getByRole("button", { name: "ペン", exact: true }).click();
  const surface = page.getByTestId("web-ink"); await surface.scrollIntoViewIfNeeded();
  await surface.click({ position: { x: 60, y: 60 } });
  await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 1);
  await page.getByRole("status").filter({ hasText: "Driveに保存済み" }).waitFor();
  assert.equal(saved, 1);
}

test("Web ink remains writable after rapid resize, rotation and zoom", { timeout: 120_000 }, t => exerciseResize(t));
test("late completion of a superseded PDF render cannot disable the current ink editor", { timeout: 60_000 }, t => exerciseResize(t, true));

/** Isolated real-browser touch test: node --test e2e/pdfTouch.browser.test.ts (no sidecar needed). */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium, type Page } from "playwright-core";

const frontend = path.resolve(import.meta.dirname, "..");
const paint = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test("PDF touch zoom stays under the fingers at high magnification, through redraws and in either pane", { timeout: 120_000 }, async t => {
  const server = await createServer({
    root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    cacheDir: "node_modules/.vite-pdf-touch-test",
    optimizeDeps: { entries: ["e2e/fixtures/pdfTouch.html"] },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
  });
  await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1366, height: 800 }, hasTouch: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  // Never contact the running user's sidecar, even if a fixture inadvertently enables a query.
  await page.route(url => url.pathname.startsWith("/api/"), route => route.abort());
  await page.route("**/touch-fixture.pdf", route => route.fulfill({
    path: path.resolve(frontend, "../tests/fixtures/sample.pdf"), contentType: "application/pdf",
  }));
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/pdfTouch.html`);
  await page.locator('[data-test-pane="right"] .textLayer').waitFor({ timeout: 20_000 }).catch(async error => {
    throw new Error(`${error}\nPage errors: ${errors.join("\n")}\n${(await page.locator("body").innerText()).slice(0, 3000)}`);
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });

  const settled = async () => {
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>("[data-pdf-surface]")].length === 2
      && [...document.querySelectorAll<HTMLElement>("[data-pdf-surface]")].every(el => !el.style.zoom
        && !!el.querySelector("canvas")?.width && el.querySelector("canvas")?.style.visibility !== "hidden"));
    await paint(page);
  };
  const geometry = (side: string) => page.evaluate(side => {
    const root = document.querySelector(`[data-test-pane="${side}"]`)!;
    const pane = root.querySelector<HTMLElement>("[data-pdf-scroller]")!;
    const surface = root.querySelector<HTMLElement>("[data-pdf-surface]")!;
    const p = pane.getBoundingClientRect(), box = surface.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height,
      cx: p.left + pane.clientWidth * 0.5, cy: p.top + pane.clientHeight * 0.45,
      zoom: Number((document.querySelector('[aria-label="Test zoom"]') as HTMLSelectElement).value),
      scrollTop: pane.scrollTop,
      canvasWidth: surface.querySelector("canvas")!.width };
  }, side);

  for (const side of ["left", "right"]) {
    await page.getByLabel("Test zoom").selectOption("3");
    await settled();
    await page.locator(`[data-test-pane="${side}"] [data-pdf-scroller]`).evaluate(el => {
      el.scrollLeft = (el.scrollWidth - el.clientWidth) * 0.55;
      el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.65;
    });
    await paint(page);
    const start = await geometry(side);
    const x = (start.cx - start.left) / start.width, y = (start.cy - start.top) / start.height;
    const points = (scale: number, dx: number, dy: number) => [
      { id: 1, x: start.cx + dx - 80 * scale, y: start.cy + dy },
      { id: 2, x: start.cx + dx + 80 * scale, y: start.cy + dy },
    ];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(1, 0, 0) });
    const zooms = new Set<number>();
    let maxError = 0;
    // Grow almost to 400%, then reverse. A paused pinch must not replace the canvas midway.
    const scales = [...Array.from({ length: 20 }, (_, i) => 1 + (i + 1) * 0.015),
      ...Array.from({ length: 20 }, (_, i) => 1.3 - (i + 1) * 0.01)];
    for (let i = 0; i < scales.length; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(scales[i], 20, 15) });
      await paint(page);
      if (i === 19) await page.waitForTimeout(250);
      const now = await geometry(side);
      zooms.add(now.zoom);
      const error = Math.hypot(now.left + x * now.width - (start.cx + 20), now.top + y * now.height - (start.cy + 15));
      maxError = Math.max(error, maxError);
      assert.ok(error < 2, `${side}: zoom ${now.zoom}, anchor drift ${error}px at step ${i}`);
      assert.equal(now.canvasWidth, start.canvasWidth, "PDF canvas must stay unchanged while pinching");
    }
    assert.ok(zooms.size >= 30, `only ${zooms.size} distinct zooms: pinch still snaps to presets`);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await settled();
    const final = await geometry(side);
    const error = Math.hypot(final.left + x * final.width - (start.cx + 20), final.top + y * final.height - (start.cy + 15));
    assert.ok(error < 2, `${side}: ${error}px drift after sharp redraw`);
    t.diagnostic(`${side}: ${zooms.size} zoom values, maximum anchor drift ${maxError.toFixed(2)}px, after redraw ${error.toFixed(2)}px`);
  }

  // A two-finger pan that ends at the drawn width must not keep an anchor for later toolbar zooms.
  const leftPane = page.locator('[data-test-pane="left"] [data-pdf-scroller]');
  await page.getByLabel("Test zoom").selectOption("3"); await settled();
  await leftPane.evaluate(el => { el.scrollTop = 1290; el.scrollLeft = 200; }); await paint(page);
  await page.getByLabel("Test zoom").selectOption("2"); await settled();
  const normalZoom = await geometry("left");
  await page.getByLabel("Test zoom").selectOption("3"); await settled();
  await leftPane.evaluate(el => { el.scrollTop = 900; el.scrollLeft = 200; }); await paint(page);
  const panStart = await geometry("left");
  const panTouches = (offset: number) => [
    { id: 1, x: panStart.cx - 60 + offset, y: panStart.cy + offset },
    { id: 2, x: panStart.cx + 60 + offset, y: panStart.cy + offset },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: panTouches(0) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: panTouches(10) }); await paint(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await settled();
  await leftPane.evaluate(el => { el.scrollTop += 400; }); await paint(page);
  await page.getByLabel("Test zoom").selectOption("2"); await settled();
  assert.ok(Math.abs((await geometry("left")).scrollTop - normalZoom.scrollTop) < 2,
    "later scrolling and zoom must not restore the old two-finger pan anchor");

  // Scrolling after a pinch must also win over the pending sharp redraw.
  await page.getByLabel("Test zoom").selectOption("3"); await settled();
  await leftPane.evaluate(el => { el.scrollTop = 600; }); await paint(page);
  const pendingStart = await geometry("left");
  const pendingTouches = (scale: number) => [
    { id: 1, x: pendingStart.cx - 60 * scale, y: pendingStart.cy },
    { id: 2, x: pendingStart.cx + 60 * scale, y: pendingStart.cy },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pendingTouches(1) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pendingTouches(1.2) }); await paint(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await leftPane.evaluate(el => { el.scrollTop += 250; }); await paint(page);
  const beforeRedraw = await geometry("left");
  await settled();
  assert.ok(Math.abs((await geometry("left")).scrollTop - beforeRedraw.scrollTop) < 2,
    "sharp redraw must respect scrolling after the pinch ended");

  // The shared zoom can be smaller than this narrower pane's fit-page size.
  await page.getByLabel("Test zoom").selectOption("0.8"); await settled();
  const narrow = await geometry("left");
  const narrowTouches = (scale: number) => [
    { id: 1, x: narrow.cx - 60 * scale, y: narrow.cy }, { id: 2, x: narrow.cx + 60 * scale, y: narrow.cy },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: narrowTouches(1) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: narrowTouches(1.02) }); await paint(page);
  const narrowAfter = await geometry("left");
  assert.ok(narrowAfter.zoom > 0.8 && narrowAfter.zoom < 0.83, "switching panes must not jump to fit page");
  assert.ok(Math.abs(narrowAfter.width / narrow.width - 1.02) < 0.005);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: narrowTouches(0.98) }); await paint(page);
  assert.ok((await geometry("left")).zoom < 0.8, "a narrower pane must also allow continuous contraction");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await settled();

  // Taking touch capture for the PDF cancels the ink layer's pending long press.
  await page.getByLabel("Test zoom").selectOption("1"); await settled();
  await page.getByLabel("Test ink overlay").check();
  await page.getByLabel("PDF書き込みレイヤー").waitFor();
  const ink = await geometry("left");
  const inkTouches = (scale: number) => [
    { id: 1, x: ink.cx - 50 * scale, y: ink.cy }, { id: 2, x: ink.cx + 50 * scale, y: ink.cy },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: inkTouches(1) });
  for (let i = 1; i <= 12; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: inkTouches(1 + i * 0.01) });
    await page.waitForTimeout(55);
  }
  assert.ok((await geometry("left")).zoom > 1.1, "ink fixture touches must reach PdfPane's pinch handler");
  assert.equal(await page.locator('[role="menu"][aria-label="書き込みのメニュー"]').count(), 0,
    "pinching with selected ink must not open its deletion menu");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await settled();
  const press = await geometry("left");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, x: press.cx, y: press.cy }] });
  // The surrounding PDF context menu can mark the page aria-hidden during a long press.
  // Check that the ink timer still opens its menu, independently of that other menu.
  await page.locator('[role="menu"][aria-label="書き込みのメニュー"]').waitFor({ state: "attached", timeout: 2000 });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.keyboard.press("Escape");
  await page.getByLabel("Test ink overlay").uncheck();
  t.diagnostic("stale anchors, narrower-pane zoom and ink long-press/pinch regressions passed");

  // At the bottom-right edge, zooming out clamps the scroll. The gesture must remember the
  // original PDF point so that reversing back to 400% returns to it, rather than accumulating drift.
  await page.getByLabel("Test zoom").selectOption("4");
  await settled();
  await page.locator('[data-test-pane="right"] [data-pdf-scroller]').evaluate(el => {
    el.scrollLeft = el.scrollWidth; el.scrollTop = el.scrollHeight;
  });
  await paint(page);
  const edge = await geometry("right");
  const edgePoint = { x: (edge.cx - edge.left) / edge.width, y: (edge.cy - edge.top) / edge.height };
  const edgeTouches = (scale: number, dx = 0, dy = 0) => [
    { id: 1, x: edge.cx + dx - 80 * scale, y: edge.cy + dy },
    { id: 2, x: edge.cx + dx + 80 * scale, y: edge.cy + dy },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: edgeTouches(1) });
  for (const scale of [0.95, 0.85, 0.75, 0.85, 0.95, 1]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: edgeTouches(scale) });
    await paint(page);
  }
  const returned = await geometry("right");
  assert.ok(Math.hypot(returned.left + edgePoint.x * returned.width - edge.cx,
    returned.top + edgePoint.y * returned.height - edge.cy) < 2, "edge clamping must not lose the original pinch anchor");
  // Two fingers can pan even when spreading them further cannot increase the zoom.
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: edgeTouches(1.15, 25, 20) });
  await paint(page);
  const atLimit = await geometry("right");
  assert.equal(atLimit.zoom, 4);
  assert.ok(Math.hypot(atLimit.left + edgePoint.x * atLimit.width - edge.cx - 25,
    atLimit.top + edgePoint.y * atLimit.height - edge.cy - 20) < 2, "midpoint must still move at maximum zoom");
  // Lift the second finger, leaving the first on the screen.
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [edgeTouches(1.15, 25, 20)[1]] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...edgeTouches(1.15, 25, 20)[0], x: edge.cx - 80 * 1.15 + 40 }] });
  await paint(page);
  const oneFinger = await geometry("right");
  assert.ok(Math.abs(oneFinger.left - atLimit.left - 15) < 2, `one remaining finger must resume panning: moved ${oneFinger.left - atLimit.left}px`);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await settled();

  // The actual fit-page size is used, rather than a made-up scale that jumps straight to 100%.
  await page.getByLabel("Test zoom").selectOption("0");
  await settled();
  const fit = await geometry("right");
  const fitTouches = (scale: number) => [
    { id: 1, x: fit.cx - 60 * scale, y: fit.cy }, { id: 2, x: fit.cx + 60 * scale, y: fit.cy },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: fitTouches(1) });
  let previousWidth = fit.width;
  for (let i = 1; i <= 30; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: fitTouches(1 + i * 0.02) });
    await paint(page);
    const now = await geometry("right");
    assert.ok(now.width > previousWidth && now.width - previousWidth < fit.width * 0.025, "fit-page pinch must grow continuously");
    previousWidth = now.width;
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await settled();
  t.diagnostic("400% limit, clamped edge reversal, one-finger continuation and continuous fit-page zoom passed");
  assert.deepEqual(errors, []);
});

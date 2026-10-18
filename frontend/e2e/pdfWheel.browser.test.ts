/** Actual Reader wheel handling with three generated PDF pages and an isolated API. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

function testPdf() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (let page = 1; page <= 3; page++) {
    const content = `BT /F1 24 Tf 60 720 Td (Page ${page}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page * 2 + 3} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(`${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test("horizontal trackpad swipes turn one page and preserve panning at high zoom", { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    cacheDir: "node_modules/.vite-pdf-wheel-test", optimizeDeps: { entries: ["e2e/fixtures/pdfWheel.html"] },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    if (new URL(route.request().url()).pathname.endsWith(".pdf")) {
      await route.fulfill({ body: testPdf(), contentType: "application/pdf", headers: { "Access-Control-Allow-Origin": "*" } });
    } else {
      await route.fulfill({ json: route.request().url().includes("/ink-v2/") ? { strokes: [] } : [],
        headers: { "Access-Control-Allow-Origin": "*" } });
    }
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/pdfWheel.html`);
  const original = page.getByRole("region", { name: "原文", exact: true });
  const pane = original.locator("[data-pdf-scroller]");
  const settled = () => page.waitForFunction(() => [...document.querySelectorAll("[data-pdf-surface]")].length === 2
    && [...document.querySelectorAll<HTMLElement>("[data-pdf-surface]")].every(el => !el.style.zoom && !!el.querySelector(".textLayer")));
  await settled();
  const current = async () => Number(await page.getByLabel("Test page").textContent());
  const swipe = async (dx: number, dy = 0, count = 6) => {
    await pane.hover({ position: { x: 250, y: 250 } });
    for (let i = 0; i < count; i++) { await page.mouse.wheel(dx, dy); await page.waitForTimeout(20); }
  };
  await swipe(0, 2, 1); // A small vertical lead-in used to lock out the entire horizontal gesture.
  await swipe(20, 1, 4);
  assert.equal(await current(), 2);
  await swipe(30, 20, 3); // Remaining diagonal inertia stays within the same gesture.
  assert.equal(await current(), 2);
  for (const delta of [18, 8, 2]) await swipe(delta, 0, 1);
  await swipe(25, 0, 4); // Start again while the previous momentum still has no 200ms gap.
  assert.equal(await current(), 3, "a repeated stroke during the old tail must turn again");
  await swipe(-25, 0, 4);
  assert.equal(await current(), 2, "an intentional reverse stroke must work without waiting for inertia to stop");
  await settled(); await page.waitForTimeout(250);
  await swipe(-25);
  assert.equal(await current(), 1);
  await settled(); await page.waitForTimeout(250);
  await swipe(-25);
  assert.equal(await current(), 1, "the first page must stay within the document");

  await page.getByLabel("Test zoom").selectOption("3"); await settled(); await page.waitForTimeout(250);
  await pane.evaluate(el => { el.scrollLeft = 400; });
  await swipe(30);
  assert.equal(await current(), 1, "a swipe within an enlarged page must pan instead of turning");
  assert.ok(await pane.evaluate(el => el.scrollLeft > 400));
  await pane.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await swipe(30, 0, 2);
  assert.equal(await current(), 1, "reaching the edge in the same gesture must not turn");
  await page.waitForTimeout(250);
  await swipe(30);
  assert.equal(await current(), 2, "a fresh outward swipe at the edge must turn");

  await page.getByLabel("Test zoom").selectOption("1"); await settled();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  const touchDrag = async (dx: number, dy = 0, cancel = false) => {
    const box = await pane.boundingBox();
    assert.ok(box);
    const x = box.x + box.width / 2, y = box.y + 220;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, x, y }] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 1, x: x + dx * i / 8, y: y + dy * i / 8 }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
    await page.waitForTimeout(50);
  };
  await touchDrag(-100);
  assert.equal(await current(), 3, "a leftward finger swipe turns to the next page");
  await settled();
  await touchDrag(100);
  assert.equal(await current(), 2, "a rightward finger swipe turns to the previous page");
  await settled();
  await touchDrag(-20);
  await touchDrag(-100, 120);
  await touchDrag(-100, 0, true);
  assert.equal(await current(), 2, "short, vertical and cancelled drags must not turn pages");
  const box = await pane.boundingBox();
  assert.ok(box);
  const a = { id: 1, x: box.x + 200, y: box.y + 220 }, b = { id: 2, x: box.x + 350, y: box.y + 220 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [a, b] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...a, x: a.x - 80 }, { ...b, x: b.x - 80 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ ...b, x: b.x - 80 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...a, x: a.x - 160 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(50);
  assert.equal(await current(), 2, "a two-finger gesture must not become a page swipe after one finger lifts");
  await page.getByLabel("Test zoom").selectOption("3"); await settled();
  await pane.evaluate(el => { el.scrollLeft = 400; });
  await touchDrag(-100);
  assert.equal(await current(), 2, "an enlarged PDF still pans under the finger");
  assert.ok(await pane.evaluate(el => el.scrollLeft > 400));
  await pane.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await touchDrag(-100);
  assert.equal(await current(), 3, "an outward finger swipe from the edge turns the page");

  // Replay the review's reproduced input patterns through the actual Reader listener. Controlled
  // timestamps keep the event spacing deterministic, including delayed/aggregated wheel events.
  await page.getByLabel("Test zoom").selectOption("1"); await settled();
  let replayClock = Date.now();
  const prepareReplay = async (initial: number) => {
    await page.locator("#page-input").fill(String(initial));
    await page.locator("#page-input").press("Enter");
    await page.waitForFunction(n => document.querySelector('[aria-label="Test page"]')?.textContent === String(n), initial);
    await settled();
  };
  const replay = async (events: number[][], expected: number) => {
    await pane.evaluate((el, { events, clock }) => {
      for (const [dx, time] of events) {
        const event = new WheelEvent("wheel", { deltaX: dx, bubbles: true, cancelable: true });
        Object.defineProperty(event, "timeStamp", { value: clock + time });
        el.dispatchEvent(event);
      }
    }, { events, clock: replayClock += 1000 });
    await page.waitForFunction(n => document.querySelector('[aria-label="Test page"]')?.textContent === String(n), expected);
    assert.equal(await current(), expected);
  };
  await prepareReplay(3);
  await replay([[20, 0], [-24, 16], [-24, 32], [-24, 48], ...Array.from({ length: 12 }, (_, i) => [-24, 64 + i * 16])], 2);
  await prepareReplay(1);
  await replay([[24, 8], [24, 16], [24, 24], [24, 32], [16, 48], [8, 56], [4, 64], [72, 208]], 2);
  await prepareReplay(1);
  let time = 0;
  await replay([24, 24, 24, 40, 32, 24, 16, 8, 3, 1, ...Array<number>(30).fill(4)].map(dx => [dx, time += 16]), 3);
  assert.deepEqual(errors, []);
});

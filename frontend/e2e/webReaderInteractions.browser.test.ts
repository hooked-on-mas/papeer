/** Focused real-DOM checks complement the full PDF/Drive journeys. No Google or OS clipboard. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { createServer } from "vite";
import { chromium, webkit, type Locator } from "playwright-core";

const fixture = `
import React,{useRef,useState} from 'react'; import {createRoot} from 'react-dom/client';
import {usePdfPinchZoom} from './usePdfPinchZoom'; import {usePairedPdfScroll} from './usePairedPdfScroll'; import './style.css';
function Reader({side}){const root=useRef(null);const[zoom,setZoom]=useState(1);
 usePdfPinchZoom(root,zoom,setZoom);
 return <div style={{display:'flex',flexDirection:'column',flex:1,minWidth:0}} data-reader={side}>
 <header style={{height:56,flexShrink:0}}><output aria-label="倍率">{zoom}</output></header>
 <section className="web-pdf-pane" aria-label={side}><div className="pdf" ref={root} data-rendered="true">
 <div className="web-pdf-surface" style={{width:390*zoom,minHeight:900*zoom}}>PDF本文</div></div></section></div>}
function App(){const root=useRef(null);const[split,setSplit]=useState(false);usePairedPdfScroll(root,split,String(split));return <div className="web-app" style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
 <button onClick={()=>setSplit(s=>!s)}>分割切替</button><main ref={root} style={{display:'flex',flex:1,minHeight:0}}><Reader side="left"/>{split&&<Reader side="right"/>}</main></div>}
createRoot(document.getElementById('root')).render(<App/>);`;

async function gesture(target: Locator, type: string, scale: number, x: number, y: number) {
  return target.evaluate((element, value) => {
    const event = new Event(value.type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { scale: { value: value.scale }, clientX: { value: value.x }, clientY: { value: value.y } });
    return !element.dispatchEvent(event);
  }, { type, scale, x, y });
}

for (const engine of ["webkit", "chromium"] as const) test(`PDF pinch interactions (${engine})`, { timeout: 180_000 }, async parent => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const output = path.resolve(frontend, "../output/reader-interactions", engine); fs.mkdirSync(output, { recursive: true });
  const server = await createServer({ configFile: path.join(frontend, "vite.web.config.ts"), logLevel: "error",
    cacheDir: path.join(output, "vite-" + randomUUID()), server: { host: "127.0.0.1", port: 0, hmr: false },
    plugins: [{ name: "interaction-fixture", enforce: "pre", transform(code, id) {
      return id.replace(/\\/g, "/").endsWith("/src/web/main.tsx") ? fixture : code;
    } }] });
  await server.listen(); parent.after(() => server.close());
  const browser = engine === "webkit" ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: "msedge", headless: true });
  parent.after(() => browser.close());
  const open = async (t: TestContext) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 700 }, hasTouch: true, serviceWorkers: "block" });
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
      await page.screenshot({ path: path.join(output, t.name.replace(/[^a-z0-9-]/gi, "-").slice(0, 80) + ".png"), scale: "css" }).catch(() => {});
      await context.close(); assert.deepEqual(errors, []);
    });
    await page.goto(server.resolvedUrls!.local[0], { timeout: 30_000 }); await page.locator(".web-pdf-surface").first().waitFor();
    return page;
  };

  await parent.test("paired scrolling works in either direction without overriding a pinch or a restored position", async t => {
    const page = await open(t); await page.setViewportSize({ width: 900, height: 700 });
    await page.getByRole("button", { name: "分割切替" }).click();
    const left = page.getByRole("region", { name: "left" }), right = page.getByRole("region", { name: "right" });
    // Loading/restoring another pane is not a request to move the page being read.
    await right.evaluate(pane => { pane.scrollTop = 90; });
    assert.equal(await left.evaluate(pane => pane.scrollTop), 0);
    await left.hover({ position: { x: 100, y: 150 } }); await page.mouse.wheel(0, 150);
    await page.waitForFunction(() => {
      const panes = [...document.querySelectorAll(".web-pdf-pane")];
      return panes[0].scrollTop > 100 && Math.abs(panes[0].scrollTop - panes[1].scrollTop) < 2;
    });
    await right.hover({ position: { x: 100, y: 150 } }); await page.mouse.wheel(0, -70);
    await page.waitForFunction(() => {
      const panes = [...document.querySelectorAll(".web-pdf-pane")];
      return panes[1].scrollTop > 0 && panes[1].scrollTop < 100 && Math.abs(panes[0].scrollTop - panes[1].scrollTop) < 2;
    });
    const beforePinch = await left.evaluate(pane => pane.scrollTop), box = (await left.boundingBox())!;
    await gesture(left, "gesturestart", 1, box.x + 100, box.y + 150);
    await gesture(left, "gesturechange", 1.5, box.x + 100, box.y + 150);
    await right.evaluate(pane => { pane.scrollTop = 0; });
    assert.equal(await left.evaluate(pane => pane.scrollTop), beforePinch, "the follower cannot rewind the pane being pinched");
    await gesture(left, "gestureend", 1.5, box.x + 100, box.y + 150);
    await page.getByRole("button", { name: "分割切替" }).click();
    await left.evaluate(pane => { pane.scrollTop = 100; });
    assert.equal(await right.count(), 0);
  });

  await parent.test("pinch limits, cancellation and header geometry are stable", async t => {
    const page = await open(t), pane = page.getByRole("region", { name: "left" }), box = (await pane.boundingBox())!;
    const header = (await page.locator('header').boundingBox())!;
    for (const [scale, expected] of [[30, "4"], [.001, "0.5"]] as const) {
      await gesture(pane, "gesturestart", 1, box.x + 150, box.y + 150);
      await gesture(pane, "gesturechange", scale, box.x + 150, box.y + 150);
      await gesture(pane, "gestureend", scale, box.x + 150, box.y + 150);
      await page.waitForFunction(value => document.querySelector('output')!.textContent === value, expected);
      assert.deepEqual(await page.locator('header').boundingBox(), header);
    }
    await gesture(pane, "gesturestart", 1, box.x + 150, box.y + 150);
    await gesture(pane, "gesturechange", 2, box.x + 150, box.y + 150);
    await page.evaluate(() => dispatchEvent(new Event("resize")));
    assert.equal(await pane.locator('.web-pdf-surface').evaluate(element => element.style.transform), "");
    assert.equal(await page.getByLabel("倍率").textContent(), "0.5");
  });

  await parent.test("a split reader gives each pinch one owner and releases it for the next pane", async t => {
    const page = await open(t); await page.setViewportSize({ width: 900, height: 700 });
    await page.getByRole("button", { name: "分割切替" }).click();
    const left = page.getByRole("region", { name: "left" }), right = page.getByRole("region", { name: "right" });
    const a = (await left.boundingBox())!, b = (await right.boundingBox())!;
    await gesture(left, "gesturestart", 1, a.x + 100, a.y + 100);
    await gesture(right, "gesturechange", 2, b.x + 100, b.y + 100);
    await gesture(right, "gestureend", 2, b.x + 100, b.y + 100);
    await page.waitForFunction(() => document.querySelector('output')!.textContent === "2");
    assert.equal(await page.locator('[data-reader=right] output').textContent(), "1");
    await gesture(right, "gesturestart", 1, b.x + 100, b.y + 100);
    await gesture(right, "gesturechange", 3, b.x + 100, b.y + 100);
    await gesture(right, "gestureend", 3, b.x + 100, b.y + 100);
    await page.waitForFunction(() => document.querySelector('[data-reader=right] output')!.textContent === "3");
    assert.equal(await page.locator('[data-reader=left] output').textContent(), "2");
  });
});

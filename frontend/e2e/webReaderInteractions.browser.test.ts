/** Focused real-DOM checks complement the full PDF/Drive journeys. No Google or OS clipboard. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { createServer } from "vite";
import { chromium, webkit, type Page, type Locator } from "playwright-core";

const fixture = `
import React,{useRef,useState} from 'react'; import {createRoot} from 'react-dom/client';
import {PdfTextSelection} from './PdfTextSelection'; import {usePdfPinchZoom} from './usePdfPinchZoom'; import './style.css';
window.__copy={mode:'ok',writes:[],pending:[]};
Object.defineProperty(navigator,'clipboard',{value:{writeText:text=>{
 const state=window.__copy;state.writes.push(text);
 if(state.mode==='deny')return Promise.reject(new Error('denied'));
 if(state.mode==='pending')return new Promise((resolve,reject)=>state.pending.push({resolve,reject}));
 return Promise.resolve();
}}});
function Reader({side}){const root=useRef(null);const[zoom,setZoom]=useState(1);const[page,setPage]=useState(1);const[enabled,setEnabled]=useState(true);const[hasText,setHasText]=useState(true);
 usePdfPinchZoom(root,zoom,setZoom,String(page));
 return <div style={{display:'flex',flexDirection:'column',flex:1,minWidth:0}} data-reader={side}>
 <header style={{height:56,flexShrink:0}}><button onClick={()=>setPage(p=>p+1)}>次の資料</button><button onClick={()=>setEnabled(e=>!e)}>指で書く切替</button><button onClick={()=>setHasText(false)}>画像のみ</button><output aria-label="倍率">{zoom}</output></header>
 <section className="web-pdf-pane" aria-label={side}><div className="pdf" ref={root}>
 <PdfTextSelection key={page+':'+zoom} container={root} enabled={enabled}/>
 <div className="web-pdf-surface" style={{width:390*zoom,minHeight:900*zoom}}>
 {hasText&&<div className="textLayer" style={{padding:'32px 20px',fontSize:20,lineHeight:2}}>
 <span>Alpha beta gamma.</span><br/><span>日本語の選択😀です。</span><br/><span>Another line to select.</span>
 </div>}</div></div></section></div>}
function App(){const[split,setSplit]=useState(false);return <div className="web-app" style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
 <button onClick={()=>setSplit(s=>!s)}>分割切替</button><main style={{display:'flex',flex:1,minHeight:0}}><Reader side="left"/>{split&&<Reader side="right"/>}</main></div>}
createRoot(document.getElementById('root')).render(<App/>);`;

async function touch(target: Locator, type: string, x: number, y: number, count = 1) {
  return target.evaluate((element, value) => {
    const event = new Event(value.type, { bubbles: true, cancelable: true });
    const touches = Array.from({ length: value.count }, (_, i) => ({ identifier: i + 1, clientX: value.x + i * 60, clientY: value.y }));
    Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: touches } });
    return !element.dispatchEvent(event);
  }, { type, x, y, count });
}

async function gesture(target: Locator, type: string, scale: number, x: number, y: number) {
  return target.evaluate((element, value) => {
    const event = new Event(value.type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { scale: { value: value.scale }, clientX: { value: value.x }, clientY: { value: value.y } });
    return !element.dispatchEvent(event);
  }, { type, scale, x, y });
}

/** Select a whole text run: by mouse where the text is natively selectable, else by long press and drag. */
async function select(page: Page, line = 0) {
  const span = page.locator('.textLayer span').nth(line), box = (await span.boundingBox())!;
  const y = box.y + box.height / 2, run = await span.textContent();
  if (await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches)) {
    await touch(span, "touchstart", box.x + 1, y); await settle();
    await touch(span, "touchmove", box.x + box.width - 1, y); await touch(span, "touchend", box.x + box.width - 1, y, 0);
    await page.waitForFunction(text => document.querySelector('output[aria-label="選択中の文字"]')?.textContent === text, run);
    return run!;
  }
  await page.mouse.move(box.x + 1, y); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, y, { steps: 8 }); await page.mouse.up();
  await page.getByRole("button", { name: "選択した文字をコピー", exact: true }).waitFor();
  return page.evaluate(() => getSelection()!.toString());
}

async function hold(page: Page, line = 0) {
  const span = page.locator('.textLayer span').nth(line), box = (await span.boundingBox())!;
  const x = box.x + 3, y = box.y + box.height / 2;
  await touch(span, "touchstart", x, y);
  return { span, x, y };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 700)); // Application long-press threshold is 500ms.

for (const engine of ["webkit", "chromium"] as const) test(`isolated PDF interactions (${engine})`, { timeout: 180_000 }, async parent => {
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
    await page.goto(server.resolvedUrls!.local[0]); await page.locator('.textLayer span').first().waitFor();
    return page;
  };

  await parent.test("copy denial retains the passage and a successful retry clears the error", async t => {
    const page = await open(t), text = await select(page);
    await page.evaluate(() => { (window as any).__copy.mode = "deny"; });
    await page.getByRole("button", { name: "選択した文字をコピー", exact: true }).tap();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByLabel("コピーする文字").inputValue(), text);
    assert.equal(await page.getByText("コピーしました", { exact: true }).count(), 0);
    await page.evaluate(() => { (window as any).__copy.mode = "ok"; });
    await page.getByRole("button", { name: "選択した文字をコピー", exact: true }).tap();
    await page.getByText("コピーしました", { exact: true }).waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.deepEqual(await page.evaluate(() => (window as any).__copy.writes), [text, text]);
  });

  await parent.test("a delayed copy of A cannot report that a newly selected B was copied", async t => {
    const page = await open(t), first = await select(page);
    await page.evaluate(() => { (window as any).__copy.mode = "pending"; });
    await page.getByRole("button", { name: "選択した文字をコピー", exact: true }).click();
    await page.waitForFunction(() => (window as any).__copy.pending.length === 1);
    const second = await select(page, 1); assert.notEqual(second, first);
    await page.evaluate(() => { const state = (window as any).__copy; state.mode = "ok"; state.pending[0].resolve(); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByText("コピーしました", { exact: true }).count(), 0, "late A completion is not success for B");
    await page.getByRole("button", { name: "選択した文字をコピー", exact: true }).click();
    await page.getByText("コピーしました", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => (window as any).__copy.writes), [first, second]);
    await select(page);
    await page.evaluate(() => { (window as any).__copy.mode = "pending"; });
    await page.getByRole("button", { name: "選択した文字をコピー", exact: true }).click();
    await select(page, 1);
    await page.evaluate(() => { (window as any).__copy.pending[1].reject(new Error("old failure")); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole("alert").count(), 0, "an old copy error does not attach to the new selection");
  });

  await parent.test("touch copy is single-shot and keyboard activation still works afterward", async t => {
    const page = await open(t), text = await select(page);
    const button = page.getByRole("button", { name: "選択した文字をコピー", exact: true });
    await button.tap(); await page.getByText("コピーしました", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => (window as any).__copy.writes), [text]);
    await button.focus(); await button.press("Enter");
    assert.deepEqual(await page.evaluate(() => (window as any).__copy.writes), [text, text]);
    await page.getByRole("button", { name: "文字選択を解除", exact: true }).click();
    await select(page); assert.equal(await page.getByRole("toolbar").count(), 1);
  });

  await parent.test("cancel, a short swipe and a second finger never become a delayed selection", async t => {
    const page = await open(t);
    for (const mode of ["cancel", "move", "pinch"]) {
      const { span, x, y } = await hold(page);
      if (mode === "cancel") await touch(span, "touchcancel", x, y, 0);
      if (mode === "move") await touch(span, "touchmove", x + 30, y + 30);
      if (mode === "pinch") await touch(span, "touchstart", x, y, 2);
      await settle();
      assert.equal(await page.evaluate(() => getSelection()?.toString() ?? ""), "", mode);
      assert.equal(await page.getByRole("toolbar").count(), 0, mode);
      await touch(span, "touchend", x, y, 0);
    }
  });

  await parent.test("a long press selects a word, extends across text runs and a tap dismisses it", async t => {
    const page = await open(t), selected = page.getByLabel("選択中の文字", { exact: true });
    await select(page);
    const { span, x, y } = await hold(page); await settle();
    assert.equal(await selected.textContent(), "Alpha", "a long press replaces the previous selection with the pressed word");
    assert.equal(await page.evaluate(() => getSelection()?.toString()), "", "the touch selection is drawn, not native");
    assert.ok(await page.locator(".web-touch-selection").count() > 0);
    assert.equal(await touch(span, "touchend", x, y, 0), true, "the long press does not become a click");
    await touch(span, "touchstart", x, y); await touch(span, "touchend", x, y, 0);
    assert.equal(await page.getByRole("toolbar").count(), 0, "a tap dismisses the touch selection");
    assert.equal(await page.locator(".web-touch-selection").count(), 0);
    const at = await hold(page); await page.getByRole("toolbar").waitFor();
    const second = (await page.locator('.textLayer span').nth(1).boundingBox())!;
    await touch(at.span, "touchmove", second.x + second.width - 3, second.y + second.height / 2);
    await page.waitForFunction(() => /日本語/.test(document.querySelector('output[aria-label="選択中の文字"]')?.textContent ?? ""));
    const extended = await selected.textContent() ?? "";
    assert.match(extended, /^Alpha beta gamma\.\n日本語/, "pdf.js line breaks are kept");
    await touch(at.span, "touchend", at.x, at.y, 0);
    await page.getByRole("button", { name: "選択した文字をコピー", exact: true }).tap();
    assert.deepEqual(await page.evaluate(() => (window as any).__copy.writes), [extended]);
  });

  await parent.test("an active pen/palm or finger-writing mode cannot trigger selection", async t => {
    const page = await open(t), root = page.locator('.pdf');
    await root.dispatchEvent("pointerdown", { pointerType: "pen", pointerId: 987 });
    let at = await hold(page); await settle(); assert.equal(await page.getByRole("toolbar").count(), 0);
    await touch(at.span, "touchend", at.x, at.y, 0);
    await root.dispatchEvent("pointerup", { pointerType: "pen", pointerId: 987 });
    await page.getByRole("button", { name: "指で書く切替" }).click();
    at = await hold(page); await settle(); assert.equal(await page.getByRole("toolbar").count(), 0);
    await touch(at.span, "touchend", at.x, at.y, 0);
    await page.getByRole("button", { name: "指で書く切替" }).click();
    at = await hold(page); await page.getByRole("toolbar").waitFor(); await touch(at.span, "touchend", at.x, at.y, 0);
  });

  await parent.test("leaving a page cancels its pending long press", async t => {
    const page = await open(t); await hold(page);
    await page.getByRole("button", { name: "次の資料" }).click(); await settle();
    assert.equal(await page.getByRole("toolbar").count(), 0);
    assert.equal(await page.locator('[data-touch-selecting]').count(), 0);
  });

  await parent.test("an image-only page does not invent selectable text", async t => {
    const page = await open(t); await page.getByRole("button", { name: "画像のみ" }).click();
    const surface = page.locator('.web-pdf-surface'), box = (await surface.boundingBox())!;
    await touch(surface, "touchstart", box.x + 100, box.y + 100); await settle();
    assert.equal(await page.getByRole("toolbar").count(), 0);
    assert.equal(await page.evaluate(() => getSelection()?.toString() ?? ""), "");
    await touch(surface, "touchend", box.x + 100, box.y + 100, 0);
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

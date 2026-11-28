import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium, type Locator } from "playwright-core";

// Render the production DocumentReader/PdfReader and real PDF. Only the storage transport is fake.
const fixture = `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {LegacyDocumentReaderConnection as DocumentReader} from './LegacyDocumentReaderConnection'; import './style.css';
const artifact={id:'document',itemId:'paper',label:'原文',filename:'original.pdf',mediaType:'application/pdf',role:'original'};
const runtime={scope:{sessionKey:'commands',libraryId:'commands',revision:'1'},query:{listArtifacts:()=>[artifact],readDocumentPages:async()=>null},
 artifacts:{read:async()=>{const response=await fetch('/command-test.pdf');return response.blob();}}};
createRoot(document.getElementById('root')).render(<div className="web-app" style={{height:'100dvh',display:'flex',flexDirection:'column'}}><DocumentReader artifact={artifact} runtime={runtime}/></div>);`;

async function swipe(pane: Locator, direction: -1 | 1) {
  await pane.evaluate((element, sign) => {
    const surface = element.querySelector(".web-pdf-surface")!;
    const box = surface.getBoundingClientRect();
    const start = { identifier: 1, clientX: box.left + 250, clientY: box.top + 180 };
    const finish = { ...start, clientX: start.clientX - sign * 150 };
    for (const [type, current, touches] of [["touchstart", start, [start]], ["touchmove", finish, [finish]], ["touchend", finish, []]] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: [current] } });
      surface.dispatchEvent(event);
    }
  }, direction);
}

test("production Web reader shares keyboard, wheel and swipe commands and fits its minimum zoom", { timeout: 180_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const output = path.resolve(frontend, "../output/reader-document-commands"); fs.mkdirSync(output, { recursive: true });
  const pdf = fs.readFileSync(path.resolve(frontend, "../tests/fixtures/reader-mixed-orientation.pdf"));
  const server = await createServer({ configFile: path.join(frontend, "vite.web.config.ts"), logLevel: "error",
    cacheDir: path.join(output, "vite-" + randomUUID()), server: { host: "127.0.0.1", port: 0, hmr: false },
    plugins: [{ name: "document-command-fixture", enforce: "pre",
      transform(code, id) { return id.replace(/\\/g, "/").endsWith("/src/web/main.tsx") ? fixture : code; },
      configureServer(vite) { vite.middlewares.use("/command-test.pdf", (_request, response) => {
        response.setHeader("Content-Type", "application/pdf"); response.end(pdf);
      }); },
    }] });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, hasTouch: true, serviceWorkers: "block" });
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  t.after(async () => {
    if (errors.length) console.error(errors);
    await page.screenshot({ path: path.join(output, "final.png") }).catch(() => {}); await browser.close();
  });
  await page.goto(server.resolvedUrls!.local[0], { timeout: 60_000 });
  const pane = page.getByRole("region", { name: "原文", exact: true });
  const number = page.getByLabel("ページ番号", { exact: true });
  const zoom = page.getByLabel("表示倍率", { exact: true });
  const settled = () => page.waitForFunction(() => !!document.querySelector('.pdf[data-rendered="true"] canvas'));
  const at = async (value: string) => { await page.waitForFunction(expected => (document.querySelector('#web-page-input') as HTMLInputElement)?.value === expected, value); await settled(); };
  await settled(); await at("1");
  const bounds = (await pane.boundingBox())!;
  // Hit the real text layer above the canvas, as a reader click does.
  await page.mouse.click(bounds.x + 180, bounds.y + 160);
  await page.keyboard.press("ArrowRight"); await at("2");
  await page.keyboard.press("ArrowLeft"); await at("1");

  // Ctrl+wheel must change the document zoom once, without changing browser controls.
  await pane.evaluate(element => element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 })));
  await page.waitForFunction(() => (document.querySelector('[aria-label="表示倍率"]') as HTMLSelectElement)?.value === "1.25");
  await page.keyboard.press("Control+0");
  await page.waitForFunction(() => (document.querySelector('[aria-label="表示倍率"]') as HTMLSelectElement)?.value === "1");
  await settled();
  await swipe(pane, 1); await at("2");
  await swipe(pane, -1); await at("1");

  // A pinch well below fit-page must settle to fit-page, not leave a tiny PDF canvas.
  await pane.evaluate(element => {
    const box = element.getBoundingClientRect();
    for (const [type, scale] of [["gesturestart", 1], ["gesturechange", .001], ["gestureend", .001]] as const) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { scale: { value: scale }, clientX: { value: box.left + 200 }, clientY: { value: box.top + 200 } });
      element.dispatchEvent(event);
    }
  });
  await page.waitForFunction(() => (document.querySelector('[aria-label="表示倍率"]') as HTMLSelectElement)?.value === "page");
  await settled();
  const size = await pane.evaluate(element => ({ pane: element.clientHeight, canvas: element.querySelector("canvas")!.getBoundingClientRect().height }));
  assert.ok(size.canvas > size.pane * .7 && size.canvas <= size.pane, JSON.stringify(size));
  assert.equal(await number.inputValue(), "1");
  assert.equal(await zoom.inputValue(), "page");
  assert.deepEqual(errors, []);
});

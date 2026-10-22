/** An update already waiting at startup must disappear after activation. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

test("an already waiting PWA update tracks activation and replacement", { timeout: 30_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const output = path.resolve(frontend, "../output/pwa/status"); fs.mkdirSync(output, { recursive: true });
  const fixture = `import React from 'react';import {createRoot} from 'react-dom/client';import {PwaStatus} from './PwaStatus';import './style.css';
    const first=Object.assign(new EventTarget(),{state:'installed'});
    const registration=Object.assign(new EventTarget(),{waiting:first,active:{state:'activated'},installing:null,update:async()=>{}});
    const serviceWorker=Object.assign(new EventTarget(),{register:async()=>registration});
    Object.defineProperty(navigator,'serviceWorker',{value:serviceWorker});
    window.activateWaiting=()=>{const worker=registration.waiting;registration.waiting=null;worker.state='activated';worker.dispatchEvent(new Event('statechange'));};
    window.replaceWaiting=()=>{const old=registration.waiting;const worker=Object.assign(new EventTarget(),{state:'installing'});registration.installing=worker;registration.dispatchEvent(new Event('updatefound'));registration.waiting=worker;registration.installing=null;worker.state='installed';worker.dispatchEvent(new Event('statechange'));if(old){old.state='redundant';old.dispatchEvent(new Event('statechange'));}};
    createRoot(document.getElementById('root')).render(<div className="web-app"><PwaStatus online={true}/></div>);`;
  const server = await createServer({ configFile: path.join(frontend, "vite.web.config.ts"), logLevel: "error",
    cacheDir: path.join(output, "vite-" + randomUUID()), server: { host: "127.0.0.1", port: 0, hmr: false },
    plugins: [{ name: "pwa-status-fixture", enforce: "pre", transform(code, id) {
      const file = id.replace(/\\/g, "/");
      if (file.endsWith("/src/web/main.tsx")) return fixture;
      if (file.endsWith("/src/web/PwaStatus.tsx")) return code.replace("import.meta.env.PROD", "true");
    } }] });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.goto(server.resolvedUrls!.local[0]);
  const apply = page.getByRole("button", { name: "更新を適用", exact: true }); await apply.waitFor();
  await page.evaluate(() => (window as unknown as { activateWaiting(): void }).activateWaiting());
  await apply.waitFor({ state: "hidden" });
  for (let index = 0; index < 2; index++) {
    await page.evaluate(() => (window as unknown as { replaceWaiting(): void }).replaceWaiting());
    await apply.waitFor(); assert.equal(await apply.count(), 1);
    assert.equal(await page.getByRole("status").filter({ hasText: "オフライン起動の準備を完了できませんでした" }).count(), 0,
      "replacing an update does not invalidate the already active offline shell");
  }
  await page.evaluate(() => (window as unknown as { activateWaiting(): void }).activateWaiting());
  await apply.waitFor({ state: "hidden" });
});

/** Native HTML selection from real PDFs, with no canvas touch handlers or Google account. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium, webkit, devices } from "playwright-core";

const fixture = `
import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
import {PdfTextReader} from './PdfTextReader'; import './style.css';
function App(){const[page,setPage]=useState(1);const[url,setUrl]=useState('/page-text.pdf');
 return <div className="web-app" style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
 <header><button onClick={()=>setPage(p=>p+1)}>次へ</button><button onClick={()=>setPage(1)}>先頭</button>
 <button onClick={()=>{setUrl('/original.pdf');setPage(1)}}>原文</button><button onClick={()=>setUrl('/broken.pdf')}>取得失敗</button></header>
 <section className="web-pdf-pane"><PdfTextReader key={url} url={url} pageNumber={page}/></section></div>}
createRoot(document.getElementById('root')).render(<App/>);`;

for (const engine of ["webkit", "chromium"] as const) test(`PDF text view uses ordinary selectable text (${engine})`, { timeout: 90_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const output = path.resolve(frontend, "../output/pdf-text", engine); fs.mkdirSync(output, { recursive: true });
  const generated = spawnSync("uv", ["run", "python", "-c", `import sys,pymupdf
pdf=pymupdf.open()
pdf.new_page().insert_text((30,40),"Alpha beta gamma. 日本語の本文です。",fontname="japan",fontsize=16)
pdf.new_page().insert_text((30,40),"次のページの本文です。",fontname="japan",fontsize=16)
pdf.new_page().draw_rect(pymupdf.Rect(30,30,100,100))
sys.stdout.buffer.write(pdf.tobytes())`], { cwd: path.resolve(frontend, ".."), maxBuffer: 8 * 1024 * 1024 });
  assert.equal(generated.status, 0, generated.stderr.toString());
  const server = await createServer({ configFile: path.join(frontend, "vite.web.config.ts"), logLevel: "error",
    cacheDir: path.join(output, "vite-" + randomUUID()), server: { host: "127.0.0.1", port: 0, hmr: false },
    plugins: [{ name: "pdf-text-fixture", enforce: "pre", transform(code, id) {
      return id.replace(/\\/g, "/").endsWith("/src/web/main.tsx") ? fixture : code;
    } }] });
  await server.listen(); t.after(() => server.close());
  const browser = engine === "webkit" ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: "msedge", headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ ...devices["iPhone 13"], serviceWorkers: "block", viewport: { width: 390, height: 664 } });
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/page-text.pdf", route => route.fulfill({ contentType: "application/pdf", body: generated.stdout }));
  await page.route("**/original.pdf", route => route.fulfill({ contentType: "application/pdf", body: fs.readFileSync(path.resolve(frontend, "../tests/fixtures/sample.pdf")) }));
  await page.route("**/broken.pdf", route => route.fulfill({ contentType: "application/pdf", body: "not a PDF" }));
  await page.goto(server.resolvedUrls!.local[0]);
  const body = page.getByRole("document", { name: "ページ本文", exact: true }); await body.waitFor();
  assert.match(await body.textContent() ?? "", /Alpha beta gamma.*日本語/);
  assert.equal(await body.evaluate(element => getComputedStyle(element).webkitUserSelect), "text");
  assert.equal(await page.locator("canvas, .textLayer, .web-ink").count(), 0);
  const points = await body.evaluate(element => {
    const node = element.firstChild!, range = document.createRange();
    range.setStart(node, 0); range.setEnd(node, 1); const first = range.getBoundingClientRect();
    range.setStart(node, 4); range.setEnd(node, 5); const last = range.getBoundingClientRect();
    return { x: first.left + .1, end: last.right - .1, y: first.top + first.height / 2 };
  });
  await page.mouse.move(points.x, points.y); await page.mouse.down();
  await page.mouse.move(points.end, points.y, { steps: 10 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => getSelection()?.toString()), "Alpha", "a real native selection contains a passage rather than the whole page");
  assert.equal(await body.evaluate(element => !element.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }))), false,
    "native selection is not intercepted by the PDF gesture handlers");
  await page.screenshot({ path: path.join(output, "native-text-selection.png"), scale: "css" });
  await page.getByRole("button", { name: "次へ", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".web-pdf-text-body")?.textContent?.includes("次のページ"));
  await page.getByRole("button", { name: "次へ", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "このページには取り出せる文字情報がありません" }).waitFor();
  assert.equal(await body.count(), 0, "an image-only page never retains the previous page's text");
  await page.getByRole("button", { name: "次へ", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "指定ページがありません" }).waitFor();
  await page.getByRole("button", { name: "原文", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".web-pdf-text-body")?.textContent?.includes("Abstract"));
  assert.equal((await body.textContent())?.includes("日本語の本文"), false);
  await page.getByRole("button", { name: "取得失敗", exact: true }).click();
  await page.getByText("PDFを表示できません。ダウンロードしてご確認ください。", { exact: true }).waitFor();
  assert.equal(await body.count(), 0);
  assert.deepEqual(errors, []);
});

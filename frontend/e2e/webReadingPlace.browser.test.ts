/** The same dimensions must behave alike with touch, mouse and different browser UAs. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium, webkit } from "playwright-core";

for (const variant of ["mouse", "webkit"] as const) {
  test(`reading place survives pane remounts, page navigation and restart (${variant})`, { timeout: 120_000 }, async t => {
    const frontend = path.resolve(import.meta.dirname, "..");
    const output = path.resolve(frontend, "../output/pwa/reading-place", variant);
    fs.mkdirSync(output, { recursive: true });
    const server = await createServer({ cacheDir: path.join(output, "vite-" + randomUUID()),
      configFile: path.join(frontend, "vite.web.config.ts"), logLevel: "error", server: { host: "127.0.0.1", port: 0, hmr: false } });
    await server.listen(); t.after(() => server.close());
    const browser = variant === "webkit" ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext({ viewport: { width: 820, height: 1080 }, hasTouch: variant !== "mouse",
      serviceWorkers: "block" });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    t.after(async () => {
      await page.screenshot({ path: path.join(output, "final.png") }).catch(() => {});
      if (errors.length) console.error(errors);
      await browser.close();
    });
    const paper = "a".repeat(32);
    // A chart/report followed by a landscape table exercises fitting across page shapes.
    const pdf = fs.readFileSync(path.resolve(frontend, "../tests/fixtures/reader-mixed-orientation.pdf"));
    const reading = Buffer.from(JSON.stringify({ version: 1, items: { [paper]: { pageCount: 2, translatedPages: {
      "1": { artifactPath: `papers/${paper}/translated.pdf`, page: 1 }, "2": { artifactPath: `papers/${paper}/translated.pdf`, page: 2 },
    } } } }));
    const blobs: Record<string, Buffer> = { original: pdf, translated: pdf, reading };
    blobs.memo = Buffer.from("# 比較しながら読むメモ\n\n読んでいる位置を保ったまま資料とメモを見比べる。\n");
    const file = (id: string) => ({ id, size: blobs[id].length, mime: id === "reading" ? "application/json" : "application/pdf",
      sha256: createHash("sha256").update(blobs[id]).digest("hex") });
    const manifest = { version: 1, revision: "responsive", updated_at: "2026-10-22T00:00:00Z", folder_id: "folder",
      items: [{ id: paper, title: "画面の広さに合わせて読む資料" }],
      attachments: [{ id: "memo", owner_id: paper, title: "読書メモ", format: "md" }], files: {
        [`papers/${paper}/original.pdf`]: file("original"), [`papers/${paper}/translated.pdf`]: file("translated"), "web-reading.json": file("reading"),
        [`papers/${paper}/attachments/memo.md`]: { ...file("memo"), mime: "text/markdown" },
      } };
    await context.route("https://accounts.google.com/gsi/client", route => route.fulfill({ contentType: "text/javascript", body:
      'window.google={accounts:{oauth2:{initTokenClient:opts=>({requestAccessToken:()=>opts.callback({access_token:"responsive-test",expires_in:3600})})}}};' }));
    await context.route("https://www.googleapis.com/**", async route => {
      const req = route.request(), url = new URL(req.url());
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
      if (req.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
      assert.equal(req.headers().authorization, "Bearer responsive-test");
      if (req.method() === "POST") { await route.fulfill({ json: { id: "saved-operation" }, headers }); return; }
      const id = url.pathname.split("/").pop()!;
      if (id === "files") await route.fulfill({ json: { files: url.searchParams.get("q")?.includes("ink-v1") ? []
        : [{ id: "library", name: "papeer-library.json", modifiedTime: manifest.updated_at }] }, headers });
      else if (id === "library") await route.fulfill({ json: manifest, headers });
      else { assert.ok(blobs[id], id); await route.fulfill({ body: blobs[id], headers }); }
    });
    await page.goto(process.env.PAPEER_WEB_TEST_URL || server.resolvedUrls!.local[0]);
    await page.getByRole("button", { name: "Googleでログインして開く →", exact: true }).click();
    const translated = page.getByRole("region", { name: "日本語訳", exact: true });
    const original = page.getByRole("region", { name: "原文", exact: true });
    const mode = page.getByLabel("本文の表示方法");
    const layout = async (value: string) => page.waitForFunction(expected => document.querySelector(".web-document-reader")?.getAttribute("data-layout") === expected, value);
    const zoom = page.getByLabel('表示倍率',{exact:true});
    const settle=async()=>{
      await page.waitForFunction(()=>{
        const panes=[...document.querySelectorAll<HTMLElement>('.web-reader-tab .web-pdf-pane')];
        return panes.length>0 && panes.every(p=>{
          const c=p.querySelector('canvas'), s=getComputedStyle(p);
          const expected=Math.floor((p.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight))*2);
          return c&&Math.abs(c.getBoundingClientRect().width-expected)<1 && !!p.querySelector('[data-testid="web-ink"]');
        });
      });
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    };
    const point=async(region=translated)=>region.evaluate(p=>{
      const r=p.getBoundingClientRect(),s=p.querySelector('.web-pdf-surface')!.getBoundingClientRect();
      return {y:Math.max(0,(r.top-s.top)/s.height),x:(r.left+p.clientWidth/2-s.left)/s.width};
    });
    const move=async(region=translated,y=.3,x=.65)=>{
      await region.evaluate((p,{x,y})=>{const s=p.querySelector<HTMLElement>('.web-pdf-surface')!;p.scrollTop=s.offsetTop+s.offsetHeight*y;p.scrollLeft=s.offsetWidth*x-p.clientWidth/2;},{x,y});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      return point(region);
    };
    const near=async(expected:{x:number;y:number},reason:string,region=translated)=>{
      await settle(); const actual=await point(region);
      assert.ok(Math.abs(expected.x-actual.x)<.005&&Math.abs(expected.y-actual.y)<.005,reason+JSON.stringify({expected,actual}));
    };
    await mode.waitFor();await page.getByRole('button',{name:'日本語訳を表示',exact:true}).click();
    await zoom.selectOption('2');await settle();const first=await move();
    await page.screenshot({path:path.join(output,'before-rotation.png')});
    await page.setViewportSize({width:1180,height:760});await layout('split');await near(first,'rotation into paired view preserves the translated passage');
    const source=await move(original,.22,.6);
    await page.setViewportSize({width:820,height:1080});await layout('single');await near(first,'rotating back preserves the passage');
    await page.screenshot({path:path.join(output,'after-rotation.png')});
    await page.getByRole('button',{name:'原文を表示',exact:true}).click();await near(source,'each side remembers its own passage',original);
    await page.getByRole('button',{name:'日本語訳を表示',exact:true}).click();await near(first,'returning to translation restores its passage');
    await page.getByRole('button',{name:'次のページ',exact:true}).click();await settle();
    assert.deepEqual(await translated.evaluate(p=>({left:p.scrollLeft,top:p.scrollTop})),{left:0,top:0},'an unread page opens at the beginning');
    const second=await move(translated,.1,.7);
    await page.getByRole('button',{name:'前のページ',exact:true}).click();await near(first,'returning to a previously read page restores its passage');
    await page.getByRole('button',{name:'次のページ',exact:true}).click();await near(second,'the next page keeps its independent passage too');
    await page.getByRole('tab',{name:'メモ',exact:true}).click();await page.getByRole('heading',{name:'比較しながら読むメモ',exact:true}).waitFor();
    await page.getByRole('tab',{name:'本文',exact:true}).click();await near(second,'returning from the memo tab preserves the passage');
    await page.reload();await near(second,'a local restart restores the passage without Google login');
    assert.equal(await page.getByLabel('ページ番号',{exact:true}).inputValue(),'2');
    assert.deepEqual(errors,[]);
  });
}

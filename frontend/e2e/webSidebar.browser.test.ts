import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright-core";

test("Web uses desktop library rows for hierarchy, held notes, search and keyboard selection", { timeout: 90_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, "..");
  const paper = "a".repeat(32), owned = "b".repeat(32), other = "c".repeat(32);
  const fixture = `
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {WebLibrarySidebar} from './WebLibrarySidebar'; import {createDriveLibraryRuntime} from './libraryRuntime';
    import {LibraryFolderRowView,LibraryPaperRowView} from '../features/library/LibraryRows'; import './style.css';
    const file={id:'memo',sha256:'d'.repeat(64),size:0,mime:'text/markdown'};
    const manifest={version:1,revision:'test',updated_at:'2026-10-18T00:00:00Z',attachments:[{id:'memo',owner_id:'${paper}',format:'md',title:'条件のメモ'}],
      items:[{id:'${paper}',title:'主論文のタイトル',first_author:'Smith',publication_year:'2024',collection_name:'研究 / 理論'},
        {id:'${owned}',title:'専用ノート',kind:'notebook',parent_id:'${paper}',collection_name:'古い分類'},
        {id:'${other}',title:'別の論文',collection_name:''}],files:{['papers/${paper}/attachments/memo.md']:file}};
    const runtime=createDriveLibraryRuntime({file:async()=>new Blob()}, {sessionKey:'test',libraryId:'library',revision:'test'},manifest);
    function App(){const [selected,setSelected]=useState('${paper}');const [artifact,setArtifact]=useState('');
      return <div className="web-app" style={{height:800,display:'flex'}}><div style={{width:320}}>
        <WebLibrarySidebar runtime={runtime} selectedItemId={selected} selectedArtifactId={artifact}
          onSelectItem={id=>{setSelected(id);setArtifact('');}} onSelectArtifact={(id,asset)=>{setSelected(id);setArtifact(asset);}} onAllFiles={()=>setSelected('all')}/>
        </div><div className="text-[0.8125rem]" style={{width:320}} data-reference>
        <LibraryFolderRowView level={1} expanded name="比較" count={1} onToggle={()=>{}}/>
        <LibraryPaperRowView level={3} label="主論文のタイトル" detail={<span>PDF</span>} expandable onToggle={()=>{}} />
        <output aria-label="選択結果">{selected}:{artifact}</output></div></div>;
    }createRoot(document.getElementById('root')).render(<App/>);`;
  const server = await createServer({ configFile: path.join(frontend, "vite.web.config.ts"), logLevel: "error", cacheDir: "node_modules/.vite-web-sidebar-test",
    plugins: [{ name: "sidebar-fixture", enforce: "pre", transform(code, id) {
      if (id.replace(/\\/g, "/").endsWith("/src/web/main.tsx")) return fixture;
      return code;
    } }], server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0]);
  const tree = page.getByRole("tree", { name: "ライブラリ", exact: true });
  const row = tree.getByRole("treeitem", { name: "主論文のタイトル", exact: true });
  await row.waitFor();
  assert.equal(await row.getAttribute("title"), "Smith (2024) 主論文のタイトル");
  assert.equal(await row.getAttribute("aria-level"), "3");
  assert.equal(await tree.getByText("古い分類").count(), 0);
  for (const kind of ["folder", "paper"]) {
    const actual = tree.locator(`[data-library-row=${kind}]`).first();
    const reference = page.locator(`[data-reference] [data-library-row=${kind}]`);
    const geometry = (element: HTMLElement) => ({ height: element.getBoundingClientRect().height,
      padding: getComputedStyle(element).paddingLeft, font: getComputedStyle(element).fontSize });
    assert.deepEqual(await actual.evaluate(geometry), await reference.evaluate(geometry));
  }
  const folder = tree.getByRole("treeitem", { name: "研究（1件）", exact: true });
  await folder.getByRole("button", { name: "閉じる", exact: true }).click();
  assert.equal(await row.count(), 0);
  await folder.press("ArrowRight"); await row.waitFor();
  await row.getByRole("button", { name: "持ち物を開く", exact: true }).click();
  const notebook = tree.getByRole("treeitem", { name: "専用ノート", exact: true });
  const memo = tree.getByRole("treeitem", { name: "条件のメモ", exact: true });
  await notebook.click(); assert.equal(await notebook.getAttribute("aria-selected"), "true");
  await memo.click(); assert.equal(await memo.getAttribute("aria-selected"), "true");
  assert.match(await page.getByLabel("選択結果").textContent() ?? "", new RegExp(`^${paper}:artifact-`));
  await page.getByRole("textbox", { name: "ライブラリを検索" }).fill("条件");
  await memo.waitFor(); assert.equal(await tree.getByRole("treeitem", { name: "別の論文", exact: true }).count(), 0);
  assert.equal(await notebook.count(), 0);
  await page.getByRole("button", { name: "検索を解除", exact: true }).click();
  await row.focus(); await row.press("ArrowDown");
  assert.equal(await notebook.evaluate(element => element === document.activeElement), true);
  await notebook.press("Enter"); assert.equal(await notebook.getAttribute("aria-selected"), "true");
  assert.equal(await page.getByRole("button", { name: /PDF を追加|ノートを作る|AIで/ }).count(), 0);
  await page.getByRole("button", { name: "ライブラリ全体のファイル", exact: true }).click();
  assert.match(await page.getByLabel("選択結果").textContent() ?? "", /^all:/);
  assert.deepEqual(errors, []);
});

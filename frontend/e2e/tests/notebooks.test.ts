import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scenario } from "../lib/app.ts";
import { waitFor } from "../lib/processes.ts";
import { libraryRow, openPaper, waitForLibrary } from "../lib/ui.ts";

scenario("手書きノートの用紙・保存・ページ操作・専用ノートを実画面で確かめる", {
  papers: [{ file: "gradient.pdf" }], viewport: { width: 1280, height: 900 }, timeout: 240_000,
}, async app => {
  const { page, api } = app, owner = app.paperIds["gradient.pdf"];
  const screenshots = path.join(os.tmpdir(), "paper-desk-c-visual");
  fs.mkdirSync(screenshots, { recursive: true });
  const visual = path.join(os.tmpdir(), "paper-desk-ui1-visual");
  fs.mkdirSync(visual, { recursive: true });
  await waitForLibrary(page, ["Stochastic Gradient"]);
  await page.getByRole("button", { name: "ノートを作る", exact: true }).click();
  const create = page.getByRole("dialog", { name: "ノートを作る", exact: true });
  await create.getByLabel("ノート名", { exact: true }).fill("手書きの実験");
  await create.getByLabel("用紙サイズ", { exact: true }).selectOption("16:9");
  await create.getByLabel("用紙の向き", { exact: true }).selectOption("landscape");
  await create.getByLabel("罫線", { exact: true }).selectOption("grid10");
  await create.getByLabel("用紙色", { exact: true }).selectOption("cream");
  await page.screenshot({ path: path.join(screenshots, "01-create-preview.png") });
  await create.getByRole("button", { name: "作成", exact: true }).click();
  await create.waitFor({ state: "detached" });
  const identity = (await api.call("GET", "/api/notebooks")).find((row: { title: string }) => row.title === "手書きの実験").id;
  const base = `/api/notebooks/${identity}`;
  const document = () => api.call("GET", base);
  let configuration = await document();
  const originalId = configuration.pages[0].id;
  const ink = () => api.call("GET", `${base}/pages/${originalId}/ink`);
  const layer = page.getByLabel("PDF書き込みレイヤー", { exact: true }).first();
  await layer.waitFor();
  const pageStrip = page.getByRole("region", { name: "ノートのページ", exact: true });
  const pageList = pageStrip.getByRole("button", { name: "ページ一覧", exact: true });
  assert.equal(await pageList.getAttribute("aria-expanded"), "false");
  assert.equal(await pageStrip.getByRole("button", { name: "複製", exact: true }).isVisible(), false);
  const collapsedHeight = (await pageStrip.boundingBox())!.height;
  await pageList.click();
  await page.getByRole("button", { name: "ページ 1", exact: true }).waitFor();
  assert.ok((await pageStrip.boundingBox())!.height > collapsedHeight + 80);
  await page.getByRole("button", { name: "ページ 1", exact: true }).click();
  assert.equal(await pageList.getAttribute("aria-expanded"), "false");
  // The notebook's own screen: its tab and header, and a one-row toolbar with nothing of reading a PDF.
  assert.equal(await page.getByRole("tab", { name: "ノート", exact: true }).getAttribute("aria-selected"), "true");
  await page.getByText("ノート · 未分類 · 1ページ", { exact: true }).waitFor();
  await page.getByRole("button", { name: "情報・整理", exact: true }).waitFor();
  await page.getByRole("button", { name: /^↗ 関連論文/ }).waitFor();
  const toolbar = page.getByRole("toolbar", { name: "ノートの道具", exact: true });
  await toolbar.waitFor();
  assert.equal(await page.getByRole("button", { name: "ペン", exact: true }).getAttribute("aria-pressed"), "true");
  for (const name of ["目次", "論文内検索", "書き込みツール", "本文選択", "原文", "訳文", "書き込み"]) {
    assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0, `ノートの画面に「${name}」のボタンを出さない`);
  }
  assert.equal(await page.getByRole("tab", { name: "PDFを読む" }).count(), 0);
  assert.equal(await page.getByRole("region", { name: "原文", exact: true }).count(), 0);
  assert.equal(await page.getByText("原文", { exact: true }).count(), 0);
  assert.equal(await page.getByText("訳文", { exact: true }).count(), 0);
  const canvas = page.getByRole("region", { name: "ノート", exact: true }).locator("canvas.react-pdf__Page__canvas");
  const geometry = async () => {
    const bar = await toolbar.boundingBox(), paper = await canvas.boundingBox();
    assert.ok(bar && paper);
    return [bar.y, bar.height, paper.x, paper.y, paper.width, paper.height].map(Math.round);
  };
  const resting = await geometry();
  // Picking another tool, and opening its settings, never moves the paper: the toolbar stays one row.
  for (const name of ["蛍光ペン", "図形", "テキスト", "消しゴム", "選択", "ペン"]) {
    const tool = page.getByRole("button", { name, exact: true });
    await tool.click();
    assert.equal(await tool.getAttribute("aria-pressed"), "true", `${name}を選ぶ`);
    assert.deepEqual(await geometry(), resting, `${name}を選んでも用紙とツールバーが動かない`);
    await tool.click();
    await page.getByRole("dialog").last().waitFor();
    assert.deepEqual(await geometry(), resting, `${name}の設定を開いても用紙とツールバーが動かない`);
    if (name === "図形") await page.screenshot({ path: path.join(visual, "notebook-shape-popover.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
  }
  const draw = async (offset = 0) => {
    const box = await layer.boundingBox(); assert.ok(box);
    await page.mouse.move(box.x+box.width*.2, box.y+box.height*(.3+offset));
    await page.mouse.down();
    await page.mouse.move(box.x+box.width*.6, box.y+box.height*(.5+offset), { steps: 12 });
    await page.mouse.up();
  };
  await draw();
  await waitFor(async () => (await ink()).strokes.length === 1, "ノートの筆跡が自動保存されること");
  await page.getByRole("button", { name: "書き込みを元に戻す", exact: true }).click();
  await waitFor(async () => (await ink()).strokes.length === 0, "筆跡のUndoが保存されること");
  await page.getByRole("button", { name: "書き込みをやり直す", exact: true }).click();
  await waitFor(async () => (await ink()).strokes.length === 1, "筆跡のRedoが保存されること");
  // The small bar for the selected writing sits just below the selection's frame, whatever the paper's shape.
  await page.getByRole("button", { name: "選択", exact: true }).click();
  const area = await layer.boundingBox(); assert.ok(area);
  await page.mouse.move(area.x + area.width * .1, area.y + area.height * .2);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * .7, area.y + area.height * .6, { steps: 8 });
  await page.mouse.up();
  const selectionBar = page.locator("[data-ink-selection-bar]");
  await selectionBar.waitFor();
  const frame = await page.locator('[data-ink-selection="true"] rect').first().boundingBox();
  const barBox = await selectionBar.boundingBox();
  assert.ok(frame && barBox);
  assert.ok(barBox.y >= frame.y + frame.height - 1, `選択の小バー（上端 ${barBox.y}）が選択枠の下端（${frame.y + frame.height}）より下にあること`);
  await page.getByRole("button", { name: "ペン", exact: true }).click();
  const nextPage = page.getByRole("menuitem", { name: /次のページ/ });
  await layer.click({ button: "right", position: { x: 10, y: 10 } });
  assert.equal(await nextPage.isVisible(), false);
  const scroller = pageStrip.locator("..").locator("[data-pdf-scroller]").first();
  await scroller.click({ button: "right", position: { x: 2, y: 2 } });
  assert.equal(await nextPage.isVisible(), false);
  // Touch events bubble separately from the overlay's pointer/contextmenu handlers.
  // Keep the contact still beyond Base UI's 500 ms long-press timer.
  await layer.evaluate(async element => {
    const box = element.getBoundingClientRect();
    const touch = new Touch({ identifier: 1, target: element, clientX: box.x + 10, clientY: box.y + 10 });
    element.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
    await new Promise(resolve => setTimeout(resolve, 650));
    element.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], targetTouches: [], changedTouches: [touch] }));
  });
  assert.equal(await nextPage.isVisible(), false);
  // Choosing nothing to select (only scrolling) brings the page's own menu back.
  await page.getByRole("button", { name: "選択", exact: true }).click();
  await page.getByRole("button", { name: "選択", exact: true }).click();
  await page.getByLabel("書き込みの選び方", { exact: true }).selectOption("select");
  await page.keyboard.press("Escape");
  await scroller.click({ button: "right", position: { x: 2, y: 2 } });
  await nextPage.waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "ペン", exact: true }).click();
  await page.getByRole("button", { name: "付箋", exact: true }).click();
  const paperBox = await layer.boundingBox(); assert.ok(paperBox);
  await page.mouse.click(paperBox.x+paperBox.width*.45, paperBox.y+paperBox.height*.4);
  const note = page.getByRole("dialog", { name: "付箋を貼る", exact: true });
  await note.getByLabel("付箋のメモ", { exact: true }).fill("ノートの位置付箋");
  await note.getByLabel("付箋のメモ", { exact: true }).press("Control+Enter");
  await note.waitFor({ state: "detached" });
  await waitFor(async () => (await api.call("GET", `/api/papers/${identity}/sticky-notes`)).length === 1, "位置付箋を安定ページIDで保存すること");
  assert.equal((await api.call("GET", `/api/papers/${identity}/sticky-notes`))[0].page_id, originalId);
  await pageList.click();
  await page.getByRole("button", { name: "複製", exact: true }).click();
  await waitFor(async () => (await document()).pages.length === 2, "ページを複製すること");
  configuration = await document();
  const duplicateId = configuration.pages[1].id;
  assert.equal((await api.call("GET", `${base}/pages/${duplicateId}/ink`)).strokes.length, 1);
  const secondThumbnail = page.getByRole("button", { name: "ページ 2", exact: true });
  await waitFor(async () => (await secondThumbnail.isEnabled()) && (await pageStrip.getAttribute("aria-busy")) !== "true",
    "複製後の再取得が終わりサムネイルが操作可能になること");
  await secondThumbnail.focus();
  await secondThumbnail.press("Alt+ArrowLeft");
  await waitFor(async () => (await document()).pages[0].id === duplicateId, "サムネイルの並べ替えでページIDと筆跡を維持すること");
  await page.getByRole("button", { name: "用紙を変更", exact: true }).click();
  const settings = page.getByRole("dialog", { name: /用紙を変更/ });
  await settings.getByLabel("用紙サイズ", { exact: true }).selectOption("A5");
  await settings.getByLabel("用紙の向き", { exact: true }).selectOption("portrait");
  await settings.getByLabel("罫線", { exact: true }).selectOption("dot5");
  await settings.getByLabel("用紙色", { exact: true }).selectOption("dark");
  await settings.getByRole("button", { name: "変更", exact: true }).click();
  await settings.waitFor({ state: "detached" });
  await waitFor(async () => (await document()).pages[0].color === "dark", "用紙変更が正本へ保存されること");
  const rendered = page.getByRole("region", { name: "ノート", exact: true }).locator("canvas.react-pdf__Page__canvas");
  await waitFor(async () => {
    const size = await rendered.boundingBox();
    return !!size && size.width > 0 && Math.abs(size.width / size.height - 148 / 210) < .01;
  }, "変更後の用紙がA5縦の比率で描画されること");
  await page.screenshot({ path: path.join(screenshots, "02-pages-ink-dark-dots.png") });
  await page.screenshot({ path: path.join(visual, "notebook-screen.png") });
  await page.getByRole("button", { name: "末尾に追加", exact: true }).click();
  await waitFor(async () => (await document()).pages.length === 3, "末尾へ追加すること");
  await page.getByRole("button", { name: "後ろに挿入", exact: true }).click();
  await waitFor(async () => (await document()).pages.length === 4, "現在ページの後ろに挿入すること");
  await page.getByRole("button", { name: "削除", exact: true }).click();
  await page.getByRole("dialog", { name: "ページを削除", exact: true }).getByRole("button", { name: "削除", exact: true }).click();
  await waitFor(async () => (await document()).pages.length === 3, "ページを削除すること");
  await page.reload();
  await layer.waitFor();
  await waitFor(async () => (await api.call("GET", `${base}/pages/${duplicateId}/ink`)).strokes.length === 1, "再起動後も複製した筆跡を読むこと");
  assert.equal(await pageList.getAttribute("aria-expanded"), "false");
  await pageList.click();
  await page.getByRole("button", { name: "ページ 2", exact: true }).click();
  await page.getByRole("button", { name: "ペン", exact: true }).click();
  let failSave = true;
  const inkRoute = "**/api/notebooks/**/pages/**/ink";
  const injectFailure: Parameters<typeof page.route>[1] = async route => {
    if (failSave && route.request().method() === "PUT") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "保存の故障注入" }) });
    else await route.continue();
  };
  await page.route(inkRoute, injectFailure);
  await draw(.15);
  await page.getByRole("alert").filter({ hasText: "保存の故障注入" }).first().waitFor();
  await pageList.click();
  await page.getByRole("button", { name: "末尾に追加", exact: true }).click();
  await page.getByRole("dialog").last().waitFor();
  assert.equal((await document()).pages.length, 3, "保存に失敗した状態でページ構成を変更しない");
  await page.keyboard.press("Escape");
  failSave = false;
  await page.getByRole("button", { name: "再試行", exact: true }).click();
  await waitFor(async () => (await ink()).strokes.length === 2, "保存失敗後の下書きを再試行すること");
  await page.unroute(inkRoute, injectFailure);
  const exported = await api.request("POST", `/api/papers/${identity}/ink-export`, { side: "original" });
  assert.equal(exported.status, 200);
  assert.equal(Buffer.from(await exported.arrayBuffer()).subarray(0,4).toString(), "%PDF");
  // The name is changed in the header itself.
  await page.getByRole("button", { name: "手書きの実験", exact: true }).click();
  const title = page.getByLabel("ノート名", { exact: true });
  await title.fill("手書きの実験・改");
  await title.press("Enter");
  await waitFor(async () => (await api.call("GET", `/api/papers/${identity}`)).title === "手書きの実験・改", "ヘッダーでノート名を変更できること");
  await openPaper(page, "Stochastic Gradient");
  assert.equal(await page.getByRole("tab", { name: "本文", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await page.getByRole("button", { name: "書き込みツール", exact: true }).count(), 1, "PDFの画面には書き込みの開閉ボタンがある");
  await page.screenshot({ path: path.join(visual, "pdf-screen.png") });
  await page.getByRole("button", { name: "その他", exact: true }).click();
  await page.getByRole("menuitem", { name: "専用ノートを作る…", exact: true }).click();
  const dedicated = page.getByRole("dialog", { name: "専用ノートを作る", exact: true });
  await dedicated.getByLabel("ノート名", { exact: true }).fill("論文専用のノート");
  await dedicated.getByLabel("罫線", { exact: true }).selectOption("cornell");
  await dedicated.getByRole("button", { name: "作成", exact: true }).click();
  await dedicated.waitFor({ state: "detached" });
  const child = (await api.call("GET", "/api/notebooks")).find((row: { title: string }) => row.title === "論文専用のノート");
  assert.equal(child.parent_id, owner); assert.equal(child.collection_name, "");
  await page.locator(`[data-tree-key="owned:${owner}:${child.id}"]`).waitFor();
  await layer.waitFor();
  await page.screenshot({ path: path.join(screenshots, "03-owned-notebook-cornell.png") });
  await page.getByText(/Stochastic Gradient.*の専用ノート · 1ページ/).waitFor();
  assert.equal(await page.getByRole("button", { name: /^↗ 関連論文/ }).count(), 0, "専用ノートには関連論文ボタンを出さない");
  await page.getByRole("button", { name: "その他", exact: true }).click();
  await page.getByRole("menuitem", { name: "持ち主を変更・独立させる…", exact: true }).click();
  const placement = page.getByRole("dialog", { name: "ノートの持ち主を変更", exact: true });
  await placement.getByLabel("ノートの持ち主", { exact: true }).selectOption("");
  await placement.getByRole("button", { name: "変更", exact: true }).click();
  await placement.waitFor({ state: "detached" });
  await waitFor(async () => (await api.call("GET", `/api/papers/${child.id}`)).parent_id === null, "持ち物から独立させること");
  await page.getByRole("button", { name: "その他", exact: true }).click();
  await page.getByRole("menuitem", { name: "持ち主を変更・独立させる…", exact: true }).click();
  await placement.getByLabel("ノートの持ち主", { exact: true }).selectOption(owner);
  await placement.getByRole("button", { name: "変更", exact: true }).click();
  await placement.waitFor({ state: "detached" });
  await openPaper(page, "Stochastic Gradient");
  await page.getByRole("button", { name: "その他", exact: true }).click();
  await page.getByRole("menuitem", { name: "ライブラリから削除", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "持ち物も削除されます", exact: true });
  await remove.getByText(/専用ノート：論文専用のノート/).waitFor();
  await page.screenshot({ path: path.join(screenshots, "04-delete-keep-choice.png") });
  await remove.getByRole("button", { name: "専用ノートを残して削除", exact: true }).click();
  await waitFor(async () => !(await api.call("GET", "/api/papers")).some((row: { id: string }) => row.id === owner), "親が削除されること");
  assert.equal((await api.call("GET", `/api/papers/${child.id}`)).parent_id, null);
  await libraryRow(page, "論文専用のノート").waitFor();
});

scenario("まだ読み込んでいないノートの付箋を付箋タブから開くと、そのページの位置へ移動する", {
  papers: [{ file: "gradient.pdf" }], viewport: { width: 1280, height: 900 }, timeout: 120_000,
}, async app => {
  const { page, api } = app;
  await waitForLibrary(page, ["Stochastic Gradient"]);
  await openPaper(page, "Stochastic Gradient");
  const made = await api.call("POST", "/api/notebooks", { title: "付箋で開くノート", collection: "" });
  const first = await api.call("GET", `/api/notebooks/${made.id}`);
  await api.call("POST", `/api/notebooks/${made.id}/pages`, { action: "append", revision: first.revision });
  const document = await api.call("GET", `/api/notebooks/${made.id}`);
  await api.call("POST", `/api/papers/${made.id}/sticky-notes`, {
    page: 2, page_id: document.pages[1].id, side: "original", quote: "", note: "二枚目の下の方", anchor_y: 0.85, anchor_x: 0.5,
  });
  await page.getByRole("tab", { name: "付箋", exact: true }).click();
  await page.getByRole("button", { name: "すべての論文", exact: true }).click();
  await page.getByRole("button", { name: "貼った場所へ", exact: true }).click();
  await page.getByRole("tab", { name: "ノート", exact: true }).waitFor();
  await page.getByRole("toolbar", { name: "ノートの道具", exact: true }).waitFor();
  assert.equal(await page.locator("#page-input").inputValue(), "2");
  await waitFor(async () => (await page.locator("[data-pdf-scroller]").first().evaluate(element => element.scrollTop)) > 100,
    "付箋の位置（ページの下の方）までスクロールすること");
});

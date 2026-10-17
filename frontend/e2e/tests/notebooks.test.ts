import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scenario } from "../lib/app.ts";
import { waitFor } from "../lib/processes.ts";
import { libraryRow, openPaper, toggleSidePanel, waitForLibrary } from "../lib/ui.ts";

scenario("手書きノートの用紙・保存・ページ操作・専用ノートを実画面で確かめる", {
  papers: [{ file: "gradient.pdf" }], viewport: { width: 1280, height: 900 }, timeout: 240_000,
}, async app => {
  const { page, api } = app, owner = app.paperIds["gradient.pdf"];
  const screenshots = path.join(os.tmpdir(), "paper-desk-c-visual");
  fs.mkdirSync(screenshots, { recursive: true });
  const visual = path.join(os.tmpdir(), "paper-desk-ui1-visual");
  fs.mkdirSync(visual, { recursive: true });
  const visual2 = path.join(os.tmpdir(), "paper-desk-ui2-visual");
  fs.mkdirSync(visual2, { recursive: true });
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
  // The page sidebar. A 16:9 landscape paper fills the width, so there is no room beside it: it is folded into
  // a thin tab at the view's left edge, and opens over the paper without moving it.
  const sidebar = page.getByRole("region", { name: "ノートのページ", exact: true });
  const sidebarButton = page.getByRole("button", { name: "ページ一覧", exact: true });
  const tab = page.getByRole("button", { name: "ページ一覧を開く", exact: true });
  const thumbnail = (number: number) => page.getByRole("button", { name: `ページ ${number}`, exact: true });
  const sidebarWidth = async () => Math.round((await sidebar.boundingBox())!.width);
  /** Opens the tab if the sidebar is folded (the sidebar beside the paper is open already). */
  const showPages = async () => {
    if (await tab.isVisible()) await tab.click();
    await thumbnail(1).waitFor();
  };
  const paperRect = async () => {
    const box = await page.getByRole("region", { name: "ノート", exact: true }).locator("canvas.react-pdf__Page__canvas").boundingBox();
    assert.ok(box);
    return [box.x, box.y, box.width, box.height].map(Math.round);
  };
  /** The same place and size, to the pixel (the canvas is redrawn at fractional sizes, which round either way). */
  const assertSameBox = (actual: number[], expected: number[], message: string) =>
    assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) <= 1), `${message}: ${actual} / ${expected}`);
  await tab.waitFor();
  assert.equal(await sidebarButton.getAttribute("aria-pressed"), "true");
  assert.ok((await sidebarWidth()) <= 24, "folded sidebar is a thin tab");
  assert.equal(await thumbnail(1).count(), 0);
  const folded = await paperRect();
  await tab.hover();
  await thumbnail(1).waitFor();
  assert.equal(await sidebarWidth(), 112);
  assertSameBox(await paperRect(), folded, "tab opened over the paper does not move or resize it");
  await page.screenshot({ path: path.join(visual2, "notebook-sidebar-tab-open.png") });
  await thumbnail(1).click();
  await tab.waitFor();
  assert.ok((await sidebarWidth()) <= 24, "choosing a page folds the opened tab");
  // Pressed (not just pointed at) it stays open until something else is done: a press on the paper folds it.
  await tab.click();
  await thumbnail(1).waitFor();
  await page.mouse.move(700, 400);
  await page.waitForTimeout(500);
  await thumbnail(1).waitFor();
  await page.keyboard.press("Escape");
  await tab.waitFor();
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
  // A right click on the writing selected opens the layer's own 削除 menu (not the page's); one beside it, the page's.
  await page.mouse.click(area.x + area.width * .4, area.y + area.height * .4, { button: "right" });
  await page.getByRole("menu", { name: "書き込みのメニュー", exact: true }).waitFor();
  assert.equal(await page.getByRole("menuitem", { name: "このページを複製", exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  await layer.click({ button: "right", position: { x: 10, y: 10 } });
  await page.getByRole("menuitem", { name: "このページを複製", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "ペン", exact: true }).click();
  // The menu over the paper (in place of the PDF's), for whichever tool is picked; only the mouse's right button opens it.
  const duplicateItem = page.getByRole("menuitem", { name: "このページを複製", exact: true });
  await layer.click({ button: "right", position: { x: 10, y: 10 } });
  await duplicateItem.waitFor();
  for (const name of ["ここに付箋を貼る", "このページの前にページを追加", "このページの後ろにページを追加", "用紙を変更…"]) {
    assert.equal(await page.getByRole("menuitem", { name, exact: true }).isVisible(), true, name);
  }
  assert.equal(await page.getByRole("menuitem", { name: "貼り付け" }).count(), 0, "コピーした書き込みがなければ貼り付けは出さない");
  assert.equal(await page.getByRole("menuitem", { name: /次のページ|拡大|縮小|翻訳/ }).count(), 0, "PDF用の項目は出さない");
  assert.equal(await page.getByRole("menuitem", { name: "このページを削除", exact: true }).getAttribute("aria-disabled"), "true", "最後の1ページは削除できない");
  await page.screenshot({ path: path.join(visual2, "notebook-paper-menu.png") });
  await page.keyboard.press("Escape");
  await duplicateItem.waitFor({ state: "detached" });
  const scroller = page.locator("[data-pdf-scroller]").first();
  await scroller.click({ button: "right", position: { x: 300, y: 2 } });
  await duplicateItem.waitFor();
  await page.keyboard.press("Escape");
  await duplicateItem.waitFor({ state: "detached" });
  // Touch events bubble separately from the overlay's pointer/contextmenu handlers.
  // Keep the contact still beyond Base UI's 500 ms long-press timer: a long press opens nothing.
  await layer.evaluate(async element => {
    const box = element.getBoundingClientRect();
    const touch = new Touch({ identifier: 1, target: element, clientX: box.x + 10, clientY: box.y + 10 });
    element.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
    await new Promise(resolve => setTimeout(resolve, 650));
    element.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], targetTouches: [], changedTouches: [touch] }));
  });
  assert.equal(await duplicateItem.isVisible(), false);
  // Choosing nothing to select (only scrolling) leaves the page's own menu to every right click.
  await page.getByRole("button", { name: "選択", exact: true }).click();
  await page.getByRole("button", { name: "選択", exact: true }).click();
  await page.getByLabel("書き込みの選び方", { exact: true }).selectOption("select");
  await page.keyboard.press("Escape");
  await scroller.click({ button: "right", position: { x: 300, y: 2 } });
  await duplicateItem.waitFor();
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
  // A sticky note from the menu over the paper goes where the right click was.
  const stickyBox = await layer.boundingBox(); assert.ok(stickyBox);
  await page.mouse.click(stickyBox.x + stickyBox.width * .7, stickyBox.y + stickyBox.height * .7, { button: "right" });
  await page.getByRole("menuitem", { name: "ここに付箋を貼る", exact: true }).click();
  await note.getByLabel("付箋のメモ", { exact: true }).fill("右クリックの付箋");
  await note.getByLabel("付箋のメモ", { exact: true }).press("Control+Enter");
  await note.waitFor({ state: "detached" });
  await waitFor(async () => (await api.call("GET", `/api/papers/${identity}/sticky-notes`)).length === 2, "右クリックの位置に付箋を保存すること");
  const placed = (await api.call("GET", `/api/papers/${identity}/sticky-notes`)).find((item: { note: string }) => item.note === "右クリックの付箋");
  assert.ok(Math.abs(placed.anchor_x - .7) < .04 && Math.abs(placed.anchor_y - .7) < .04, `付箋の位置 (${placed.anchor_x}, ${placed.anchor_y})`);
  /** A right click on the middle of the paper: clear of the sidebar a tab opens over its left edge. */
  const rightClickPaper = async () => {
    await layer.waitFor();
    const box = await layer.boundingBox(); assert.ok(box);
    await page.mouse.click(box.x + box.width * .7, box.y + box.height * .5, { button: "right" });
  };
  const pageField = page.locator("#page-input");
  const removePage = async (id: string) => {
    const before = (await document()).pages;
    await showPages();
    await thumbnail(before.findIndex((item: { id: string }) => item.id === id) + 1).click({ button: "right" });
    await page.getByRole("menuitem", { name: "このページを削除", exact: true }).click();
    await page.getByRole("dialog", { name: "ページを削除", exact: true }).getByRole("button", { name: "削除", exact: true }).click();
    await waitFor(async () => (await document()).pages.length === before.length - 1, "サムネイルのメニューからページを削除すること");
  };
  await rightClickPaper();
  await duplicateItem.click();
  await waitFor(async () => (await document()).pages.length === 2, "用紙のメニューからページを複製すること");
  configuration = await document();
  const duplicateId = configuration.pages[1].id;
  assert.equal((await api.call("GET", `${base}/pages/${duplicateId}/ink`)).strokes.length, 1);
  assert.equal(await pageField.inputValue(), "2", "複製したページへ移動すること");
  await showPages();
  const secondThumbnail = thumbnail(2);
  await waitFor(async () => (await secondThumbnail.isEnabled()) && (await sidebar.getAttribute("aria-busy")) !== "true",
    "複製後の再取得が終わりサムネイルが操作可能になること");
  await secondThumbnail.focus();
  await secondThumbnail.press("Alt+ArrowUp");
  await waitFor(async () => (await document()).pages[0].id === duplicateId, "サムネイルの並べ替えでページIDと筆跡を維持すること");
  await rightClickPaper();
  await page.getByRole("menuitem", { name: "用紙を変更…", exact: true }).click();
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
  // A portrait paper leaves room beside it: the sidebar stays open there, and shown or hidden the paper is the same.
  await thumbnail(1).waitFor();
  assert.equal(await tab.count(), 0, "余白があればつまみに畳まない");
  assert.equal(await sidebarWidth(), 112);
  const withSidebar = await paperRect();
  await page.screenshot({ path: path.join(visual2, "notebook-sidebar-margin.png") });
  await sidebarButton.click();
  assert.equal(await sidebar.count(), 0, "▤で隠すとつまみも出さない");
  assert.equal(await sidebarButton.getAttribute("aria-pressed"), "false");
  assertSameBox(await paperRect(), withSidebar, "サイドバーを隠しても出しても用紙の大きさ・位置は同じ");
  await sidebarButton.click();
  await thumbnail(1).waitFor();
  assertSameBox(await paperRect(), withSidebar, "サイドバーを出しても用紙は同じ");
  // Narrowing the view (the right panel opens beside the paper) leaves no room: the sidebar folds into the tab.
  await toggleSidePanel(page, "メモ");
  await tab.waitFor();
  assert.ok((await sidebarWidth()) <= 24);
  const narrowed = await paperRect();
  assertSameBox([0, 0, ...narrowed.slice(2)], [0, 0, ...withSidebar.slice(2)], "右パネルを開いても用紙の大きさは変わらない");
  await page.screenshot({ path: path.join(visual2, "notebook-sidebar-tab.png") });
  await toggleSidePanel(page, "メモ");
  await thumbnail(1).waitFor();
  assert.equal(await tab.count(), 0);
  assertSameBox(await paperRect(), withSidebar, "サイドバーを出しても用紙は同じ");
  await page.screenshot({ path: path.join(screenshots, "02-pages-ink-dark-dots.png") });
  await page.screenshot({ path: path.join(visual, "notebook-screen.png") });
  // A page operation reloads the notebook's file, and the paper is gone from the view for a moment: the sidebar
  // beside the paper stays where it is (never folds into the tab, never rebuilt), and its keys keep working.
  await page.evaluate(() => {
    const w = window as unknown as { __tabSeen: boolean };
    w.__tabSeen = false;
    const check = () => { if (globalThis.document.querySelector('button[aria-label="ページ一覧を開く"]')) w.__tabSeen = true; };
    new MutationObserver(check).observe(globalThis.document.body, { childList: true, subtree: true });
    globalThis.document.querySelector('button[aria-label="ページ 1"]')?.setAttribute("data-probe", "kept");
  });
  const noOverlap = async (label: string) => {
    const boxes: { y: number; height: number }[] = [];
    for (let number = 1; number <= (await document()).pages.length; number++) {
      const box = await thumbnail(number).boundingBox(); assert.ok(box, `${label}: ページ ${number} のサムネイル`);
      boxes.push(box);
    }
    boxes.forEach((box, i) => { if (i) assert.ok(box.y >= boxes[i - 1].y + boxes[i - 1].height - 1, `${label}: ページ ${i + 1} のサムネイルが前の行と重ならない`); });
  };
  await rightClickPaper();
  await page.getByRole("menuitem", { name: "このページの後ろにページを追加", exact: true }).click();
  await waitFor(async () => (await document()).pages.length === 3, "縦長ページの後ろにページを追加すること");
  const addedId = (await document()).pages[1].id;
  await thumbnail(2).waitFor();
  await waitFor(async () => (await thumbnail(2).isEnabled()) && (await sidebar.getAttribute("aria-busy")) !== "true", "追加後の再取得が終わること");
  assert.equal(await sidebarWidth(), 112, "ページを足してもサイドバーは余白に出たまま");
  assert.equal(await page.evaluate(() => (window as unknown as { __tabSeen: boolean }).__tabSeen), false, "ページを足す間もつまみに畳まれない");
  assert.equal(await page.locator('[data-probe="kept"]').count(), 1, "サムネイルの列が作り直されない");
  await noOverlap("追加後");
  await thumbnail(2).focus();
  for (const [key, expected] of [["Alt+ArrowDown", [duplicateId, originalId, addedId]], ["Alt+ArrowUp", [duplicateId, addedId, originalId]], ["Alt+ArrowDown", [duplicateId, originalId, addedId]]] as const) {
    await page.keyboard.press(key);
    await waitFor(async () => JSON.stringify((await document()).pages.map((item: { id: string }) => item.id)) === JSON.stringify(expected), `${key} でページを並べ替えること`);
    await waitFor(async () => (await sidebar.getAttribute("aria-busy")) !== "true", "並べ替え後の再取得が終わること");
    await page.waitForTimeout(150);
    assert.equal(await sidebarWidth(), 112, "並べ替え中もサイドバーは余白に出たまま");
    await noOverlap(`${key} の後（縦横の混在）`);
    assert.equal(await page.evaluate(() => globalThis.document.activeElement?.getAttribute("aria-label")),
      `ページ ${expected.indexOf(addedId) + 1}`, "並べ替え後もフォーカスが動かしたページに残り、続けて並べ替えられる");
  }
  assert.equal(await page.evaluate(() => (window as unknown as { __tabSeen: boolean }).__tabSeen), false, "並べ替えの間もつまみに畳まれない");
  await removePage(addedId);
  await thumbnail(1).click();
  await waitFor(async () => (await pageField.inputValue()) === "1", "最初のページへ戻ること");
  // The button at the paper's corner: the next page, and on the last page a new one at the end.
  const nextButton = page.getByRole("button", { name: "次のページ（用紙の右下）", exact: true });
  const newPageButton = page.getByRole("button", { name: "新しいページ（末尾に追加）", exact: true });
  assert.equal(await newPageButton.count(), 0);
  await nextButton.click();
  await waitFor(async () => (await pageField.inputValue()) === "2", "右下のボタンで次のページへ移ること");
  await newPageButton.waitFor();
  assert.equal(await nextButton.count(), 0, "最後のページでは「新しいページ」に替わる");
  await page.screenshot({ path: path.join(visual2, "notebook-corner-new-page.png") });
  await newPageButton.click();
  await waitFor(async () => (await document()).pages.length === 3, "右下のボタンで末尾にページを追加すること");
  await waitFor(async () => (await pageField.inputValue()) === "3", "追加したページへ移ること");
  const thirdId = (await document()).pages[2].id;
  await showPages();
  await page.getByRole("button", { name: "ページを追加", exact: true }).click();
  await waitFor(async () => (await document()).pages.length === 4, "サイドバーの「ページを追加」で末尾に追加すること");
  await rightClickPaper();
  await page.getByRole("menuitem", { name: "このページの後ろにページを追加", exact: true }).click();
  await waitFor(async () => (await document()).pages.length === 5, "現在ページの後ろに追加すること");
  assert.equal(await pageField.inputValue(), "5");
  await showPages();
  await thumbnail(1).click({ button: "right" });
  await page.screenshot({ path: path.join(visual2, "notebook-thumbnail-menu.png") });
  await page.getByRole("menuitem", { name: "このページへ移動", exact: true }).waitFor();
  await page.getByRole("menuitem", { name: "このページの前にページを追加", exact: true }).click();
  await waitFor(async () => (await document()).pages.length === 6, "サムネイルのメニューから先頭の前にページを追加すること");
  configuration = await document();
  assert.equal(configuration.pages[1].id, duplicateId, "先頭の前に入れても元の先頭ページは2番目になる");
  assert.equal(await pageField.inputValue(), "1", "追加したページへ移ること");
  const extra = configuration.pages.filter((item: { id: string }) => ![duplicateId, originalId, thirdId].includes(item.id));
  assert.equal(extra.length, 3);
  assert.equal((await api.call("GET", `${base}/pages/${duplicateId}/ink`)).strokes.length, 1, "ページを足しても書き込みは元のページに付いている");
  for (const item of extra) await removePage(item.id);
  assert.deepEqual((await document()).pages.map((item: { id: string }) => item.id), [duplicateId, originalId, thirdId]);
  await page.reload();
  await layer.waitFor();
  await waitFor(async () => (await api.call("GET", `${base}/pages/${duplicateId}/ink`)).strokes.length === 1, "再起動後も複製した筆跡を読むこと");
  await showPages();
  await thumbnail(2).click();
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
  await showPages();
  await page.getByRole("button", { name: "ページを追加", exact: true }).click();
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
  // The notebook zooms apart from the PDFs: it opens at 「ページ全体」, and changing it leaves the PDF's alone.
  const zoomSelect = page.locator('select[aria-label="表示倍率"]');
  assert.equal(await zoomSelect.inputValue(), "0");
  await zoomSelect.selectOption("2");
  await page.keyboard.press("Control+=");
  assert.equal(await zoomSelect.inputValue(), "2.5", "Ctrl+=でノートの倍率が上がる");
  await openPaper(page, "Stochastic Gradient");
  assert.equal(await zoomSelect.inputValue(), "1", "ノートの倍率を変えてもPDFの倍率は変わらない");
  await zoomSelect.selectOption("1.5");
  await libraryRow(page, "手書きの実験・改").click();
  await layer.waitFor();
  assert.equal(await zoomSelect.inputValue(), "2.5", "PDFの倍率を変えてもノートの倍率は変わらない");
  await page.keyboard.press("Control+0");
  assert.equal(await zoomSelect.inputValue(), "0", "Ctrl+0でノートは「ページ全体」に戻る");
  await openPaper(page, "Stochastic Gradient");
  assert.equal(await zoomSelect.inputValue(), "1.5");
  await zoomSelect.selectOption("1");
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
  // A notebook opens at 「ページ全体」, which has nothing to scroll to: this one is shown at 幅に合わせる, as chosen before.
  await page.addInitScript(() => localStorage.setItem("papeer-storage", JSON.stringify({ state: { notebookZoom: 1 }, version: 3 })));
  await page.reload();
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

scenario("ノートのホイールめくり・右下のボタンとペン・つまみの開閉を実画面で確かめる", {
  papers: [{ file: "gradient.pdf" }], viewport: { width: 1280, height: 900 }, timeout: 150_000,
}, async app => {
  const { page, api, cdp } = app;
  await waitForLibrary(page, ["Stochastic Gradient"]);
  const made = await api.call("POST", "/api/notebooks", { title: "めくるノート", collection: "", size: "16:9", orientation: "landscape" });
  const base = `/api/notebooks/${made.id}`;
  for (let i = 0; i < 2; i++) await api.call("POST", `${base}/pages`, { action: "append", revision: (await api.call("GET", base)).revision });
  await page.reload();
  await waitForLibrary(page, ["めくるノート"]);
  await libraryRow(page, "めくるノート").click();
  const layer = page.getByLabel("PDF書き込みレイヤー", { exact: true }).first();
  await layer.waitFor();
  const pageField = page.locator("#page-input");
  const count = async () => (await api.call("GET", base)).pages.length;
  const box = async () => { const value = await layer.boundingBox(); assert.ok(value); return value; };
  const visual2 = path.join(os.tmpdir(), "paper-desk-ui2-visual");
  fs.mkdirSync(visual2, { recursive: true });
  const turn = async (delta: number) => {
    const value = await box();
    await page.mouse.move(value.x + value.width / 2, value.y + value.height / 2);
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, delta); await page.waitForTimeout(60); }
    await page.waitForTimeout(400);
  };
  await page.waitForTimeout(800);
  assert.equal(await pageField.inputValue(), "1");
  // The wheel turns the page (the whole of it is in view at 「ページ全体」)...
  await turn(120);
  assert.equal(await pageField.inputValue(), "2", "ペンを選んでいてもホイールでページがめくれる");
  // ...but not while the pen is down (or a mouse button held on the paper).
  const held = await box();
  await page.mouse.move(held.x + held.width / 2, held.y + held.height / 2);
  await page.mouse.down();
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(60); }
  await page.waitForTimeout(400);
  await page.mouse.up();
  assert.equal(await pageField.inputValue(), "2", "ペンが触れている間はホイールでめくらない");
  await turn(120);
  assert.equal(await pageField.inputValue(), "3");
  // At the last page the wheel never makes a new page.
  await turn(120);
  await turn(120);
  assert.equal(await pageField.inputValue(), "3");
  assert.equal(await count(), 3, "最後のページでホイールを回してもページは増えない");
  // The corner button is laid over the paper here (a landscape paper fills the width): it steps aside for the pen.
  const corner = page.getByRole("button", { name: "新しいページ（末尾に追加）", exact: true });
  await corner.waitFor();
  assert.equal(await corner.evaluate(element => getComputedStyle(element).opacity), "1");
  const cornerBox = (await corner.boundingBox())!;
  const pen = (type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number) =>
    cdp.send("Input.dispatchMouseEvent", { type, x, y, pointerType: "pen", ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }) } as never);
  await page.mouse.move(100, 100);
  await pen("mouseMoved", cornerBox.x - 30, cornerBox.y + cornerBox.height / 2);
  await waitFor(async () => (await corner.evaluate(element => getComputedStyle(element).opacity)) === "0", "ペンが近づくと右下のボタンが消えること");
  await page.screenshot({ path: path.join(visual2, "notebook-corner-pen-near.png") });
  await page.mouse.move(cornerBox.x + 5, cornerBox.y + 5);
  await waitFor(async () => (await corner.evaluate(element => getComputedStyle(element).opacity)) === "1", "マウスでは消えない（ペンが離れたら戻る）", 5000);
  // A pen hovering at the left edge does not open the tab; pressing it does.
  const tab = page.getByRole("button", { name: "ページ一覧を開く", exact: true });
  const edge = (await tab.boundingBox())!;
  await pen("mouseMoved", edge.x + edge.width / 2, edge.y + 200);
  await page.waitForTimeout(500);
  assert.equal(await page.getByRole("button", { name: "ページ 1", exact: true }).count(), 0, "ペンを近づけただけではつまみは開かない");
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
  await page.getByRole("button", { name: "ページ 1", exact: true }).waitFor();
  await page.mouse.move(700, 450);
  await page.getByRole("button", { name: "ページ 1", exact: true }).waitFor({ state: "detached" });
  // Writing on the paper folds a tab opened by a press.
  await tab.click();
  await page.getByRole("button", { name: "ページ 1", exact: true }).waitFor();
  const writing = await box();
  await page.mouse.move(writing.x + writing.width * .5, writing.y + writing.height * .5);
  await page.mouse.down();
  await page.mouse.move(writing.x + writing.width * .6, writing.y + writing.height * .6, { steps: 5 });
  await page.mouse.up();
  await page.getByRole("button", { name: "ページ 1", exact: true }).waitFor({ state: "detached" });
});

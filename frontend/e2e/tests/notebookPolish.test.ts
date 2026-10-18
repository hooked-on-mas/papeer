import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page, Route } from "playwright-core";
import { scenario } from "../lib/app.ts";
import { waitFor } from "../lib/processes.ts";
import { libraryRow, waitForLibrary } from "../lib/ui.ts";

const visual = path.join(os.tmpdir(), "paper-desk-ui4-visual");
fs.mkdirSync(visual, { recursive: true });

/** The sidebar and the paper as laid out now: the sidebar's box (just the tab if it is thin) and the paper's. */
async function layout(page: Page) {
  const paper = await page.getByRole("region", { name: "ノート", exact: true }).locator("canvas.react-pdf__Page__canvas").boundingBox();
  const sidebar = await page.getByRole("region", { name: "ノートのページ", exact: true }).boundingBox();
  assert.ok(paper && sidebar);
  return { paper, sidebar, beside: sidebar.width > 40 };
}

/** The toolbar's controls that its row clips (the 「…」 button stands outside it), and whether the window scrolls sideways. */
async function clipped(page: Page) {
  return page.evaluate(() => {
    const toolbar = document.querySelector('[role=toolbar][aria-label="ノートの道具"]')!;
    const row = toolbar.querySelector<HTMLElement>(".overflow-hidden")!;
    const clip = row.getBoundingClientRect();
    const out: string[] = [];
    row.querySelectorAll<HTMLElement>("button, input, select").forEach((element) => {
      const box = element.getBoundingClientRect();
      if (box.width === 0) return;
      if (box.right > clip.right + 1 || box.left < clip.left - 1) out.push(element.getAttribute("aria-label") ?? element.tagName);
    });
    const more = toolbar.querySelector<HTMLElement>('[aria-label="その他の表示・操作"]')!.getBoundingClientRect();
    return { clipped: out, moreInside: more.right <= window.innerWidth + 0.5 && more.left >= 0, sideways: document.documentElement.scrollWidth > window.innerWidth };
  });
}

scenario("ノートの仕上げ：集中表示、狭い幅、キーボードと読み上げ", {
  papers: [{ file: "gradient.pdf" }], viewport: { width: 1280, height: 900 }, timeout: 360_000,
}, async app => {
  const { page, api } = app;
  await waitForLibrary(page, ["Stochastic Gradient"]);
  const make = async (title: string, orientation: "portrait" | "landscape") => {
    const made = await api.call("POST", "/api/notebooks", { title, collection: "", size: orientation === "portrait" ? "A4" : "16:9", orientation });
    const base = `/api/notebooks/${made.id}`;
    for (let i = 0; i < 2; i++) await api.call("POST", `${base}/pages`, { action: "append", revision: (await api.call("GET", base)).revision });
    return { id: made.id as string, base };
  };
  const portrait = await make("縦のノート", "portrait");
  const landscape = await make("横のノート", "landscape");
  await page.reload();
  await waitForLibrary(page, ["縦のノート", "横のノート"]);
  const layer = page.getByLabel("PDF書き込みレイヤー", { exact: true }).first();
  const open = async (title: string) => {
    await libraryRow(page, title).click();
    await page.locator("h1", { hasText: title }).waitFor();
    await layer.waitFor();
    await page.waitForTimeout(700);
  };
  const toolbar = page.getByRole("toolbar", { name: "ノートの道具", exact: true });
  const pageField = page.locator("#page-input");
  const sidebar = page.getByRole("region", { name: "ノートのページ", exact: true });
  const tab = page.getByRole("button", { name: "ページ一覧を開く", exact: true });
  const thumbnail = (number: number) => page.getByRole("button", { name: `ページ ${number}`, exact: true });
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName);

  // 1. Focus mode: the header, the tabs and the library go; the toolbar, the sidebar and the corner button stay.
  await open("縦のノート");
  assert.equal(await page.getByRole("tablist").isVisible(), true);
  await page.screenshot({ path: path.join(visual, "01-normal.png") });
  for (const width of [1280, 1000, 800, 640]) {
    await app.setViewport(width, 820);
    await page.waitForTimeout(600);
    const normal = await layout(page);
    if (normal.beside) assert.ok(normal.sidebar.x + normal.sidebar.width <= normal.paper.x + 1, `${width}px: サイドバーは用紙の左の余白に収まる`);
    await page.keyboard.press("F11");
    await page.getByRole("tablist").waitFor({ state: "hidden" });
    await page.waitForTimeout(700);
    assert.equal(await page.locator("h1").count(), 0, "集中表示ではヘッダーを隠す");
    assert.equal(await page.locator("[role=tree]").count(), 0, "集中表示では左パネルを隠す");
    await toolbar.waitFor();
    assert.equal(await page.getByRole("button", { name: "集中表示を終了", exact: true }).isVisible(), true);
    assert.equal(await page.getByRole("button", { name: /^(次のページ（用紙の右下）|新しいページ)/ }).isVisible(), true, "右下のボタンは残る");
    assert.equal(await sidebar.count(), 1, "サイドバー（またはつまみ）は残る");
    const focus = await layout(page);
    if (focus.beside) assert.ok(focus.sidebar.x + focus.sidebar.width <= focus.paper.x + 1, `${width}px 集中表示: サイドバーが用紙に重ならない（${focus.sidebar.x + focus.sidebar.width} > ${focus.paper.x}）`);
    else assert.ok(focus.sidebar.width <= 24, `${width}px 集中表示: 余白がなければつまみ`);
    assert.deepEqual((await clipped(page)).clipped, [], `${width}px 集中表示: ツールバーの部品が切れない`);
    await page.screenshot({ path: path.join(visual, `02-focus-${width}.png`) });
    await page.getByRole("button", { name: "集中表示を終了", exact: true }).click();
    await page.getByRole("tablist").waitFor();
    await page.waitForTimeout(600);
    const back = await layout(page);
    if (back.beside) assert.ok(back.sidebar.x + back.sidebar.width <= back.paper.x + 1, `${width}px 戻した後: サイドバーが用紙に重ならない`);
  }
  await app.setViewport(1280, 900);

  // 2. A folded tab that is open when focus mode is switched does not stay laid over a paper that has room beside it.
  await open("横のノート");
  await tab.waitFor();
  await tab.click();
  await thumbnail(1).waitFor();
  await page.keyboard.press("F11");
  await page.getByRole("tablist").waitFor({ state: "hidden" });
  await page.waitForTimeout(700);
  const inFocus = await layout(page);
  assert.ok(!inFocus.beside || inFocus.sidebar.x + inFocus.sidebar.width <= inFocus.paper.x + 1, "集中表示にしても、用紙に重なったままのサイドバーが残らない");
  await page.screenshot({ path: path.join(visual, "03-focus-landscape.png") });
  await page.keyboard.press("F11");
  await page.getByRole("tablist").waitFor();
  await page.waitForTimeout(500);

  // 3. A narrow window (640px, the library open): nothing of the toolbar is cut off, and what leaves is in the 「…」 menu.
  await open("縦のノート");
  await app.setViewport(640, 800);
  await page.waitForTimeout(700);
  let state = await clipped(page);
  assert.deepEqual(state.clipped, [], "640px: ツールバーの部品が切れない");
  assert.equal(state.moreInside, true, "640px: 「⋯」が窓の内側にある");
  assert.equal(state.sideways, false, "640px: 横にスクロールしない");
  for (const name of ["ペン", "選択", "消しゴム"]) assert.equal(await page.getByRole("button", { name, exact: true }).isVisible(), true, name);
  assert.equal(await pageField.isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "次のページ", exact: true }).isVisible(), true);
  await page.screenshot({ path: path.join(visual, "04-narrow-640.png") });
  const undoButtons = await page.getByRole("button", { name: "書き込みを元に戻す", exact: true }).count();
  await page.getByRole("button", { name: "その他の表示・操作", exact: true }).click();
  await page.getByRole("menu").waitFor();
  await page.screenshot({ path: path.join(visual, "05-narrow-640-menu.png") });
  // Undo and Redo are in the row or in the menu, not in both and not in neither.
  assert.equal(await page.getByRole("menuitem", { name: /元に戻す/ }).count() + undoButtons, 1);
  await page.keyboard.press("Escape");
  // The corner button is laid over the paper, below the toolbar and inside the window.
  const corner = await page.getByRole("button", { name: /^(次のページ（用紙の右下）|新しいページ)/ }).boundingBox();
  assert.ok(corner && corner.x >= 0 && corner.x + corner.width <= 640 && corner.y > 120, `右下ボタンが窓の内側にある ${JSON.stringify(corner)}`);
  // With the library folded the row has room again, and Undo is back in it.
  await page.keyboard.press("Control+b");
  await page.waitForTimeout(500);
  state = await clipped(page);
  assert.deepEqual(state.clipped, []);
  assert.equal(await page.getByRole("button", { name: "書き込みを元に戻す", exact: true }).isVisible(), true, "左パネルを畳むとUndoのボタンが戻る");
  await page.keyboard.press("Control+b");
  await app.setViewport(1280, 900);
  await page.waitForTimeout(500);

  // 4. Reading aloud: the page count, the arrow, the tools, the status.
  const snapshot = await page.locator("body").ariaSnapshot();
  assert.ok(snapshot.includes("全3ページ"), "総ページ数が読まれる");
  assert.ok(!/\/ 3/.test(snapshot), "「/ 3」の記号は読まれない");
  assert.ok(/button "関連論文 0"/.test(snapshot), "関連論文ボタンは「↗」なしで読まれる");
  for (const name of ["ペン", "蛍光ペン", "図形", "テキスト", "消しゴム", "選択"]) {
    const button = page.getByRole("button", { name, exact: true });
    assert.equal(await button.getAttribute("aria-expanded"), null, `${name}は aria-expanded を持たない`);
    assert.equal(await button.getAttribute("aria-haspopup"), null);
    assert.ok(["true", "false"].includes((await button.getAttribute("aria-pressed")) ?? ""), `${name}は aria-pressed を持つ`);
  }
  // The change-in-progress text is a live region that is in the page before it has anything to say.
  const liveRegions = await page.locator("[role=status]").evaluateAll(list => list.map(item => item.className));
  assert.ok(liveRegions.some(name => name.includes("sr-only")), "ページ変更中の文言の領域は、変更の前から画面にある");
  await page.evaluate(() => { for (const item of document.querySelectorAll("[role=status]")) if (item.className.includes("sr-only")) item.setAttribute("data-probe", "live"); });
  let hold = true;
  const slow = async (route: Route) => {
    if (route.request().method() === "POST" && hold) await new Promise(resolve => setTimeout(resolve, 1500));
    await route.continue();
  };
  await page.route(`**${portrait.base}/pages`, slow);
  await page.getByRole("button", { name: "ページを追加", exact: true }).click();
  await page.locator("[role=status][data-probe=live]").filter({ hasText: "書き込みを保存してページを変更中…" }).waitFor();
  hold = false;
  await waitFor(async () => (await api.call("GET", portrait.base)).pages.length === 4, "ページを追加できること");
  await page.unroute(`**${portrait.base}/pages`, slow);
  await page.locator("[role=status][data-probe=live]").filter({ hasText: /^$/ }).waitFor();
  const extra = (await api.call("GET", portrait.base)).pages[3].id;
  await api.call("POST", `${portrait.base}/pages`, { action: "delete", page_id: extra, revision: (await api.call("GET", portrait.base)).revision });
  await page.reload();
  await layer.waitFor();
  await page.waitForTimeout(700);
  await thumbnail(3).waitFor();

  // 5. Enter goes to the page (Space too, and no drag starts).
  await thumbnail(3).focus();
  await page.keyboard.press("Enter");
  await waitFor(async () => (await pageField.inputValue()) === "3", "Enterでそのページへ移動すること");
  await thumbnail(2).focus();
  await page.keyboard.press("Space");
  await waitFor(async () => (await pageField.inputValue()) === "2", "Spaceでもそのページへ移動すること");
  assert.equal(await page.locator("[aria-roledescription=draggable]").count(), 0, "キーボードでドラッグは始まらない");
  const orderBefore = (await api.call("GET", portrait.base)).pages.map((item: { id: string }) => item.id);
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(300);
  assert.deepEqual((await api.call("GET", portrait.base)).pages.map((item: { id: string }) => item.id), orderBefore, "Enterでは並べ替えが始まらない");
  await page.screenshot({ path: path.join(visual, "06-thumbnail-keys.png") });

  // 6. The opened tab: Escape, choosing a page and Tab-ing out fold it, and Escape or a page put the focus on the tab.
  await open("横のノート");
  await tab.waitFor();
  await tab.focus();
  await page.keyboard.press("Enter");
  await thumbnail(1).waitFor();
  await waitFor(async () => (await focused()) === "ページ 1", "つまみをキーで開くと現在のページにフォーカスが移ること");
  await page.keyboard.press("Escape");
  await tab.waitFor();
  await waitFor(async () => (await focused()) === "ページ一覧を開く", "Escで畳むとフォーカスがつまみに戻ること");
  await page.keyboard.press("Enter");
  await thumbnail(2).waitFor();
  await thumbnail(2).focus();
  await page.keyboard.press("Enter");
  await waitFor(async () => (await pageField.inputValue()) === "2", "Enterで選んだページへ移ること");
  await tab.waitFor();
  await waitFor(async () => (await focused()) === "ページ一覧を開く", "ページを選んで畳むとフォーカスがつまみに戻ること");
  // Tab out.
  await page.keyboard.press("Enter");
  await thumbnail(1).waitFor();
  await waitFor(async () => (await focused()) === "ページ 2", "開くと現在のページにフォーカスが移ること");
  let steps = 0;
  while (await thumbnail(1).count() && steps++ < 10) await page.keyboard.press("Tab");
  assert.ok(steps > 1 && steps < 10, `Tabで外へ出ると畳まれる（${steps}回）`);
  await tab.waitFor();
  assert.notEqual(await focused(), "ページ一覧を開く", "Tabで出たあとはフォーカスをつまみへ戻さない");
  await page.screenshot({ path: path.join(visual, "07-tab-folded.png") });
  // Chosen with the mouse, the page folds the tab and leaves the focus on neither the tab nor the list (on the page, as before):
  // so Space does not open the list again, and the keys of the writing are not shut out.
  await tab.click();
  await thumbnail(3).waitFor();
  await thumbnail(3).click();
  await waitFor(async () => (await pageField.inputValue()) === "3", "マウスで選んだページへ移ること");
  await tab.waitFor();
  await page.waitForTimeout(300);
  const where = await page.evaluate(() => {
    const active = document.activeElement;
    return { tag: active?.tagName, inSidebar: !!active?.closest('[aria-label="ノートのページ"]'), label: active?.getAttribute("aria-label") };
  });
  assert.equal(where.inSidebar, false, `マウスで選んだあと、フォーカスがつまみにも一覧にも残らない（${JSON.stringify(where)}）`);
  assert.equal(where.tag, "BODY");
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  assert.equal(await thumbnail(1).count(), 0, "マウスで選んだあとの Space で一覧が開き直さない");
  await page.keyboard.press("Control+v");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(200);
  assert.equal(await page.locator("[aria-roledescription=draggable]").count(), 0);

  // 7. 「⋯ → 用紙を変更…（このページ）」 changes the paper of the page shown.
  await page.getByRole("button", { name: "その他の表示・操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "用紙を変更…（このページ）", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /p\.3 の用紙を変更/ });
  await dialog.waitFor();
  await dialog.getByLabel("罫線", { exact: true }).selectOption("grid5");
  await dialog.getByRole("button", { name: "変更", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await waitFor(async () => (await api.call("GET", landscape.base)).pages[2].template === "grid5", "メニューから現在のページの用紙を変えること");
  assert.notEqual((await api.call("GET", landscape.base)).pages[0].template, "grid5", "ほかのページは変わらない");

  // 8. A notebook says 名前 and フォルダー, not ファイル名 and 分類.
  await page.getByRole("button", { name: "横のノート", exact: true }).click();
  const title = page.getByLabel("ノート名", { exact: true });
  await title.fill("横のノート改");
  await title.press("Enter");
  await page.getByRole("status").filter({ hasText: /名前を「横のノート改」に変更しました。/ }).first().waitFor({ state: "attached" });
  assert.equal(await page.getByText(/ファイル名を「横のノート改」/).count(), 0);
  await libraryRow(page, "横のノート改").click({ button: "right" });
  await page.getByRole("menuitem", { name: "フォルダーを移動", exact: true }).hover();
  await page.getByRole("menuitem", { name: "新しいフォルダーを入力…", exact: true }).click();
  await page.getByRole("dialog", { name: "新しいフォルダー", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog", { name: "新しい分類", exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  await libraryRow(page, "Stochastic Gradient").click({ button: "right" });
  await page.getByRole("menuitem", { name: "分類を変更", exact: true }).hover();
  await page.getByRole("menuitem", { name: "新しい分類を入力…", exact: true }).click();
  await page.getByRole("dialog", { name: "新しい分類", exact: true }).waitFor();
  await page.keyboard.press("Escape");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scenario } from "../lib/app.ts";
import { waitFor } from "../lib/processes.ts";
import { libraryRow, waitForLibrary } from "../lib/ui.ts";

scenario("ノートの作成：フォルダー・空白の右クリックと Ctrl+Alt+N、既定名と前回の用紙、ノート行とそのメニュー", {
  papers: [{ file: "gradient.pdf", collection: "機械学習" }], collections: ["読書会"], viewport: { width: 1280, height: 900 }, timeout: 240_000,
}, async app => {
  const { page, api } = app;
  const visual = path.join(os.tmpdir(), "paper-desk-ui3-visual");
  fs.mkdirSync(visual, { recursive: true });
  await waitForLibrary(page, ["機械学習", "読書会", "Stochastic Gradient"]);
  const now = new Date();
  const base = `ノート ${now.getMonth() + 1}/${now.getDate()}`;
  const dialog = page.getByRole("dialog", { name: "ノートを作る", exact: true });
  const notebooks = async () => api.call("GET", "/api/notebooks") as Promise<{ id: string; title: string; collection_name: string; read_status: string; parent_id: string | null }[]>;
  const nameInput = dialog.getByLabel("ノート名", { exact: true });
  const folderSelect = dialog.getByLabel("作成先", { exact: true });
  const menu = page.getByRole("menu");
  const labelsOf = async () => (await menu.getByRole("menuitem").allInnerTexts()).map(label => label.replace(/\s+/g, " ").trim());
  /** A row of the tree that is a paper or a notebook. */
  const row = (title: string) => page.locator("[role=treeitem][data-tree-key^='paper:']").filter({ hasText: title });

  // 1. A folder's context menu: 「ここにノートを作る…」 makes the notebook in that folder.
  await libraryRow(page, "読書会").click({ button: "right" });
  await page.screenshot({ path: path.join(visual, "folder-menu.png") });
  await page.getByRole("menuitem", { name: "ここにノートを作る…", exact: true }).click();
  await dialog.waitFor();
  assert.equal(await folderSelect.inputValue(), "読書会");
  assert.equal(await nameInput.inputValue(), base);
  // The name is selected as the dialog opens, so that typing replaces it.
  await page.waitForFunction(() => {
    const input = document.activeElement as HTMLInputElement | null;
    return input?.getAttribute("aria-label") === "ノート名" && input.selectionStart === 0 && input.selectionEnd === input.value.length && input.value.length > 0;
  });
  assert.equal(await dialog.getByLabel("用紙サイズ", { exact: true }).inputValue(), "A4", "no earlier notebook: the default paper");
  await page.screenshot({ path: path.join(visual, "create-dialog.png") });
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "detached" });
  let rows = await notebooks();
  const first = rows.find(item => item.title === base);
  assert.ok(first, "notebook created with the default name");
  assert.equal(first.collection_name, "読書会");
  // Opened in the middle, and its row is shown and selected in the folder it was made in.
  await page.getByRole("tab", { name: "ノート", exact: true }).waitFor();
  await row(base).waitFor();
  assert.equal(await row(base).getAttribute("aria-selected"), "true");
  assert.equal(await row(base).getAttribute("data-drop-collection"), "読書会");

  // 2. The tree's blank part has a menu of its own; the notebook goes to the 追加先 (now 読書会), as 「(2)」.
  const area = (await page.locator("[role=tree]").locator("xpath=..").boundingBox())!;
  await page.mouse.click(area.x + area.width / 2, area.y + area.height - 12, { button: "right" });
  await menu.waitFor();
  assert.deepEqual(await labelsOf(), ["ノートを作る…", "フォルダーを作成…", "PDFを追加…"]);
  await page.screenshot({ path: path.join(visual, "blank-menu.png") });
  await menu.getByRole("menuitem", { name: "ノートを作る…", exact: true }).click();
  await dialog.waitFor();
  assert.equal(await folderSelect.inputValue(), "読書会");
  assert.equal(await nameInput.inputValue(), `${base} (2)`);
  // The folder can be changed in place; the name follows it while it is not typed.
  await folderSelect.selectOption("機械学習");
  assert.equal(await nameInput.inputValue(), base);
  assert.equal(await folderSelect.locator("option").first().innerText(), "未分類");
  await dialog.getByLabel("用紙サイズ", { exact: true }).selectOption("B5");
  await dialog.getByLabel("罫線", { exact: true }).selectOption("grid10");
  await dialog.getByRole("button", { name: "作成", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  rows = await notebooks();
  const second = rows.find(item => item.collection_name === "機械学習");
  assert.ok(second && second.title === base);
  assert.equal((await api.call("GET", `/api/notebooks/${second.id}`)).pages[0].size, "B5");
  await page.waitForFunction((title) => [...document.querySelectorAll("[role=treeitem]")].some(el =>
    el.getAttribute("aria-selected") === "true" && el.getAttribute("data-drop-collection") === "機械学習" && (el as HTMLElement).innerText.includes(title)), base);

  // 3. Ctrl+Alt+N opens it too (not the folder dialog of Ctrl+Shift+N), with the paper chosen last.
  await page.keyboard.press("Control+Alt+n");
  await dialog.waitFor();
  assert.equal(await folderSelect.inputValue(), "機械学習");
  assert.equal(await nameInput.inputValue(), `${base} (2)`);
  assert.equal(await dialog.getByLabel("用紙サイズ", { exact: true }).inputValue(), "B5");
  assert.equal(await dialog.getByLabel("罫線", { exact: true }).inputValue(), "grid10");
  assert.equal(await page.getByRole("dialog", { name: "フォルダーを作成" }).count(), 0);
  // It does not open again over itself, and a name typed is kept.
  await nameInput.fill("手書きの実験");
  await page.keyboard.press("Control+Alt+n");
  assert.equal(await nameInput.inputValue(), "手書きの実験");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  const saved = await page.evaluate(() => localStorage.getItem("papeer-storage"));
  assert.match(saved ?? "", /"lastNotebookPaper":\{[^}]*"size":"B5"/);

  // 4. The notebook's row: its pages and no reading status (a PDF's row keeps its status).
  const text = async (title: string) => (await row(title).first().innerText()).replace(/\s+/g, " ");
  assert.match(await text(base), /1ページ/);
  assert.doesNotMatch(await text(base), /未読|読書中|読了|未設定/);
  assert.match(await text("Stochastic Gradient"), /未読|読書中/);
  assert.ok((await notebooks()).every(item => item.read_status === "未読"), "opening a notebook does not start reading it");

  // 5. Its context menu.
  const target = row(base).first();
  await target.click({ button: "right" });
  await menu.waitFor();
  assert.deepEqual(await labelsOf(), [
    "名前を変更… F2", "関連論文を追加…", "専用ノートを作る…", "持ち主を変更・独立させる…", "フォルダーを移動", "タグ", "情報・整理",
    "書き込み付きPDFとして保存…", "保存フォルダーを開く", "ライブラリから削除",
  ]);
  await page.screenshot({ path: path.join(visual, "notebook-row-menu.png") });
  await menu.getByRole("menuitem", { name: "フォルダーを移動" }).hover();
  await page.getByRole("menuitemcheckbox", { name: "機械学習" }).waitFor();
  await page.screenshot({ path: path.join(visual, "notebook-row-menu-move.png") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  // The PDF's own menu is as before.
  await row("Stochastic Gradient").click({ button: "right" });
  await menu.waitFor();
  const pdfLabels = await labelsOf();
  for (const label of ["専用ノートを作る…", "論文情報・整理", "分類を変更", "読書状態", "ファイル名を変更…", "原文PDFを開く", "BibTeX をコピー", "ライブラリから削除"]) {
    assert.ok(pdfLabels.some(item => item.startsWith(label)), `PDF の行メニューに「${label}」`);
  }
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });

  // Renaming from the menu asks for a name, not a file name.
  await target.click({ button: "right" });
  await menu.getByRole("menuitem", { name: /^名前を変更…/ }).click();
  const rename = page.getByRole("dialog", { name: "名前を変更", exact: true });
  await rename.waitFor();
  await rename.getByRole("textbox").fill("名前を変えたノート");
  await page.keyboard.press("Enter");
  await rename.waitFor({ state: "detached" });
  await waitFor(async () => (await notebooks()).filter(item => item.title === "名前を変えたノート").length === 1 || undefined, "名前の変更が保存されること");
  await row("名前を変えたノート").first().waitFor();

  // 6. The reading status: filtered by for PDFs only, and not in the information panel or a selection of notebooks.
  const filter = page.getByLabel("読書状態で絞り込み", { exact: true });
  await filter.selectOption("未読");
  await page.waitForFunction(() => ![...document.querySelectorAll("[role=treeitem][data-tree-key^='paper:']")].some(el => /名前を変えたノート/.test((el as HTMLElement).innerText)));
  await row("Stochastic Gradient").waitFor();
  await filter.selectOption("");
  await row("名前を変えたノート").first().waitFor();
  await row("名前を変えたノート").first().click({ button: "right" });
  await menu.getByRole("menuitem", { name: "情報・整理", exact: true }).click();
  await page.getByRole("heading", { name: "タグ", exact: true }).waitFor();
  assert.equal(await page.getByText("読書状態", { exact: true }).count(), 0, "情報・整理に読書状態を出さない");
  assert.equal(await page.getByRole("heading", { name: "読書状態・タグ" }).count(), 0);
  await page.screenshot({ path: path.join(visual, "notebook-info.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  // A selection of the two notebooks has no reading status to change; with the PDF it changes the PDF's only.
  await row("名前を変えたノート").first().click();
  await row(base).first().click({ modifiers: ["Control"] });
  await row(base).first().click({ button: "right" });
  await menu.waitFor();
  assert.ok((await labelsOf()).length > 0 && await menu.getByText("2件の論文を選択中").count() === 1, "2件を選択中のメニュー");
  assert.equal(await menu.getByText(/読書状態を変更/).count(), 0);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await row("Stochastic Gradient").click({ modifiers: ["Control"] });
  await row("Stochastic Gradient").click({ button: "right" });
  await menu.getByText("読書状態を変更（PDFのみ）", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });

  // 7. A 専用ノート is made for its owner: no folder to choose.
  await row("Stochastic Gradient").click();
  await row("Stochastic Gradient").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "専用ノートを作る…", exact: true }).click();
  const owned = page.getByRole("dialog", { name: "専用ノートを作る", exact: true });
  await owned.waitFor();
  assert.equal(await owned.getByLabel("作成先", { exact: true }).count(), 0);
  await owned.getByText("持ち主：").waitFor();
  await page.screenshot({ path: path.join(visual, "owned-dialog.png") });
  await page.keyboard.press("Escape");
  await owned.waitFor({ state: "detached" });
});

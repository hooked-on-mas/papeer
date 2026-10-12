// 複数mdメモを実ウィンドウで作り、切替・ツリー・持込み・付箋との接続を確かめる。
import assert from "node:assert/strict";
import path from "node:path";
import { scenario } from "../lib/app.ts";
import { REPO, waitFor } from "../lib/processes.ts";
import { libraryRow, openPaper, waitForLibrary } from "../lib/ui.ts";

scenario("複数メモを切り替え、持ち物を開き、mdと付箋を取り込む", {
  papers: [{ file: "gradient.pdf" }, { file: "observer.pdf" }],
}, async app => {
  const { page, api } = app, owner = app.paperIds["gradient.pdf"];
  const base = `/api/papers/${owner}/attachments`;
  await waitForLibrary(page, ["Stochastic Gradient", "Robust Observer"]);
  await openPaper(page, "Stochastic Gradient");
  const lines = await page.evaluate(() => [...document.querySelectorAll('[data-page-number="1"] .textLayer span')]
    .filter(span => (span.textContent ?? "").length > 30).slice(3, 5).map(span => {
      const rect = span.getBoundingClientRect();
      return { left: rect.left, right: rect.right, middle: (rect.top + rect.bottom) / 2 };
    }));
  assert.equal(lines.length, 2);
  await page.mouse.move(lines[0].left + 3, lines[0].middle);
  await page.mouse.down();
  await page.mouse.move(lines[1].right - 20, lines[1].middle, { steps: 8 });
  await page.mouse.up();
  await page.locator("[data-selection-toolbar]").getByRole("button", { name: "メモへ", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "論文のメモ", exact: true });
  await waitFor(async () => (await api.call("GET", base)).length === 1, "メモがない論文への引用で新形式メモを作ること");
  const firstId = (await api.call("GET", base))[0].id;
  await waitFor(async () => (await api.call("GET", `${base}/${firstId}`)).content.includes("papeer:"), "引用を出典リンク付きで新形式へ保存すること");
  await editor.fill("# 読書メモ\n\n- 最初の項目");
  await editor.press("Control+End");
  await editor.press("Enter");
  await page.keyboard.insertText("二つ目の項目");
  await waitFor(async () => (await api.call("GET", `${base}/${firstId}`)).content.includes("- 二つ目の項目"), "リストの続きを自動入力して保存すること");
  await page.getByRole("button", { name: "メモの名前を変更", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "メモの名前を変更", exact: true });
  await rename.getByRole("textbox").fill("読むポイント.md");
  await rename.getByRole("button", { name: "OK", exact: true }).click();
  await rename.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "新規メモ", exact: true }).click();
  const selector = page.getByRole("combobox", { name: "メモを選択", exact: true });
  await waitFor(async () => await selector.locator("option").count() === 2 && await selector.inputValue() !== firstId, "新しいメモの入力欄が開くこと");
  await editor.fill("別のメモへだけ保存する");
  const secondId = await selector.inputValue();
  await selector.selectOption(firstId);
  await waitFor(async () => (await editor.innerText()).includes("二つ目の項目"), "切り替え先の内容が表示されること");
  await waitFor(async () => (await api.call("GET", `${base}/${secondId}`)).content === "別のメモへだけ保存する", "切替前の内容が正しいメモに保存されること");
  await page.getByRole("button", { name: "メモを後ろへ", exact: true }).click();
  await waitFor(async () => (await api.call("GET", base))[1].id === firstId, "順序が保存されること");
  for (let i = 0; i < 5; i++) await api.call("POST", base, { title: `補足${i}.md`, content: `補足 ${i}` });
  const paper = libraryRow(page, "Stochastic Gradient");
  await paper.getByLabel("持ち物 7件", { exact: true }).waitFor();
  assert.equal(await paper.getAttribute("aria-expanded"), "false");
  await paper.focus();
  await paper.press("ArrowRight");
  const more = page.getByRole("treeitem").filter({ hasText: /^ほか 2件$/ });
  await more.waitFor();
  assert.equal(await page.locator(`[data-tree-key^="attachment:${owner}:"]`).count(), 5);
  await page.locator(`[data-tree-key="attachment:${owner}:${firstId}"]`).click();
  assert.equal(await page.getByRole("tab", { name: "PDFを読む", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await selector.inputValue(), firstId);
  await more.click();
  assert.equal(await selector.locator("option").count(), 7);
  await page.locator(`[data-memo-owner="${owner}"]`).last().evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["# 持込\n本文"], "持込.md", { type: "text/markdown" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await waitFor(async () => (await api.call("GET", base)).length === 8, "mdのドロップが新しい持ち物になること");
  const imported = (await api.call("GET", base)).find((row: { title: string }) => row.title === "持込.md");
  assert.equal(imported.source, "imported");
  assert.equal((await api.call("GET", `${base}/${imported.id}`)).content, "# 持込\n本文");
  await selector.selectOption(imported.id);
  await api.call("POST", `/api/papers/${owner}/sticky-notes`, { page: 1, side: "original", quote: "引用の内容", note: "付箋から追記" });
  await page.getByRole("tab", { name: "付箋", exact: true }).click();
  await page.getByRole("button", { name: "メモに書き出す", exact: true }).click();
  await page.getByRole("menuitem", { name: "付箋とハイライト（1件）", exact: true }).click();
  await waitFor(async () => (await api.call("GET", `${base}/${imported.id}`)).content.includes("付箋から追記"), "選択中の新形式メモに付箋が追記されること");
  await page.getByRole("button", { name: "検索・置換", exact: true }).click();
  await page.locator(".cm-search").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "メモを削除", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "メモを削除", exact: true });
  await remove.getByRole("button", { name: "削除する", exact: true }).click();
  await waitFor(async () => (await api.call("GET", base)).length === 7, "削除が一覧と件数に反映されること");
  await paper.getByLabel("持ち物 7件", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(REPO, "tmp", "e2e-results", "multiple-memos.png") });
  assert.deepEqual(app.consoleErrors.filter(error => error.startsWith("[pageerror]")), []);
});

// 整理パネルを開いてもメモとPDFの位置が保たれ、別の論文の情報はその論文に保存される。
import assert from "node:assert/strict";
import path from "node:path";
import { scenario } from "../lib/app.ts";
import { REPO, waitFor } from "../lib/processes.ts";
import { libraryRow, openPaper, readingPlace, waitForLibrary } from "../lib/ui.ts";

scenario("メモと整理を別に開き、整理の保存先と読書位置を保つ", {
  tags: ["比較対象"],
  collections: ["整理済み"],
  papers: [{ file: "gradient.pdf" }, { file: "observer.pdf" }],
}, async (app) => {
  const { page, api } = app;
  const currentId = app.paperIds["gradient.pdf"], otherId = app.paperIds["observer.pdf"];
  await waitForLibrary(page, ["Stochastic Gradient", "Robust Observer"]);
  await openPaper(page, "Stochastic Gradient");
  const place = await readingPlace(page);
  const pdf = await page.locator("[data-page-number] canvas").first().elementHandle();

  await page.getByRole("tab", { name: "メモ", exact: true }).click();
  const memo = page.getByPlaceholder("論文に関するメモを自由に記述できます…");
  await memo.fill("読みながら書いたメモを維持する");
  assert.equal(await page.getByLabel("出版年", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "論文情報・整理", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "論文情報・整理", exact: true });
  await panel.getByLabel("筆頭著者", { exact: true }).fill("Current Author");
  await panel.getByRole("button", { name: "閉じる", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  assert.equal(await page.getByRole("tab", { name: "メモ", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await memo.inputValue(), "読みながら書いたメモを維持する");
  await waitFor(async () => (await api.call("GET", `/api/papers/${currentId}`)).first_author === "Current Author",
    "閉じたパネルの書誌情報が保存されること");

  // The library's other paper can be organized without replacing the open memo or PDF.
  await libraryRow(page, "Robust Observer").click({ button: "right" });
  await page.getByRole("menuitem", { name: "論文情報・整理", exact: true }).click();
  await panel.getByText("Robust Observer", { exact: false }).waitFor();
  await panel.getByLabel("筆頭著者", { exact: true }).fill("Other Author");
  await panel.getByLabel("フォルダー", { exact: true }).fill("整理済み");
  await panel.getByLabel("フォルダー", { exact: true }).press("Tab");
  await panel.getByRole("button", { name: "読書状態", exact: false }).click();
  await page.getByRole("menuitemradio", { name: "読了", exact: true }).click();
  const tags = panel.getByRole("combobox", { name: "タグ", exact: true });
  await tags.fill("比較対象");
  await page.getByRole("option", { name: "比較対象", exact: false }).click();
  await panel.getByRole("button", { name: "閉じる", exact: true }).click();
  await panel.waitFor({ state: "detached" });
  await waitFor(async () => {
    const paper = await api.call("GET", `/api/papers/${otherId}`);
    return paper.first_author === "Other Author" && paper.collection_name === "整理済み"
      && paper.read_status === "読了" && paper.tags.includes("比較対象");
  }, "別の論文の整理と書誌情報がその論文に保存されること");
  assert.equal((await api.call("GET", `/api/papers/${currentId}`)).first_author, "Current Author");
  assert.equal(await memo.inputValue(), "読みながら書いたメモを維持する");

  await page.getByRole("tab", { name: "PDFを読む", exact: true }).click();
  assert.deepEqual(await readingPlace(page), place);
  assert.equal(await pdf!.evaluate(canvas => canvas.isConnected), true);

  // Escape closes the organization panel without leaving focus mode.
  await page.keyboard.press("F11");
  const focusPlace = await readingPlace(page);
  await page.getByRole("button", { name: "その他の表示・操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "論文情報・整理", exact: true }).click();
  await panel.getByLabel("筆頭著者", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(REPO, "tmp", "e2e-results", "paper-details-panel.png") });
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
  assert.equal(await page.getByRole("button", { name: "集中表示を終了", exact: true }).isVisible(), true);
  const afterClose = await readingPlace(page);
  assert.equal(afterClose.page, focusPlace.page);
  assert.ok(Math.abs(afterClose.y - focusPlace.y) < 0.02);

  await page.getByRole("button", { name: "集中表示を終了", exact: true }).click();
  await app.setViewport(986, 763);
  await page.getByRole("button", { name: "論文情報・整理", exact: true }).click();
  await panel.getByLabel("筆頭著者", { exact: true }).waitFor();
  assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  assert.equal(await panel.getByRole("button", { name: "閉じる", exact: true }).isVisible(), true);
  await page.screenshot({ path: path.join(REPO, "tmp", "e2e-results", "paper-details-narrow.png") });
  await panel.getByRole("button", { name: "閉じる", exact: true }).click();
  assert.deepEqual(app.consoleErrors.filter(error => error.startsWith("[pageerror]")), []);
});

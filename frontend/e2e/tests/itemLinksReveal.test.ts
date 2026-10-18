import assert from "node:assert/strict";
import { scenario } from "../lib/app.ts";
import { waitFor } from "../lib/processes.ts";
import { waitForLibrary } from "../lib/ui.ts";

// Showing a linked note in its folder, from the ↗ row under the PDF, while the library is narrowed by a
// tag or a reading state the note does not carry: the note is out of the tree until the filter is lifted.

scenario("タグで絞り込んだ中の↗行から、遠い独立ノートの原本を絞り込み解除して表示しフォーカスする", {
  tags: ["重要"],
  collections: Array.from({ length: 240 }, (_, index) => `F${String(index).padStart(3, "0")}`),
  papers: [{ file: "gradient.pdf", collection: "F000", tags: ["重要"] }, { file: "observer.pdf", collection: "F000" }],
  viewport: { width: 1280, height: 900 }, timeout: 180_000,
}, async app => {
  const { page, api } = app;
  const paperId = app.paperIds["gradient.pdf"], otherId = app.paperIds["observer.pdf"];
  await waitForLibrary(page, ["Stochastic Gradient", "Robust Observer"]);
  const notebook = await api.call("POST", "/api/notebooks", { title: "離れたノート", collection: "F239" });
  await api.call("POST", `/api/papers/${paperId}/links`, { target_id: notebook.id });
  const row = (id: string) => page.locator(`[data-tree-key="paper:${id}"]`);
  const linkRow = page.locator(`[data-tree-key="link:${paperId}:${notebook.id}"]`);
  const tag = page.getByRole("region", { name: "タグで絞り込み" }).getByRole("button", { name: /重要/ });
  await waitFor(async () => await page.getByRole("treeitem").count() < 80, "長いツリーが仮想化されること");

  await tag.click();
  await waitFor(async () => await tag.getAttribute("aria-pressed") === "true" && await row(otherId).count() === 0,
    "タグで絞り込むと、タグのない論文とノートが一覧から消えること");
  assert.equal(await row(notebook.id).count(), 0);
  // The ↗ count and the arrow come with the links query: ArrowRight before them does not open the row.
  await row(paperId).getByLabel("紐づけ 1件", { exact: true }).waitFor();
  await waitFor(async () => await row(paperId).getAttribute("aria-expanded") !== null, "論文の行が開閉できる行になること");
  await row(paperId).focus(); await row(paperId).press("ArrowRight");
  await linkRow.waitFor();
  await linkRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "フォルダー内で表示", exact: true }).click();

  await waitFor(async () => await tag.getAttribute("aria-pressed") === "false", "ノートを隠すタグの絞り込みが解除されること");
  await waitFor(async () => await row(notebook.id).count() === 1 && await row(notebook.id).evaluate(el => el === document.activeElement),
    "遠いフォルダーにある原本の行へフォーカスすること", 15_000);
  await waitFor(() => page.evaluate((id) => {
    const target = document.querySelector(`[data-tree-key="paper:${id}"]`);
    const list = document.querySelector("[role=tree]")?.parentElement;
    if (!target || !list) return false;
    const a = target.getBoundingClientRect(), b = list.getBoundingClientRect();
    return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
  }, notebook.id), "原本の行がスクロールされて見えること", 15_000);
  // The far row is the only one drawn around F239; Home goes back to the top, where the other paper returns.
  await page.keyboard.press("Home");
  await row(otherId).waitFor();
  assert.equal(await row(otherId).count(), 1, "他の論文も絞り込み解除で戻ること");
  assert.deepEqual(app.consoleErrors.filter(error => error.startsWith("[pageerror]")), []);
});

scenario("読書状態の絞り込みだけがノートを隠すとき、読書状態だけ解除してタグの絞り込みは残す", {
  tags: ["重要"], collections: ["Papers", "Notes"],
  papers: [{ file: "gradient.pdf", collection: "Papers", tags: ["重要"] }, { file: "observer.pdf", collection: "Papers" }],
  viewport: { width: 1280, height: 900 }, timeout: 180_000,
}, async app => {
  const { page, api } = app;
  const paperId = app.paperIds["gradient.pdf"], otherId = app.paperIds["observer.pdf"];
  await waitForLibrary(page, ["Stochastic Gradient", "Robust Observer"]);
  const notebook = await api.call("POST", "/api/notebooks", { title: "輪読ノート", collection: "Notes" });
  // The note carries the tag, not the state: only the state's filter leaves it out.
  await api.call("PATCH", `/api/papers/${notebook.id}`, { tags: ["重要"] });
  await api.call("PATCH", `/api/papers/${paperId}`, { read_status: "読了" });
  await api.call("POST", `/api/papers/${paperId}/links`, { target_id: notebook.id });
  const row = (id: string) => page.locator(`[data-tree-key="paper:${id}"]`);
  const linkRow = page.locator(`[data-tree-key="link:${paperId}:${notebook.id}"]`);
  const tag = page.getByRole("region", { name: "タグで絞り込み" }).getByRole("button", { name: /重要/ });
  const status = page.getByRole("combobox", { name: "読書状態で絞り込み", exact: true });

  await tag.click();
  await waitFor(async () => await row(otherId).count() === 0 && await row(notebook.id).count() === 1,
    "タグを付けたノートはタグの絞り込みでは残ること");
  await status.selectOption("読了");
  await waitFor(async () => await row(notebook.id).count() === 0 && await row(paperId).count() === 1,
    "読書状態の絞り込みでノートの原本が一覧から消えること");
  await row(paperId).getByLabel("紐づけ 1件", { exact: true }).waitFor();
  await waitFor(async () => await row(paperId).getAttribute("aria-expanded") !== null, "論文の行が開閉できる行になること");
  await row(paperId).focus(); await row(paperId).press("ArrowRight");
  await linkRow.waitFor();
  await linkRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "フォルダー内で表示", exact: true }).click();

  await waitFor(async () => await row(notebook.id).count() === 1 && await row(notebook.id).evaluate(el => el === document.activeElement),
    "原本の行へフォーカスすること");
  assert.equal(await status.inputValue(), "", "ノートを隠していた読書状態の絞り込みは解除される");
  assert.equal(await tag.getAttribute("aria-pressed"), "true", "ノートを隠していないタグの絞り込みは残る");
  assert.equal(await row(otherId).count(), 0, "残した絞り込みで他の論文は隠れたまま");
  assert.deepEqual(app.consoleErrors.filter(error => error.startsWith("[pageerror]")), []);
});

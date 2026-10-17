import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scenario } from "../lib/app.ts";
import { waitFor } from "../lib/processes.ts";
import { waitForLibrary } from "../lib/ui.ts";

scenario("論文と独立ノートをドラッグ・右クリックで紐づけ、両側から開いて外す", {
  collections: ["Papers", "Notes"], papers: [{ file: "gradient.pdf", collection: "Papers" }, { file: "observer.pdf", collection: "Papers" }],
  viewport: { width: 1280, height: 900 }, timeout: 180_000,
}, async app => {
  const { page, api } = app;
  const paperId = app.paperIds["gradient.pdf"], otherId = app.paperIds["observer.pdf"];
  const screenshotDir = path.join(os.tmpdir(), "paper-desk-d-visual"); fs.mkdirSync(screenshotDir, { recursive: true });
  await waitForLibrary(page, ["Stochastic Gradient", "Robust Observer"]);
  const notebook = await api.call("POST", "/api/notebooks", { title: "輪読ノート", collection: "Notes" });
  // External clients publish the same change events as the drag and context menu.
  const row = (id: string) => page.locator(`[data-tree-key="paper:${id}"]`);
  const linkRow = (owner: string, target: string) => page.locator(`[data-tree-key="link:${owner}:${target}"]`);
  await row(notebook.id).waitFor();
  const from = await row(paperId).boundingBox(), to = await row(notebook.id).boundingBox(); assert.ok(from && to);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.getByText("紐づけ（置き場所はそのまま）", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(screenshotDir, "01-drag-link.png") });
  await page.mouse.up();
  await waitFor(async () => (await api.call("GET", `/api/papers/${paperId}/links`)).length === 1, "ドラッグで紐づくこと");
  assert.equal((await api.call("GET", `/api/papers/${paperId}`)).collection_name, "Papers");
  assert.equal((await api.call("GET", `/api/papers/${notebook.id}`)).collection_name, "Notes");
  await row(notebook.id).getByLabel("紐づけ 1件", { exact: true }).waitFor();
  await row(paperId).focus(); await row(paperId).press("ArrowRight");
  await linkRow(paperId, notebook.id).waitFor();
  assert.equal(await linkRow(paperId, notebook.id).getAttribute("aria-expanded"), null);
  await linkRow(paperId, notebook.id).click();
  await page.locator("h1", { hasText: "輪読ノート" }).waitFor();
  assert.equal(await row(notebook.id).getAttribute("aria-current"), "true");
  assert.equal(await linkRow(paperId, notebook.id).getAttribute("aria-selected"), "false");
  await page.getByRole("button", { name: "↗ 関連論文 1", exact: true }).click();
  await page.getByRole("button", { name: /↗.*Stochastic Gradient/ }).waitFor();
  await row(notebook.id).focus(); await row(notebook.id).press("ArrowRight");
  await linkRow(notebook.id, paperId).click({ button: "right" });
  await page.getByRole("menuitem", { name: "フォルダー内で表示", exact: true }).click();
  await waitFor(() => row(paperId).evaluate(el => el === document.activeElement), "原本の行へフォーカスすること");
  await row(otherId).click({ button: "right" });
  await page.getByRole("menuitem", { name: "ノートに紐づける…", exact: true }).click();
  const chooser = page.getByRole("dialog", { name: "ノートに紐づける", exact: true });
  await chooser.getByRole("button", { name: /輪読ノート/ }).click();
  await chooser.waitFor({ state: "detached" });
  await waitFor(async () => (await api.call("GET", `/api/papers/${notebook.id}/links`)).length === 2, "右クリックでも紐づくこと");
  await page.getByRole("button", { name: "接続・設定", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "設定", exact: true });
  await settings.getByRole("navigation", { name: "設定の項目", exact: true }).getByRole("button", { name: "表示", exact: true }).click();
  await settings.getByLabel("左パネルの紐づけ行を隠す", { exact: true }).check();
  await settings.getByRole("button", { name: "閉じる", exact: true }).click();
  await linkRow(paperId, notebook.id).waitFor({ state: "detached" });
  assert.equal(await row(notebook.id).getByLabel("紐づけ 2件", { exact: true }).count(), 0);
  await page.reload();
  await waitForLibrary(page, ["輪読ノート"]);
  assert.equal(await page.locator('[data-tree-key^="link:"]').count(), 0, "隠す設定は再起動後も保存される");
  await row(notebook.id).click();
  await page.getByRole("button", { name: "↗ 関連論文 2", exact: true }).click();
  const related = page.getByRole("dialog", { name: "関連論文", exact: true });
  await related.getByRole("button", { name: /Stochastic Gradient.*紐づけを外す/ }).click();
  await waitFor(async () => (await api.call("GET", `/api/papers/${notebook.id}/links`)).length === 1, "隠している間も画面の関連論文から解除すること");
  assert.ok(await api.call("GET", `/api/papers/${paperId}`));
  await page.screenshot({ path: path.join(screenshotDir, "02-related-papers-hidden-tree.png") });
  // Five holdings followed by a link must route the remainder to the complete chooser.
  for (let index = 0; index < 5; index++) await api.call("POST", `/api/papers/${otherId}/attachments`, { title: `メモ${index}.md`, content: "" });
  await page.getByRole("button", { name: "接続・設定", exact: true }).click();
  await settings.getByRole("navigation", { name: "設定の項目", exact: true }).getByRole("button", { name: "表示", exact: true }).click();
  await settings.getByLabel("左パネルの紐づけ行を隠す", { exact: true }).uncheck();
  await settings.getByRole("button", { name: "閉じる", exact: true }).click();
  await row(otherId).focus(); await row(otherId).press("ArrowRight");
  await page.locator(`[data-tree-key="more:${otherId}"]`).click();
  const all = page.getByRole("dialog", { name: "持ち物", exact: true });
  await all.getByRole("button", { name: "↗ 輪読ノート", exact: true }).waitFor();
  assert.equal(await all.getByRole("button", { name: /メモ[0-4].md/ }).count(), 5);
  await page.screenshot({ path: path.join(screenshotDir, "03-complete-children.png") });
  await page.keyboard.press("Escape");
  await row(otherId).click();
  await page.getByRole("button", { name: "論文情報・整理", exact: true }).click();
  const details = page.getByRole("dialog", { name: "論文情報・整理", exact: true });
  await details.getByRole("heading", { name: "関連ノート", exact: true }).waitFor();
  await details.getByRole("button", { name: "↗ 輪読ノート", exact: true }).waitFor();
  await details.getByRole("button", { name: "閉じる", exact: true }).click();
  assert.deepEqual(app.consoleErrors.filter(error => error.startsWith("[pageerror]")), []);
});

scenario("長いツリーでも複数論文をキーでノートに紐づけ、ノート混在は紐づけない", {
  collections: Array.from({ length: 240 }, (_, index) => `F${String(index).padStart(3, "0")}`),
  papers: [{ file: "gradient.pdf", collection: "F000" }, { file: "observer.pdf", collection: "F000" }],
  viewport: { width: 1280, height: 900 }, timeout: 180_000,
}, async app => {
  const { page, api } = app;
  const first = app.paperIds["gradient.pdf"], second = app.paperIds["observer.pdf"];
  await waitForLibrary(page, ["Stochastic Gradient", "Robust Observer"]);
  const notebook = await api.call("POST", "/api/notebooks", { title: "離れたノート", collection: "F239" });
  const row = (id: string) => page.locator(`[data-tree-key="paper:${id}"]`);
  await waitFor(async () => await page.getByRole("treeitem").count() < 80, "長いツリーが仮想化されること");
  assert.equal(await row(notebook.id).count(), 0, "遠いノートは通常画面外");
  await row(first).click();
  await row(second).click({ modifiers: ["Control"] });
  await row(first).focus(); await page.keyboard.press("Space");
  await row(notebook.id).waitFor({ state: "attached" });
  const hint = page.getByText("紐づけ（置き場所はそのまま）", { exact: true });
  let steps = 0;
  for (; steps < 245 && !await hint.count(); steps++) await page.keyboard.press("ArrowDown");
  assert.ok(steps < 245, "keyboard drag reaches the notebook beyond the viewport");
  await page.keyboard.press("Space");
  await waitFor(async () => (await api.call("GET", `/api/papers/${notebook.id}/links`)).length === 2, "選択した2論文がどちらも紐づくこと");
  assert.equal((await api.call("GET", `/api/papers/${first}`)).collection_name, "F000");
  assert.equal((await api.call("GET", `/api/papers/${second}`)).collection_name, "F000");
  const target = await api.call("POST", "/api/notebooks", { title: "混在選択の宛先", collection: "F000" });
  // Reveal the just-created target by returning to the first folder.
  await row(first).focus(); await page.keyboard.press("Home");
  await page.getByRole("tree").locator('[data-tree-key="folder:F000"]').waitFor();
  await row(target.id).waitFor();
  await row(target.id).click();
  await row(first).click({ modifiers: ["Control"] });
  const sourceBox = await row(first).boundingBox(); assert.ok(sourceBox);
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 12, sourceBox.y + sourceBox.height / 2, { steps: 3 });
  const targetBox = await row(target.id).boundingBox(); assert.ok(targetBox);
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 });
  assert.equal(await hint.count(), 0, "ノートを含む選択は紐づけ先を有効にしない");
  await page.mouse.up();
  assert.deepEqual(await api.call("GET", `/api/papers/${target.id}/links`), []);
  assert.equal((await api.call("GET", `/api/papers/${first}`)).collection_name, "F000");
  assert.deepEqual(app.consoleErrors.filter(error => error.startsWith("[pageerror]")), []);
});

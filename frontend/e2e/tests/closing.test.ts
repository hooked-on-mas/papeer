// 終了: × で閉じると保存できない入力を確かめ、キャンセルで入力を残したまま戻る
import assert from "node:assert/strict";
import { scenario } from "../lib/app.ts";
import { waitForLibrary, openPaper } from "../lib/ui.ts";

scenario("× で閉じると保存できない入力の確認が出て、キャンセルで終了せずに戻る", {
  papers: [{ file: "gradient.pdf" }],
}, async (app) => {
  const { page, api } = app;
  const id = app.paperIds["gradient.pdf"];
  await waitForLibrary(page, ["Stochastic Gradient"]);
  await openPaper(page, "Stochastic Gradient");
  await page.getByRole("button", { name: "論文情報・整理", exact: true }).click();
  const year = page.getByPlaceholder("例：2024（不明なら空欄）");
  await year.fill("20x4");
  await year.press("Tab");
  // Held as a draft that cannot be saved, with the reason shown.
  await page.getByRole("alert").filter({ hasText: "出版年は半角数字4桁で入力してください" }).waitFor();
  await page.getByRole("dialog", { name: "論文情報・整理", exact: true }).getByRole("button", { name: "閉じる", exact: true }).click();
  await page.getByRole("dialog", { name: "論文情報・整理", exact: true }).waitFor({ state: "detached" });

  // The window's × (WM_CLOSE). Should the app go ahead and quit, lib/app.ts answers its exit call instead.
  app.requestWindowClose();
  const question = page.getByRole("dialog").filter({ hasText: "保存できない入力があります" });
  await question.waitFor();
  assert.match(await question.innerText(), /出版年/);
  await question.getByRole("button", { name: "キャンセル" }).click();
  await question.waitFor({ state: "detached" });

  // Still running, with what was typed kept and nothing saved.
  assert.equal(app.appRunning(), true);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: "論文情報・整理", exact: true }).click();
  assert.equal(await year.inputValue(), "20x4");
  assert.notEqual((await api.call("GET", `/api/papers/${id}`)).publication_year, "20x4");
  // The sidecar was not asked to shut down.
  assert.equal((await fetch(`${api.base}/health`)).ok, true);
});

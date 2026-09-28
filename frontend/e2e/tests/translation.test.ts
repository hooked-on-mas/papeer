// 翻訳: 代役 API で訳して PDF ができる、用語抽出を閉じて開き直すと引き継がれる（T42）
import assert from "node:assert/strict";
import { scenario } from "../lib/app.ts";
import { waitFor } from "../lib/processes.ts";
import { openPaper, waitForLibrary } from "../lib/ui.ts";

scenario("代役 API で翻訳すると、訳文の PDF ができて表示される", {
  papers: [{ file: "observer.pdf" }],
  // The first translation on a PC converts the bundled fonts (about 30 s; cached for later runs).
  timeout: 300_000,
}, async (app) => {
  const { page, api } = app;
  const id = app.paperIds["observer.pdf"];
  await waitForLibrary(page, ["Robust Observer"]);
  await openPaper(page, "Robust Observer");
  const before = await app.stubRequests();

  await page.getByRole("button", { name: "翻訳する…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("翻訳対象: 3ページ").waitFor();
  await dialog.getByRole("button", { name: "用語を確認せずに翻訳" }).click();
  await dialog.waitFor({ state: "detached" });
  await page.locator("header").getByText(/翻訳中/).waitFor();
  await page.locator("header").getByText("翻訳完了 · 3/3ページ").waitFor({ timeout: 240_000 });

  const after = await app.stubRequests();
  assert.ok(after.translation > before.translation, "代役 API に翻訳の依頼が届いていません");
  // The translated page is drawn next to the original.
  await page.getByText("日本語訳", { exact: true }).waitFor();
  await waitFor(async () => (await page.locator("[data-page-number] canvas").count()) >= 2, "訳文のページが描かれること", 30_000);
  const paper = await api.call("GET", `/api/papers/${id}`);
  assert.equal(paper.has_translated, true);
  const pdf = await api.request("GET", `/api/papers/${id}/files/translated.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), "%PDF");
});

scenario("用語抽出中に翻訳の設定を閉じて開き直すと、抽出が引き継がれて結果が出る", {
  papers: [{ file: "gradient.pdf" }],
}, async (app) => {
  const { page } = app;
  await waitForLibrary(page, ["Stochastic Gradient"]);
  await openPaper(page, "Stochastic Gradient");
  // Each answer of the stand-in AI waits, so the extraction is still running when the dialog is reopened.
  await app.setStubDelay(3);
  try {
    const before = await app.stubRequests();
    const header = page.getByRole("button", { name: "翻訳する…" });
    await header.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText(/全論文共通の専門用語辞書/).click();
    await dialog.getByRole("button", { name: "AIで未登録の専門用語を確認" }).click();
    await dialog.getByRole("button", { name: "抽出を中止" }).waitFor();
    await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
    await dialog.waitFor({ state: "detached" });

    // Reopened while the extraction runs: it shows the extraction going on, not a fresh start.
    assert.equal(await header.isEnabled(), true, "用語抽出中に「翻訳する…」が押せません");
    await header.click();
    await dialog.getByText(/AIが未登録の専門用語を抽出しています/).waitFor();
    await dialog.getByRole("button", { name: "抽出を中止" }).waitFor();

    // The result arrives in the reopened dialog, the terms marked as new.
    await dialog.getByText(/訳語の判断が必要な未登録語を\d+件抽出しました/).waitFor({ timeout: 30_000 });
    const targets = await dialog.locator("input").evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value));
    assert.ok(targets.includes("訳語1"), `抽出した訳語が表示されていません: ${targets.join(", ")}`);
    assert.ok(await dialog.getByText("新規", { exact: true }).count() > 0, "今回の追加候補に「新規」が付いていません");
    assert.equal((await app.stubRequests()).glossary - before.glossary, 1, "用語抽出が 1 回だけ行われていません");

    await dialog.getByRole("button", { name: "キャンセル" }).click();
    const discard = page.getByRole("dialog").filter({ hasText: "辞書の変更を破棄" });
    await discard.getByRole("button", { name: "破棄" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
  } finally {
    await app.setStubDelay(0);
  }
});

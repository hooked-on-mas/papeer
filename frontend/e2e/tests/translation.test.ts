// 翻訳: 代役 API で訳して PDF ができる、用語抽出を閉じて開き直すと引き継がれる（T42）、辞書の任意の選択・選択の変更、用語抽出の候補を論文限定で保存
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
  await dialog.getByRole("button", { name: "翻訳を開始" }).click();
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
    await dialog.getByRole("button", { name: "訳語の修正", exact: true }).click();
    await dialog.getByText("訳語の一覧・辞書を管理（詳細設定）", { exact: true }).click();
    await dialog.getByText("AIに訳語を提案してもらう（任意）", { exact: true }).click();
    await dialog.getByRole("button", { name: "AIで訳語候補を抽出" }).click();
    await dialog.getByRole("button", { name: "抽出を中止" }).waitFor();
    await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
    await dialog.waitFor({ state: "detached" });

    // Reopened while the extraction runs: it shows the extraction going on, not a fresh start.
    assert.equal(await header.isEnabled(), true, "用語抽出中に「翻訳する…」が押せません");
    await header.click();
    await dialog.getByRole("button", { name: "訳語の修正", exact: true }).click();
    await dialog.getByText("訳語の一覧・辞書を管理（詳細設定）", { exact: true }).click();
    await dialog.getByText(/AIが未登録の専門用語を抽出しています/).waitFor();
    await dialog.getByRole("button", { name: "抽出を中止" }).waitFor();

    // The result arrives in the reopened dialog, the terms marked as new.
    await dialog.getByText(/確認候補は\d+件です/).waitFor({ timeout: 30_000 });
    const targets = await dialog.locator("input").evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value));
    assert.ok(targets.includes("訳語1"), `抽出した訳語が表示されていません: ${targets.join(", ")}`);
    assert.ok(await dialog.getByText(/AIからの提案（\d+件）/).count() > 0, "追加候補が表示されていません");
    assert.equal((await app.stubRequests()).glossary - before.glossary, 1, "用語抽出が 1 回だけ行われていません");

    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
  } finally {
    await app.setStubDelay(0);
  }
});

scenario("辞書のAI選択は任意で、通常の翻訳を開いても始まらない", {
  papers: [{ file: "observer.pdf" }], timeout: 300_000,
}, async app => {
  const { page, api } = app;
  const id = app.paperIds["observer.pdf"];
  await api.call("PUT", "/api/glossary", { expected_terms: [], terms: [
    { source: "observer", target: "オブザーバ" }, { source: "cell", target: "セル", domain: "電池" },
  ] });
  await waitForLibrary(page, ["Robust Observer"]);
  await openPaper(page, "Robust Observer");
  const before = await app.stubRequests();
  await page.getByRole("button", { name: "翻訳する…", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "翻訳を開始", exact: true }).waitFor();
  assert.equal(await dialog.getByRole("tablist").count(), 0);
  assert.equal((await app.stubRequests()).domains - before.domains, 0);
  await dialog.getByRole("button", { name: "訳語の修正", exact: true }).click();
  await dialog.getByText("訳語の一覧・辞書を管理（詳細設定）", { exact: true }).click();
  await dialog.getByText("使う分野を変更", { exact: true }).click();
  await dialog.getByText("訳語の適用を確認・更新", { exact: true }).click();
  await dialog.getByRole("button", { name: "AIで適用する訳語を選び直す", exact: true }).click();
  await waitFor(async () => (await api.call("GET", `/api/papers/${id}/glossary-domains`)).chosen_by === "ai", "明示的に依頼した選択が保存されること");
  assert.equal((await app.stubRequests()).domains - before.domains, 1);
  const battery = dialog.getByRole("checkbox", { name: /^電池/ });
  await battery.check();
  await waitFor(async () => (await api.call("GET", `/api/papers/${id}/glossary-domains`)).chosen_by === "user", "手動の選択が保存されること");
  assert.equal((await app.stubRequests()).domains - before.domains, 1, "分野を選んだだけでAI処理は始まらない");
  await dialog.getByRole("button", { name: "翻訳に戻る", exact: true }).click();
  await dialog.getByRole("button", { name: "翻訳を開始", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.locator("header").getByText("翻訳完了 · 3/3ページ").waitFor({ timeout: 240_000 });
  assert.equal((await api.call("GET", `/api/papers/${id}`)).has_translated, true);
  assert.equal((await app.stubRequests()).domains - before.domains, 1);
});

scenario("抽出した訳語候補は、選んだ語だけを論文限定で保存できる", {
  papers: [{ file: "gradient.pdf" }],
}, async app => {
  const { page, api } = app;
  const id = app.paperIds["gradient.pdf"];
  const terms = [{ source: "observer", target: "オブザーバ" }, { source: "cell", target: "セル", domain: "電池" }];
  await api.call("PUT", "/api/glossary", { expected_terms: [], terms });
  await api.call("PUT", `/api/papers/${id}/glossary-domains`, { domains: ["電池"], new_domain: null });
  await waitForLibrary(page, ["Stochastic Gradient"]);
  await openPaper(page, "Stochastic Gradient");
  const before = await app.stubRequests();
  await page.getByRole("button", { name: "翻訳する…", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "訳語の修正", exact: true }).click();
  await dialog.getByText("訳語の一覧・辞書を管理（詳細設定）", { exact: true }).click();
  await dialog.getByText("AIに訳語を提案してもらう（任意）", { exact: true }).click();
  await dialog.getByRole("button", { name: "AIで訳語候補を抽出", exact: true }).click();
  await dialog.getByText(/確認候補は\d+件です/).waitFor({ timeout: 30_000 });
  const candidates = dialog.locator('fieldset').filter({ hasText: "AIからの提案" }).getByRole("checkbox");
  assert.ok(await candidates.count() > 0);
  assert.equal(await candidates.first().isChecked(), false);
  await candidates.first().check();
  await dialog.getByRole("button", { name: "この論文の訳語を保存", exact: true }).click();
  await dialog.getByText("この論文の訳語を保存しました。次の翻訳から反映します。", { exact: true }).waitFor();
  assert.equal((await api.call("GET", `/api/papers/${id}/glossary`)).terms.length, 1);
  assert.deepEqual(await api.call("GET", "/api/glossary"), terms);
  assert.equal((await app.stubRequests()).glossary - before.glossary, 1);
  assert.equal((await app.stubRequests()).domains - before.domains, 0);
});

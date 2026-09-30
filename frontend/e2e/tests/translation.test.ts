// 翻訳: 代役 API で訳して PDF ができる、用語抽出を閉じて開き直すと引き継がれる（T42）、分野辞書の自動選択・手動の分割・選択の変更、用語抽出の候補が主な分野辞書に入る
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
    await dialog.getByText(/専門用語辞書（\d+件/).click();
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

scenario("分野辞書があると AI が論文の分野辞書を選び、手動で分けられ、チェックで選び直して翻訳できる", {
  papers: [{ file: "observer.pdf" }],
  timeout: 300_000,
}, async (app) => {
  const { page, api } = app;
  const id = app.paperIds["observer.pdf"];
  // 共通に 1 語、分野辞書「電池」に 1 語。代役 AI の応答は空（選択は何も選ばず、分割は何も動かさない）。
  await api.call("PUT", "/api/glossary", { expected_terms: [], terms: [
    { source: "observer", target: "オブザーバ" }, { source: "cell", target: "セル", domain: "電池" },
  ] });
  await waitForLibrary(page, ["Robust Observer"]);
  await openPaper(page, "Robust Observer");
  const before = await app.stubRequests();
  // The choice takes a moment, so that the dialog can be seen holding the buttons meanwhile.
  await app.setStubDelay(2);
  try {
    await page.getByRole("button", { name: "翻訳する…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("AIがこの論文の分野辞書を選んでいます…").waitFor();
    assert.equal(await dialog.getByRole("button", { name: "用語を確認せずに翻訳" }).isDisabled(), true, "選択中に開始ボタンが押せます");
    await dialog.getByText("AIがこの論文の分野辞書を選んでいます…").waitFor({ state: "detached", timeout: 30_000 });
  } finally {
    await app.setStubDelay(0);
  }
  const dialog = page.getByRole("dialog");
  assert.equal((await app.stubRequests()).domains - before.domains, 1, "分野辞書の選択が 1 回だけ行われていません");
  let record = await api.call("GET", `/api/papers/${id}/glossary-domains`);
  assert.equal(record.chosen_by, "ai");
  assert.deepEqual(record.domains, []);

  // The list: the heading counts the domains, each term shows its domain, and the list can be narrowed to one.
  await dialog.getByText("専門用語辞書（2件・分野辞書 1）").click();
  await dialog.getByText("この論文に使う分野辞書").waitFor();
  await dialog.getByText(/AIがこの論文の内容から選びました/).waitFor();
  assert.equal(await dialog.getByLabel("分野 2").inputValue(), "電池");
  assert.equal(await dialog.getByLabel("分野 1").inputValue(), "共通");
  await dialog.getByLabel("分野で絞り込み").selectOption("電池");
  assert.equal(await dialog.locator('input[aria-label^="原語"]').count(), 1);
  await dialog.getByLabel("分野で絞り込み").selectOption("");
  assert.equal(await dialog.locator('input[aria-label^="原語"]').count(), 2);

  // Splitting by hand asks the AI once (nothing moves with the stand-in's empty answer) and says so.
  await dialog.getByRole("button", { name: "AIで分野ごとに分ける" }).click();
  await dialog.getByText(/分野辞書へ移す語はありませんでした/).waitFor({ timeout: 30_000 });
  assert.equal((await app.stubRequests()).domains - before.domains, 2, "手動の分割が 1 回だけ行われていません");

  // Choosing by hand is saved at once, as the user's choice.
  const battery = dialog.getByRole("checkbox", { name: /^電池/ });
  assert.equal(await battery.isChecked(), false);
  await battery.click();
  await waitFor(async () => await battery.isChecked(), "チェックがすぐに付くこと", 5_000);
  await waitFor(async () => (await api.call("GET", `/api/papers/${id}/glossary-domains`)).chosen_by === "user", "選択がユーザーの選択として保存されること");
  record = await api.call("GET", `/api/papers/${id}/glossary-domains`);
  assert.deepEqual(record.domains, ["電池"]);
  assert.equal((await app.stubRequests()).domains - before.domains, 2, "手動の選択のあとに AI が呼ばれています");

  // Translating goes on with the terms of the domains chosen.
  await dialog.getByRole("button", { name: "用語を確認せずに翻訳" }).click();
  await dialog.waitFor({ state: "detached" });
  await page.locator("header").getByText("翻訳完了 · 3/3ページ").waitFor({ timeout: 240_000 });
  const paper = await api.call("GET", `/api/papers/${id}`);
  assert.equal(paper.has_translated, true);
  assert.equal((await app.stubRequests()).domains - before.domains, 2, "翻訳のあとに分野辞書の AI が呼ばれています");
});

scenario("用語抽出の候補は、論文の主な分野辞書（選んだ分野辞書）の語として追加される", {
  papers: [{ file: "gradient.pdf" }],
}, async (app) => {
  const { page, api } = app;
  const id = app.paperIds["gradient.pdf"];
  // The paper's choice is the user's (the dictionary "電池"), so that the dialog does not ask the AI to choose.
  await api.call("PUT", "/api/glossary", { expected_terms: [], terms: [
    { source: "observer", target: "オブザーバ" }, { source: "cell", target: "セル", domain: "電池" },
  ] });
  await api.call("PUT", `/api/papers/${id}/glossary-domains`, { domains: ["電池"], new_domain: null });
  await waitForLibrary(page, ["Stochastic Gradient"]);
  await openPaper(page, "Stochastic Gradient");
  const before = await app.stubRequests();

  await page.getByRole("button", { name: "翻訳する…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("専門用語辞書（2件・分野辞書 1）").click();
  await dialog.getByRole("checkbox", { name: /^電池/ }).waitFor();
  await dialog.getByRole("button", { name: "AIで未登録の専門用語を確認" }).click();
  await dialog.getByText(/訳語の判断が必要な未登録語を\d+件抽出しました/).waitFor({ timeout: 30_000 });

  // 今回の追加候補: every candidate is new, and in the paper's main domain rather than 共通.
  const candidates = dialog.getByLabel(/^分野 \d+$/);
  const count = await candidates.count();
  assert.ok(count > 0, "追加候補が表示されていません");
  assert.equal(await dialog.getByText("新規", { exact: true }).count(), count, "追加候補のすべてに「新規」が付いていません");
  const domains = await candidates.evaluateAll((selects) => selects.map((s) => (s as HTMLSelectElement).value));
  assert.deepEqual([...new Set(domains)], ["電池"], `候補の分野が主な分野辞書ではありません: ${domains.join(", ")}`);
  assert.equal((await app.stubRequests()).glossary - before.glossary, 1, "用語抽出が 1 回だけ行われていません");
  assert.equal((await app.stubRequests()).domains - before.domains, 0, "分野辞書の AI が呼ばれています");

  // Saved with the domain: the dictionary holds the candidates as 電池's terms.
  await dialog.getByRole("button", { name: "辞書を保存" }).click();
  await waitFor(async () => (await api.call("GET", "/api/glossary")).length === 2 + count, "候補が辞書に保存されること", 15_000);
  const saved = (await api.call("GET", "/api/glossary")) as { source: string; domain?: string }[];
  assert.equal(saved.filter((t) => t.domain === "電池").length, 1 + count);
  assert.equal(saved.find((t) => t.source === "observer")?.domain, undefined, "共通の語に分野が付いています");
});

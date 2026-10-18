import { firstMemoContent } from "../lib/ui.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { scenario } from "../lib/app.ts";
import { REPO, waitFor } from "../lib/processes.ts";
import { openPaper, waitForLibrary } from "../lib/ui.ts";

scenario("表示設定の全項目、キー検索、多数のタグと重複名の案内", {
  tags: Array.from({ length: 20 }, (_, i) => `タグ${String(i + 1).padStart(2, "0")}`), papers: [{ file: "gradient.pdf" }],
}, async app => {
  const { page, api } = app;
  await waitForLibrary(page, ["Stochastic Gradient"]);
  assert.equal(await page.getByText("PDFを追加 → AI接続を設定 → 翻訳・解説・チャット", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "接続・設定", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "設定", exact: true });
  const nav = settings.getByRole("navigation", { name: "設定の項目", exact: true });
  await nav.getByRole("button", { name: "表示", exact: true }).click();
  const lastOption = settings.getByRole("radio", { name: "前回の状態を引き継ぐ", exact: true });
  const lastBox = (await lastOption.boundingBox())!;
  assert.ok(lastBox.y + lastBox.height < (await settings.getByRole("button", { name: "閉じる", exact: true }).boundingBox())!.y,
    "表示設定の最後の選択肢もスクロールせず操作できること");
  assert.equal(await settings.getByRole("radio").count(), 14);
  const colors = settings.locator("details").filter({ has: page.locator("summary", { hasText: "色と保存への影響" }) });
  assert.equal(await colors.getAttribute("open"), null);
  await colors.locator("summary").click();
  assert.equal(await colors.getByText(/PDFの保存には影響しません/).isVisible(), true);
  await colors.locator("summary").click();
  await page.screenshot({ path: path.join(REPO, "tmp/e2e-results/settings-appearance-compact.png") });

  await nav.getByRole("button", { name: "ショートカット", exact: true }).click();
  const search = settings.getByRole("searchbox", { name: "ショートカットを検索", exact: true });
  await search.fill("Ctrl+F");
  assert.equal(await settings.getByRole("listitem").count(), 2, "FがPDFやShiftの一部分に誤一致しないこと");
  assert.match(await settings.innerText(), /ライブラリを検索/);
  await search.fill("存在しない操作");
  await settings.getByText("一致する操作がありません。検索語を変えてください。", { exact: true }).waitFor();
  await search.fill("");
  assert.ok(await settings.getByRole("listitem").count() > 30);

  await nav.getByRole("button", { name: "論文のタグ", exact: true }).click();
  const name = settings.getByRole("textbox", { name: "新しいタグ名", exact: true });
  await name.fill("  タグ01  ");
  await settings.getByText("この名前は登録済みです。", { exact: true }).waitFor();
  assert.equal(await settings.getByRole("button", { name: "追加", exact: true }).isDisabled(), true);
  const listHeight = await settings.getByRole("button", { name: "「タグ01」を削除", exact: true }).evaluate(el => el.parentElement!.parentElement!.getBoundingClientRect().height);
  assert.ok(listHeight > 500, "20件の一覧を小さな内部スクロールに押し込めないこと");
  await name.fill("追加したタグ");
  await settings.getByRole("button", { name: "追加", exact: true }).click();
  await waitFor(async () => (await api.call("GET", "/api/tags")).includes("追加したタグ"), "タグの追加が保存されること");
  await settings.getByRole("button", { name: "「追加したタグ」を削除", exact: true }).scrollIntoViewIfNeeded();
  await app.setViewport(986, 763);
  assert.equal(await settings.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await settings.getByRole("button", { name: "閉じる", exact: true }).click();
  assert.deepEqual(app.consoleErrors.filter(e => e.startsWith("[pageerror]")), []);
});

scenario("付箋検索の解除、テンプレート挿入、OCRと指示文とバックアップの詳細", {
  papers: [{ file: "gradient.pdf" }], viewport: { width: 986, height: 763 },
}, async app => {
  const { page, api } = app;
  await waitForLibrary(page, ["Stochastic Gradient"]);
  await openPaper(page, "Stochastic Gradient");
  await page.getByRole("tab", { name: "付箋", exact: true }).click();
  const notes = page.getByRole("region", { name: "付箋一覧", exact: true });
  await notes.locator("summary", { hasText: "ほかの付け方" }).click();
  assert.equal(await notes.getByText(/右クリックや書き込みツール/).isVisible(), true);
  await notes.getByRole("combobox", { name: "付箋の原文・訳文", exact: true }).selectOption("original");
  const search = notes.getByRole("textbox", { name: "付箋を検索", exact: true });
  await search.fill("誤差");
  await notes.getByRole("button", { name: "付箋の検索語を消す", exact: true }).click();
  assert.equal(await search.inputValue(), "");
  assert.equal(await search.evaluate(el => el === document.activeElement), true);
  assert.equal(await notes.getByRole("combobox", { name: "付箋の原文・訳文", exact: true }).inputValue(), "original");
  await notes.getByRole("button", { name: "条件をクリア", exact: true }).click();
  assert.equal(await notes.getByRole("status").innerText(), "0件");
  await page.getByRole("tab", { name: "メモ", exact: true }).click();
  await page.getByRole("button", { name: "新規メモ", exact: true }).click();
  await page.getByRole("button", { name: "テンプレートを使う", exact: true }).click();
  const template = page.getByRole("dialog", { name: "テンプレートを使う", exact: true });
  const readingNote = template.getByRole("navigation", { name: "保存済みテンプレート", exact: true }).getByRole("button", { name: "読書メモ", exact: true });
  assert.match(await readingNote.getAttribute("title") ?? "", /標準テンプレート/);
  const preview = template.getByRole("region", { name: "テンプレートのプレビュー", exact: true });
  assert.ok((await preview.boundingBox())!.width > 400);
  await template.getByRole("button", { name: "この内容をメモに追加", exact: true }).click();
  await waitFor(async () => (await firstMemoContent(api, app.paperIds["gradient.pdf"])).includes("何を解決する論文"), "テンプレートがメモに保存されること");

  await page.getByRole("button", { name: "接続・設定", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "設定", exact: true });
  const nav = settings.getByRole("navigation", { name: "設定の項目", exact: true });
  await nav.getByRole("button", { name: "OCR", exact: true }).click();
  const directory = settings.locator("details").filter({ has: page.locator("summary", { hasText: "言語データの保存先" }) });
  await directory.locator("summary").waitFor();
  assert.equal(await directory.getAttribute("open"), null);
  await directory.locator("summary").click();
  assert.equal(await directory.locator("p").isVisible(), true);
  assert.match(await directory.innerText(), /tessdata/);
  assert.equal(await settings.getByRole("button", { name: "英語の言語データをダウンロード", exact: true }).isEnabled(), true);

  await nav.getByRole("button", { name: "プロンプト", exact: true }).click();
  const style = settings.locator("details").filter({ has: page.locator("summary", { hasText: "訳文スタイルの差し込みについて" }) });
  assert.equal(await style.getAttribute("open"), null);
  await style.locator("summary").click();
  assert.match(await style.innerText(), /消すとスタイルの指示は付きません/);
  assert.equal(await settings.getByText(/AIの利用枠を使います/).isVisible(), true);
  const prompt = settings.getByRole("textbox", { name: "翻訳", exact: true });
  const text = `${await prompt.inputValue()}\n読書表示の検証用の指示。`;
  await prompt.fill(text);
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await settings.waitFor({ state: "detached" });
  assert.equal((await api.call("GET", "/api/prompts")).translation, text);

  await page.getByRole("button", { name: "接続・設定", exact: true }).click();
  await nav.getByRole("button", { name: "バックアップ", exact: true }).click();
  const contents = settings.locator("details").filter({ has: page.locator("summary", { hasText: "保存する内容と対象外の設定" }) });
  assert.equal(await contents.getAttribute("open"), null);
  await contents.locator("summary").click();
  assert.equal(await contents.getByText(/CLIのパスとAPI URL/).isVisible(), true);
  assert.equal(await settings.getByText(/復元前のデータは、このPCの履歴/).isVisible(), true);
  await settings.getByRole("button", { name: "閉じる", exact: true }).click();
  assert.deepEqual(app.consoleErrors.filter(e => e.startsWith("[pageerror]")), []);
});

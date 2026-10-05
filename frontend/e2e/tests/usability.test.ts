// Native-use findings: cancellation, keyboard focus and retained context must survive a fresh launch.
import assert from "node:assert/strict";
import { scenario } from "../lib/app.ts";
import { waitFor } from "../lib/processes.ts";
import { libraryRow, openPaper, readingPlace, waitForLibrary } from "../lib/ui.ts";

scenario("検索語だけの解除、一覧のタイトル移動、ページ入力の取り消しと検索後のフォーカス", {
  tags: ["重要"],
  papers: [{ file: "gradient.pdf", tags: ["重要"] }, { file: "observer.pdf" }],
}, async ({ page, api, paperIds, consoleErrors }) => {
  await waitForLibrary(page, ["Stochastic Gradient", "Robust Observer"]);
  await page.getByRole("heading", { name: "論文を選んで、読み始めよう", exact: true }).waitFor();
  const tag = page.getByRole("region", { name: "タグで絞り込み" }).getByRole("button", { name: /重要/ });
  await tag.click();
  const librarySearch = page.getByRole("textbox", { name: "ライブラリを検索", exact: true });
  await librarySearch.fill("Gradient");
  await page.getByRole("button", { name: "検索を解除", exact: true }).click();
  await waitFor(async () => await libraryRow(page, "Robust Observer").count() === 0
    && await librarySearch.inputValue() === "", "検索語を消してもタグが保持されること");
  assert.equal(await tag.getAttribute("aria-pressed"), "true");
  await librarySearch.fill("Gradient");
  await librarySearch.press("Escape");
  assert.equal(await tag.getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "検索・絞り込みを解除", exact: true }).click();
  await waitForLibrary(page, ["Stochastic Gradient", "Robust Observer"]);

  const id = paperIds["gradient.pdf"];
  await api.call("PATCH", `/api/papers/${id}`, { first_author: "Taro Yamada" });
  const gradient = libraryRow(page, "Stochastic Gradient");
  await waitFor(async () => (await gradient.getAttribute("title"))?.includes("Taro Yamada"), "著者を含む説明が更新されること");
  assert.match(await gradient.innerText(), /^Stochastic Gradient/);
  await libraryRow(page, "Robust Observer").focus();
  await page.keyboard.press("s");
  assert.equal(await gradient.evaluate(el => el === document.activeElement), true, "一覧の表示タイトルで移動できること");
  await page.keyboard.press("Control+Shift+f");
  await waitFor(async () => await librarySearch.evaluate(el => el === document.activeElement), "ショートカットで一覧の検索欄に移ること");
  assert.match(await librarySearch.getAttribute("title") ?? "", /Ctrl\+Shift\+F/);

  await openPaper(page, "Stochastic Gradient");
  const number = page.getByRole("textbox", { name: "ページ番号", exact: true });
  await number.fill("3");
  await number.press("Enter");
  await waitFor(async () => (await readingPlace(page)).page === "3", "最終ページへの移動");
  await number.fill("999");
  await number.press("Enter");
  assert.equal(await number.inputValue(), "3", "上限超過を現在ページに正規化すること");
  await number.fill("1");
  await number.press("Escape");
  assert.equal(await number.inputValue(), "3", "取り消し時に blur が移動を確定しないこと");
  await number.fill("0");
  await number.press("Enter");
  await waitFor(async () => (await readingPlace(page)).page === "1", "下限を1ページにすること");

  await page.getByRole("button", { name: "論文内検索", exact: true }).click();
  const search = page.getByRole("textbox", { name: "論文内を検索", exact: true });
  await search.fill("Gradient");
  const result = page.getByRole("button", { name: /^p\.\d+\s/ }).first();
  await result.waitFor();
  assert.equal(await result.getAttribute("title"), await result.textContent(), "省略された結果も説明で全文を読めること");
  await page.getByRole("button", { name: "検索語を消す", exact: true }).click();
  assert.equal(await search.inputValue(), "");
  assert.equal(await search.evaluate(el => el === document.activeElement), true);
  assert.equal(await page.getByRole("button", { name: /^p\.\d+\s/ }).count(), 0);
  await search.fill("no_such_phrase_20261006");
  await page.getByText("原文に一致する語句がありません。検索語を変えてください。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("combobox", { name: "検索対象", exact: true }).inputValue(), "original");
  await search.press("Escape");
  const searchButton = page.getByRole("button", { name: "論文内検索", exact: true });
  assert.equal(await searchButton.evaluate(el => el === document.activeElement), true);
  await page.keyboard.press("Space");
  await search.waitFor();
  assert.deepEqual(consoleErrors.filter(e => e.startsWith("[pageerror]")), []);
});

scenario("メモの編集位置を保ち、長いタイトルと未分類への移動を保存する", {
  collections: ["読書会"], papers: [{ file: "gradient.pdf", collection: "読書会" }],
}, async ({ page, api, paperIds, consoleErrors }) => {
  await waitForLibrary(page, ["Stochastic Gradient"]);
  await openPaper(page, "Stochastic Gradient");
  await page.getByRole("tab", { name: "メモ", exact: true }).click();
  await page.getByRole("button", { name: "プレビュー", exact: true }).click();
  await page.getByText("メモはまだありません。「編集」で書き始めるか、テンプレートを追加してください。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const memo = page.getByRole("textbox", { name: "論文のメモ", exact: true });
  await waitFor(async () => await memo.evaluate(el => el === document.activeElement), "編集ボタンから入力欄に戻ること");
  const longNote = Array.from({ length: 80 }, (_, i) => `メモの行 ${i + 1}`).join("\n");
  await page.keyboard.insertText(longNote);
  await memo.press("Control+End");
  const before = await memo.evaluate((el: HTMLTextAreaElement) => ({ start: el.selectionStart, end: el.selectionEnd, top: el.scrollTop }));
  assert.ok(before.top > 100);
  await page.getByRole("button", { name: "プレビュー", exact: true }).click();
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await waitFor(async () => await memo.evaluate(el => el === document.activeElement), "再編集でフォーカスが戻ること");
  const after = await memo.evaluate((el: HTMLTextAreaElement) => ({ start: el.selectionStart, end: el.selectionEnd, top: el.scrollTop }));
  assert.deepEqual(after, before, "カーソルとスクロールを保つこと");
  await page.keyboard.insertText("\n最後に追記");
  const id = paperIds["gradient.pdf"];
  await waitFor(async () => (await api.call("GET", `/api/papers/${id}`)).note === `${longNote}\n最後に追記`, "編集を続けた内容が保存されること");

  await page.getByRole("button", { name: "論文情報・整理", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "論文情報・整理", exact: true });
  const title = panel.getByRole("textbox", { name: "タイトル", exact: true });
  assert.equal(await title.evaluate(el => el.tagName), "TEXTAREA");
  const text = "Stochastic Gradient Networks: A Comparative Study of Robust Adaptive Control and Experimental Limitations";
  await title.fill(text);
  await title.press("Tab");
  await waitFor(async () => (await api.call("GET", `/api/papers/${id}`)).title === text, "長いタイトルが保存されること");
  await panel.getByRole("button", { name: "未分類に戻す", exact: true }).click();
  await waitFor(async () => !(await api.call("GET", `/api/papers/${id}`)).collection_name, "未分類への移動が保存されること");
  assert.equal(await panel.getByLabel("フォルダー", { exact: true }).inputValue(), "");
  await panel.getByRole("button", { name: "閉じる", exact: true }).click();
  assert.equal(await memo.inputValue(), `${longNote}\n最後に追記`);
  assert.deepEqual(consoleErrors.filter(e => e.startsWith("[pageerror]")), []);
});

scenario("チャットの送信条件を示し、回答中の参照範囲と選択を保持する", {
  collections: ["読書会"], papers: [{ file: "gradient.pdf", collection: "読書会" }, { file: "observer.pdf" }],
}, async (app) => {
  const { page } = app;
  await waitForLibrary(page, ["Stochastic Gradient", "Robust Observer"]);
  await openPaper(page, "Stochastic Gradient");
  await page.getByRole("tab", { name: "チャット", exact: true }).click();
  const scope = page.getByRole("combobox", { name: "参照範囲", exact: true });
  const question = page.getByRole("textbox", { name: "論文への質問", exact: true });
  const send = page.getByRole("button", { name: "送信", exact: true });
  await scope.selectOption("selected");
  await question.fill("実験条件を説明してください。");
  await page.getByText("参照する論文を1件以上選ぶと送信できます。", { exact: true }).waitFor();
  assert.equal(await send.isDisabled(), true);
  const paper = page.getByRole("checkbox", { name: /Stochastic Gradient/ });
  await paper.check();
  await page.getByText("1件の論文を参照します。", { exact: true }).waitFor();
  assert.equal(await send.isEnabled(), true);
  await app.setStubDelay(20);
  await send.click();
  await waitFor(async () => await question.isDisabled(), "回答を作成中になること");
  assert.equal(await scope.isDisabled(), true);
  assert.equal(await paper.isDisabled(), true);
  assert.equal(await paper.isChecked(), true);
  await page.getByTestId("main").getByRole("button", { name: "中止", exact: true }).click();
  await waitFor(async () => await scope.isEnabled() && await question.isEnabled(), "中止後に編集に戻れること", 30_000);
  assert.equal(await scope.inputValue(), "selected");
  assert.equal(await paper.isChecked(), true);
  assert.equal(await question.inputValue(), "実験条件を説明してください。");
  await scope.selectOption("collection");
  const collection = page.getByRole("combobox", { name: "参照するフォルダー", exact: true });
  await collection.selectOption("読書会");
  await send.click();
  await waitFor(async () => await question.isDisabled(), "フォルダーを参照して回答中になること");
  assert.equal(await collection.isDisabled(), true);
  await page.getByTestId("main").getByRole("button", { name: "中止", exact: true }).click();
  await waitFor(async () => await collection.isEnabled(), "中止後にフォルダーを変更できること", 30_000);
  assert.equal(await collection.inputValue(), "読書会");
  await app.setStubDelay(0);
  assert.deepEqual(app.consoleErrors.filter(e => e.startsWith("[pageerror]")), []);
});

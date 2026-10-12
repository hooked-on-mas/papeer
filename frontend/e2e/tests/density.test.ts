// Information hidden by default must stay reachable; compact layouts must preserve reading and editing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { scenario } from "../lib/app.ts";
import { REPO, waitFor } from "../lib/processes.ts";
import { folderOfRow, libraryRow, openPaper, readingPlace, waitForLibrary } from "../lib/ui.ts";

scenario("必要時の取り消しと説明、メモのテンプレート、サマリーの読みやすい余白", {
  collections: ["読書会"], papers: [{ file: "gradient.pdf" }], viewport: { width: 986, height: 800 },
  beforeApp(dirs) {
    const [id] = fs.readdirSync(path.join(dirs.data, "papers"));
    fs.writeFileSync(path.join(dirs.data, "papers", id, "article.md"),
      "# 論文の理解\n\n目的と前提条件を整理する。\n\n## 手法\n\n勾配を用いて追従誤差を改善する。\n\n## 結果と限界\n\n条件の違いによる結果を比較する。\n");
  },
}, async (app) => {
  const { page, api, paperIds } = app;
  await waitForLibrary(page, ["Stochastic Gradient"]);
  const undo = page.getByTestId("sidebar").getByRole("button", { name: "元に戻す", exact: true });
  assert.equal(await undo.count(), 0);
  await libraryRow(page, "Stochastic Gradient").click({ button: "right" });
  await page.getByRole("menuitem", { name: "分類を変更", exact: true }).hover();
  await page.getByRole("menu").last().getByRole("menuitemcheckbox", { name: "読書会", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await waitFor(async () => await folderOfRow(page, "Stochastic Gradient") === "読書会", "移動が一覧に反映されること");
  await undo.click();
  await waitFor(async () => await folderOfRow(page, "Stochastic Gradient") === "未分類", "取り消しで未分類に戻ること");
  assert.equal(await undo.count(), 0);

  await api.call("PATCH", `/api/papers/${paperIds["gradient.pdf"]}`, { author: "Taro Yamada" });
  await openPaper(page, "Stochastic Gradient");
  assert.equal(await page.locator("h1").innerText(), "Stochastic Gradient Networks");
  await page.getByRole("tab", { name: "メモ", exact: true }).click();
  await page.getByRole("button", { name: "新規メモ", exact: true }).click();
  await page.getByRole("button", { name: "テンプレートを使う", exact: true }).click();
  const template = page.getByRole("dialog", { name: "テンプレートを使う", exact: true });
  await template.getByRole("button", { name: "この内容をメモに追加", exact: true }).click();
  await template.waitFor({ state: "detached" });
  await page.getByText(/をメモの末尾に追加しました。/).waitFor();
  const memo = page.getByRole("textbox", { name: "論文のメモ", exact: true });
  assert.ok((await memo.innerText()).includes("#"));
  const note = Array.from({ length: 30 }, (_, i) => `メモ ${i + 1}`).join("\n");
  await memo.fill(note);
  assert.ok((await memo.boundingBox())!.height >= 400, "30行のメモに十分な編集領域があること");
  await page.getByRole("button", { name: "論文情報・整理", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "論文情報・整理", exact: true });
  const arxiv = panel.getByLabel("arXiv ID", { exact: true });
  await arxiv.waitFor();
  const arxivBox = (await arxiv.boundingBox())!;
  assert.ok(arxivBox.y + arxivBox.height < 735, "通常入力欄が下端で切れないこと");
  const help = panel.locator("details").filter({ has: page.locator("summary", { hasText: "論文情報の取得について" }) });
  assert.equal(await help.getAttribute("open"), null);
  await help.locator("summary").click();
  assert.equal(await help.getByText(/論文情報は追加時にPDFから/).isVisible(), true);
  await panel.getByRole("button", { name: "閉じる", exact: true }).click();
  assert.equal(await memo.innerText(), note);
  await page.getByRole("tab", { name: "サマリー", exact: true }).click();
  const article = page.getByRole("article", { name: "論文のサマリー", exact: true });
  await article.getByRole("heading", { name: "結果と限界", exact: true }).waitFor();
  const summary = await article.evaluate(el => {
    const box = el.getBoundingClientRect();
    const pane = el.closest(".summary-page")!.parentElement!.getBoundingClientRect();
    return { top: box.top - pane.top, bottom: box.bottom, paneBottom: pane.bottom, sideways: el.scrollWidth > el.clientWidth };
  });
  assert.ok(summary.top <= 30 && summary.bottom < summary.paneBottom, "短い3節を不要なスクロールなしで読めること");
  assert.equal(summary.sideways, false);
  await page.screenshot({ path: path.join(REPO, "tmp/e2e-results/density-summary.png") });
  assert.deepEqual(app.consoleErrors.filter(e => e.startsWith("[pageerror]")), []);
});

scenario("チャットの説明と使用量を必要時に開き、論文名から原文とPDFを確認する", {
  papers: [{ file: "gradient.pdf" }, { file: "observer.pdf" }, { file: "twocol.pdf" }],
}, async (app) => {
  const { page } = app;
  await waitForLibrary(page, ["Stochastic Gradient", "Robust Observer", "Adaptive Tracking"]);
  await openPaper(page, "Stochastic Gradient");
  await page.getByRole("tab", { name: "チャット", exact: true }).click();
  const attachmentHelp = page.locator("details").filter({ has: page.locator("summary", { hasText: "PDFの箇所を添えるには" }) });
  assert.equal(await attachmentHelp.getAttribute("open"), null);
  await attachmentHelp.locator("summary").click();
  assert.equal(await attachmentHelp.getByText(/PDFで文章を選び/).isVisible(), true);
  await attachmentHelp.locator("summary").click();
  assert.equal(await page.getByText("この接続先はWeb検索に対応していません。設定のAI接続を変更してください。", { exact: true }).count(), 0);
  await page.getByRole("combobox", { name: "参照範囲", exact: true }).selectOption("selected");
  for (const name of ["Stochastic Gradient", "Robust Observer", "Adaptive Tracking"]) await page.getByRole("checkbox", { name: new RegExp(name) }).check();
  await page.locator("summary", { hasText: "論文の参照ページ・検索条件" }).click();
  await page.getByLabel("検索の補助語", { exact: true }).fill("gradient observer tracking");
  await page.locator("summary", { hasText: "論文の参照ページ・検索条件" }).click();
  await page.getByRole("textbox", { name: "論文への質問", exact: true }).fill("gradient observer tracking の実験条件と限界を比較してください。");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  const evidence = page.locator("details").filter({ has: page.locator("summary", { hasText: /参照ページの原文を確認/ }) });
  await evidence.locator("summary").waitFor({ timeout: 45_000 });
  await evidence.locator("summary").click();
  const excerpts = evidence.getByRole("button", { name: /のp\.\d+の原文抜粋を見る/ });
  await waitFor(async () => await excerpts.count() === 10, "10個の原文抜粋が論文名で読めること");
  assert.equal((await evidence.innerText()).includes(app.paperIds["gradient.pdf"].slice(0, 8)), false);
  const group = evidence.getByRole("region", { name: "Adaptive Tracking Control with Two Columnsの参照ページ", exact: true });
  const boxes = await group.getByRole("button").evaluateAll(elements => elements.map(el => el.getBoundingClientRect().top));
  assert.ok(new Set(boxes).size < boxes.length, "広い画面ではページ項目が横に並ぶこと");
  const usage = page.locator("details").filter({ has: page.locator("summary", { hasText: "AIの使用量" }) });
  assert.equal(await usage.getAttribute("open"), null);
  await usage.locator("summary").click();
  assert.equal(await usage.locator("p").isVisible(), true);
  assert.match(await usage.innerText(), /入力/);
  await page.getByRole("button", { name: "AI・接続情報", exact: true }).click();
  await page.getByRole("heading", { name: "AI・接続情報", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  const excerpt = group.getByRole("button", { name: /のp\.\d+の原文抜粋を見る/ }).first();
  const pageNumber = Number(/のp\.(\d+)/.exec((await excerpt.getAttribute("aria-label"))!)![1]);
  await excerpt.click();
  await waitFor(async () => (await group.innerText()).includes("Transformer"), "原文のテキストが読み込まれること");
  await page.screenshot({ path: path.join(REPO, "tmp/e2e-results/density-citations.png") });
  await group.getByRole("button", { name: "PDFでページ全体を確認", exact: true }).click();
  await page.getByRole("heading", { name: "Adaptive Tracking Control with Two Columns", exact: true }).waitFor();
  await waitFor(async () => (await readingPlace(page)).page === String(pageNumber), "正しい論文の参照ページを開くこと");
  assert.deepEqual(app.consoleErrors.filter(e => e.startsWith("[pageerror]")), []);
});

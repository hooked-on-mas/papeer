import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright-core";
import { scenario } from "../lib/app.ts";
import { waitFor } from "../lib/processes.ts";
import { libraryRow, libraryRows, openPaper, readingPlace, toggleSidePanel, waitForLibrary } from "../lib/ui.ts";

/** A document of the scenarios: the visible text is `body`; `head` and `tail` hold what a reader never sees. */
const htmlPage = (body: string, head = "", tail = "") =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8">${head}</head><body>${body}${tail}</body></html>`;

/** The side panels the toolbar offers for the open item (サマリー・チャット・メモ), read from its panel menu. */
async function offeredPanels(page: Page): Promise<string[]> {
  const select = page.getByRole("button", { name: "右パネルを選択", exact: true });
  const trigger = await select.count() && await select.first().isVisible()
    ? select.first() : page.getByRole("button", { name: "その他の表示・操作", exact: true });
  await trigger.click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  const labels = await menu.getByRole("menuitemcheckbox").evaluateAll(items =>
    items.map(item => (item.getAttribute("aria-label") ?? item.textContent ?? "").trim()));
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  return labels.map(label => /^(サマリー|チャット|メモ)を右に表示/.exec(label)?.[1]).filter((label): label is string => !!label);
}

const SEARCH_ERROR = "検索できませんでした。";

scenario("HTML資料の本文だけをライブラリ検索で見つけ、開く資料・件数・更新を実画面で確かめる", {
  papers: [{ file: "gradient.pdf" }, { file: "observer.pdf" }], viewport: { width: 1366, height: 900 }, timeout: 240_000,
}, async app => {
  const { page, api } = app, owner = app.paperIds["gradient.pdf"];
  const docs = `/api/papers/${owner}/documents`, attachments = `/api/papers/${owner}/attachments`;
  const screenshots = path.join(os.tmpdir(), "paper-desk-e-visual");
  fs.mkdirSync(screenshots, { recursive: true });
  const startedAt = Date.now();
  const mark = (step: string) => console.log(`[htmlBody +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${step}`);

  // The library-search requests the page makes, by their query: a result is only "none" once its answer has come.
  const answered: string[] = [];
  page.on("response", response => {
    try {
      const url = new URL(response.url());
      if (url.pathname === "/api/library-search" && response.ok()) answered.push(url.searchParams.get("q") ?? "");
    } catch { /* not a URL the page can parse */ }
  });
  const search = page.getByRole("textbox", { name: "ライブラリを検索", exact: true });
  const hits = page.getByRole("button").filter({ hasText: "資料「" });
  const nothing = page.getByText("見つかりませんでした。検索語や絞り込みを変更してください。", { exact: true });
  /** Types the words from an empty box (so that the same words are asked for again) and waits for their answer. */
  const searchFor = async (query: string) => {
    await search.fill("");
    await libraryRow(page, "Stochastic Gradient").waitFor();
    const before = answered.filter(q => q === query).length;
    await search.fill(query);
    await waitFor(() => answered.filter(q => q === query).length > before, `「${query}」の検索結果が返ること`, 15_000, 100);
  };
  const titles = async () => (await libraryRows(page)).filter(row => /Stochastic Gradient|Robust Observer/.test(row.text)).length;

  mark("start");
  await waitForLibrary(page, ["Stochastic Gradient", "Robust Observer"]);
  assert.equal(await titles(), 2);
  const paperCount = (await api.call("GET", "/api/papers")).length;
  await openPaper(page, "Stochastic Gradient");

  // Visible static text (Japanese, a named and a numeric character reference) and, apart from it, a script, a style
  // and what a reader never sees: none of the latter may be found.
  const first = await api.call("POST", docs, {
    title: "観測資料アルファ.html",
    content: htmlPage("<h1>観測計画の概要</h1><p>琥珀の天秤&amp;銀の歯車、ミズ&#x30CA;ラ観測は静かな朝に行う。</p>",
      "<style>/* 紺碧の影 */ body{font-family:sans-serif}</style>",
      "<script>window.hidden = '朱鷺の羽根';</script>"),
  });
  const second = await api.call("POST", docs, {
    title: "観測資料ベータ.html",
    content: htmlPage("<h1>第二資料の見出し</h1><p>瑠璃の羅針盤と、星屑の図書館の貸出簿。</p>"),
  });
  await api.call("POST", attachments, { title: "読書.md", content: "読書メモ本文" });
  await libraryRow(page, "Stochastic Gradient").getByLabel("持ち物 3件", { exact: true }).waitFor();
  assert.equal((await api.call("GET", "/api/papers")).length, paperCount, "資料を足しても一覧の項目は増えないこと");
  assert.equal(await titles(), 2);
  mark("documents created");

  // A character reference is found as the character it stands for, and the hit says which document and shows
  // the text around the match, with the character references resolved.
  await searchFor("ミズナラ観測");
  await hits.first().waitFor();
  assert.equal(await hits.count(), 1);
  const alpha = await hits.first().innerText();
  assert.ok(alpha.includes("Stochastic Gradient"), alpha);
  assert.ok(alpha.includes("資料「観測資料アルファ.html」"), alpha);
  assert.ok(alpha.includes("ミズナラ観測"), alpha);
  assert.ok(!alpha.includes("&#x30CA;") && !alpha.includes("&amp;"), alpha);
  await searchFor("天秤&銀の歯車");
  await hits.first().waitFor();
  assert.equal(await hits.count(), 1);
  assert.ok((await hits.first().innerText()).includes("天秤&銀の歯車"));
  mark("static text found");

  // What the document only carries (a script, a style) is not its text.
  for (const hidden of ["朱鷺の羽根", "紺碧の影"]) {
    await searchFor(hidden);
    await nothing.waitFor();
    await waitFor(async () => (await hits.count()) === 0 && (await page.getByText("検索中…").count()) === 0,
      `「${hidden}」に一致する資料が表示されないこと`, 10_000, 100);
    assert.equal(await page.getByText(SEARCH_ERROR).count(), 0);
    const result = await api.call("GET", `/api/library-search?q=${encodeURIComponent(hidden)}`);
    assert.deepEqual(result.results, [], `「${hidden}」は資料の本文ではないこと`);
  }
  mark("script and style not searched");

  // The hit of the second document opens that document, not the first one the pane would show by default.
  await searchFor("星屑の図書館");
  await hits.first().waitFor();
  assert.equal(await hits.count(), 1);
  const beta = await hits.first().innerText();
  assert.ok(beta.includes("資料「観測資料ベータ.html」") && beta.includes("星屑の図書館"), beta);
  await page.screenshot({ path: path.join(screenshots, "04-html-body-search.png") });
  await hits.first().click();
  const selector = page.getByRole("combobox", { name: "資料を選択", exact: true });
  const frame = (title: string) => page.frameLocator(`iframe[title="${title}"]`);
  await frame("観測資料ベータ.html").getByRole("heading", { name: "第二資料の見出し", exact: true }).waitFor();
  assert.equal(await selector.inputValue(), second.id);
  assert.equal(await page.locator("[data-html-owner] iframe").count(), 1);
  await frame("観測資料ベータ.html").getByText("星屑の図書館", { exact: false }).waitFor();
  // The paper itself is still the open item: its PDF is on the left and its row is the one in the library.
  await page.locator("[data-page-number] canvas").first().waitFor({ timeout: 30_000 });
  mark("hit opened the document");

  // The search leaves the library as it was.
  await search.fill("");
  await libraryRow(page, "Stochastic Gradient").waitFor();
  assert.equal(await titles(), 2);
  assert.equal((await api.call("GET", "/api/papers")).length, paperCount);

  // Renamed, added and deleted documents are what the next search finds.
  await api.call("PATCH", `${attachments}/${second.id}`, { title: "観測資料ベータ改.html" });
  await searchFor("星屑の図書館");
  await waitFor(async () => (await hits.count()) === 1 && (await hits.first().innerText()).includes("資料「観測資料ベータ改.html」"),
    "改名した資料の名前で見つかること", 15_000, 200);
  const third = await api.call("POST", docs, {
    title: "観測資料ガンマ.html", content: htmlPage("<p>翡翠の砂時計は北の棚にある。</p>"),
  });
  await searchFor("翡翠の砂時計");
  await waitFor(async () => (await hits.count()) === 1 && (await hits.first().innerText()).includes("資料「観測資料ガンマ.html」"),
    "追加した資料が見つかること", 15_000, 200);
  await api.call("DELETE", `${attachments}/${third.id}`);
  await searchFor("翡翠の砂時計");
  await nothing.waitFor({ timeout: 15_000 });
  await waitFor(async () => (await hits.count()) === 0, "削除した資料が見つからないこと", 15_000, 200);
  assert.deepEqual((await api.call("GET", `/api/library-search?q=${encodeURIComponent("翡翠の砂時計")}`)).results, []);
  // What was not touched is still found.
  await searchFor("ミズナラ観測");
  await waitFor(async () => (await hits.count()) === 1, "ほかの資料は変わらず見つかること", 15_000, 200);
  // Its hit opens it (not the document opened before, nor the first one by default).
  await hits.first().click();
  await frame("観測資料アルファ.html").getByRole("heading", { name: "観測計画の概要", exact: true }).waitFor();
  assert.equal(await selector.inputValue(), first.id);
  assert.equal(await page.locator("[data-html-owner] iframe").count(), 1);
  mark("rename, add and delete reflected");

  // The memo of the same paper is what it was.
  await search.fill("");
  await libraryRow(page, "Stochastic Gradient").waitFor();
  await page.getByRole("button", { name: "メモ", exact: true }).click();
  const memo = page.getByRole("textbox", { name: "論文のメモ", exact: true });
  await memo.waitFor();
  assert.ok((await memo.innerText()).includes("読書メモ本文"));
  mark("done");
});

scenario("文字のない独立ノートのHTML資料を本文として質問し、出典から開き、資料が無くなるとチャットが閉じる", {
  papers: [{ file: "gradient.pdf" }], viewport: { width: 1366, height: 900 }, timeout: 240_000,
}, async app => {
  const { page, api } = app, paper = app.paperIds["gradient.pdf"];
  const screenshots = path.join(os.tmpdir(), "paper-desk-e-visual");
  fs.mkdirSync(screenshots, { recursive: true });
  const startedAt = Date.now();
  const mark = (step: string) => console.log(`[htmlBody +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${step}`);
  const frame = (title: string) => page.frameLocator(`iframe[title="${title}"]`);
  const selector = page.getByRole("combobox", { name: "資料を選択", exact: true });
  const chat = page.locator('aside[data-side-panel="chat"]');
  const documentCount = async (id: string) =>
    (await api.call("GET", "/api/notebooks")).find((row: { id: string }) => row.id === id)?.html_document_count ?? 0;
  const openItem = async (id: string, title: string) => {
    await page.locator(`[data-tree-key="paper:${id}"]`).click();
    await page.locator("h1", { hasText: title }).waitFor();
  };

  await waitForLibrary(page, ["Stochastic Gradient"]);
  // Documents (and a memo) of the PDF paper too: what it shows must stay what it was.
  await api.call("POST", `/api/papers/${paper}/documents`, { title: "別資料ひとつめ.html", content: htmlPage("<h1>ひとつめの見出し</h1>") });
  const otherSecond = await api.call("POST", `/api/papers/${paper}/documents`, { title: "別資料ふたつめ.html", content: htmlPage("<h1>ふたつめの見出し</h1>") });
  await api.call("POST", `/api/papers/${paper}/attachments`, { title: "読書.md", content: "PDFのメモ本文" });
  const otherFirstId = (await api.call("GET", `/api/papers/${paper}/attachments`)).find((row: { title: string }) => row.title === "別資料ひとつめ.html").id;

  // An independent notebook with no text at all (never read by OCR): no chat, no summary, until it holds a document.
  const title = "文字のない資料ノート";
  const notebook = await api.call("POST", "/api/notebooks", { title });
  const id = notebook.id as string;
  await page.locator(`[data-tree-key="paper:${id}"]`).waitFor();
  await openItem(id, title);
  assert.deepEqual(await offeredPanels(page), ["メモ"]);
  assert.equal(await documentCount(id), 0);
  mark("empty notebook: memo only");

  const wordA = "蒼穹の羅針儀", wordB = "夜光の砂時計";
  const a = await api.call("POST", `/api/papers/${id}/documents`, {
    title: "質問資料アルファ.html", content: htmlPage(`<h1>航海記録</h1><p>${wordA}は嵐の夜にも北を指した。</p>`, "<style>.x{color:red}</style>"),
  });
  const b = await api.call("POST", `/api/papers/${id}/documents`, {
    title: "質問資料ベータ.html", content: htmlPage(`<h1>倉庫目録</h1><p>${wordB}は二番棚に置かれている。</p>`),
  });
  await waitFor(async () => (await offeredPanels(page)).includes("チャット"), "資料のあるノートでチャットが選べること", 20_000, 500);
  const panels = await offeredPanels(page);
  assert.deepEqual(panels.sort(), ["チャット", "メモ"], "サマリーは文字のないノートでは選べないままであること");
  assert.equal(await documentCount(id), 2);
  mark("notebook with documents: chat offered");

  // Ask about a word that only the first document has.
  await toggleSidePanel(page, "チャット");
  await chat.waitFor();
  const question = chat.getByRole("textbox", { name: "論文への質問", exact: true });
  await question.waitFor();
  await chat.getByRole("button", { name: "送信", exact: true }).waitFor();
  await chat.getByText("参照範囲", { exact: false }).first().waitFor();
  assert.equal(await page.locator('aside[data-side-panel="summary"]').count(), 0);
  const requestsBefore = (await app.stubRequests()).other;
  const text = `「${wordA}」について、資料に何と書かれているか教えてください。`;
  await question.fill(text);
  await chat.getByRole("button", { name: "送信", exact: true }).click();
  const messages = await waitFor(async () => {
    const rows = await api.call("GET", `/api/papers/${id}/messages`);
    return rows.length >= 2 ? rows : undefined;
  }, "資料のノートへの質問に回答が付くこと", 90_000, 500);
  assert.equal(messages[0].role, "user");
  assert.ok(String(messages[0].content).includes(wordA));
  assert.equal(messages[1].role, "assistant");
  assert.ok((await app.stubRequests()).other > requestsBefore, "AI へ質問が送られたこと");
  // The source footer is the service's own: it names the documents the answer was given, whatever the stub said.
  const answer = String(messages[1].content);
  assert.ok(answer.includes(`papeer://${id}/attachment/${a.id}`), answer);
  assert.ok(answer.includes(`papeer://${id}/attachment/${b.id}`), answer);
  assert.ok(!answer.includes("参照未確認"), answer);
  const sourceA = chat.getByRole("button", { name: "資料「質問資料アルファ.html」", exact: true });
  const sourceB = chat.getByRole("button", { name: "資料「質問資料ベータ.html」", exact: true });
  await sourceA.waitFor();
  await sourceB.waitFor();
  await chat.getByText(/^回答 ·/).waitFor();
  await page.screenshot({ path: path.join(screenshots, "05-html-notebook-chat.png") });
  assert.deepEqual((await offeredPanels(page)).sort(), ["チャット", "メモ"]);
  mark("answered with document sources");

  // The source button opens that document in the right panel.
  await sourceA.click();
  await frame("質問資料アルファ.html").getByRole("heading", { name: "航海記録", exact: true }).waitFor();
  assert.equal(await selector.inputValue(), a.id);
  assert.equal(await page.locator("[data-html-owner] iframe").count(), 1);
  assert.equal(await chat.count(), 0);
  mark("source opened its document");

  // The answer remembers the source; the document is deleted while another one remains: the old button must not
  // show the other document in its place.
  await toggleSidePanel(page, "チャット");
  await sourceA.waitFor();
  await api.call("DELETE", `/api/papers/${id}/attachments/${a.id}`);
  await waitFor(async () => (await api.call("GET", `/api/papers/${id}/attachments`)).every((row: { id: string }) => row.id !== a.id),
    "資料Aが削除されること", 10_000, 200);
  await waitFor(async () => (await documentCount(id)) === 1, "資料の件数が1件になること", 15_000, 200);
  assert.deepEqual((await offeredPanels(page)).sort(), ["チャット", "メモ"], "資料が残るかぎりチャットは選べること");
  await sourceA.click();
  await page.getByText("資料が見つかりません").first().waitFor({ timeout: 15_000 });
  await waitFor(async () => (await page.locator("[data-html-owner] iframe").count()) === 0,
    "削除された資料の出典を開いても別の資料を表示しないこと", 10_000, 200);
  assert.equal(await page.locator('iframe[title="質問資料ベータ.html"]').count(), 0);
  mark("deleted source: not found, no other document shown");

  // Choosing the remaining document explicitly shows it.
  await selector.selectOption(b.id);
  await frame("質問資料ベータ.html").getByRole("heading", { name: "倉庫目録", exact: true }).waitFor();
  assert.equal(await page.getByText("資料が見つかりません").count(), 0);
  assert.equal(await page.locator("[data-html-owner] iframe").count(), 1);

  // The last document goes while the chat is open: the chat is no longer offered and its pane closes.
  await toggleSidePanel(page, "チャット");
  await chat.waitFor();
  await api.call("DELETE", `/api/papers/${id}/attachments/${b.id}`);
  await waitFor(async () => (await documentCount(id)) === 0, "資料の件数が0件になること", 15_000, 200);
  await chat.waitFor({ state: "detached", timeout: 15_000 });
  assert.deepEqual(await offeredPanels(page), ["メモ"], "資料が無くなったノートではチャットもサマリーも選べないこと");
  mark("last document deleted: chat closed");

  // The PDF paper keeps all of its panels, and its memo and first document are what they were.
  await openItem(paper, "Stochastic Gradient");
  await page.locator("[data-page-number] canvas").first().waitFor({ timeout: 30_000 });
  await chat.waitFor();
  assert.deepEqual((await offeredPanels(page)).sort(), ["サマリー", "チャット", "メモ"]);
  await toggleSidePanel(page, "メモ");
  await page.getByRole("button", { name: "メモ", exact: true }).click();
  const memo = page.getByRole("textbox", { name: "論文のメモ", exact: true });
  await memo.waitFor();
  assert.ok((await memo.innerText()).includes("PDFのメモ本文"));
  // Never chosen: the first document of its owner is shown.
  await page.getByRole("button", { name: "資料", exact: true }).click();
  await frame("別資料ひとつめ.html").getByRole("heading", { name: "ひとつめの見出し", exact: true }).waitFor();
  assert.equal(await selector.inputValue(), otherFirstId);
  assert.notEqual(otherFirstId, otherSecond.id);
  assert.equal(await page.locator("[data-html-owner] iframe").count(), 1);

  // And back at the notebook: still no chat.
  await openItem(id, title);
  assert.deepEqual(await offeredPanels(page), ["メモ"]);
  mark("done");
});

scenario("大きく開いたHTML資料から、同じ論文のPDFページ引用とPDF本文の検索結果でPDFの閲覧に戻り、資料の引用はその資料を開く", {
  papers: [{ file: "gradient.pdf" }], viewport: { width: 1366, height: 900 }, timeout: 240_000,
}, async app => {
  const { page, api } = app, owner = app.paperIds["gradient.pdf"];
  const startedAt = Date.now();
  const mark = (step: string) => console.log(`[htmlBody +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${step}`);
  const frame = (title: string) => page.frameLocator(`iframe[title="${title}"]`);
  const documentTitle = "引用元の資料.html";
  const heading = "拡大して読む見出し";
  const canvases = page.locator("[data-page-number] canvas");
  const documentButton = page.getByRole("button", { name: "資料", exact: true });
  const back = page.getByRole("button", { name: "右パネルに戻す", exact: true });
  const search = page.getByRole("textbox", { name: "ライブラリを検索", exact: true });

  await waitForLibrary(page, ["Stochastic Gradient"]);
  const document = await api.call("POST", `/api/papers/${owner}/documents`, { title: documentTitle, content: htmlPage(`<h1>${heading}</h1><p>引用の確認用の本文。</p>`) });
  await openPaper(page, "Stochastic Gradient");

  /** Opens the paper's documents in the right panel and then large, in place of the PDF. */
  const enlarge = async () => {
    if (!(await documentButton.count() && await documentButton.first().isVisible())) await toggleSidePanel(page, "メモ");
    await documentButton.first().click();
    await frame(documentTitle).getByRole("heading", { name: heading, exact: true }).waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "大きく開く", exact: true }).click();
    await back.waitFor();
    await waitFor(async () => (await page.locator("[data-page-number]").count()) === 0, "大きく開くとPDFの閲覧が置き換わること", 10_000, 100);
    await frame(documentTitle).getByRole("heading", { name: heading, exact: true }).waitFor();
  };
  /** The PDF is what is read again: the document is no longer large, and the page field says where. */
  const readingPdfAt = async (pageNumber: string, what: string) => {
    await canvases.first().waitFor({ timeout: 30_000 });
    await waitFor(async () => (await back.count()) === 0 && (await page.locator("iframe").count()) === 0
      && (await readingPlace(page)).page === pageNumber, `${what}でPDFの${pageNumber}ページが開くこと`, 15_000, 200);
  };

  await enlarge();
  assert.equal(await selectorValue(page), document.id);
  mark("document enlarged");

  // Arrow keys are available in the app even while the PDF reader is replaced by a large document.
  await back.focus();
  await page.keyboard.press("ArrowRight");
  await readingPdfAt("2", "次ページへの操作");
  await enlarge();
  await back.focus();
  await page.keyboard.press("ArrowLeft");
  await readingPdfAt("1", "前ページへの操作");
  await enlarge();
  await back.focus();
  await page.keyboard.press("ArrowLeft");
  await readingPdfAt("1", "先頭ページをもう一度指定する操作");
  await enlarge();
  mark("page turns returned to the PDF, including the current edge page");

  // A page citation of the answer, asked for in the chat tab while the document is large.
  await page.getByRole("tab", { name: "チャット", exact: true }).click();
  await page.getByText("参照範囲", { exact: false }).first().waitFor();
  await page.locator("summary", { hasText: "論文の参照ページ・検索条件" }).click();
  await page.getByLabel("この論文の追加ページ", { exact: true }).fill("3");
  await page.getByRole("textbox", { name: "論文への質問", exact: true }).fill("3ページの内容を確認してください。");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  const messages = await waitFor(async () => {
    const rows = await api.call("GET", `/api/papers/${owner}/messages`);
    return rows.length >= 2 ? rows : undefined;
  }, "質問に回答が付くこと", 90_000, 500);
  assert.ok(String(messages[1].content).includes(`papeer://${owner}/3`), String(messages[1].content));
  const citation = page.getByRole("button", { name: "原文の3ページを開く", exact: true }).first();
  await citation.waitFor({ timeout: 15_000 });
  await citation.click();
  await readingPdfAt("3", "同じ論文のページ引用");
  assert.equal((await readingPlace(page)).page, "3");
  mark("page citation returned to the PDF at the cited page");

  // The document citation of the same answer opens exactly that document, beside the PDF.
  await page.getByRole("tab", { name: "チャット", exact: true }).click();
  await page.getByRole("button", { name: `資料「${documentTitle}」`, exact: true }).first().click();
  await frame(documentTitle).getByRole("heading", { name: heading, exact: true }).waitFor({ timeout: 20_000 });
  assert.equal(await selectorValue(page), document.id);
  await canvases.first().waitFor({ timeout: 30_000 });
  assert.equal(await back.count(), 0);
  mark("document citation opened that document");

  // A hit in the PDF's own text, from the library search, also returns to the PDF at the hit's page.
  await enlarge();
  await search.fill("gradient");
  const hit = page.getByRole("button").filter({ has: page.getByText(/^原文 p\.[12]$/) }).first();
  await hit.waitFor({ timeout: 20_000 });
  const hitPage = /原文 p\.(\d+)/.exec(await hit.innerText())![1];
  await hit.click();
  await readingPdfAt(hitPage, "PDF本文の検索結果");
  mark("search hit returned to the PDF");
  // Wry injects its plugin initializer into the isolated frame as well; its denied bridge produces
  // this known error. Other uncaught errors still fail the scenario (isolation is tested separately).
  assert.deepEqual(app.consoleErrors.filter(e => e.startsWith("[pageerror]")
    && e !== "[pageerror] Cannot read properties of undefined (reading 'plugins')"), []);
});

/** The document the 資料 pane has chosen, as its selector shows it. */
async function selectorValue(page: Page): Promise<string> {
  return page.getByRole("combobox", { name: "資料を選択", exact: true }).inputValue();
}

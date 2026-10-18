// 付箋: 作成・編集の「確定」でダイアログがすぐ閉じ、保存される（T37 の修正）
import assert from "node:assert/strict";
import { scenario, type App } from "../lib/app.ts";
import { waitFor } from "../lib/processes.ts";
import { armClickTimer, clickTimings, openPaper, waitForLibrary } from "../lib/ui.ts";

/**
 * From the click on 確定 to the dialog's removal, in the page's own time (armClickTimer): the dialog closes
 * as soon as the note is saved (some 150 ms here). Before the fix it stayed open until the library had
 * been read again as well.
 */
const CLOSES_WITHIN_MS = 1000;

async function confirmAndTime(app: App, label: string): Promise<void> {
  const dialog = app.page.getByRole("dialog");
  await armClickTimer(app.page, "dialog closed");
  await dialog.getByRole("button", { name: "確定" }).click();
  await dialog.waitFor({ state: "detached", timeout: 5_000 });
  const { afterClick } = await clickTimings(app.page);
  assert.ok(afterClick !== null, `${label}のダイアログが閉じた時刻を測れませんでした`);
  assert.ok(afterClick < CLOSES_WITHIN_MS, `${label}のダイアログが閉じるまで ${Math.round(afterClick)} ms かかりました`);
}

scenario("付箋を作成・編集すると、確定でダイアログがすぐ閉じる", {
  papers: [{ file: "twocol.pdf" }],
}, async (app) => {
  const { page, api } = app;
  const id = app.paperIds["twocol.pdf"];
  await waitForLibrary(page, ["Adaptive Tracking"]);
  await openPaper(page, "Adaptive Tracking");

  // Select two lines of the first page's text: the selection toolbar offers 付箋.
  const lines = await page.evaluate(() => [...document.querySelectorAll('[data-page-number="1"] .textLayer span')]
    .filter((span) => (span.textContent ?? "").length > 30).slice(3, 5).map((span) => {
      const r = span.getBoundingClientRect();
      return { left: r.left, right: r.right, middle: (r.top + r.bottom) / 2 };
    }));
  assert.equal(lines.length, 2, "選択できる本文の行が見つかりません");
  await page.mouse.move(lines[0].left + 3, lines[0].middle);
  await page.mouse.down();
  await page.mouse.move(lines[1].right - 20, lines[1].middle, { steps: 8 });
  await page.mouse.up();
  await page.locator("[data-selection-toolbar]").getByRole("button", { name: "付箋" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByText("付箋を貼る").waitFor();
  await dialog.getByLabel("付箋のメモ").fill("E2E の付箋");
  await confirmAndTime(app, "作成");
  const marker = page.locator("button[data-sticky-note]");
  await waitFor(async () => (await marker.getAttribute("aria-label")) === "付箋：重要 E2E の付箋", "付箋の印が出ること", 10_000);

  await marker.dblclick();
  await dialog.getByText("付箋を編集").waitFor();
  await dialog.getByLabel("付箋のメモ").fill("E2E の付箋（編集済み）");
  await confirmAndTime(app, "編集");
  await waitFor(async () => (await marker.getAttribute("aria-label")) === "付箋：重要 E2E の付箋（編集済み）", "付箋の印が変わること", 10_000);

  const notes = await api.call("GET", `/api/papers/${id}/sticky-notes`);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].note, "E2E の付箋（編集済み）");
  assert.equal(notes[0].page, 1);
});

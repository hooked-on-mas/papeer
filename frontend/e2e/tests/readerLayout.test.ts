// PDF の表示: 狭い窓で右パネルを開いてもページの右が欠けない（ui-fixes の 1）、開け閉めで読む位置を保つ（ui-fixes の 2）
import assert from "node:assert/strict";
import { scenario } from "../lib/app.ts";
import { waitFor } from "../lib/processes.ts";
import { openPaper, pageFits, readingPlace, toggleSidePanel, waitForLibrary } from "../lib/ui.ts";

scenario("986px の窓で右パネルを開いても、PDF の右が欠けない", {
  papers: [{ file: "twocol.pdf" }],
  viewport: { width: 986, height: 763 },
}, async (app) => {
  const { page } = app;
  await waitForLibrary(page, ["Adaptive Tracking"]);
  await openPaper(page, "Adaptive Tracking");
  const clipped = async () => (await pageFits(page)).filter((p) => p.pageRight > p.paneRight + 1 && !p.sideways);
  await waitFor(async () => (await clipped()).length === 0, "パネルを開く前にページが枠に収まること", 10_000);

  const before = (await pageFits(page))[0];
  await toggleSidePanel(page, "メモ");
  await page.getByRole("button", { name: "新規メモ", exact: true }).waitFor();
  // The page is laid out again at the narrower width (after a short wait for the drag to settle).
  await waitFor(async () => {
    const [first] = await pageFits(page);
    return first && first.paneRight < before.paneRight - 50;
  }, "PDF の枠が狭くなること", 10_000);
  await waitFor(async () => (await clipped()).length === 0,
    async () => `右が欠けたページがあります: ${JSON.stringify(await clipped())}`, 10_000);
});

scenario("拡大表示で右パネルを開け閉めしても、ページ内の読む位置が保たれる", {
  papers: [{ file: "twocol.pdf" }],
}, async (app) => {
  const { page } = app;
  await waitForLibrary(page, ["Adaptive Tracking"]);
  await openPaper(page, "Adaptive Tracking");
  await page.locator('select[aria-label="表示倍率"]').selectOption("2");
  await page.getByLabel("ページ番号").fill("3");
  await page.keyboard.press("Enter");
  await page.locator('[data-page-number="3"] canvas').waitFor();
  await waitFor(async () => (await readingPlace(page)).page === "3", "3 ページに移ること");
  const pane = await page.locator('[data-page-number="3"]').boundingBox();
  assert.ok(pane);
  await page.mouse.move(pane.x + pane.width / 2, pane.y + 200);
  await page.mouse.wheel(0, 200);
  const start = await waitFor(async () => {
    const place = await readingPlace(page);
    return place.y > 0.05 ? place : undefined;
  }, "ページの途中までスクロールすること");

  for (const step of ["開く", "閉じる"]) {
    await toggleSidePanel(page, "メモ");
    // The pane changes width, the page is redrawn: wait for the place to settle, then compare.
    let last = await readingPlace(page);
    await waitFor(async () => {
      const now = await readingPlace(page);
      const same = Math.abs(now.scrollTop - last.scrollTop) < 1;
      last = now;
      return same ? now : undefined;
    }, "スクロール位置が落ち着くこと", 5_000, 400);
    await waitFor(async () => {
      const now = await readingPlace(page);
      return now.page === "3" && Math.abs(now.y - start.y) < 0.02;
    }, async () => `右パネルを${step}と読む位置が変わりました（前 ${start.y.toFixed(3)} → 後 ${(await readingPlace(page)).y.toFixed(3)}）`, 2_000);
  }
});

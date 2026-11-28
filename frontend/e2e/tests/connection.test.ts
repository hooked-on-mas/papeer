// sidecar が止まったとき: 同期の失敗を知らせず（ui-fixes の 3）、接続切れのバナーが題名に重ならない（ui-fixes の 4）
import assert from "node:assert/strict";
import { scenario } from "../lib/app.ts";
import { openPaper, toastTexts, waitForLibrary } from "../lib/ui.ts";

const BANNER = "アプリの処理部（sidecar）との接続が切れました";

scenario("sidecar を止めても同期の失敗が出ず、接続切れのバナーは題名に重ならない", {
  papers: [{ file: "observer.pdf" }],
}, async (app) => {
  const { page } = app;
  await waitForLibrary(page, ["Robust Observer"]);
  await openPaper(page, "Robust Observer");

  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("h1", { hasText: "Robust Observer" }).waitFor({ timeout: 30_000 });
  await app.stopSidecar();

  const banner = page.getByRole("status").filter({ hasText: BANNER });
  await banner.waitFor({ timeout: 15_000 });
  assert.doesNotMatch(await toastTexts(page), /同期/);

  // The banner has its own room above the app: it does not cover the paper's title.
  const bannerBox = await banner.boundingBox();
  // The header's title (the paper's, or the start page's once the paper can no longer be read).
  const titleBox = await page.locator("h1").first().boundingBox();
  assert.ok(bannerBox && titleBox);
  assert.ok(bannerBox.y + bannerBox.height <= titleBox.y + 0.5,
    `バナー（${bannerBox.y}〜${bannerBox.y + bannerBox.height}）が題名（${titleBox.y}〜）に重なっています`);

  await app.startSidecar();
  await banner.waitFor({ state: "detached", timeout: 30_000 });
  assert.doesNotMatch(await toastTexts(page), /同期/);
});

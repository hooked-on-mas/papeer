// 設定の版の違いの通知: settings.json に知らない項目があると知らせ、「今後表示しない」が効く
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { scenario } from "../lib/app.ts";
import { waitFor } from "../lib/processes.ts";
import { waitForLibrary } from "../lib/ui.ts";

const TITLE = "新しい版のPapeerの設定があります";
const UNKNOWN_KEY = "e2e_setting_from_a_newer_version";

scenario("設定に知らない項目があると版の違いを知らせ、「今後表示しない」で次から出さない", {
  papers: [{ file: "observer.pdf" }],
  // As if a newer Papeer on another PC had written the library's settings.
  beforeApp: (dirs) => {
    const file = path.join(dirs.data, "settings.json");
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...settings, [UNKNOWN_KEY]: true }, null, 2), "utf8");
  },
}, async (app) => {
  const { page } = app;
  const notice = page.getByRole("dialog").filter({ hasText: TITLE });
  await notice.waitFor({ timeout: 30_000 });
  assert.match(await notice.innerText(), new RegExp(UNKNOWN_KEY));
  await notice.getByRole("button", { name: "今後表示しない" }).click();
  await notice.waitFor({ state: "detached" });
  const saved = await page.evaluate(() => localStorage.getItem("papeer-settings-version-notice"));
  assert.equal(JSON.parse(saved ?? "{}").state?.dismissed, true, `「今後表示しない」が保存されていません: ${saved}`);

  // The next launch: a new session (nothing told yet), with the same PC's storage.
  let settingsRead = false;
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/settings" && response.request().method() === "GET" && response.ok()) settingsRead = true;
  });
  await page.evaluate(() => sessionStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForLibrary(page, ["Robust Observer"]);
  await waitFor(() => settingsRead, "設定を読み直すこと", 15_000);
  // The notice would be asked for as soon as the settings are in (VersionNoticeHost).
  await page.waitForTimeout(1_500);
  assert.equal(await notice.count(), 0, "「今後表示しない」を選んだのに通知が出ました");
  // The settings still hold the key: only the notice is off.
  assert.deepEqual((await app.api.call("GET", "/api/settings")).unknown_keys, [UNKNOWN_KEY]);
});

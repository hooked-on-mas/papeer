// ライブラリ: 起動して論文が出る、タグの付け外し（T37・T47）、フォルダーへの移動（ui-fixes の 6）
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { scenario } from "../lib/app.ts";
import { waitFor } from "../lib/processes.ts";
import { armClickTimer, clickTimings, folderOfRow, libraryRow, waitForLibrary, watchSidecarWrites } from "../lib/ui.ts";

scenario("起動するとライブラリにフォルダーと論文が出る", {
  collections: ["FolderA", "FolderB"],
  papers: [
    { file: "twocol.pdf" },
    { file: "observer.pdf", collection: "FolderA", tags: ["tag-beta"] },
    { file: "gradient.pdf", collection: "FolderA" },
  ],
}, async (app) => {
  const { page } = app;
  await waitForLibrary(page, ["FolderA", "FolderB", "未分類", "Adaptive Tracking", "Robust Observer", "Stochastic Gradient"]);
  assert.equal(await folderOfRow(page, "Robust Observer"), "FolderA");
  assert.equal(await folderOfRow(page, "Adaptive Tracking"), "未分類");
  assert.match(await libraryRow(page, "Robust Observer").innerText(), /tag-beta/);
  await page.getByText("3 件の論文").waitFor();
  // The library the app shows is the test's own.
  assert.ok(fs.existsSync(path.join(app.dirs.data, "library.sqlite3")), "ライブラリが一時フォルダーにありません");
  assert.deepEqual(app.consoleErrors.filter((e) => e.startsWith("[pageerror]")), []);
});

scenario("右クリックのタグを続けて付け外しすると、順番に本文付きで保存される", {
  tags: ["tag-alpha", "tag-beta"],
  papers: [{ file: "lyapunov.pdf" }],
}, async (app) => {
  const { page, api } = app;
  const id = app.paperIds["lyapunov.pdf"];
  await waitForLibrary(page, ["Lyapunov"]);
  const writes = watchSidecarWrites(page);
  const serverTags = async () => (await api.call("GET", `/api/papers/${id}`)).tags as string[];

  await libraryRow(page, "Lyapunov").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^タグ/ }).hover();
  const tag = (name: string) => page.getByRole("menuitemcheckbox", { name });
  // Two clicks in a row: the second waits for the first (the paper's queue), so neither is lost.
  await tag("tag-alpha").click();
  await tag("tag-beta").click();
  await waitFor(async () => JSON.stringify(await serverTags()) === JSON.stringify(["tag-alpha", "tag-beta"]),
    "2 つのタグが保存されること", 10_000);
  // The menu stays open, with both ticked, and the row shows both. (Between the end of the saves and the
  // sidecar's paper.changed, about 0.5 s, both may show the tags as they were before: waited out here.)
  const shown = async () => ({
    alpha: await tag("tag-alpha").getAttribute("aria-checked"),
    beta: await tag("tag-beta").getAttribute("aria-checked"),
    row: await libraryRow(page, "Lyapunov").innerText(),
  });
  const t0 = Date.now();
  const log: string[] = [];
  await waitFor(async () => {
    const s = await shown();
    log.push(`${Date.now() - t0}ms ${s.alpha} ${s.beta} ${s.row.replace(/\n/g, " ")}`);
    return s.alpha === "true" && s.beta === "true" && s.row.includes("tag-alpha") && s.row.includes("tag-beta");
  }, async () => `メニューと行が保存したタグを示しません: ${log.slice(-5).join(" / ")}`, 10_000, 50);

  await tag("tag-alpha").click();
  await waitFor(async () => JSON.stringify(await serverTags()) === JSON.stringify(["tag-beta"]), "タグを外したことが保存されること", 10_000);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await waitFor(async () => {
    const row = await libraryRow(page, "Lyapunov").innerText();
    return row.includes("tag-beta") && !row.includes("tag-alpha");
  }, "行のタグが保存と同じになること", 10_000);

  // Each change went out as a PATCH with a JSON body (T37: WebView2 sends the body), one at a time,
  // each built on the tags the sidecar held after the one before (T47).
  const patches = writes.filter((w) => w.method === "PATCH" && w.path === `/api/papers/${id}`);
  assert.deepEqual(patches.map((w) => JSON.parse(w.body ?? "null")), [
    { tags: ["tag-alpha"] },
    { tags: ["tag-alpha", "tag-beta"] },
    { tags: ["tag-beta"] },
  ]);
});

scenario("右クリックで別のフォルダーへ移すと、保存と同時に行が移る", {
  collections: ["FolderA", "FolderB"],
  papers: [{ file: "lyapunov.pdf" }, { file: "observer.pdf", collection: "FolderA" }],
}, async (app) => {
  const { page, api } = app;
  const id = app.paperIds["lyapunov.pdf"];
  await waitForLibrary(page, ["FolderB", "Lyapunov"]);
  assert.equal(await folderOfRow(page, "Lyapunov"), "未分類");

  await libraryRow(page, "Lyapunov").click({ button: "right" });
  await page.getByRole("menuitem", { name: "分類を変更" }).hover();
  await armClickTimer(page, { rowInFolder: ["Lyapunov", "FolderB"] });
  await page.getByRole("menu").last().getByRole("menuitemcheckbox", { name: "FolderB" }).click();
  await waitFor(async () => (await folderOfRow(page, "Lyapunov")) === "FolderB", "行が FolderB に移ること", 5_000);
  // From the PATCH's answer to the row's move, in the page's own time (armClickTimer). The fix moves the
  // row as the answer arrives (some 20 ms here); before it, the row followed the library's own refresh,
  // some 400 ms later. 250 ms leaves room for a busy PC while still telling the two apart.
  const { afterAnswer } = await clickTimings(page, `/api/papers/${id}`);
  assert.ok(afterAnswer !== null, "移動の PATCH の応答か、行が移った時刻を測れませんでした");
  assert.ok(afterAnswer < 250, `保存の応答から ${Math.round(afterAnswer)} ms 後に行が移りました（250 ms 未満のはず）`);
  assert.equal((await api.call("GET", `/api/papers/${id}`)).collection_name, "FolderB");
});

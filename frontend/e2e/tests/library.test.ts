// ライブラリ: 起動して論文が出る、タグの付け外し（T37・T47）、フォルダーへの移動（ui-fixes の 6）、長いライブラリの仮想化と、200 行の境目・画面より上の変化で見ている行が動かないこと（L7b）
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { scenario } from "../lib/app.ts";
import { REPO, waitFor } from "../lib/processes.ts";
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

scenario("行の多いライブラリは見えている行だけを描き、End で画面外の最後の論文へ移って開ける", {
  // 240 folders and 未分類: more rows than the tree renders all of (VIRTUALIZE_FROM in treeLines.ts).
  collections: Array.from({ length: 240 }, (_, i) => `F${String(i).padStart(3, "0")}`),
  papers: [{ file: "lyapunov.pdf" }],
}, async (app) => {
  const { page } = app;
  await waitForLibrary(page, ["F000"]);
  const first = await page.evaluate(() => {
    const rows = document.querySelectorAll("[role=treeitem]");
    return { rendered: rows.length, setSize: rows[0]?.getAttribute("aria-setsize"), posInSet: rows[0]?.getAttribute("aria-posinset") };
  });
  // Each row says its place among all the top folders, though only the rows in view are in the page.
  assert.deepEqual([first.setSize, first.posInSet], ["241", "1"]);
  assert.ok(first.rendered < 80, `${first.rendered} 行が描かれています（見えている行と前後の数行のはず）`);
  assert.equal(await libraryRow(page, "Lyapunov").count(), 0);

  // The keys go to the last row, out of view: the list scrolls to it and it takes the focus.
  await libraryRow(page, "F000").first().focus();
  await page.keyboard.press("End");
  const focused = () => page.evaluate(() => {
    const row = document.activeElement as HTMLElement | null;
    const list = row?.closest("[role=tree]")?.parentElement;
    if (!row || !list) return null;
    const box = row.getBoundingClientRect();
    const view = list.getBoundingClientRect();
    return { text: row.innerText.split("\n")[0], inView: box.top >= view.top - 1 && box.bottom <= view.bottom + 1,
      level: row.getAttribute("aria-level"), posInSet: row.getAttribute("aria-posinset") };
  });
  await waitFor(async () => (await focused())?.text.includes("Lyapunov") ?? false, async () => `End で最後の論文に移りません: ${JSON.stringify(await focused())}`, 5_000);
  const last = await focused();
  assert.ok(last?.inView, "最後の論文の行が見えていません");
  assert.deepEqual([last?.level, last?.posInSet], ["2", "1"]);
  assert.equal(await folderOfRow(page, "Lyapunov"), "未分類");

  // Enter opens it; Home goes back to the first row.
  await page.keyboard.press("Enter");
  await page.locator("h1", { hasText: "Lyapunov" }).waitFor();
  await libraryRow(page, "Lyapunov").focus();
  await page.keyboard.press("Home");
  await waitFor(async () => (await focused())?.text === "F000", async () => `Home で先頭の行に戻りません: ${JSON.stringify(await focused())}`, 5_000);
  assert.ok((await focused())?.inView);
  assert.deepEqual(app.consoleErrors.filter((e) => e.startsWith("[pageerror]")), []);
});

/** The first row of the library that shows in the list's view, and how far its top is from the view's top. */
const topRow = (page: Page) => page.evaluate(() => {
  const list = document.querySelector("[role=tree]")?.parentElement;
  if (!list) return null;
  const view = list.getBoundingClientRect();
  const rows = [...document.querySelectorAll("[role=treeitem]")].map((row) => ({ row, box: row.getBoundingClientRect() }))
    .filter(({ box }) => box.bottom > view.top + 0.5 && box.top < view.bottom).sort((a, b) => a.box.top - b.box.top);
  const first = rows[0];
  return first ? { text: (first.row as HTMLElement).innerText.split("\n")[0], top: Math.round(first.box.top - view.top) } : null;
});

/** Whether the same row is at the top of the view, within a pixel of where it was. */
const sameTop = (a: Awaited<ReturnType<typeof topRow>>, b: Awaited<ReturnType<typeof topRow>>) =>
  !!a && !!b && a.text === b.text && Math.abs(a.top - b.top) <= 1;

scenario("文字の大きさ 150% で行が 200 を越えても、画面より上の行が動いても、見ている行はそのままで、行のボタンのフォーカスも残る", {
  // 194 folders, 未分類 and four papers in the middle: 199 rows, all of them rendered.
  collections: Array.from({ length: 194 }, (_, i) => `F${String(i).padStart(3, "0")}`),
  papers: [
    { file: "gradient.pdf", collection: "F095" }, { file: "observer.pdf", collection: "F095" }, { file: "twocol.pdf", collection: "F095" },
    { file: "lyapunov.pdf", collection: "F097" },
  ],
}, async (app) => {
  const { page, api } = app;
  await waitForLibrary(page, ["F000"]);
  // 150%, where the papers' status lines wrap in the sidebar: rows taller than their classes say.
  await page.getByRole("button", { name: "接続・設定" }).click();
  await page.getByRole("navigation", { name: "設定の項目" }).getByRole("button", { name: "表示" }).click();
  await page.getByRole("radio", { name: /150%/ }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  const virtual = () => page.evaluate(() => document.querySelector("[role=tree]")?.classList.contains("relative") ?? false);
  assert.equal(await virtual(), false);
  // The paper in F097 in the middle of the view, below the three of F095.
  await libraryRow(page, "Lyapunov").evaluate((row) => row.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(200);
  const before = await topRow(page);
  assert.ok(before?.text.startsWith("F0"), JSON.stringify(before));

  // A paper added below the view: 200 rows, and the list starts rendering only those in view.
  const inbox = path.join(app.dirs.root, "inbox-more");
  fs.mkdirSync(inbox, { recursive: true });
  const copy = path.join(inbox, "sample.pdf");
  fs.copyFileSync(path.join(REPO, "tests", "fixtures", "sample.pdf"), copy);
  const started = await api.call("POST", "/api/papers/import", { paths: [copy], collection: "F193" });
  await api.job(started.job_id);
  await page.getByText("5 件の論文").waitFor();
  await waitFor(virtual, "200 行で、見えている行だけを描くようになること", 10_000);
  await page.waitForTimeout(300);
  const at200 = await topRow(page);
  assert.ok(sameTop(at200, before), `200 行になったときに一覧が動きました: ${JSON.stringify(before)} → ${JSON.stringify(at200)}`);

  // The paper in view moved to the first folder, far above: the rows in view stay where they are.
  const id = app.paperIds["lyapunov.pdf"];
  await api.call("PATCH", `/api/papers/${id}`, { collection: "F000" });
  await waitFor(async () => (await libraryRow(page, "Lyapunov").count()) === 0, "論文の行が画面から F000 へ移ること", 10_000);
  await page.waitForTimeout(300);
  const moved = await topRow(page);
  assert.ok(sameTop(moved, before), `画面より上に行が移ったときに一覧が動きました: ${JSON.stringify(before)} → ${JSON.stringify(moved)}`);

  // The focus on a button in a row (a folder's ▸) stays there while the list scrolls far away and back.
  const button = page.locator("[role=treeitem][data-tree-key^='folder:F'] button").first();
  const label = await button.evaluate((element) => { (element as HTMLElement).focus(); return element.closest("[role=treeitem]")!.getAttribute("data-tree-key"); });
  await page.evaluate(() => { document.querySelector("[role=tree]")!.parentElement!.scrollTop = 99999; });
  await page.waitForTimeout(300);
  const far = await page.evaluate(() => document.activeElement?.closest("[role=treeitem]")?.getAttribute("data-tree-key") ?? document.activeElement?.tagName);
  assert.equal(far, label, "スクロールした先でフォーカスが行のボタンから外れました");
  assert.deepEqual(app.consoleErrors.filter((e) => e.startsWith("[pageerror]")), []);
});

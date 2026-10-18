/** The folder organizing dialog against a stand-in API (README「E2E テスト」): its flow, its refusals and its entry points. */
import assert from "node:assert/strict";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createServer } from "vite";
import { chromium, type Page, type WebSocketRoute } from "playwright-core";
import type { OrganizeProposal } from "../src/api/jobTypes.ts";

const PAPERS = [
  { id: "a", title: "Policy gradient methods", collection_name: "Inbox" },
  { id: "b", title: "Q-learning", collection_name: "Inbox" },
  { id: "c", title: "Linear MPC", collection_name: "Inbox" },
  { id: "d", title: "ResNet", collection_name: "Inbox" },
  { id: "e", title: "Image classification survey", collection_name: "Vision" },
];

const PROPOSAL: OrganizeProposal = {
  source: "Inbox",
  instruction: "",
  folders: [
    { name: "強化学習", reason: "報酬から方策を学ぶ研究", new: true },
    { name: "制御", reason: "制御理論に基づく論文", new: true },
    { name: "Vision", reason: "画像を扱う既存のフォルダー", new: false },
  ],
  moves: [
    { paper_id: "a", title: "Policy gradient methods", from: "Inbox", to: "強化学習" },
    { paper_id: "b", title: "Q-learning", from: "Inbox", to: "強化学習" },
    { paper_id: "c", title: "Linear MPC", from: "Inbox", to: "制御" },
    { paper_id: "d", title: "ResNet", from: "Inbox", to: "Vision" },
  ],
  expected: { a: "Inbox", b: "Inbox", c: "Inbox", d: "Inbox" },
  message: "4件を3つのフォルダーに分けました。",
};

async function open(t: TestContext) {
  const frontend = path.resolve(import.meta.dirname, "..");
  const server = await createServer({ root: frontend, configFile: path.join(frontend, "vite.config.ts"), logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: "msedge", headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  let events: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\/events/, socket => { events = socket; });
  const folders = new Map(PAPERS.map(paper => [paper.id, paper.collection_name]));
  const organizes: Record<string, any>[] = [];
  const applies: Record<string, any>[] = [];
  const patches: { id: string; body: Record<string, any> }[] = [];
  // What the next apply-moves answers: moved papers are moved in `folders`, a refusal is a 409.
  const apply = { refuse: false, created: ["RL"] };
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname, method = request.method();
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    const row = (id: string) => ({ id, sha256: id, title: PAPERS.find(p => p.id === id)!.title, original_name: `${id}.pdf`, pages: 8,
      status: "not_translated", collection_name: folders.get(id) ?? "", created_at: "", tags: [], read_status: "", translated_count: 0 });
    let json: unknown = [];
    if (method === "POST" && pathname === "/api/collections/organize") {
      organizes.push(request.postDataJSON());
      json = { job_id: `organize-${organizes.length}` };
    } else if (method === "POST" && pathname === "/api/collections/apply-moves") {
      const body = request.postDataJSON();
      applies.push(body);
      if (apply.refuse) {
        await route.fulfill({ status: 409, json: { detail: "論文のフォルダーが案を作った後に変更されたため、適用できません。", code: "collection_changed" }, headers });
        return;
      }
      for (const move of body.moves) folders.set(move.paper_id, move.to);
      json = { moved: body.moves.length, created: apply.created };
    } else if (pathname === "/api/papers") json = PAPERS.map(paper => row(paper.id));
    else if (pathname === "/api/collections") json = ["Inbox", "Vision"];
    else if (/^\/api\/papers\/[a-e]$/.test(pathname)) {
      const id = pathname.split("/").pop()!;
      if (method === "PATCH") {
        const body = request.postDataJSON();
        patches.push({ id, body });
        if (typeof body.collection === "string") folders.set(id, body.collection);
        json = {};
      } else json = row(id);
    } else if (pathname === "/api/reading-statuses") json = ["未読", "読了"];
    await route.fulfill({ json, headers });
  });
  const send = async (event: Record<string, unknown>) => {
    for (let wait = 0; !events && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(events, "the event stream is connected");
    events.send(JSON.stringify(event));
  };
  const finish = (index: number, result: OrganizeProposal | null, error: string | null = null) => send({
    type: "job.finished", job_id: `organize-${index}`, paper_id: null, kind: "library-organize", status: result ? "succeeded" : "failed",
    running: false, cancelled: false, message: "", error, result });
  const waitFor = async (what: string, ready: () => boolean) => {
    for (let wait = 0; !ready() && wait < 200; wait++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(ready(), what);
  };
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/organize.html`);
  // The first load of a changed source takes long: the sources are transformed as they are asked for.
  await page.getByRole("treeitem", { name: "Inbox（4件）" }).waitFor({ timeout: 90_000 });
  return { page, organizes, applies, patches, apply, folders, send, finish, waitFor };
}

const DIALOG = "AIでフォルダーに分ける";
async function openFromFolder(page: Page, folder = "Inbox（4件）") {
  await page.getByRole("treeitem", { name: folder }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "AIで内容別に分ける…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: DIALOG, exact: true });
  await dialog.waitFor();
  return dialog;
}
const history = async (page: Page) => JSON.parse(await page.getByTestId("history").textContent() ?? "[]");

test("proposal from a folder's menu: leave one out, send one elsewhere, rename a new folder, apply and undo", { timeout: 120_000 }, async t => {
  const { page, organizes, applies, patches, send, finish, waitFor } = await open(t);
  const dialog = await openFromFolder(page);
  assert.equal(await dialog.getByLabel("整理するフォルダー", { exact: true }).inputValue(), "Inbox");
  await dialog.getByText("直接入っている4件の論文を調べます。子フォルダーの論文は含みません。", { exact: true }).waitFor();
  const instruction = dialog.getByLabel("指示（任意）", { exact: true });
  await dialog.getByRole("button", { name: "研究分野別に", exact: true }).click();
  assert.equal(await instruction.inputValue(), "研究分野別に");
  await instruction.fill("研究分野別に。既存のフォルダーを優先");
  await dialog.getByRole("button", { name: "案を作る", exact: true }).click();
  await waitFor("the request is sent", () => organizes.length === 1);
  assert.deepEqual(organizes[0], { source: "Inbox", instruction: "研究分野別に。既存のフォルダーを優先", paper_ids: null, feedback: "", previous: null });

  // Running: the job's message shows, and a second proposal cannot be started.
  await send({ type: "job.progress", job_id: "organize-1", paper_id: null, kind: "library-organize", message: "フォルダー分けの案を作っています…", done: 1, total: 2 });
  await dialog.getByRole("status").getByText("フォルダー分けの案を作っています…（1/2）", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "案を作る", exact: true }).isDisabled(), true);
  await finish(1, PROPOSAL);

  const list = dialog.getByRole("list", { name: "移動案", exact: true });
  await list.waitFor();
  await dialog.getByText("4件を3個のフォルダーへ移動します（新しいフォルダー2個を作成）。", { exact: true }).waitFor();
  assert.equal(await dialog.getByText("報酬から方策を学ぶ研究", { exact: true }).isVisible(), true);
  assert.equal(await list.getByText("新規", { exact: true }).count(), 2, "the new folders are marked");
  assert.equal(await list.getByRole("checkbox").count(), 4 + 3, "each paper and each folder can be checked");
  await dialog.getByRole("button", { name: "4件を移動", exact: true }).waitFor();

  await dialog.getByRole("checkbox", { name: "「Q-learning」を移動する", exact: true }).uncheck();
  await dialog.getByLabel("「Linear MPC」の移動先", { exact: true }).selectOption("Vision");
  // A name that is taken is refused where it is typed; a free one renames the folder and its papers' destination.
  await dialog.getByRole("button", { name: "「強化学習」の名前を変更", exact: true }).click();
  const name = dialog.getByLabel("「強化学習」の新しい名前", { exact: true });
  await name.fill("vision");
  await name.press("Enter");
  await dialog.getByRole("alert").getByText("同じ名前のフォルダーがすでにあります。", { exact: true }).waitFor();
  await name.fill("RL");
  await name.press("Enter");
  await list.getByTitle("RL", { exact: true }).waitFor();
  await dialog.getByText("3件を2個のフォルダーへ移動します（新しいフォルダー1個を作成）。", { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel("「Policy gradient methods」の移動先", { exact: true }).inputValue(), "RL");

  await dialog.getByRole("button", { name: "3件を移動", exact: true }).click();
  await waitFor("the moves are applied", () => applies.length === 1);
  assert.deepEqual(applies[0], {
    moves: [{ paper_id: "a", to: "RL" }, { paper_id: "c", to: "Vision" }, { paper_id: "d", to: "Vision" }],
    expected: { a: "Inbox", c: "Inbox", d: "Inbox" },
  });
  await dialog.waitFor({ state: "hidden" });
  await page.getByText("3件を移動しました（1個のフォルダーを作成）", { exact: true }).waitFor();
  // One entry to undo for the whole batch.
  const [record, ...rest] = await history(page);
  assert.equal(rest.length, 0);
  assert.equal(record.kind, "move-papers");
  assert.deepEqual(record.moves, [{ paperId: "a", from: "Inbox", to: "RL" }, { paperId: "c", from: "Inbox", to: "Vision" }, { paperId: "d", from: "Inbox", to: "Vision" }]);

  await page.getByRole("button", { name: "元に戻す", exact: true }).first().click();
  await waitFor("every paper is moved back", () => patches.length === 3);
  assert.deepEqual(patches.map(patch => [patch.id, patch.body.collection]).sort(), [["a", "Inbox"], ["c", "Inbox"], ["d", "Inbox"]]);
  await page.waitForFunction(() => document.querySelector("[data-testid=history]")?.textContent === "[]");
});

test("a changed library refuses the apply; revising sends the feedback and the edited proposal; a proposal made while closed is reopened from its notice", { timeout: 120_000 }, async t => {
  const { page, organizes, applies, apply, finish, waitFor } = await open(t);
  let dialog = await openFromFolder(page);
  await dialog.getByRole("button", { name: "案を作る", exact: true }).click();
  await waitFor("the request is sent", () => organizes.length === 1);
  assert.deepEqual(organizes[0], { source: "Inbox", instruction: "", paper_ids: null, feedback: "", previous: null });
  await finish(1, PROPOSAL);
  await dialog.getByRole("list", { name: "移動案", exact: true }).waitFor();

  // 作り直す is for an instruction (or a change); the edited proposal goes with it, without the paper left out.
  const revise = dialog.getByRole("button", { name: "作り直す", exact: true });
  assert.equal(await revise.isDisabled(), true);
  await dialog.getByRole("checkbox", { name: "「Q-learning」を移動する", exact: true }).uncheck();
  await dialog.getByLabel("追加の指示（任意）", { exact: true }).fill("もっと粗く分けてください");
  await revise.click();
  await waitFor("the revision is sent", () => organizes.length === 2);
  const { previous, ...revision } = organizes[1];
  assert.deepEqual(revision, { source: "Inbox", instruction: "", paper_ids: null, feedback: "もっと粗く分けてください" });
  assert.deepEqual(previous.moves.map((move: { paper_id: string }) => move.paper_id), ["a", "c", "d"]);
  assert.deepEqual(previous.expected, { a: "Inbox", c: "Inbox", d: "Inbox" });
  assert.equal(previous.source, "Inbox");

  // The dialog is closed while the job runs; its result is told by a notice that opens it again.
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const revised: OrganizeProposal = { ...PROPOSAL, message: "2つに粗くまとめました。", folders: [
    { name: "学習", reason: "学習ベースの論文", new: true }, { name: "Vision", reason: "", new: false }],
  moves: [{ paper_id: "a", title: "Policy gradient methods", from: "Inbox", to: "学習" }, { paper_id: "d", title: "ResNet", from: "Inbox", to: "Vision" }],
  expected: { a: "Inbox", d: "Inbox" } };
  await finish(2, revised);
  await page.getByText("フォルダー整理の案ができました", { exact: true }).waitFor();
  await page.getByRole("button", { name: "確認する", exact: true }).click();
  dialog = page.getByRole("dialog", { name: DIALOG, exact: true });
  await dialog.waitFor();
  await dialog.getByText("2つに粗くまとめました。", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("list", { name: "移動案", exact: true }).getByRole("checkbox").count(), 2 + 2);

  // The papers' folders changed since: nothing is applied, and a new proposal is one click away.
  apply.refuse = true;
  await dialog.getByRole("button", { name: "2件を移動", exact: true }).click();
  await waitFor("the apply is sent", () => applies.length === 1);
  await dialog.getByRole("alert").getByText("分類が変わったため、もう一度案を作ってください。", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "2件を移動", exact: true }).isDisabled(), true);
  assert.deepEqual(await history(page), []);
  await dialog.getByRole("button", { name: "案を作り直す", exact: true }).click();
  await waitFor("the new proposal is requested", () => organizes.length === 3);
  assert.deepEqual(organizes[2], { source: "Inbox", instruction: "", paper_ids: null, feedback: "", previous: null });
  await finish(3, PROPOSAL);
  await dialog.getByText("4件を3個のフォルダーへ移動します（新しいフォルダー2個を作成）。", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("alert").count(), 0);
  assert.equal(await dialog.getByRole("button", { name: "4件を移動", exact: true }).isEnabled(), true);
});

test("after adding PDFs, 「AIで分類」 opens the dialog for those papers; a failed job is told in the dialog", { timeout: 120_000 }, async t => {
  const { page, organizes, send, finish, waitFor } = await open(t);
  await send({ type: "job.finished", job_id: "import-1", paper_id: null, kind: "import", status: "succeeded", running: false, cancelled: false,
    message: "", error: null, result: { paper_ids: ["a", "b", "e"], added: 2, added_ids: ["a", "b"], needs_ocr: [], metadata_failures: [] } });
  // "e" was in the library already: only the papers just added are offered.
  await page.getByText("2件のPDFを追加しました", { exact: true }).waitFor();
  await page.getByRole("button", { name: "AIで分類", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: DIALOG, exact: true });
  await dialog.waitFor();
  await dialog.getByText("選択した論文 2件", { exact: true }).waitFor();
  await dialog.getByText("選択した2件の論文を調べます。新しいフォルダーは「Inbox」の下に作ります。", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "案を作る", exact: true }).click();
  await waitFor("the request is sent", () => organizes.length === 1);
  assert.deepEqual(organizes[0], { source: "Inbox", instruction: "", paper_ids: ["a", "b"], feedback: "", previous: null });
  await finish(1, null, "AIから有効なフォルダー整理の案を取得できませんでした。再試行してください。");
  // The failure is raised as any job's is, in the error dialog; the dialog under it says it as well.
  const error = page.getByRole("dialog").filter({ hasText: "エラーの詳細" });
  await error.waitFor();
  await error.getByRole("button", { name: "閉じる", exact: true }).click();
  await error.waitFor({ state: "hidden" });
  await dialog.getByText(/案を作れませんでした。AIから有効な/).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "案を作る", exact: true }).isEnabled(), true);
});

test("too many papers added at once for one proposal: the notice has no button to the dialog", { timeout: 120_000 }, async t => {
  const { page, send } = await open(t);
  const ids = Array.from({ length: 301 }, (_, i) => `n${i}`);
  await send({ type: "job.finished", job_id: "import-2", paper_id: null, kind: "import", status: "succeeded", running: false, cancelled: false,
    message: "", error: null, result: { paper_ids: ids, added: 301, added_ids: ids, needs_ocr: [], metadata_failures: [] } });
  await page.getByText("301件のPDFを追加しました", { exact: true }).waitFor();
  await page.getByText(/一度にAIで分けられるのは300件までです/).waitFor();
  assert.equal(await page.getByRole("button", { name: "AIで分類", exact: true }).count(), 0);
});

/**
 * One launch of the app for one scenario: a new library, sidecar and WebView2 profile in a temporary
 * folder, driven over the Chrome DevTools Protocol (playwright-core's connectOverCDP).
 *
 * Order: folders → sidecar (python -m sidecar on 8000) → the scenario's data through the API → the debug
 * papeer.exe (page from the shared Vite on 1420) → check that WebView2 uses the temporary profile (else stop
 * at once and fail) → connect. close() force-stops everything and deletes the folder, once no process
 * names it any more.
 *
 * The real app folders are kept out in three ways. PAPEER_E2E_DIR (a debug build only, src-tauri/src/lib.rs)
 * makes the app put the WebView2 profile in the test's folder and leave out the window-state plugin, which
 * would read and write %APPDATA%\local.paperdesk\.window-state.json. Then, as checks: the profile named on
 * WebView2's command line, and the real folders' files (realAppFiles) unchanged after each launch. The app
 * is also only ever force-stopped, and its IPC calls that would end it are answered here (guardExit).
 */
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { isInside, isolatedDirs, isolatedEnv, userDataDir, type IsolatedDirs } from "./env.ts";
import {
  APP_EXE, DEV_TOKEN, PYTHON, REPO, SIDECAR_PORT, VITE_PORT, assertRunning, forceStop, freePort, isListening,
  logTail, powershell, processesMentioning, removeTree, start, waitFor, webviewChildren, type ProcessInfo, type Started,
} from "./processes.ts";

/** What run.ts prepared for every scenario (passed in the environment). */
export interface RunInfo {
  runDir: string;
  stubUrl: string;
  pdfDir: string;
  resultsDir: string;
  fontCache: string;
}

export function runInfo(): RunInfo {
  const raw = process.env.E2E_RUN;
  if (!raw) throw new Error("E2E テストは `just e2e`（node e2e/run.ts）から実行してください。");
  return JSON.parse(raw) as RunInfo;
}

export interface PaperSeed {
  /** A file made by tools/e2e_pdfs.py (twocol.pdf, observer.pdf, gradient.pdf, lyapunov.pdf) or "sample.pdf". */
  file: string;
  collection?: string;
  tags?: string[];
}

export interface LaunchOptions {
  papers?: PaperSeed[];
  /** Empty folders to create. */
  collections?: string[];
  /** Tags to create (without papers). */
  tags?: string[];
  /** Runs after the data is in place and before the app starts (e.g. to edit settings.json). */
  beforeApp?: (dirs: IsolatedDirs) => void | Promise<void>;
  viewport?: { width: number; height: number };
}

export const DEFAULT_VIEWPORT = { width: 1366, height: 800 };

/** The Tauri commands that would end the app: answered here instead, so the app never exits by itself. */
const BLOCKED_IPC = ["plugin:process|exit", "plugin:process|restart", "plugin:window|destroy"];

/**
 * The files of the real app folders (under the Windows known folders, which Tauri uses whatever
 * LOCALAPPDATA/APPDATA say) that a launch would write if the isolation failed: the window-state plugin's
 * file and the WebView2 profile's "Local State". run.ts finds the known folders (E2E_REAL_FOLDERS).
 * A second guard: PAPEER_E2E_DIR already keeps the app away from them.
 */
function realAppFiles(): string[] {
  const folders = JSON.parse(process.env.E2E_REAL_FOLDERS ?? "[]") as string[];
  return folders.flatMap((folder) => [
    path.join(folder, "local.paperdesk", ".window-state.json"),
    path.join(folder, "local.paperdesk", "EBWebView", "Local State"),
  ]);
}

/** Each file's last write time (null when it does not exist). */
function mtimes(files: string[]): (number | null)[] {
  return files.map((file) => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  });
}

/** How long close() waits for the launch's processes to end: a warning after the first, a failure after the second. */
const LEFTOVER_WARN_MS = 20_000;
const LEFTOVER_LIMIT_MS = 180_000;

export class Api {
  readonly base = `http://127.0.0.1:${SIDECAR_PORT}`;

  async request(method: string, route: string, body?: unknown): Promise<Response> {
    return fetch(this.base + route, {
      method,
      headers: { Authorization: `Bearer ${DEV_TOKEN}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async call<T = any>(method: string, route: string, body?: unknown): Promise<T> {
    const response = await this.request(method, route, body);
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${route} → HTTP ${response.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Waits for a job to finish and returns it; throws if it did not succeed. */
  async job(jobId: string, timeout = 120_000): Promise<any> {
    return waitFor(async () => {
      const job = await this.call("GET", `/api/jobs/${jobId}`);
      if (job.running) return undefined;
      if (job.status !== "succeeded") throw new Error(`ジョブ ${job.kind} が ${job.status} で終わりました: ${job.error}`);
      return job;
    }, `ジョブ ${jobId} の終了`, timeout, 200);
  }
}

export interface App {
  name: string;
  dirs: IsolatedDirs;
  api: Api;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  /** Paper ids by file name of the seed. */
  paperIds: Record<string, string>;
  /** Console errors and uncaught exceptions of the page. */
  consoleErrors: string[];
  /** The WebView2 profile folder (--user-data-dir), checked to be inside `dirs.webview`. */
  webviewProfile: string;
  /** How long each step of the launch took. */
  timings: string[];
  setViewport(width: number, height: number): Promise<void>;
  stopSidecar(): Promise<void>;
  startSidecar(): Promise<void>;
  stubRequests(): Promise<{ translation: number; glossary: number; domains: number; other: number }>;
  setStubDelay(seconds: number): Promise<void>;
  /** Asks the window to close, like its × button (WM_CLOSE). */
  requestWindowClose(): void;
  /** Whether papeer.exe is still running. */
  appRunning(): boolean;
}

interface Launch extends App {
  saveFailure(error: unknown): Promise<void>;
  close(): Promise<void>;
}

/** A file name for the scenario (its Japanese name, without the characters Windows does not allow). */
function slug(name: string): string {
  return name.replace(/[\s<>:"/\\|?*「」（）、。・…×]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "scenario";
}

async function launch(name: string, options: LaunchOptions): Promise<Launch> {
  const run = runInfo();
  // Nothing of an earlier scenario may still run beside this one (close() waits for that; this also
  // covers a scenario whose cleanup failed).
  await waitFor(() => processesMentioning(run.runDir).length === 0,
    () => `前のシナリオのプロセスが残っています:\n${processesMentioning(run.runDir).map((p) => `PID ${p.pid} ${p.name}`).join("\n")}`,
    LEFTOVER_LIMIT_MS, 1_000);
  // An ASCII folder name: the data, WebView2 profile and logs of this launch.
  const root = fs.mkdtempSync(path.join(run.runDir, "scenario-"));
  const dirs = isolatedDirs(root);
  const logs = path.join(root, "logs");
  const env = isolatedEnv(process.env, dirs, {
    PAPEER_TOKEN: DEV_TOKEN,
    PAPEER_PORT: String(SIDECAR_PORT),
    PAPEER_FONT_CACHE_DIR: run.fontCache,
    PYTHONUTF8: "1",
  });
  const api = new Api();
  const timings: string[] = [];
  let since = Date.now();
  const mark = (step: string) => {
    timings.push(`${step} ${((Date.now() - since) / 1000).toFixed(1)} 秒`);
    since = Date.now();
  };
  let sidecar: Started | undefined;
  let app: Started | undefined;
  let browser: Browser | undefined;
  let webviewPids: number[] = [];
  const realFiles = realAppFiles();
  const realFilesBefore = mtimes(realFiles);

  const startSidecar = async () => {
    if (await isListening(SIDECAR_PORT)) throw new Error(`ポート ${SIDECAR_PORT} が使われています（開発用の sidecar が起動していれば止めてください）。`);
    sidecar = start(PYTHON, ["-m", "sidecar"], { cwd: REPO, env, log: path.join(logs, "sidecar.log") });
    const current = sidecar;
    await waitFor(async () => {
      assertRunning(current, "sidecar");
      const response = await fetch(`${api.base}/health`);
      return response.ok;
    }, "sidecar の起動", 60_000, 200);
  };
  /** Whether the sidecar still runs, for the failure report: one that ended by itself would explain a lost connection. */
  const sidecarState = () => {
    if (!sidecar) return "テストが止めたまま";
    const code = sidecar.child.exitCode;
    return code === null ? "動作中" : `終了コード ${code} で終了（0x${(code >>> 0).toString(16)}）`;
  };
  const stopSidecar = async () => {
    await sidecar?.stop();
    sidecar = undefined;
  };

  const close = async () => {
    // WebView2 and the app before the sidecar, so the app never sees the sidecar go and never exits by
    // itself. WebView2's browser process (and everything under it) is stopped by name: left to end with
    // the app, it lingers for seconds.
    since = Date.now();
    // Only processes that still name this launch's folder: a PID seen at the start may belong to another by now.
    const ours = new Set(processesMentioning(root).map((p) => p.pid));
    forceStop(webviewPids.filter((pid) => ours.has(pid)));
    await app?.stop();
    mark("終了: アプリ");
    await stopSidecar();
    mark("sidecar");
    // Not browser.close(): with the app gone it only waits for the lost connection to time out.
    // WebView2 processes end with their host; stop any that are still there (they name the folder). The
    // next scenario starts only once they are gone: under load a browser process can take half a minute.
    const waitStarted = Date.now();
    let warned = false;
    let left: ProcessInfo[] = [];
    const problems: string[] = [];
    const describe = () => left.map((p) => `PID ${p.pid} ${p.name} ${p.commandLine.slice(0, 160)}`).join("\n");
    for (;;) {
      left = processesMentioning(root);
      if (!left.length) break;
      const waited = Date.now() - waitStarted;
      if (waited > LEFTOVER_LIMIT_MS) {
        problems.push(`${LEFTOVER_LIMIT_MS / 1000} 秒待っても、この起動のプロセスが終わりません:\n${describe()}`);
        break;
      }
      if (!warned && waited > LEFTOVER_WARN_MS) {
        warned = true;
        console.warn(`この起動のプロセスが ${LEFTOVER_WARN_MS / 1000} 秒たっても残っています（最長 ${LEFTOVER_LIMIT_MS / 1000} 秒待ちます）:\n${describe()}`);
      }
      forceStop(left.map((p) => p.pid));
      await sleep(500);
    }
    mark("残りのプロセス");
    // Antivirus scanning may hold a file for a while: run.ts deletes the whole run folder again at the end.
    if (!await removeTree(root)) console.warn(`一時フォルダーをまだ消せません（実行の最後にもう一度消します）: ${root}`);
    mark("一時フォルダーの削除");
    const changed = realFiles.filter((file, i) => mtimes([file])[0] !== realFilesBefore[i]);
    if (changed.length) {
      problems.push(`実際のアプリのフォルダーのファイルが変わりました（同じ時刻に本物の Papeer を使っていなければ、隔離の失敗です）: ${changed.join(", ")}`);
    }
    if (problems.length) throw new Error(problems.join("\n"));
  };

  try {
    await startSidecar();
    mark("sidecar");
    const paperIds = await seed(api, run, dirs, options);
    mark("論文の取り込み");
    await options.beforeApp?.(dirs);

    if (!await isListening(VITE_PORT)) throw new Error(`Vite（ポート ${VITE_PORT}）が起動していません。`);
    const cdpPort = await freePort();
    app = start(APP_EXE, [], {
      cwd: path.dirname(APP_EXE),
      env: {
        ...env,
        PAPEER_E2E_DIR: dirs.webview,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
        // WebView2 does not open the debugging port with another home folder. Tauri finds its folders
        // through the Windows known folders, not USERPROFILE, and the app reads no file of its own there
        // (the sidecar does: its USERPROFILE and CODEX_HOME stay in the test's folder).
        USERPROFILE: process.env.USERPROFILE,
        HOME: process.env.HOME,
      },
      log: path.join(logs, "app.log"),
      detached: true,
    });
    const webview = checkWebviewProfile(app, dirs);
    const webviewProfile = webview.profile;
    webviewPids = webview.pids;

    const appStarted = app;
    mark("アプリと WebView2 の確認");
    browser = await waitFor(async () => {
      assertRunning(appStarted, "papeer.exe");
      return chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 5_000 });
    }, "WebView2 への CDP 接続", 60_000, 250);
    const connected = browser;
    const context = connected.contexts()[0];
    const page = await waitFor(() => context.pages().find((p) => p.url().startsWith(`http://localhost:${VITE_PORT}`)),
      "アプリの画面", 30_000);
    page.setDefaultTimeout(20_000);
    const consoleErrors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 500)); });
    page.on("pageerror", (e) => consoleErrors.push(`[pageerror] ${e.message.slice(0, 500)}`));
    await guardExit(page);
    const cdp = await context.newCDPSession(page);
    const setViewport = async (width: number, height: number) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    };
    const viewport = options.viewport ?? DEFAULT_VIEWPORT;
    await setViewport(viewport.width, viewport.height);
    await page.waitForLoadState("domcontentloaded");

    const stubRequests = async () => (await (await fetch(`${run.stubUrl}/_e2e/requests`)).json()) as { translation: number; glossary: number; domains: number; other: number };
    const setStubDelay = async (seconds: number) => {
      await fetch(`${run.stubUrl}/_e2e/delay`, { method: "POST", body: JSON.stringify({ seconds }) });
    };
    mark("画面");
    const launched: Launch = {
      name, dirs, api, browser: connected, context, page, cdp, paperIds, consoleErrors, webviewProfile, timings,
      setViewport,
      stopSidecar,
      startSidecar,
      stubRequests,
      setStubDelay,
      requestWindowClose: () => postWindowClose(appStarted),
      appRunning: () => appStarted.child.exitCode === null,
      saveFailure: async (error) => {
        fs.mkdirSync(run.resultsDir, { recursive: true });
        const base = path.join(run.resultsDir, slug(name));
        await page.screenshot({ path: `${base}-failure.png`, timeout: 5_000 }).catch(() => undefined);
        const text = [
          `シナリオ: ${name}`, `エラー: ${error instanceof Error ? error.stack : String(error)}`,
          "", "--- ページのコンソールのエラー ---", ...consoleErrors,
          "", `--- sidecar のログ（末尾）: ${sidecarState()} ---`, logTail(path.join(logs, "sidecar.log"), 60),
          "", "--- アプリのログ（末尾） ---", logTail(path.join(logs, "app.log"), 30),
        ].join("\n");
        fs.writeFileSync(`${base}-failure.txt`, text, "utf8");
      },
      close,
    };
    return launched;
  } catch (error) {
    // Save what there is to look at, then stop everything this launch started.
    try {
      fs.mkdirSync(run.resultsDir, { recursive: true });
      fs.writeFileSync(path.join(run.resultsDir, `${slug(name)}-launch-failure.txt`), [
        String(error instanceof Error ? error.stack : error),
        "", "--- sidecar のログ（末尾） ---", logTail(path.join(logs, "sidecar.log"), 60),
        "", "--- アプリのログ（末尾） ---", logTail(path.join(logs, "app.log"), 30),
      ].join("\n"), "utf8");
    } catch {
      // Best effort.
    }
    await close().catch((cleanup) => console.error(`後始末に失敗しました: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`));
    throw error;
  }
}

/** Puts the scenario's data in place through the API; the paper ids by seed file. */
async function seed(api: Api, run: RunInfo, dirs: IsolatedDirs, options: LaunchOptions): Promise<Record<string, string>> {
  // Translation goes to the stand-in AI; one request at a time keeps the order of pages predictable.
  await api.call("PUT", "/api/settings", {
    provider: "api", model: "papeer-e2e-stub", translation_concurrency: 1,
    provider_options: { api: { base_url: `${run.stubUrl}/v1`, model: "papeer-e2e-stub" } },
  });
  for (const name of options.collections ?? []) await api.call("POST", "/api/collections", { name });
  for (const name of options.tags ?? []) await api.call("POST", "/api/tags", { name });
  const ids: Record<string, string> = {};
  const inbox = path.join(dirs.root, "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  for (const paper of options.papers ?? []) {
    const source = paper.file === "sample.pdf" ? path.join(REPO, "tests", "fixtures", "sample.pdf") : path.join(run.pdfDir, paper.file);
    const copy = path.join(inbox, paper.file);
    fs.copyFileSync(source, copy);
    const started = await api.call("POST", "/api/papers/import", { paths: [copy], collection: paper.collection ?? null });
    const job = await api.job(started.job_id);
    const id = job.result.paper_ids[0] as string;
    ids[paper.file] = id;
    for (const tag of paper.tags ?? []) await api.call("POST", "/api/tags", { name: tag });
    if (paper.tags?.length) await api.call("PATCH", `/api/papers/${id}`, { tags: paper.tags });
  }
  return ids;
}

/**
 * Stops the app at once and fails unless its WebView2 profile (--user-data-dir of the browser process)
 * is inside the test's folder. Runs right after the start, before anything else talks to the app.
 */
export function checkWebviewProfile(app: Started, dirs: IsolatedDirs): { profile: string; pids: number[] } {
  const pid = app.child.pid;
  if (pid === undefined) throw new Error("papeer.exe を起動できませんでした。");
  const children = webviewChildren(pid, 30_000);
  const problems: string[] = [];
  if (!children.length) problems.push("WebView2 のプロセスが見つかりません");
  for (const child of children) {
    const dir = userDataDir(child.commandLine);
    if (!dir || !isInside(dir, dirs.webview)) problems.push(`PID ${child.pid} の --user-data-dir が一時フォルダーの外です: ${dir ?? "（指定なし）"}`);
  }
  if (problems.length) {
    forceStop([pid, ...children.map((c) => c.pid)]);
    throw new Error(`WebView2 のプロファイルを隔離できていないため、アプリを止めました。\n${problems.join("\n")}`);
  }
  return { profile: userDataDir(children[0].commandLine) ?? "", pids: children.map((c) => c.pid) };
}

/** Answers the IPC calls that would end the app (the requests to http://ipc.localhost/<command>). */
async function guardExit(page: Page): Promise<void> {
  await page.route((url) => url.hostname === "ipc.localhost" && BLOCKED_IPC.includes(decodeURIComponent(url.pathname.slice(1))), async (route) => {
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "Tauri-Response",
      "Content-Type": "application/json",
      "Tauri-Response": "ok",
    };
    if (route.request().method() === "OPTIONS") await route.fulfill({ status: 204, headers });
    else await route.fulfill({ status: 200, headers, body: "null" });
  });
}

/** Sends WM_CLOSE to the app's window, as its × button does. */
function postWindowClose(app: Started): void {
  const pid = app.child.pid;
  powershell(`Add-Type -Namespace E2E -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'
$p = Get-Process -Id ${pid} -ErrorAction Stop
if ($p.MainWindowHandle -eq 0) { throw 'no window' }
[void][E2E.W]::PostMessage($p.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)`);
}

/**
 * A scenario: launches the app with its own data, runs `body`, and always stops everything. On failure
 * a screenshot and the logs go to tmp/e2e-results (README「E2E テスト」).
 */
export function scenario(name: string, options: LaunchOptions & { timeout?: number; todo?: string }, body: (app: App, t: TestContext) => Promise<void>): void {
  test(name, { timeout: options.timeout ?? 240_000, todo: options.todo }, async (t) => {
    const app = await launch(name, options);
    t.diagnostic(`WebView2 のプロファイル: ${app.webviewProfile}`);
    t.diagnostic(`起動: ${app.timings.join("、")}`);
    let failed = false;
    try {
      await body(app, t);
    } catch (error) {
      failed = true;
      await app.saveFailure(error);
      throw error;
    } finally {
      try {
        const launched = app.timings.length;
        await app.close();
        t.diagnostic(app.timings.slice(launched).join("、"));
      } catch (error) {
        // Also after a failed scenario: told, since the next one would start beside what is left.
        if (!failed) throw error;
        console.error(`後始末に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
}

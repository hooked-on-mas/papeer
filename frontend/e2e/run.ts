/**
 * Runs the end-to-end tests (`just e2e`, README「E2E テスト」).
 *
 *   node e2e/run.ts [--repeat N] [name ...]
 *
 * Prepares what every scenario shares: a temporary run folder, the synthetic PDFs (tools/e2e_pdfs.py),
 * the stand-in AI (tools/e2e_stub_ai.py) and Vite on 1420 — all in the isolated environment of lib/env.ts —
 * then runs e2e/tests/*.test.ts with node:test, one file at a time (each scenario launches its own sidecar
 * and app, lib/app.ts). `name` keeps the test files whose name contains it; `--repeat N` runs them N times.
 * Everything is stopped and the run folder deleted at the end, also after Ctrl+C.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedDirs, isolatedEnv } from "./lib/env.ts";
import {
  APP_EXE, FRONTEND, PYTHON, REPO, SIDECAR_PORT, VITE_PORT, assertRunning, cleanEarlierRuns, isListening, powershell, removeTree, start, sweepLeftovers, waitFor, type Started,
} from "./lib/processes.ts";
import type { RunInfo } from "./lib/app.ts";

const TESTS = path.join(FRONTEND, "e2e", "tests");
const RESULTS = path.join(REPO, "tmp", "e2e-results");
// The same cache as pytest (tests/conftest.py): converting the bundled fonts takes about 30 seconds once.
const FONT_CACHE = path.join(REPO, ".pytest_cache", "d", "papeer-font-cache");

function fail(message: string): never {
  console.error(`E2E テストを始められません: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { repeat: number; filters: string[] } {
  let repeat = 1;
  const filters: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repeat") repeat = Number(argv[++i]);
    else filters.push(argv[i]);
  }
  if (!Number.isInteger(repeat) || repeat < 1) fail("--repeat には 1 以上の整数を指定してください。");
  return { repeat, filters };
}

const { repeat, filters } = parseArgs(process.argv.slice(2));
if (process.platform !== "win32") fail("Windows（WebView2）専用です。");
if (!fs.existsSync(APP_EXE)) fail(`${APP_EXE} がありません。\`just e2e\` か frontend/src-tauri で cargo build を実行してください。`);
if (!fs.existsSync(PYTHON)) fail(`${PYTHON} がありません。\`just setup\` を実行してください。`);
for (const port of [SIDECAR_PORT, VITE_PORT]) {
  if (await isListening(port)) fail(`ポート ${port} が使われています。開発用の sidecar・Vite・アプリ（just dev-sidecar / dev-frontend）を止めてから実行してください。`);
}
const files = fs.readdirSync(TESTS).filter((f) => f.endsWith(".test.ts")).filter((f) => !filters.length || filters.some((n) => f.includes(n))).sort();
if (!files.length) fail(`「${filters.join(" ")}」に当たるテストがありません。`);

// What an earlier run left (it was stopped before its cleanup): its WebView2 and temporary folders.
const earlier = await cleanEarlierRuns(os.tmpdir());
if (earlier.processes || earlier.folders.length) {
  console.warn(`前回の実行の残り（プロセス ${earlier.processes} 個、一時フォルダー ${earlier.folders.length} 個）を片付けました。`);
}
// The real roaming and local AppData as Tauri finds them (the known folders, whatever APPDATA says):
// each launch checks that the app's files there stay unchanged (lib/app.ts, realAppFiles).
const realFolders = powershell("[Environment]::GetFolderPath('ApplicationData'); [Environment]::GetFolderPath('LocalApplicationData')")
  .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
if (realFolders.length !== 2) fail("既知フォルダー（AppData）の場所を調べられませんでした。");

const runStart = new Date(Date.now() - 1000);
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "papeer-e2e-"));
const shared = isolatedDirs(path.join(runDir, "shared"));
const env = isolatedEnv(process.env, shared);
const started: Started[] = [];
let stopping = false;

async function stopAll(): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const p of started.reverse()) await p.stop();
  const left = sweepLeftovers(runStart, runDir);
  if (left) console.warn(`残っていたプロセスを ${left} 個止めました。`);
  if (!await removeTree(runDir)) console.warn(`一時フォルダーを消せませんでした: ${runDir}`);
}

let child: ReturnType<typeof spawn> | undefined;
process.on("SIGINT", () => {
  // node:test's own children get the Ctrl+C too and may end before their cleanup: stopAll sweeps up the
  // scenario's app (detached, out of this console), sidecar and WebView2.
  child?.kill();
  void stopAll().then(() => process.exit(130));
});

let exitCode = 0;
try {
  fs.rmSync(RESULTS, { recursive: true, force: true });
  fs.mkdirSync(FONT_CACHE, { recursive: true });

  const pdfDir = path.join(runDir, "pdfs");
  const made = spawnSync(PYTHON, [path.join(REPO, "tools", "e2e_pdfs.py"), pdfDir], { cwd: REPO, env, encoding: "utf8" });
  if (made.status !== 0) throw new Error(`テスト用の PDF を作れませんでした:\n${made.stderr}`);

  const stub = start(PYTHON, [path.join(REPO, "tools", "e2e_stub_ai.py")], { cwd: REPO, env, log: path.join(runDir, "stub-ai.log") });
  started.push(stub);
  const stubPort = await waitFor(() => {
    assertRunning(stub, "代役 API");
    return /PORT (\d+)/.exec(fs.readFileSync(stub.log, "utf8"))?.[1];
  }, "代役 API の起動", 30_000);

  const vite = start(process.execPath, [path.join(FRONTEND, "node_modules", "vite", "bin", "vite.js"), "--port", String(VITE_PORT), "--strictPort"], {
    cwd: FRONTEND, env, log: path.join(runDir, "vite.log"),
  });
  started.push(vite);
  await waitFor(async () => {
    assertRunning(vite, "Vite");
    return (await fetch(`http://localhost:${VITE_PORT}/`)).ok;
  }, "Vite の起動", 60_000, 250);

  const info: RunInfo = { runDir, stubUrl: `http://127.0.0.1:${stubPort}`, pdfDir, resultsDir: RESULTS, fontCache: FONT_CACHE };
  const testEnv = { ...process.env, E2E_RUN: JSON.stringify(info), E2E_REAL_FOLDERS: JSON.stringify(realFolders) };
  for (let round = 1; round <= repeat; round++) {
    if (repeat > 1) console.log(`\n=== ${round} / ${repeat} 回目 ===`);
    const began = Date.now();
    const code = await new Promise<number>((resolve) => {
      child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", ...files.map((f) => path.join(TESTS, f))], {
        cwd: FRONTEND, env: testEnv, stdio: "inherit",
      });
      child.on("exit", (c) => resolve(c ?? 1));
    });
    console.log(`${repeat > 1 ? `${round} 回目: ` : ""}${code === 0 ? "成功" : "失敗"}（${((Date.now() - began) / 1000).toFixed(0)} 秒）`);
    if (code !== 0) {
      exitCode = code;
      console.log(`失敗したシナリオの画面とログ: ${RESULTS}`);
      break;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await stopAll();
}
process.exit(exitCode);

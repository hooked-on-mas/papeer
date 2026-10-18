/** Starting, waiting for and stopping the processes of the end-to-end tests (Windows). */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const FRONTEND = path.resolve(import.meta.dirname, "..", "..");
export const REPO = path.resolve(FRONTEND, "..");
export const PYTHON = path.join(REPO, ".venv", "Scripts", "python.exe");
export const APP_EXE = path.join(FRONTEND, "src-tauri", "target", "debug", "papeer.exe");

/** The ports a debug build of the app uses: it talks to the sidecar on 8000 and loads the page from Vite on 1420 (src-tauri). */
export const SIDECAR_PORT = 8000;
export const VITE_PORT = 1420;
/** The token of a debug build (DEV_TOKEN in src-tauri/src/lib.rs). */
export const DEV_TOKEN = "dev_token";

export interface Started {
  child: ChildProcess;
  log: string;
  /** Force-stops the process and everything it started. */
  stop(): Promise<void>;
}

/** Starts `command` with its output in `log`. `detached` keeps it out of this console (Ctrl+C is handled by run.ts). */
export function start(command: string, args: string[], options: SpawnOptions & { log: string; detached?: boolean }): Started {
  fs.mkdirSync(path.dirname(options.log), { recursive: true });
  const out = fs.openSync(options.log, "a");
  const child = spawn(command, args, { ...options, stdio: ["ignore", out, out], windowsHide: true });
  fs.closeSync(out);
  child.on("error", () => undefined); // Reported by the caller's wait, not as an unhandled error.
  return { child, log: options.log, stop: () => killTree(child) };
}

/** Ends a process and its children at once (taskkill /T /F): no clean exit, so nothing is saved on the way out. */
export async function killTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  await Promise.race([exited, sleep(10_000)]);
}

/**
 * Polls `check` until it returns a value other than undefined/false; throws `message` (what was waited
 * for, or a function that describes what went wrong) after `timeout` ms.
 */
export async function waitFor<T>(check: () => Promise<T | undefined | false> | T | undefined | false,
  message: string | (() => string | Promise<string>), timeout = 30_000, interval = 100): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined && value !== false) return value as T;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      const text = typeof message === "string" ? message : await message();
      throw new Error(`${text}（${timeout / 1000} 秒待ちました）${lastError ? `: ${String(lastError)}` : ""}`);
    }
    await sleep(interval);
  }
}

/** Whether something listens on 127.0.0.1:port (or ::1 for "localhost" servers such as Vite). */
export async function isListening(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "::1"]) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    });
    if (open) return true;
  }
  return false;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/** Throws unless `child` is still running (with the end of its log). */
export function assertRunning(started: Started, name: string): void {
  if (started.child.exitCode !== null) {
    throw new Error(`${name} が終了しました（終了コード ${started.child.exitCode}）。\n${logTail(started.log)}`);
  }
}

export function logTail(file: string, lines = 30): string {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** Runs a PowerShell script (no profile) and returns its standard output. */
export function powershell(script: string, timeout = 60_000): string {
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", timeout, windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.stdout;
}

export interface ProcessInfo { pid: number; parent: number; name: string; commandLine: string }

/** Every process whose command line contains `text` (e.g. the test's temporary folder), other than the query's own. */
export function processesMentioning(text: string): ProcessInfo[] {
  const quoted = text.replace(/'/g, "''");
  const out = powershell(`$t = '${quoted}'
@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($t, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
  ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name; commandLine = $_.CommandLine } }) | ConvertTo-Json -Compress -Depth 2`);
  return parseProcesses(out);
}

/** The WebView2 processes started by `pid`: waits up to `timeout` ms for the first one. */
export function webviewChildren(pid: number, timeout: number): ProcessInfo[] {
  const out = powershell(`$deadline = (Get-Date).AddMilliseconds(${timeout})
do {
  $p = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe' AND ParentProcessId=${pid}")
  if ($p.Count -gt 0) { break }
  if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 50
} while ((Get-Date) -lt $deadline)
@($p | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name; commandLine = $_.CommandLine } }) | ConvertTo-Json -Compress -Depth 2`, timeout + 30_000);
  return parseProcesses(out);
}

function parseProcesses(out: string): ProcessInfo[] {
  const text = out.trim();
  if (!text) return [];
  const value = JSON.parse(text) as ProcessInfo | ProcessInfo[];
  return (Array.isArray(value) ? value : [value]).map((p) => ({ ...p, commandLine: p.commandLine ?? "" }));
}

/**
 * Stops what a run may have left when a test process was ended before its cleanup (Ctrl+C): processes
 * started after `since` that are this checkout's debug app, a sidecar or stand-in AI started with this
 * checkout's .venv python (`-m sidecar`, tools\e2e_stub_ai.py), or that name `runDir` (WebView2 with its
 * profile there), and every process these started in turn: the venv's python.exe is a launcher that runs
 * the real interpreter as its child, whose command line no longer names the .venv. Only processes started
 * after the run began: the ports were free then, so none of them is the developer's own.
 */
export function sweepLeftovers(since: Date, runDir: string): number {
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  const out = powershell(`$since = [datetime]::Parse('${since.toISOString()}').ToLocalTime()
$app = ${quote(APP_EXE)}; $py = ${quote(PYTHON)}; $dir = ${quote(runDir)}; $stub = ${quote(path.join(REPO, "tools", "e2e_stub_ai.py"))}
function Has($text, $part) { $text -and $text.IndexOf($part, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
$all = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CreationDate -gt $since })
$found = @{}
foreach ($p in $all) {
  if (($p.ExecutablePath -and $p.ExecutablePath -ieq $app) -or (Has $p.CommandLine $dir) -or
      ((Has $p.CommandLine $py) -and ($p.CommandLine -match '-m sidecar' -or (Has $p.CommandLine $stub)))) { $found[$p.ProcessId] = $p }
}
# Their descendants, started after them (so not an unrelated process that took over a parent's old PID).
do {
  $added = 0
  foreach ($p in $all) {
    $parent = $found[$p.ParentProcessId]
    if (-not $found.ContainsKey($p.ProcessId) -and $parent -and $p.CreationDate -ge $parent.CreationDate) { $found[$p.ProcessId] = $p; $added++ }
  }
} while ($added -gt 0)
@($found.Keys) -join ' '`);
  const pids = out.trim().split(/\s+/).filter(Boolean).map(Number);
  forceStop(pids);
  return pids.length;
}

/**
 * Before a run: stops the processes that name a folder of an earlier run (`<temp>\papeer-e2e-*`: WebView2
 * with its profile there) and deletes those folders. Only called once the ports were found free, so no
 * other run is going on.
 */
export async function cleanEarlierRuns(tempDir: string): Promise<{ processes: number; folders: string[] }> {
  const prefix = path.join(tempDir, "papeer-e2e-");
  const left = processesMentioning(prefix);
  forceStop(left.map((p) => p.pid));
  await waitFor(() => processesMentioning(prefix).length === 0, "前回の E2E テストのプロセスの終了", 60_000, 1_000);
  const folders = fs.readdirSync(tempDir).filter((name) => name.startsWith("papeer-e2e-")).map((name) => path.join(tempDir, name));
  for (const folder of folders) await removeTree(folder);
  return { processes: left.length, folders };
}

export function forceStop(pids: number[]): void {
  for (const pid of pids) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

/** Deletes a folder, retrying while a process that was just stopped still holds its files. */
export async function removeTree(dir: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Retried below.
    }
    if (!fs.existsSync(dir)) return true;
    await sleep(500);
  }
  return false;
}
